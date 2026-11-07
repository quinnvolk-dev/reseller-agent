import { db, getListing, saveSale, logRun } from '../lib/db.js';
import { withdrawOffer } from '../lib/ebay.js';
import { toDollars } from '../lib/money.js';
import { getShop, assertCanList } from './shops.js';

// Items live in the `listings` table (see src/migrations/001_multi_shop.js for why).
export const getItem = getListing;

function requireItem(itemId) {
  const item = getItem(itemId);
  if (!item) throw new Error(`No item found with id ${itemId}`);
  return item;
}

const SOLD_STATES = ['sold', 'shipped', 'returned'];

/**
 * Records that an item is live on a platform: upserts its platform_listings row and moves the
 * item to 'listed'. Enforces the shop's allowed platforms and price floor.
 */
export function recordListing({ itemId, platform, externalId = null, url = null, offerId = null, priceCents = null }) {
  const item = requireItem(itemId);
  if (SOLD_STATES.includes(item.status)) {
    throw new Error(`Item #${itemId} is already ${item.status}; not recording a new listing for it.`);
  }
  assertCanList(getShop(item.shop_id), platform, priceCents);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO platform_listings (item_id, platform, external_id, url, offer_id, status)
       VALUES (?, ?, ?, ?, ?, 'active')
       ON CONFLICT (item_id, platform) DO UPDATE SET
         external_id = excluded.external_id,
         url = excluded.url,
         offer_id = COALESCE(excluded.offer_id, platform_listings.offer_id),
         status = 'active',
         delist_pending = 0,
         updated_at = datetime('now')`
    ).run(itemId, platform, externalId, url, offerId);
    db.prepare(`UPDATE listings SET status = 'listed' WHERE id = ?`).run(itemId);
  })();

  return db.prepare('SELECT * FROM platform_listings WHERE item_id = ? AND platform = ?').get(itemId, platform);
}

export function getPlatformListings(itemId) {
  return db.prepare('SELECT * FROM platform_listings WHERE item_id = ? ORDER BY platform').all(itemId);
}

function ebayOfferIdFor(listingRow) {
  if (listingRow.offer_id) return listingRow.offer_id;
  // Listings published through `npm run go-live` always store offer_id; this covers ones that
  // were recorded by hand but still have a draft/published offer from `npm run publish`.
  return (
    db
      .prepare(
        `SELECT offer_id FROM ebay_offers
         WHERE listing_id = ? AND offer_id IS NOT NULL
         ORDER BY (status = 'published') DESC, id DESC LIMIT 1`
      )
      .get(listingRow.item_id)?.offer_id ?? null
  );
}

/**
 * Records a sale of an item and closes it out everywhere:
 *   1. inserts the sale (integer cents + the dollar columns `books` reads),
 *   2. sets the item to 'sold' and its listing on the selling platform to 'sold',
 *   3. ends the item's other active listings — eBay via the API (withdraw offer); anything
 *      else (Depop: partner-only API) is flagged delist_pending for you to take down by hand.
 * Steps 1–2 are one transaction. Step 3 runs after, so an eBay API failure never loses the
 * sale; a failed eBay end is flagged delist_pending instead.
 *
 * `deps.withdrawEbayOffer` exists so tests can run without touching eBay.
 */
export async function recordSale(
  {
    itemId,
    platform = 'ebay',
    salePriceCents,
    feesCents,
    feesEstimated = false,
    shippingChargedCents = 0,
    costBasisCents = 0,
    shippingCostCents = 0,
    otherCostsCents = 0,
    soldAt = null,
    notes = null,
  },
  { withdrawEbayOffer = withdrawOffer } = {}
) {
  const started = Date.now();
  try {
    const item = requireItem(itemId);
    if (SOLD_STATES.includes(item.status)) {
      throw new Error(`Item #${itemId} is already ${item.status}. Not recording a second sale.`);
    }
    for (const [k, v] of Object.entries({ salePriceCents, feesCents, shippingChargedCents, costBasisCents, shippingCostCents, otherCostsCents })) {
      if (!Number.isInteger(v)) throw new Error(`${k} must be a whole number of cents (got ${v}).`);
    }

    const revenue = salePriceCents + shippingChargedCents;
    const netCents = revenue - costBasisCents - feesCents - shippingCostCents - otherCostsCents;
    const marginPct = revenue ? +((netCents / revenue) * 100).toFixed(1) : null;

    let saleId;
    db.transaction(() => {
      saleId = saveSale({
        sold_at: soldAt,
        listing_id: itemId,
        item: item.title ?? item.query,
        platform,
        sale_price: toDollars(salePriceCents),
        shipping_charged: toDollars(shippingChargedCents),
        cost_basis: toDollars(costBasisCents),
        platform_fees: toDollars(feesCents),
        fees_estimated: feesEstimated ? 1 : 0,
        shipping_cost: toDollars(shippingCostCents),
        other_costs: toDollars(otherCostsCents),
        net_profit: toDollars(netCents),
        margin_pct: marginPct,
        notes,
        sale_price_cents: salePriceCents,
        fees_cents: feesCents,
      });
      db.prepare(`UPDATE listings SET status = 'sold' WHERE id = ?`).run(itemId);
      db.prepare(
        `INSERT INTO platform_listings (item_id, platform, status) VALUES (?, ?, 'sold')
         ON CONFLICT (item_id, platform) DO UPDATE SET
           status = 'sold', delist_pending = 0, updated_at = datetime('now')`
      ).run(itemId, platform);
    })();

    const others = db
      .prepare(`SELECT * FROM platform_listings WHERE item_id = ? AND platform != ? AND status = 'active'`)
      .all(itemId, platform);

    const ended = [];
    const manual = [];
    const flag = db.prepare(
      `UPDATE platform_listings SET delist_pending = 1, updated_at = datetime('now') WHERE id = ?`
    );
    const end = db.prepare(
      `UPDATE platform_listings SET status = 'ended', delist_pending = 0, updated_at = datetime('now') WHERE id = ?`
    );

    for (const l of others) {
      if (l.platform === 'ebay') {
        const offerId = ebayOfferIdFor(l);
        if (!offerId) {
          flag.run(l.id);
          manual.push({ ...l, reason: 'no eBay offer ID on file, so it cannot be ended via the API' });
          continue;
        }
        try {
          await withdrawEbayOffer(offerId);
          end.run(l.id);
          db.prepare(`UPDATE ebay_offers SET status = 'withdrawn' WHERE offer_id = ?`).run(offerId);
          ended.push(l);
        } catch (err) {
          flag.run(l.id);
          manual.push({ ...l, reason: `eBay API error: ${err.message}` });
        }
      } else {
        flag.run(l.id);
        manual.push({ ...l, reason: `${l.platform} has no public delist API` });
      }
    }

    logRun({
      module: 'sales',
      status: 'ok',
      detail:
        `item #${itemId} sold on ${platform}; ended ${ended.length}` +
        (manual.length ? `; needs manual delist: ${manual.map((m) => m.platform).join(', ')}` : ''),
      durationMs: Date.now() - started,
    });

    return { saleId, item, netCents, marginPct, ended, manual };
  } catch (err) {
    logRun({ module: 'sales', status: 'error', detail: err.message, durationMs: Date.now() - started });
    throw err;
  }
}

/** Listings still live somewhere after the item sold elsewhere. */
export function delistQueue() {
  return db
    .prepare(
      `SELECT pl.*, i.title, i.shop_id FROM platform_listings pl
       JOIN listings i ON i.id = pl.item_id
       WHERE pl.delist_pending = 1 ORDER BY pl.updated_at`
    )
    .all();
}

/** You took it down by hand: mark the listing ended. */
export function markDelisted(itemId, platform) {
  const r = db
    .prepare(
      `UPDATE platform_listings SET status = 'ended', delist_pending = 0, updated_at = datetime('now')
       WHERE item_id = ? AND platform = ? AND status = 'active'`
    )
    .run(itemId, platform);
  if (!r.changes) throw new Error(`No active ${platform} listing found for item #${itemId}.`);
}
