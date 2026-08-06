import { searchActive } from '../lib/ebay.js';
import { askJSON } from '../lib/claude.js';
import { saveResearch, logRun } from '../lib/db.js';

const SYSTEM = `You are a sourcing analyst for a dropshipper who lists items on eBay and only
orders from their wholesale supplier after a sale — they never hold inventory or risk bulk
capital. That changes what matters compared to bulk-buy resale:

- There is no bulk discount and no capital at risk, so margins are thin by nature. A margin
  under 25% over wholesale cost usually isn't worth the operational overhead and fee exposure.
- Handling time is bounded by the supplier's fulfillment speed, not the seller's. Slow or
  unreliable supplier shipping is the main way dropshippers get bad feedback and account
  strikes — factor supplier handling days into the verdict, not just price.
- Sell-through and competition matter more than usual, since thin margins mean volume is what
  makes the business work, not per-unit profit.
- If the item is realistically available from Amazon/Walmart/other retail listings rather than
  a genuine wholesale account, flag that: retail-arbitrage dropshipping violates eBay policy.

Never invent numbers that were not provided. If sold data is missing, say the analysis is
incomplete rather than guessing at demand.`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['LIST', 'PASS', 'NEED_MORE_DATA'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    suggested_list_price: { type: ['number', 'null'] },
    est_net_per_unit: { type: ['number', 'null'] },
    est_margin_pct: { type: ['number', 'null'] },
    reasoning: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    missing_data: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'reasoning', 'risks', 'missing_data'],
};

export async function analyze({ query, wholesaleCost, supplierHandlingDays, sold90d, soldAvg, condition }) {
  const started = Date.now();

  try {
    const active = await searchActive(query, { condition });

    const sellThrough =
      sold90d && active.totalMatches
        ? +(sold90d / active.totalMatches).toFixed(3)
        : null;

    const prompt = `Evaluate this potential dropship item. No bulk purchase happens — the
supplier ships it after the sale, so there's no upfront capital at risk, only margin per unit.

PRODUCT: ${query}
Wholesale cost (paid to supplier per unit, only after a sale): $${wholesaleCost}
Supplier handling time before it ships: ${supplierHandlingDays ?? 'not specified'} business days

ACTIVE LISTINGS ON EBAY (live data):
- Total matching active listings: ${active.totalMatches}
- Sample size analyzed: ${active.sampleSize}
- Median asking price: ${active.median != null ? '$' + active.median : 'n/a'}
- 10th percentile: ${active.p10 != null ? '$' + active.p10 : 'n/a'}
- 90th percentile: ${active.p90 != null ? '$' + active.p90 : 'n/a'}
- Range: ${active.low != null ? '$' + active.low + ' - $' + active.high : 'n/a'}

SOLD DATA (manually entered from Terapeak):
- Units sold in last 90 days: ${sold90d ?? 'NOT PROVIDED'}
- Average sold price: ${soldAvg != null ? '$' + soldAvg : 'NOT PROVIDED'}
- Sell-through rate: ${sellThrough != null ? (sellThrough * 100).toFixed(1) + '%' : 'cannot calculate'}

SAMPLE ACTIVE TITLES (for spotting variants/condition issues):
${active.titles.map((t) => '- ' + t).join('\n')}

Return JSON with exactly these keys:
{
  "verdict": "LIST" | "PASS" | "NEED_MORE_DATA",
  "confidence": "high" | "medium" | "low",
  "suggested_list_price": number or null,
  "est_net_per_unit": number or null,
  "est_margin_pct": number or null,
  "reasoning": "2-4 sentences, plain language, lead with the single most important factor",
  "risks": ["short risk strings, including handling-time or policy risk if relevant"],
  "missing_data": ["what would make this call more reliable"]
}`;

    const result = await askJSON(prompt, { system: SYSTEM, maxTokens: 3000, schema: SCHEMA });

    saveResearch({
      query,
      unit_cost: wholesaleCost,
      qty: 1,
      active_count: active.totalMatches,
      active_median: active.median,
      active_low: active.low,
      active_high: active.high,
      sold_90d: sold90d ?? null,
      sold_avg: soldAvg ?? null,
      sell_through: sellThrough,
      verdict: result.verdict,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });

    logRun({
      module: 'wholesale-sourcing',
      status: 'ok',
      detail: `${query} -> ${result.verdict}`,
      durationMs: Date.now() - started,
    });

    return { ...result, active, sellThrough };
  } catch (err) {
    logRun({
      module: 'wholesale-sourcing',
      status: 'error',
      detail: err.message,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
