import {
  MARKETPLACE,
  upsertInventoryItem,
  createOffer,
  suggestCategory,
} from '../lib/ebay.js';
import { db, getListing, saveOffer, logRun } from '../lib/db.js';
import { publishOffer, listingUrl } from '../lib/ebay.js';
import { toCents } from '../lib/money.js';
import { getShop, assertCanList } from './shops.js';
import { recordListing } from './inventory.js';

const VALID_CONDITIONS = [
  'NEW', 'LIKE_NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS',
  'CERTIFIED_REFURBISHED', 'EXCELLENT_REFURBISHED', 'VERY_GOOD_REFURBISHED', 'GOOD_REFURBISHED',
  'SELLER_REFURBISHED', 'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
];

const CURRENCY_BY_MARKETPLACE = {
  EBAY_US: 'USD', EBAY_GB: 'GBP', EBAY_DE: 'EUR', EBAY_AU: 'AUD', EBAY_CA: 'CAD',
};

const REQUIRED_ENV = [
  'EBAY_FULFILLMENT_POLICY_ID',
  'EBAY_PAYMENT_POLICY_ID',
  'EBAY_RETURN_POLICY_ID',
  'EBAY_MERCHANT_LOCATION_KEY',
];

function slugSku(query) {
  const base = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Creates a DRAFT offer on eBay: an inventory item + an unpublished offer. Nothing here
 * ever goes live — createOffer() leaves the offer UNPUBLISHED by default, and this module
 * never calls publishOffer(). Review the draft in Seller Hub before publishing it yourself.
 */
export async function createDraft({
  listingId, title, description, photos, price, qty, condition, categoryId, sku, shopId,
}) {
  const started = Date.now();

  try {
    const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missingEnv.length) {
      throw new Error(
        `Missing from .env: ${missingEnv.join(', ')}. Run "npm run ebay-policies" to look up ` +
          'your business policy IDs and merchant location key first.'
      );
    }

    let listing = null;
    if (listingId != null) {
      listing = getListing(listingId);
      if (!listing) throw new Error(`No listing found with id ${listingId}`);
      if (['sold', 'shipped', 'returned'].includes(listing.status)) {
        throw new Error(`Item #${listingId} is already ${listing.status}.`);
      }
      if (shopId != null && shopId !== listing.shop_id) {
        throw new Error(`Item #${listingId} belongs to shop #${listing.shop_id}, not shop #${shopId}.`);
      }
    }

    // Shop rules: allowed platforms + price floor. Items carry their shop; a standalone
    // --title draft uses --shop (default 1, your own inventory).
    const shop = getShop(listing?.shop_id ?? shopId ?? 1);
    assertCanList(shop, 'ebay', Number.isFinite(price) ? toCents(price) : null);

    const finalTitle = title ?? listing?.title;
    const finalDescription = description ?? listing?.description;
    const finalCondition = (condition ?? '').toUpperCase();

    if (!finalTitle || !finalDescription) {
      throw new Error('title/description are required (pass --listing <id> or --title/--desc directly).');
    }
    if (!photos?.length) {
      throw new Error(
        'photos must be public image URLs (the eBay Inventory API cannot accept local file ' +
          'paths or the ones used to generate the listing draft — host them first).'
      );
    }
    if (!Number.isFinite(price) || price <= 0) throw new Error('--price is required and must be > 0.');
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('--qty is required and must be > 0.');
    if (!VALID_CONDITIONS.includes(finalCondition)) {
      throw new Error(`--condition must be one of: ${VALID_CONDITIONS.join(', ')}`);
    }

    let finalCategoryId = categoryId;
    let categorySource = 'provided';
    if (!finalCategoryId) {
      const suggestions = await suggestCategory(finalTitle);
      if (!suggestions.length) {
        throw new Error('No category suggestions found — pass --category <id> explicitly.');
      }
      finalCategoryId = suggestions[0].id;
      categorySource = `auto-suggested: "${suggestions[0].name}" (pass --category to override)`;
    }

    const finalSku = sku ?? `sku-${slugSku(finalTitle)}`;

    await upsertInventoryItem(finalSku, {
      condition: finalCondition,
      product: {
        title: finalTitle.slice(0, 80),
        description: finalDescription,
        imageUrls: photos,
      },
      availability: {
        shipToLocationAvailability: { quantity: qty },
      },
    });

    const currency = CURRENCY_BY_MARKETPLACE[MARKETPLACE] ?? process.env.EBAY_CURRENCY ?? 'USD';

    const offerResult = await createOffer({
      sku: finalSku,
      marketplaceId: MARKETPLACE,
      format: 'FIXED_PRICE',
      availableQuantity: qty,
      categoryId: finalCategoryId,
      listingDescription: `<p>${finalDescription.replace(/\n+/g, '</p><p>')}</p>`,
      listingPolicies: {
        fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
        paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
        returnPolicyId: process.env.EBAY_RETURN_POLICY_ID,
      },
      pricingSummary: { price: { value: String(price), currency } },
      merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY,
    });

    saveOffer({
      listing_id: listingId ?? null,
      sku: finalSku,
      offer_id: offerResult.offerId,
      category_id: finalCategoryId,
      price,
      qty,
      status: 'draft',
      detail: offerResult.warnings?.length ? JSON.stringify(offerResult.warnings) : null,
    });

    logRun({
      module: 'publish',
      status: 'ok',
      detail: `${finalTitle} -> draft offer ${offerResult.offerId}`,
      durationMs: Date.now() - started,
    });

    return { sku: finalSku, offerId: offerResult.offerId, categoryId: finalCategoryId, categorySource, warnings: offerResult.warnings ?? [] };
  } catch (err) {
    logRun({ module: 'publish', status: 'error', detail: err.message, durationMs: Date.now() - started });
    throw err;
  }
}

