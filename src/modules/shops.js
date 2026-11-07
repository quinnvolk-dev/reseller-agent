import { db } from '../lib/db.js';
import { fmtCents } from '../lib/money.js';

export const KNOWN_PLATFORMS = ['ebay', 'depop', 'etsy', 'poshmark', 'mercari'];
const ACCOUNT_MODES = ['mine', 'theirs'];

function parse(row) {
  if (!row) return row;
  return { ...row, allowed_platforms: JSON.parse(row.allowed_platforms) };
}

export function getShop(id) {
  const shop = parse(db.prepare('SELECT * FROM shops WHERE id = ?').get(id));
  if (!shop) throw new Error(`No shop found with id ${id}. See: npm run shops`);
  return shop;
}

export function listShops() {
  return db.prepare('SELECT * FROM shops ORDER BY id').all().map(parse);
}

export function createShop({
  name,
  contactName = null,
  contactEmail = null,
  contactPhone = null,
  allowedPlatforms = ['ebay'],
  priceFloorCents = 0,
  mySplitPct = 25,
  accountMode = 'mine',
  ebayConnected = false,
}) {
  if (!name?.trim()) throw new Error('Shop name is required.');

  const platforms = [...new Set(allowedPlatforms.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (!platforms.length) throw new Error('A shop needs at least one allowed platform.');
  const unknown = platforms.filter((p) => !KNOWN_PLATFORMS.includes(p));
  if (unknown.length) {
    throw new Error(`Unknown platform(s): ${unknown.join(', ')}. Known: ${KNOWN_PLATFORMS.join(', ')}`);
  }
  if (!Number.isInteger(priceFloorCents) || priceFloorCents < 0) {
    throw new Error('Price floor must be zero or more.');
  }
  if (!Number.isFinite(mySplitPct) || mySplitPct < 0 || mySplitPct > 100) {
    throw new Error('Your split must be between 0 and 100 percent.');
  }
  if (!ACCOUNT_MODES.includes(accountMode)) {
    throw new Error(`Account mode must be one of: ${ACCOUNT_MODES.join(', ')}`);
  }

  return Number(
    db
      .prepare(
        `INSERT INTO shops
          (name, contact_name, contact_email, contact_phone, allowed_platforms,
           price_floor_cents, my_split_pct, account_mode, ebay_connected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name.trim(), contactName, contactEmail, contactPhone, JSON.stringify(platforms),
        priceFloorCents, mySplitPct, accountMode, ebayConnected ? 1 : 0
      ).lastInsertRowid
  );
}

/**
 * Throws unless this shop allows listing on `platform` at `priceCents`. Every code path that
 * creates a listing (eBay draft, eBay go-live, manually recorded Depop listing) calls this.
 */
export function assertCanList(shop, platform, priceCents) {
  if (!shop.allowed_platforms.includes(platform)) {
    throw new Error(
      `Shop #${shop.id} (${shop.name}) does not allow listing on ${platform}. ` +
        `Allowed: ${shop.allowed_platforms.join(', ')}.`
    );
  }
  if (priceCents == null) {
    if (shop.price_floor_cents > 0) {
      throw new Error(`A price is required to check shop #${shop.id}'s price floor of ${fmtCents(shop.price_floor_cents)}.`);
    }
    return;
  }
  if (priceCents < shop.price_floor_cents) {
    throw new Error(
      `${fmtCents(priceCents)} is below shop #${shop.id} (${shop.name})'s price floor of ` +
        `${fmtCents(shop.price_floor_cents)}.`
    );
  }
  if (platform === 'ebay' && shop.account_mode === 'theirs') {
    // The app holds one eBay token (yours, in .env). Listing on a shop's own account would
    // need per-shop OAuth tokens, which aren't built yet — refuse rather than list it on yours.
    throw new Error(
      `Shop #${shop.id} (${shop.name}) is set to list on its own eBay account (account_mode 'theirs'), ` +
        'and per-shop eBay accounts are not supported yet. Switch it to "mine" to list on your account.'
    );
  }
}

export function getPayouts({ month, shopId } = {}) {
  const clauses = [];
  const params = {};
  if (month) {
    clauses.push('month = @month');
    params.month = month;
  }
  if (shopId != null) {
    clauses.push('shop_id = @shopId');
    params.shopId = shopId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM shop_payouts ${where} ORDER BY month DESC, shop_id`).all(params);
}
