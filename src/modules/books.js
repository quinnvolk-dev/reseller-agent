import { getListing, saveSale, listSales, logRun } from '../lib/db.js';
import { toCents, toDollars } from '../lib/money.js';
import { recordSale } from './inventory.js';

// eBay's standard final value fee is ~13.25% of (item price + shipping charged) for most
// categories, plus a flat $0.30 per order, as of the rates published at ebay.com/help/selling
// /fees-credits-invoices/store-selling-fees. This is a fallback estimate only — pull the real
// number from Seller Hub > Payouts once the payout lands, same reasoning as the Terapeak note
// in the README: a guess is fine to keep moving, but don't let it quietly become the truth.
const DEFAULT_FEE_PCT = 13.25;
const DEFAULT_FEE_FLAT = 0.3;

export function estimateFees(salePrice, shippingCharged = 0, feePct = DEFAULT_FEE_PCT) {
  return +((salePrice + shippingCharged) * (feePct / 100) + DEFAULT_FEE_FLAT).toFixed(2);
}

/**
 * Logs a sale from dollar amounts (what `npm run sale-add` takes). If it's tied to an item
 * (--listing), it goes through inventory.recordSale, which also marks the item sold and ends
 * its other listings. A standalone --item sale is just written to the books (counts as shop 1).
 */
export async function logSale({
  item,
  listingId,
  platform = 'ebay',
  salePrice,
  shippingCharged = 0,
  costBasis,
  platformFees,
  feePct,
  shippingCost = 0,
  otherCosts = 0,
  soldAt,
  notes,
}, deps = {}) {
  const started = Date.now();

  try {
    if (!Number.isFinite(salePrice)) throw new Error('Sale price is required.');
    if (!Number.isFinite(costBasis)) throw new Error('Cost basis is required.');

    const listing = listingId ? getListing(listingId) : null;
    if (listingId && !listing) throw new Error(`No listing found with id ${listingId}`);
    const resolvedItem = item ?? listing?.title;
    if (!resolvedItem) throw new Error('Item description is required (or pass --listing).');

    const feesEstimated = platformFees == null;
    const fees = feesEstimated ? estimateFees(salePrice, shippingCharged, feePct) : platformFees;

    if (listing) {
      const r = await recordSale(
        {
          itemId: listingId,
          platform,
          salePriceCents: toCents(salePrice),
          feesCents: toCents(fees),
          feesEstimated,
          shippingChargedCents: toCents(shippingCharged),
          costBasisCents: toCents(costBasis),
          shippingCostCents: toCents(shippingCost),
          otherCostsCents: toCents(otherCosts),
          soldAt: soldAt ?? null,
          notes: notes ?? null,
        },
        deps
      );
      return {
        id: r.saleId,
        item: resolvedItem,
        fees,
        feesEstimated,
        netProfit: toDollars(r.netCents),
        marginPct: r.marginPct,
        ended: r.ended,
        manual: r.manual,
      };
    }

    const revenue = salePrice + shippingCharged;
    const costs = costBasis + fees + shippingCost + otherCosts;
    const netProfit = +(revenue - costs).toFixed(2);
    const marginPct = revenue ? +((netProfit / revenue) * 100).toFixed(1) : null;

    const id = saveSale({
      sold_at: soldAt ?? null,
      listing_id: listingId ?? null,
      item: resolvedItem,
      platform,
      sale_price: salePrice,
      shipping_charged: shippingCharged,
      cost_basis: costBasis,
      platform_fees: fees,
      fees_estimated: feesEstimated ? 1 : 0,
      shipping_cost: shippingCost,
      other_costs: otherCosts,
      net_profit: netProfit,
      margin_pct: marginPct,
      notes: notes ?? null,
    });

    logRun({
      module: 'books',
      status: 'ok',
      detail: `sale #${id}: ${resolvedItem} -> net $${netProfit}`,
      durationMs: Date.now() - started,
    });

    return { id, item: resolvedItem, fees, feesEstimated, netProfit, marginPct, ended: [], manual: [] };
  } catch (err) {
    logRun({ module: 'books', status: 'error', detail: err.message, durationMs: Date.now() - started });
    throw err;
  }
}

export function summary({ since, platform } = {}) {
  const sales = listSales({ since, platform });

  const totals = sales.reduce(
    (acc, s) => {
      acc.count += 1;
      acc.revenue += s.sale_price + s.shipping_charged;
      acc.costBasis += s.cost_basis;
      acc.fees += s.platform_fees;
      acc.shippingCost += s.shipping_cost;
      acc.otherCosts += s.other_costs;
      acc.netProfit += s.net_profit;
      if (s.fees_estimated) acc.estimatedFeeCount += 1;
      return acc;
    },
    { count: 0, revenue: 0, costBasis: 0, fees: 0, shippingCost: 0, otherCosts: 0, netProfit: 0, estimatedFeeCount: 0 }
  );

  const round2 = (n) => +n.toFixed(2);
  return {
    sales,
    count: totals.count,
    revenue: round2(totals.revenue),
    costBasis: round2(totals.costBasis),
    fees: round2(totals.fees),
    shippingCost: round2(totals.shippingCost),
    otherCosts: round2(totals.otherCosts),
    netProfit: round2(totals.netProfit),
    avgMarginPct: totals.revenue ? round2((totals.netProfit / totals.revenue) * 100) : null,
    estimatedFeeCount: totals.estimatedFeeCount,
  };
}