/**
 * Makes an item's eBay draft offer LIVE, then records the eBay listing ID + URL in
 * platform_listings and moves the item to 'listed'. Only ever runs from an explicit
 * `npm run go-live -- ... --yes`; nothing calls it automatically. Re-checks the shop's
 * platform/price-floor rules first, since settings may have changed since the draft.
 *
 * `deps.publish` exists so tests can run without touching eBay.
 */
export async function goLive({ itemId, offerId }, { publish = publishOffer } = {}) {
  const started = Date.now();
  try {
    const offer = offerId
      ? db.prepare(`SELECT * FROM ebay_offers WHERE offer_id = ?`).get(offerId)
      : db
          .prepare(
            `SELECT * FROM ebay_offers WHERE listing_id = ? AND status = 'draft' AND offer_id IS NOT NULL
             ORDER BY id DESC LIMIT 1`
          )
          .get(itemId);
    if (!offer) {
      throw new Error(
        offerId
          ? `No offer ${offerId} in the local database (create it with npm run publish first).`
          : `Item #${itemId} has no draft eBay offer. Run npm run publish -- --listing ${itemId} ... first.`
      );
    }
    if (offer.status !== 'draft') throw new Error(`Offer ${offer.offer_id} is ${offer.status}, not a draft.`);
    if (offer.listing_id == null) {
      throw new Error(`Offer ${offer.offer_id} isn't tied to an item, so it can't be tracked per shop.`);
    }
    if (itemId != null && offer.listing_id !== itemId) {
      throw new Error(`Offer ${offer.offer_id} belongs to item #${offer.listing_id}, not #${itemId}.`);
    }

    const item = getListing(offer.listing_id);
    const priceCents = toCents(offer.price);
    // recordListing checks this too, but check BEFORE the listing goes live, not after.
    assertCanList(getShop(item.shop_id), 'ebay', priceCents);

    const res = await publish(offer.offer_id);
    const ebayListingId = res?.listingId;
    if (!ebayListingId) throw new Error(`eBay did not return a listing ID: ${JSON.stringify(res)}`);

    db.prepare(`UPDATE ebay_offers SET status = 'published' WHERE id = ?`).run(offer.id);
    const row = recordListing({
      itemId: item.id,
      platform: 'ebay',
      externalId: ebayListingId,
      url: listingUrl(ebayListingId),
      offerId: offer.offer_id,
      priceCents,
    });

    logRun({ module: 'publish', status: 'ok', detail: `item #${item.id} live on eBay: ${ebayListingId}`, durationMs: Date.now() - started });
    return row;
  } catch (err) {
    logRun({ module: 'publish', status: 'error', detail: err.message, durationMs: Date.now() - started });
    throw err;
  }
}
