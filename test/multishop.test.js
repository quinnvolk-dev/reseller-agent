import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './support/tempdb.js';

// Fresh throwaway DB. eBay is never called: every eBay function is injected as a fake below.
useTempDb();
process.env.EBAY_ENV = 'sandbox';

const { db, init, saveListing, saveOffer } = await import('../src/lib/db.js');
init();
const { createShop, getShop, assertCanList, getPayouts } = await import('../src/modules/shops.js');
const { recordListing, recordSale, delistQueue, markDelisted, getPlatformListings } = await import('../src/modules/inventory.js');
const { goLive } = await import('../src/modules/publish.js');
const { logSale, summary } = await import('../src/modules/books.js');
const { toCents } = await import('../src/lib/money.js');

const fakeEbay = () => {
  const calls = [];
  return { calls, withdrawEbayOffer: async (id) => { calls.push(id); } };
};

const shopId = createShop({
  name: 'Fremont Vintage',
  contactName: 'Pat',
  allowedPlatforms: ['ebay'],
  priceFloorCents: 2000,
  mySplitPct: 25,
});

test('createShop stores settings and defaults', () => {
  const s = getShop(shopId);
  assert.deepEqual(s.allowed_platforms, ['ebay']);
  assert.equal(s.price_floor_cents, 2000);
  assert.equal(s.my_split_pct, 25);
  assert.equal(s.account_mode, 'mine');
  assert.equal(s.ebay_connected, 0);

  const d = getShop(createShop({ name: 'Defaults' }));
  assert.deepEqual(d.allowed_platforms, ['ebay']);
  assert.equal(d.my_split_pct, 25);
});

test('createShop rejects bad input', () => {
  assert.throws(() => createShop({ name: '' }), /name is required/);
  assert.throws(() => createShop({ name: 'x', allowedPlatforms: ['myspace'] }), /Unknown platform/);
  assert.throws(() => createShop({ name: 'x', mySplitPct: 120 }), /between 0 and 100/);
  assert.throws(() => createShop({ name: 'x', accountMode: 'both' }), /Account mode/);
});

test('items default to shop 1 and can be created for another shop', () => {
  const a = saveListing({ query: 'a', photos: null, title: 'A', description: null, tags: null, condition_assessment: null, suggested_price: null, confidence: null, flags: null });
  const b = saveListing({ shop_id: shopId, query: 'b', photos: null, title: 'B', description: null, tags: null, condition_assessment: null, suggested_price: null, confidence: null, flags: null });
  assert.equal(db.prepare('SELECT shop_id FROM listings WHERE id = ?').get(a).shop_id, 1);
  assert.equal(db.prepare('SELECT shop_id FROM listings WHERE id = ?').get(b).shop_id, shopId);
  assert.throws(() => saveListing({ shop_id: 999, query: 'c', photos: null, title: 'C', description: null, tags: null, condition_assessment: null, suggested_price: null, confidence: null, flags: null }), /FOREIGN KEY/);
});

function newItem(shop = shopId, title = 'Item') {
  return saveListing({ shop_id: shop, status: 'review', query: title, photos: null, title, description: null, tags: null, condition_assessment: null, suggested_price: null, confidence: null, flags: null });
}

test('listing respects allowed platforms and price floor', () => {
  const item = newItem();
  assert.throws(() => recordListing({ itemId: item, platform: 'depop', priceCents: 5000 }), /does not allow listing on depop/);
  assert.throws(() => recordListing({ itemId: item, platform: 'ebay', priceCents: 1999 }), /below .* price floor of \$20\.00/);
  assert.throws(() => recordListing({ itemId: item, platform: 'ebay' }), /price is required/);
  assert.equal(db.prepare('SELECT status FROM listings WHERE id = ?').get(item).status, 'review');

  const row = recordListing({ itemId: item, platform: 'ebay', externalId: '1100', url: 'https://sandbox.ebay.com/itm/1100', priceCents: 2000 });
  assert.equal(row.status, 'active');
  assert.equal(row.external_id, '1100');
  assert.equal(db.prepare('SELECT status FROM listings WHERE id = ?').get(item).status, 'listed');
});

