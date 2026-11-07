import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import path from 'path';
import { migrate } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RESELLER_DB_PATH lets tests (or a scratch copy) point at a different file. Unset = your real DB.
export const DB_PATH = process.env.RESELLER_DB_PATH || path.join(__dirname, '../data/agent.db');

if (DB_PATH !== ':memory:') mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

export function init() {
  db.exec(`
    -- Every product you've researched, with the verdict and whether you followed it.
    CREATE TABLE IF NOT EXISTS research (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      query         TEXT NOT NULL,
      unit_cost     REAL,
      qty           INTEGER,
      active_count  INTEGER,
      active_median REAL,
      active_low    REAL,
      active_high   REAL,
      sold_90d      INTEGER,
      sold_avg      REAL,
      sell_through  REAL,
      verdict       TEXT,
      confidence    TEXT,
      reasoning     TEXT,
      -- filled in later by you, so you can score the agent
      actually_bought  INTEGER DEFAULT NULL,
      actual_outcome   TEXT DEFAULT NULL
    );

    -- Every run of every module. This is what the dashboard reads later.
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      module      TEXT NOT NULL,
      status      TEXT NOT NULL,   -- ok | error
      detail      TEXT,
      duration_ms INTEGER
    );

    -- Every listing draft generated from photos, with the price it actually sold at.
    CREATE TABLE IF NOT EXISTS listings (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      query                TEXT NOT NULL,
      photos               TEXT,   -- JSON array of file paths used
      title                TEXT,
      description          TEXT,
      tags                 TEXT,   -- JSON array
      condition_assessment TEXT,
      suggested_price      REAL,
      confidence           TEXT,
      flags                TEXT,   -- JSON array: mismatches between photos and claimed item/condition
      -- filled in later by you, so you can score the agent
      actual_list_price    REAL DEFAULT NULL,
      actual_outcome       TEXT DEFAULT NULL
    );

    -- Every draft/published offer pushed to eBay via the Sell API.
    CREATE TABLE IF NOT EXISTS ebay_offers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      listing_id    INTEGER,   -- FK into listings, nullable if run standalone
      sku           TEXT NOT NULL,
      offer_id      TEXT,
      category_id   TEXT,
      price         REAL,
      qty           INTEGER,
      status        TEXT NOT NULL DEFAULT 'draft',   -- draft | published | error
      detail        TEXT
    );

    -- Buyer message drafts. Never sent automatically — you copy the draft into eBay/Depop yourself.
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      listing_id    INTEGER,   -- FK into listings, nullable if run standalone
      buyer_message TEXT NOT NULL,
      situation     TEXT,   -- free-text context you supply: order status, shipping, prior thread, etc
      draft_reply   TEXT,
      tone          TEXT,
      confidence    TEXT,
      flags         TEXT,   -- JSON array: things the draft couldn't confirm and left for you to decide
      -- filled in later by you, so you can score the agent
      actual_sent      INTEGER DEFAULT NULL,
      actual_outcome   TEXT DEFAULT NULL
    );

    -- Completed sales: real numbers, not estimates. This is what "books" reports off.
    CREATE TABLE IF NOT EXISTS sales (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      sold_at           TEXT NOT NULL DEFAULT (datetime('now')),
      listing_id        INTEGER,   -- FK into listings, nullable if run standalone
      item              TEXT NOT NULL,
      platform          TEXT NOT NULL DEFAULT 'ebay',
      sale_price        REAL NOT NULL,
      shipping_charged  REAL NOT NULL DEFAULT 0,   -- what the buyer paid you for shipping, if itemized
      cost_basis        REAL NOT NULL,             -- unit/wholesale cost of the item
      platform_fees     REAL NOT NULL,             -- final value fee etc, actual or estimated
      fees_estimated    INTEGER NOT NULL DEFAULT 0,-- 1 if platform_fees is a formula guess, not a real payout number
      shipping_cost     REAL NOT NULL DEFAULT 0,   -- what you actually paid to ship it
      other_costs       REAL NOT NULL DEFAULT 0,   -- packaging, supplies, etc
      net_profit        REAL NOT NULL,
      margin_pct        REAL,
      notes             TEXT
    );

    -- Dropship orders: an eBay sale that still needs to be placed with the supplier.
    -- No eBay order-sync yet (needs a new OAuth scope) — log these by hand for now.
    CREATE TABLE IF NOT EXISTS dropship_orders (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      ebay_order_id      TEXT,
      item               TEXT NOT NULL,
      buyer_name         TEXT,
      buyer_address      TEXT,
      supplier           TEXT,
      wholesale_cost     REAL,
      sale_price         REAL,
      status             TEXT NOT NULL DEFAULT 'needs_ordering',
        -- needs_ordering | ordered | shipped | delivered | issue
      supplier_order_ref TEXT,
      tracking_number    TEXT,
      notes              TEXT,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Schema changes after the original tables live in src/migrations/ (multi-shop, ...).
  migrate(db, { dbPath: DB_PATH });
}

export function logRun({ module, status, detail, durationMs }) {
  db.prepare(
    `INSERT INTO runs (module, status, detail, duration_ms) VALUES (?, ?, ?, ?)`
  ).run(module, status, detail ?? null, durationMs ?? null);
}

export function saveResearch(row) {
  const stmt = db.prepare(`
    INSERT INTO research
      (query, unit_cost, qty, active_count, active_median, active_low, active_high,
       sold_90d, sold_avg, sell_through, verdict, confidence, reasoning)
    VALUES
      (@query, @unit_cost, @qty, @active_count, @active_median, @active_low, @active_high,
       @sold_90d, @sold_avg, @sell_through, @verdict, @confidence, @reasoning)
  `);
  return stmt.run(row).lastInsertRowid;
}

export function saveListing(row) {
  const stmt = db.prepare(`
    INSERT INTO listings
      (query, photos, title, description, tags, condition_assessment,
       suggested_price, confidence, flags)
    VALUES
      (@query, @photos, @title, @description, @tags, @condition_assessment,
       @suggested_price, @confidence, @flags)
  `);
  return stmt.run(row).lastInsertRowid;
}

export function saveOffer(row) {
  const stmt = db.prepare(`
    INSERT INTO ebay_offers
      (listing_id, sku, offer_id, category_id, price, qty, status, detail)
    VALUES
      (@listing_id, @sku, @offer_id, @category_id, @price, @qty, @status, @detail)
  `);
  return stmt.run(row).lastInsertRowid;
}

export function getListing(id) {
  return db.prepare(`SELECT * FROM listings WHERE id = ?`).get(id);
}

export function saveMessage(row) {
  const stmt = db.prepare(`
    INSERT INTO messages
      (listing_id, buyer_message, situation, draft_reply, tone, confidence, flags)
    VALUES
      (@listing_id, @buyer_message, @situation, @draft_reply, @tone, @confidence, @flags)
  `);
  return stmt.run(row).lastInsertRowid;
}

export function saveSale(row) {
  const stmt = db.prepare(`
    INSERT INTO sales
      (sold_at, listing_id, item, platform, sale_price, shipping_charged, cost_basis,
       platform_fees, fees_estimated, shipping_cost, other_costs, net_profit, margin_pct, notes)
    VALUES
      (COALESCE(@sold_at, datetime('now')), @listing_id, @item, @platform, @sale_price,
       @shipping_charged, @cost_basis, @platform_fees, @fees_estimated, @shipping_cost,
       @other_costs, @net_profit, @margin_pct, @notes)
  `);
  return stmt.run(row).lastInsertRowid;
}

export function listSales({ since, platform } = {}) {
  const clauses = [];
  const params = {};
  if (since) {
    clauses.push('sold_at >= @since');
    params.since = since;
  }
  if (platform) {
    clauses.push('platform = @platform');
    params.platform = platform;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM sales ${where} ORDER BY sold_at`).all(params);
}

