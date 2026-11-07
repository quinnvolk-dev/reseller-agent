// Multi-shop support.
//
// Naming note: this codebase already had tables called `listings` and `sales` before
// multi-shop existed, so this migration adapts to them instead of creating duplicates:
//   - `listings` (one row per item drafted from photos) IS the items table. It gains
//     shop_id + status. Existing rows become shop 1.
//   - Per-platform listings (eBay listing ID, Depop URL, ...) go in a NEW table,
//     `platform_listings`, because the name `listings` is taken.
//   - `sales` already exists with dollar (REAL) columns that `npm run books` reads. It gains
//     integer-cents columns (sale_price_cents, fees_cents) plus shipped_at / paid_out_at, and
//     the existing rows are backfilled. sales.listing_id is the item id.
// Nothing is dropped or recreated.

export const id = '001_multi_shop';

export function up(db) {
  db.exec(`
    CREATE TABLE shops (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      contact_name      TEXT,
      contact_email     TEXT,
      contact_phone     TEXT,
      allowed_platforms TEXT NOT NULL DEFAULT '["ebay"]'
                        CHECK (json_valid(allowed_platforms) AND json_type(allowed_platforms) = 'array'),
      price_floor_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_floor_cents >= 0),
      my_split_pct      REAL NOT NULL DEFAULT 25 CHECK (my_split_pct BETWEEN 0 AND 100),
      account_mode      TEXT NOT NULL DEFAULT 'mine' CHECK (account_mode IN ('mine', 'theirs')),
      ebay_connected    INTEGER NOT NULL DEFAULT 0 CHECK (ebay_connected IN (0, 1)),
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Shop 1 is your own inventory: you keep 100% (my_split_pct 0 means the "shop share"
    -- column is the whole net, which is yours anyway). eBay is the account in .env.
    INSERT INTO shops (id, name, allowed_platforms, price_floor_cents, my_split_pct, account_mode, ebay_connected)
    VALUES (1, 'Quinn (own inventory)', '["ebay","depop"]', 0, 0, 'mine', 1);

    -- Items (the existing listings table).
    ALTER TABLE listings ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1 REFERENCES shops(id);
    ALTER TABLE listings ADD COLUMN status TEXT NOT NULL DEFAULT 'intake'
      CHECK (status IN ('intake', 'review', 'listed', 'sold', 'shipped', 'returned'));

    -- Existing items: anything with a logged sale is 'sold'; everything else already has a
    -- generated draft waiting on you, which is 'review'.
    UPDATE listings
    SET status = CASE
      WHEN EXISTS (SELECT 1 FROM sales s WHERE s.listing_id = listings.id) THEN 'sold'
      ELSE 'review'
    END;

    CREATE INDEX idx_listings_shop ON listings(shop_id);
    CREATE INDEX idx_listings_status ON listings(status);

    -- Where each item is listed. One row per item per platform.
    CREATE TABLE platform_listings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id        INTEGER NOT NULL REFERENCES listings(id),
      platform       TEXT NOT NULL,
      external_id    TEXT,               -- eBay listing ID, Depop product ID, ...
      url            TEXT,
      offer_id       TEXT,               -- eBay Inventory API offer ID, needed to end the listing via API
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'ended')),
      delist_pending INTEGER NOT NULL DEFAULT 0 CHECK (delist_pending IN (0, 1)),
                                         -- 1 = still live, you need to take it down by hand (e.g. Depop)
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (item_id, platform)
    );

    -- Sales: integer cents alongside the existing dollar columns.
    ALTER TABLE sales ADD COLUMN sale_price_cents INTEGER;
    ALTER TABLE sales ADD COLUMN fees_cents INTEGER;
    ALTER TABLE sales ADD COLUMN shipped_at TEXT;
    ALTER TABLE sales ADD COLUMN paid_out_at TEXT;

    UPDATE sales
    SET sale_price_cents = CAST(ROUND(sale_price * 100) AS INTEGER),
        fees_cents       = CAST(ROUND(platform_fees * 100) AS INTEGER);

    -- Monthly payout per shop. Sales with no item (logged with --item instead of --listing)
    -- count as shop 1. my_cut is rounded once per shop-month; shop_share is the remainder,
    -- so my_cut + shop_share always equals net exactly.
    CREATE VIEW shop_payouts AS
    SELECT
      shop_id,
      shop_name,
      month,
      items_sold,
      gross_cents,
      fees_cents,
      net_cents,
      my_cut_cents,
      net_cents - my_cut_cents AS shop_share_cents
    FROM (
      SELECT
        sh.id                                        AS shop_id,
        sh.name                                      AS shop_name,
        strftime('%Y-%m', s.sold_at)                 AS month,
        COUNT(*)                                     AS items_sold,
        SUM(s.sale_price_cents)                      AS gross_cents,
        SUM(s.fees_cents)                            AS fees_cents,
        SUM(s.sale_price_cents - s.fees_cents)       AS net_cents,
        CAST(ROUND(SUM(s.sale_price_cents - s.fees_cents) * sh.my_split_pct / 100.0) AS INTEGER)
                                                     AS my_cut_cents
      FROM sales s
      LEFT JOIN listings i ON i.id = s.listing_id
      JOIN shops sh ON sh.id = COALESCE(i.shop_id, 1)
      GROUP BY sh.id, strftime('%Y-%m', s.sold_at)
    );
  `);
}