test("shops with account_mode 'theirs' can't list on eBay through your account", () => {
  const theirs = getShop(createShop({ name: 'Own account', accountMode: 'theirs' }));
  assert.throws(() => assertCanList(theirs, 'ebay', 5000), /per-shop eBay accounts are not supported/);
});

test('goLive publishes the draft offer and records the eBay listing', async () => {
  const item = newItem();
  saveOffer({ listing_id: item, sku: 'sku-1', offer_id: 'OFFER-1', category_id: '1', price: 45, qty: 1, status: 'draft', detail: null });
  const published = [];
  const row = await goLive({ itemId: item }, { publish: async (id) => { published.push(id); return { listingId: '2200' }; } });

  assert.deepEqual(published, ['OFFER-1']);
  assert.equal(row.external_id, '2200');
  assert.equal(row.url, 'https://sandbox.ebay.com/itm/2200');
  assert.equal(row.offer_id, 'OFFER-1');
  assert.equal(db.prepare('SELECT status FROM ebay_offers WHERE offer_id = ?').get('OFFER-1').status, 'published');
  assert.equal(db.prepare('SELECT status FROM listings WHERE id = ?').get(item).status, 'listed');
});

test('goLive refuses a draft priced under the shop floor without calling eBay', async () => {
  const item = newItem();
  saveOffer({ listing_id: item, sku: 'sku-2', offer_id: 'OFFER-2', category_id: '1', price: 10, qty: 1, status: 'draft', detail: null });
  let called = false;
  await assert.rejects(goLive({ itemId: item }, { publish: async () => { called = true; } }), /below .* price floor/);
  assert.equal(called, false);
});

test('recordSale on Depop ends the eBay listing via API', async () => {
  const shop1Item = newItem(1, 'Jacket');
  recordListing({ itemId: shop1Item, platform: 'ebay', externalId: '3300', offerId: 'OFFER-3', priceCents: 6000 });
  recordListing({ itemId: shop1Item, platform: 'depop', url: 'https://depop.com/products/x', priceCents: 6000 });

  const ebay = fakeEbay();
  const r = await recordSale({ itemId: shop1Item, platform: 'depop', salePriceCents: 5500, feesCents: 550, soldAt: '2026-11-03' }, ebay);

  assert.deepEqual(ebay.calls, ['OFFER-3']);
  assert.equal(r.ended.length, 1);
  assert.equal(r.manual.length, 0);
  const byPlatform = Object.fromEntries(getPlatformListings(shop1Item).map((l) => [l.platform, l.status]));
  assert.deepEqual(byPlatform, { depop: 'sold', ebay: 'ended' });
  assert.equal(db.prepare('SELECT status FROM listings WHERE id = ?').get(shop1Item).status, 'sold');
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(r.saleId);
  assert.equal(sale.sale_price_cents, 5500);
  assert.equal(sale.fees_cents, 550);
  assert.equal(sale.sale_price, 55);
});