export function saveDropshipOrder(row) {
  const stmt = db.prepare(`
    INSERT INTO dropship_orders
      (ebay_order_id, item, buyer_name, buyer_address, supplier, wholesale_cost, sale_price, notes)
    VALUES
      (@ebay_order_id, @item, @buyer_name, @buyer_address, @supplier, @wholesale_cost, @sale_price, @notes)
  `);
  return stmt.run(row).lastInsertRowid;
}

export function listDropshipOrders({ status } = {}) {
  if (status) {
    return db.prepare(`SELECT * FROM dropship_orders WHERE status = ? ORDER BY created_at`).all(status);
  }
  return db.prepare(`SELECT * FROM dropship_orders WHERE status != 'delivered' ORDER BY created_at`).all();
}

export function updateDropshipOrder(id, { status, supplier_order_ref, tracking_number, notes }) {
  const row = db.prepare(`SELECT * FROM dropship_orders WHERE id = ?`).get(id);
  if (!row) throw new Error(`No dropship order found with id ${id}`);

  db.prepare(`
    UPDATE dropship_orders
    SET status = @status,
        supplier_order_ref = @supplier_order_ref,
        tracking_number = @tracking_number,
        notes = @notes,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id,
    status: status ?? row.status,
    supplier_order_ref: supplier_order_ref ?? row.supplier_order_ref,
    tracking_number: tracking_number ?? row.tracking_number,
    notes: notes ?? row.notes,
  });
}

export function getRunStats({ sinceDays = 7 } = {}) {
  const since = `-${sinceDays} days`;
  const totals = db
    .prepare(`SELECT status, COUNT(*) AS n FROM runs WHERE started_at >= datetime('now', ?) GROUP BY status`)
    .all(since);
  const recentErrors = db
    .prepare(
      `SELECT started_at, module, detail FROM runs
       WHERE status = 'error' AND started_at >= datetime('now', ?)
       ORDER BY started_at DESC LIMIT 25`
    )
    .all(since);
  return {
    ok: totals.find((t) => t.status === 'ok')?.n ?? 0,
    error: totals.find((t) => t.status === 'error')?.n ?? 0,
    recentErrors,
  };
}

export function getResearchStats() {
  const byVerdict = db.prepare(`SELECT verdict, COUNT(*) AS n FROM research GROUP BY verdict`).all();
  const scored = db.prepare(`SELECT COUNT(*) AS n FROM research WHERE actually_bought IS NOT NULL`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM research`).get().n;
  return { total, byVerdict, scored };
}

export function getListingStats() {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM listings`).get().n;
  const flagged = db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE flags != '[]' AND flags IS NOT NULL`).get().n;
  return { total, flagged };
}

export function getOfferStats() {
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM ebay_offers GROUP BY status`).all();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ebay_offers`).get().n;
  return { total, byStatus };
}

export function getMessageStats() {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
  const flagged = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE flags != '[]' AND flags IS NOT NULL`).get().n;
  return { total, flagged };
}

// Running `node src/lib/db.js` creates the tables.
if (import.meta.url === `file://${process.argv[1]}`) {
  init();
  console.log('Database ready at', DB_PATH);
}
