import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { useTempDb, LEGACY_SCHEMA } from './support/tempdb.js';

// Build a pre-multi-shop database with real-looking rows, THEN let the app open it.
const file = useTempDb();
{
  const legacy = new Database(file);
  legacy.exec(LEGACY_SCHEMA);
  legacy.exec(`
    INSERT INTO listings (id, query, title) VALUES (1, 'levis 501', 'Levis 501 32x32'), (2, 'pyrex bowl', 'Pyrex bowl');
    INSERT INTO sales (listing_id, item, sale_price, cost_basis, platform_fees, net_profit, sold_at)
      VALUES (1, 'Levis 501 32x32', 45.99, 8, 6.39, 31.6, '2026-10-12');
    INSERT INTO sales (listing_id, item, sale_price, cost_basis, platform_fees, net_profit, sold_at)
      VALUES (NULL, 'loose standalone sale', 10.10, 2, 1.64, 6.46, '2026-10-20');
  `);
  legacy.close();
}

const { db, init } = await import('../src/lib/db.js');
init();

test('existing items become shop 1 and keep their data', () => {
  const rows = db.prepare('SELECT id, title, shop_id, status FROM listings ORDER BY id').all();
  assert.deepEqual(rows, [
    { id: 1, title: 'Levis 501 32x32', shop_id: 1, status: 'sold' },
    { id: 2, title: 'Pyrex bowl', shop_id: 1, status: 'review' },
  ]);
});

test('shop 1 is seeded with the requested settings', () => {
  const s = db.prepare('SELECT * FROM shops WHERE id = 1').get();
  assert.equal(s.name, 'Quinn (own inventory)');
  assert.equal(s.my_split_pct, 0);
  assert.deepEqual(JSON.parse(s.allowed_platforms), ['ebay', 'depop']);
  assert.equal(s.account_mode, 'mine');
});

test('existing sales are backfilled to integer cents', () => {
  const rows = db.prepare('SELECT sale_price_cents, fees_cents FROM sales ORDER BY id').all();
  assert.deepEqual(rows, [
    { sale_price_cents: 4599, fees_cents: 639 },
    { sale_price_cents: 1010, fees_cents: 164 },
  ]);
});

test('shop_payouts includes legacy sales under shop 1', () => {
  const r = db.prepare("SELECT * FROM shop_payouts WHERE shop_id = 1 AND month = '2026-10'").get();
  assert.equal(r.items_sold, 2);
  assert.equal(r.gross_cents, 5609);
  assert.equal(r.fees_cents, 803);
  assert.equal(r.net_cents, 4806);
  assert.equal(r.my_cut_cents, 0);
  assert.equal(r.shop_share_cents, 4806);
});

test('a backup of the pre-migration database was written', () => {
  const backups = readdirSync(path.join(path.dirname(file), 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /before-001_multi_shop\.db$/);
  const old = new Database(path.join(path.dirname(file), 'backups', backups[0]));
  const cols = old.prepare('PRAGMA table_info(listings)').all().map((c) => c.name);
  assert.ok(!cols.includes('shop_id'), 'backup should be the untouched pre-migration schema');
  old.close();
});

test('running init again is a no-op', () => {
  init();
  const n = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.equal(n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops').get().n, 1);
});
