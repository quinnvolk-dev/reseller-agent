import { init, saveDropshipOrder, listDropshipOrders, updateDropshipOrder } from './lib/db.js';
import { analyze } from './modules/sourcing.js';
import { analyze as analyzeWholesale } from './modules/wholesaleSourcing.js';
import { generate } from './modules/listing.js';
import { createDraft } from './modules/publish.js';
import { draftReply } from './modules/messaging.js';
import { logSale, summary } from './modules/books.js';
import { build as buildDashboard } from './modules/dashboard.js';
import { start as startDashboardServer } from './modules/dashboardServer.js';
import { consentUrl, exchangeCode, getBusinessPolicies, getMerchantLocations, createMerchantLocation } from './lib/ebay.js';

init();

const [, , command, ...rest] = process.argv;

function flag(name, fallback = null) {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
}

function money(n) {
  return n == null ? 'n/a' : '$' + Number(n).toFixed(2);
}

try {
if (command === 'migrate') {
  // init() above already applied anything pending; this just reports where things stand.
  const { db } = await import('./lib/db.js');
  const rows = db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
  console.log('\n  Database is up to date. Applied migrations:');
  rows.forEach((r) => console.log(`    ${r.id}  (${r.applied_at})`));
  console.log();
} else if (command === 'source') {
  const query = flag('q');
  const unitCost = parseFloat(flag('cost'));
  const qty = parseInt(flag('qty', '1'), 10);
  const sold90d = flag('sold') ? parseInt(flag('sold'), 10) : null;
  const soldAvg = flag('soldavg') ? parseFloat(flag('soldavg')) : null;

  if (!query || !Number.isFinite(unitCost)) {
    console.error(
      'Usage: npm run source -- --q "product name" --cost 12.50 --qty 50 [--sold 340] [--soldavg 34.99]'
    );
    process.exit(1);
  }

  const r = await analyze({ query, unitCost, qty, sold90d, soldAvg });

  console.log(`\n  ${query}`);
  console.log(`  ${'-'.repeat(query.length)}\n`);
  console.log(`  VERDICT      ${r.verdict}  (${r.confidence} confidence)`);
  console.log(`  Capital      ${money(r.landed)} for ${qty} units`);
  console.log(`  Active       ${r.active.totalMatches} listings, median ${money(r.active.median)}`);
  console.log(`  Sell-through ${r.sellThrough != null ? (r.sellThrough * 100).toFixed(1) + '%' : 'unknown (no sold data)'}`);
  console.log(`  List at      ${money(r.suggested_list_price)}`);
  console.log(`  Net/unit     ${money(r.est_net_per_unit)}  (${r.est_margin_pct ?? '?'}% margin)`);
  console.log(`  Clear time   ${r.weeks_to_clear ?? '?'} weeks\n`);
  console.log(`  ${r.reasoning}\n`);

  if (r.risks?.length) {
    console.log('  Risks:');
    r.risks.forEach((x) => console.log(`    - ${x}`));
    console.log();
  }
  if (r.missing_data?.length) {
    console.log('  Would firm this up:');
    r.missing_data.forEach((x) => console.log(`    - ${x}`));
    console.log();
  }
} else if (command === 'source-wholesale') {
  const query = flag('q');
  const wholesaleCost = parseFloat(flag('wcost'));
  const supplierHandlingDays = flag('handling') ? parseInt(flag('handling'), 10) : null;
  const sold90d = flag('sold') ? parseInt(flag('sold'), 10) : null;
  const soldAvg = flag('soldavg') ? parseFloat(flag('soldavg')) : null;

  if (!query || !Number.isFinite(wholesaleCost)) {
    console.error(
      'Usage: npm run source-wholesale -- --q "product name" --wcost 8.50 [--handling 3] [--sold 340] [--soldavg 34.99]'
    );
    process.exit(1);
  }

  const r = await analyzeWholesale({ query, wholesaleCost, supplierHandlingDays, sold90d, soldAvg });

  console.log(`\n  ${query}`);
  console.log(`  ${'-'.repeat(query.length)}\n`);
  console.log(`  VERDICT      ${r.verdict}  (${r.confidence} confidence)`);
  console.log(`  Active       ${r.active.totalMatches} listings, median ${money(r.active.median)}`);
  console.log(`  Sell-through ${r.sellThrough != null ? (r.sellThrough * 100).toFixed(1) + '%' : 'unknown (no sold data)'}`);
  console.log(`  List at      ${money(r.suggested_list_price)}`);
  console.log(`  Net/unit     ${money(r.est_net_per_unit)}  (${r.est_margin_pct ?? '?'}% margin)\n`);
  console.log(`  ${r.reasoning}\n`);

  if (r.risks?.length) {
    console.log('  Risks:');
    r.risks.forEach((x) => console.log(`    - ${x}`));
    console.log();
  }
  if (r.missing_data?.length) {
    console.log('  Would firm this up:');
    r.missing_data.forEach((x) => console.log(`    - ${x}`));
    console.log();
  }
} else if (command === 'order-add') {
  const item = flag('item');
  const wholesaleCost = flag('wcost') ? parseFloat(flag('wcost')) : null;
  const salePrice = flag('price') ? parseFloat(flag('price')) : null;
  const supplier = flag('supplier');
  const buyerName = flag('buyer');
  const buyerAddress = flag('address');
  const ebayOrderId = flag('order-id');
  const notes = flag('notes');

  if (!item) {
    console.error(
      'Usage: npm run order-add -- --item "..." [--wcost 8.50] [--price 24.99] [--supplier "..."] [--buyer "..."] [--address "..."] [--order-id "..."] [--notes "..."]'
    );
    process.exit(1);
  }

  const id = saveDropshipOrder({
    ebay_order_id: ebayOrderId,
    item,
    buyer_name: buyerName,
    buyer_address: buyerAddress,
    supplier,
    wholesale_cost: wholesaleCost,
    sale_price: salePrice,
    notes,
  });

  console.log(`\n  Logged order #${id}: ${item} (needs_ordering)\n`);
} else if (command === 'orders') {
  const status = flag('status');
  const orders = listDropshipOrders(status ? { status } : {});

  if (!orders.length) {
    console.log('\n  No pending dropship orders.\n');
  } else {
    console.log();
    orders.forEach((o) => {
      console.log(`  #${o.id}  [${o.status}]  ${o.item}`);
      if (o.supplier) console.log(`       supplier: ${o.supplier}`);
      if (o.buyer_name || o.buyer_address) console.log(`       ship to: ${o.buyer_name ?? ''} ${o.buyer_address ?? ''}`);
      if (o.wholesale_cost != null || o.sale_price != null) {
        console.log(`       cost ${money(o.wholesale_cost)} -> sold ${money(o.sale_price)}`);
      }
      if (o.tracking_number) console.log(`       tracking: ${o.tracking_number}`);
      console.log();
    });
  }
} else if (command === 'order-update') {
  const id = flag('id') ? parseInt(flag('id'), 10) : null;
  const status = flag('status');
  const supplierOrderRef = flag('supplier-ref');
  const trackingNumber = flag('tracking');
  const notes = flag('notes');

  if (!id) {
    console.error(
      'Usage: npm run order-update -- --id N [--status ordered|shipped|delivered|issue] [--supplier-ref "..."] [--tracking "..."] [--notes "..."]'
    );
    process.exit(1);
  }

  updateDropshipOrder(id, { status, supplier_order_ref: supplierOrderRef, tracking_number: trackingNumber, notes });
  console.log(`\n  Order #${id} updated.\n`);
} else if (command === 'list') {
  const query = flag('q');
  const photos = flag('photos')?.split(',').map((p) => p.trim()).filter(Boolean);
  const unitCost = flag('cost') ? parseFloat(flag('cost')) : null;
  const condition = flag('condition');
  const notes = flag('notes');

  if (!query || !photos?.length) {
    console.error(
      'Usage: npm run list -- --photos "img1.jpg,img2.jpg" --q "product name" [--cost 12.50] [--condition "used"] [--notes "size L"]'
    );
    process.exit(1);
  }

  const r = await generate({ photos, query, unitCost, condition, notes });

  console.log(`\n  ${r.title}`);
  console.log(`  ${'-'.repeat(r.title.length)}\n`);
  console.log(`  ${r.description}\n`);
  console.log(`  Condition    ${r.condition_assessment}`);
  console.log(`  Price        ${money(r.suggested_price)}  (${r.confidence} confidence)`);
  console.log(`  Comps        ${r.active.totalMatches} listings, median ${money(r.active.median)}`);
  console.log(`  Tags         ${(r.tags ?? []).join(', ')}\n`);

  if (r.flags?.length) {
    console.log('  Flags:');
    r.flags.forEach((x) => console.log(`    - ${x}`));
    console.log();
  }
} else if (command === 'ebay-auth') {
  const code = flag('code');

  if (!code) {
    const url = consentUrl();
    console.log('\n  Visit this URL, log in, and approve access:\n');
    console.log(`  ${url}\n`);
    console.log(
      '  You will land on your redirect URL with ?code=... in the address bar. It works\n' +
        "  even if that page doesn't load — copy the code (URL-decode it: %2F -> /, etc.) and run:\n"
    );
    console.log('  npm run ebay-auth -- --code "PASTE_THE_CODE_HERE"\n');
  } else {
    const decoded = decodeURIComponent(code);
    const tokens = await exchangeCode(decoded);
    console.log('\n  Success. Add this to your .env:\n');
    console.log(`  EBAY_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  }
} else if (command === 'ebay-policies') {
  const [policies, locations] = await Promise.all([getBusinessPolicies(), getMerchantLocations()]);

  console.log('\n  Payment policies:');
  policies.payment.forEach((p) => console.log(`    ${p.paymentPolicyId}  ${p.name}`));
  console.log('\n  Return policies:');
  policies.return.forEach((p) => console.log(`    ${p.returnPolicyId}  ${p.name}`));
  console.log('\n  Fulfillment policies:');
  policies.fulfillment.forEach((p) => console.log(`    ${p.fulfillmentPolicyId}  ${p.name}`));
  console.log('\n  Merchant locations:');
  locations.forEach((l) => console.log(`    ${l.merchantLocationKey}  ${l.name ?? ''}`));

  if (!policies.payment.length || !policies.return.length || !policies.fulfillment.length) {
    console.log(
      '\n  Missing policies means Business Policies are not opted in yet for this account.\n' +
        '  Seller Hub -> Account -> Business Policies (or the sandbox equivalent) to create them.'
    );
  }
  if (!locations.length) {
    console.log(
      '\n  No merchant location found. Create one with the Inventory Location API, or in\n' +
        '  Seller Hub -> Shipping preferences, before running publish.'
    );
  }
  console.log('\n  Copy the IDs you want into .env as EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID,\n  EBAY_FULFILLMENT_POLICY_ID, EBAY_MERCHANT_LOCATION_KEY.\n');
} else if (command === 'ebay-location') {
  const key = flag('key', 'primary');
  const line1 = flag('line1');
  const city = flag('city');
  const state = flag('state');
  const postalCode = flag('zip');
  const country = flag('country', 'US');

  if (!line1 || !city || !state || !postalCode) {
    console.error(
      'Usage: npm run ebay-location -- --line1 "123 Main St" --city Seattle --state WA --zip 98105 [--country US] [--key primary]'
    );
    process.exit(1);
  }

  await createMerchantLocation(key, { line1, city, state, postalCode, country });
  console.log(`\n  Location "${key}" created. Add this to your .env:\n`);
  console.log(`  EBAY_MERCHANT_LOCATION_KEY=${key}\n`);
} else if (command === 'publish') {
  const listingId = flag('listing') ? parseInt(flag('listing'), 10) : null;
  const title = flag('title');
  const description = flag('desc');
  const photos = flag('photos')?.split(',').map((p) => p.trim()).filter(Boolean);
  const price = flag('price') ? parseFloat(flag('price')) : null;
  const qty = flag('qty') ? parseInt(flag('qty'), 10) : null;
  const condition = flag('condition');
  const categoryId = flag('category');
  const sku = flag('sku');

  if ((!listingId && !title) || !photos?.length || !price || !qty || !condition) {
    console.error(
      'Usage: npm run publish -- --listing <id> --photos "https://.../1.jpg,..." --price 45 --qty 3 --condition USED_EXCELLENT [--category 12345] [--sku my-sku]\n' +
        '   or: npm run publish -- --title "..." --desc "..." --photos "..." --price 45 --qty 3 --condition NEW\n' +
        'photos must be public URLs, not local file paths. This creates a DRAFT offer only — it does not go live.'
    );
    process.exit(1);
  }

  const r = await createDraft({ listingId, title, description, photos, price, qty, condition, categoryId, sku });

  console.log(`\n  Draft created (not published)`);
  console.log(`  SKU        ${r.sku}`);
  console.log(`  Offer ID   ${r.offerId}`);
  console.log(`  Category   ${r.categoryId}  (${r.categorySource})`);
  if (r.warnings.length) {
    console.log('  Warnings from eBay:');
    r.warnings.forEach((w) => console.log(`    - ${w.message ?? JSON.stringify(w)}`));
  }
  console.log('\n  Review it in Seller Hub -> Listings -> Drafts before publishing it yourself.\n');
} else if (command === 'reply') {
  const buyerMessage = flag('message');
  const listingId = flag('listing') ? parseInt(flag('listing'), 10) : null;
  const situation = flag('situation');

  if (!buyerMessage) {
    console.error(
      'Usage: npm run reply -- --message "buyer\'s message text" [--listing <id>] [--situation "order shipped 8/3, tracking 1Z..."]'
    );
    process.exit(1);
  }

  const r = await draftReply({ buyerMessage, listingId, situation });

  console.log(`\n  Draft reply  (${r.confidence} confidence, tone: ${r.tone})\n`);
  console.log(`  ${r.draft_reply}\n`);

  if (r.flags?.length) {
    console.log('  Flags — check before sending:');
    r.flags.forEach((x) => console.log(`    - ${x}`));
    console.log();
  }
  console.log('  This is a draft only — copy it into eBay/Depop yourself once you\'re happy with it.\n');
} else if (command === 'sale-add') {
  const listingId = flag('listing') ? parseInt(flag('listing'), 10) : null;
  const item = flag('item');
  const platform = flag('platform', 'ebay');
  const salePrice = flag('price') ? parseFloat(flag('price')) : null;
  const shippingCharged = flag('shipping-charged') ? parseFloat(flag('shipping-charged')) : 0;
  const costBasis = flag('cost') ? parseFloat(flag('cost')) : null;
  const platformFees = flag('fees') ? parseFloat(flag('fees')) : null;
  const feePct = flag('fee-pct') ? parseFloat(flag('fee-pct')) : undefined;
  const shippingCost = flag('shipping') ? parseFloat(flag('shipping')) : 0;
  const otherCosts = flag('other') ? parseFloat(flag('other')) : 0;
  const soldAt = flag('sold-at');
  const notes = flag('notes');

  if ((!item && !listingId) || !Number.isFinite(salePrice) || !Number.isFinite(costBasis)) {
    console.error(
      'Usage: npm run sale-add -- (--item "..." | --listing <id>) --price N --cost N\n' +
        '  [--fees N | --fee-pct N]  (omit both to use the default 13.25% + $0.30 estimate)\n' +
        '  [--shipping-charged N] [--shipping N] [--other N] [--platform ebay] [--sold-at "2026-08-05"] [--notes "..."]'
    );
    process.exit(1);
  }

  const r = logSale({
    item, listingId, platform, salePrice, shippingCharged, costBasis,
    platformFees, feePct, shippingCost, otherCosts, soldAt, notes,
  });

  console.log(`\n  Logged sale #${r.id}: ${r.item}`);
  console.log(`  Fees        ${money(r.fees)}${r.feesEstimated ? '  (estimated — replace with the real payout figure when it lands)' : ''}`);
  console.log(`  Net profit  ${money(r.netProfit)}  (${r.marginPct ?? '?'}% margin)\n`);
} else if (command === 'books') {
  const since = flag('since');
  const platform = flag('platform');
  const s = summary({ since, platform });

  console.log(`\n  Books${since ? ` since ${since}` : ''}${platform ? ` (${platform})` : ''}\n`);
  if (!s.count) {
    console.log('  No sales logged yet. Use npm run sale-add as things sell.\n');
  } else {
    console.log(`  Sales        ${s.count}`);
    console.log(`  Revenue      ${money(s.revenue)}`);
    console.log(`  Cost basis   ${money(s.costBasis)}`);
    console.log(`  Platform fees ${money(s.fees)}${s.estimatedFeeCount ? `  (${s.estimatedFeeCount} estimated)` : ''}`);
    console.log(`  Shipping     ${money(s.shippingCost)}`);
    console.log(`  Other costs  ${money(s.otherCosts)}`);
    console.log(`  Net profit   ${money(s.netProfit)}  (${s.avgMarginPct ?? '?'}% avg margin)\n`);
  }
} else if (command === 'dashboard') {
  const sinceDays = flag('days') ? parseInt(flag('days'), 10) : 7;

  if (rest.includes('--text')) {
    const d = buildDashboard({ sinceDays });

    console.log(`\n  Dashboard  (error window: last ${sinceDays}d)\n`);

    console.log(`  Runs         ${d.runs.ok} ok, ${d.runs.error} error`);
    if (d.runs.recentErrors.length) {
      console.log('  Recent errors:');
      d.runs.recentErrors.forEach((e) => console.log(`    - [${e.module}] ${e.detail ?? ''}  (${e.started_at})`));
    }
    console.log();

    console.log(`  Research     ${d.research.total} runs, ${d.research.scored} scored (actually_bought filled in)`);
    d.research.byVerdict.forEach((v) => console.log(`    ${v.verdict ?? 'unknown'}: ${v.n}`));
    console.log();

    console.log(`  Listings     ${d.listings.total} generated, ${d.listings.flagged} flagged`);
    console.log(`  eBay offers  ${d.offers.total} total`);
    d.offers.byStatus.forEach((s) => console.log(`    ${s.status}: ${s.n}`));
    console.log(`  Messages     ${d.messages.total} drafted, ${d.messages.flagged} flagged for review`);
    console.log();

    console.log('  Books (all-time)');
    if (!d.books.count) {
      console.log('    No sales logged yet — npm run sale-add as things sell.');
    } else {
      console.log(
        `    ${d.books.count} sales, ${money(d.books.revenue)} revenue, ${money(d.books.netProfit)} net profit ` +
          `(${d.books.avgMarginPct}% avg margin)`
      );
      if (d.books.estimatedFeeCount) console.log(`    ${d.books.estimatedFeeCount} sale(s) still on estimated fees`);
    }
    console.log();

    if (d.pendingDropship.length) {
      console.log(`  Dropship orders needing action: ${d.pendingDropship.length}`);
      d.pendingDropship.forEach((o) => console.log(`    #${o.id}  ${o.item}`));
      console.log();
    }
  } else {
    const port = flag('port') ? parseInt(flag('port'), 10) : 4173;
    startDashboardServer({ port, sinceDays });
  }
} else {
  console.log(
    'Commands:\n' +
      '  npm run source -- --q "..." --cost N --qty N [--sold N] [--soldavg N]\n' +
      '  npm run source-wholesale -- --q "..." --wcost N [--handling N] [--sold N] [--soldavg N]\n' +
      '  npm run list -- --photos "img1.jpg,img2.jpg" --q "..." [--cost N] [--condition "..."] [--notes "..."]\n' +
      '  npm run ebay-auth [-- --code "..."]        one-time eBay account authorization\n' +
      '  npm run ebay-policies                       look up policy IDs and merchant location\n' +
      '  npm run ebay-location -- --line1 "..." --city ... --state .. --zip ...   create a ship-from location\n' +
      '  npm run publish -- --listing <id> --photos "https://..." --price N --qty N --condition ENUM\n' +
      '  npm run reply -- --message "..." [--listing <id>] [--situation "..."]\n' +
      '  npm run sale-add -- (--item "..." | --listing <id>) --price N --cost N [--fees N] [--shipping N]\n' +
      '  npm run books [-- --since "2026-01-01"] [--platform ebay]\n' +
      '  npm run dashboard [-- --port 4173] [--days 7]   opens a local web dashboard (add --text for the CLI report)\n' +
      '  npm run order-add -- --item "..." [--wcost N] [--price N] [--supplier "..."] [--buyer "..."] [--address "..."]\n' +
      '  npm run orders [-- --status needs_ordering|ordered|shipped|delivered|issue]\n' +
      '  npm run order-update -- --id N [--status ...] [--supplier-ref "..."] [--tracking "..."]'
  );
}
} catch (err) {
  console.error(`\n  Error: ${err.message}\n`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