test('recordSale on eBay flags Depop for manual delist, and a second sale is refused', async () => {
  const item = newItem(1, 'Boots');
  recordListing({ itemId: item, platform: 'ebay', externalId: '4400', offerId: 'OFFER-4', priceCents: 8000 });
  recordListing({ itemId: item, platform: 'depop', url: 'https://depop.com/products/y', priceCents: 8000 });

  const ebay = fakeEbay();
  const r = await recordSale({ itemId: item, platform: 'ebay', salePriceCents: 8000, feesCents: 1090, soldAt: '2026-11-04' }, ebay);
  assert.deepEqual(ebay.calls, []);
  assert.equal(r.manual.length, 1);
  assert.equal(r.manual[0].platform, 'depop');

  const queue = delistQueue();
  assert.ok(queue.some((q) => q.item_id === item && q.platform === 'depop'));
  markDelisted(item, 'depop');
  assert.ok(!delistQueue().some((q) => q.item_id === item));
  assert.equal(getPlatformListings(item).find((l) => l.platform === 'depop').status, 'ended');

  await assert.rejects(recordSale({ itemId: item, platform: 'ebay', salePriceCents: 1, feesCents: 0 }, ebay), /already sold/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales WHERE listing_id = ?').get(item).n, 1);
});

test('an eBay API failure does not lose the sale; the listing is flagged instead', async () => {
  const item = newItem(1, 'Lamp');
  recordListing({ itemId: item, platform: 'ebay', externalId: '5500', offerId: 'OFFER-5', priceCents: 3000 });
  recordListing({ itemId: item, platform: 'depop', priceCents: 3000 });
  const r = await recordSale(
    { itemId: item, platform: 'depop', salePriceCents: 3000, feesCents: 300, soldAt: '2026-11-05' },
    { withdrawEbayOffer: async () => { throw new Error('503'); } }
  );
  assert.equal(r.manual[0].platform, 'ebay');
  assert.match(r.manual[0].reason, /503/);
  assert.equal(db.prepare('SELECT status FROM listings WHERE id = ?').get(item).status, 'sold');
});

test('sale-add path (logSale with --listing) closes out the item too', async () => {
  const item = newItem(shopId, 'Pyrex');
  recordListing({ itemId: item, platform: 'ebay', externalId: '6600', offerId: 'OFFER-6', priceCents: 4000 });
  const r = await logSale(
    { listingId: item, platform: 'ebay', salePrice: 40, costBasis: 0, platformFees: 5.6, soldAt: '2026-11-02' },
    fakeEbay()
  );
  assert.equal(r.netProfit, 34.4);
  assert.equal(db.prepare('SELECT status FROM listings WHERE id = ?').get(item).status, 'sold');
  assert.equal(getPlatformListings(item)[0].status, 'sold');
});

test('standalone sale-add (no item) still works and counts toward shop 1', async () => {
  const r = await logSale({ item: 'Garage sale lot', salePrice: 12.34, costBasis: 1, platformFees: 2, soldAt: '2026-11-01' });
  const s = db.prepare('SELECT sale_price_cents, fees_cents FROM sales WHERE id = ?').get(r.id);
  assert.deepEqual(s, { sale_price_cents: 1234, fees_cents: 200 });
  assert.ok(summary().count >= 1);
});

test('shop_payouts: gross, fees, net, my cut and shop share per shop per month', async () => {
  const a = newItem(shopId, 'A');
  const b = newItem(shopId, 'B');
  await recordSale({ itemId: a, platform: 'ebay', salePriceCents: 10000, feesCents: 1333, soldAt: '2026-12-01' }, fakeEbay());
  await recordSale({ itemId: b, platform: 'ebay', salePriceCents: 5001, feesCents: 700, soldAt: '2026-12-15' }, fakeEbay());

  const [p] = getPayouts({ month: '2026-12', shopId });
  assert.equal(p.items_sold, 2);
  assert.equal(p.gross_cents, 15001);
  assert.equal(p.fees_cents, 2033);
  assert.equal(p.net_cents, 12968);
  assert.equal(p.my_cut_cents, 3242); // 12968 * 25% = 3242
  assert.equal(p.shop_share_cents, 12968 - 3242);

  const nov = getPayouts({ month: '2026-11', shopId })[0];
  assert.equal(nov.items_sold, 1); // the Pyrex
  const own = getPayouts({ month: '2026-11', shopId: 1 })[0];
  assert.equal(own.my_cut_cents, 0);
  assert.equal(own.shop_share_cents, own.net_cents);
});

test('toCents rounds float noise consistently', () => {
  assert.equal(toCents(45.99), 4599);
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents('12.5'), 1250);
});
