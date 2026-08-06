import { searchActive } from '../lib/ebay.js';
import { askJSON } from '../lib/claude.js';
import { saveResearch, logRun } from '../lib/db.js';

const SYSTEM = `You are a sourcing analyst for a small reseller who buys inventory in bulk.

Your job is to protect their capital. They are a solo seller with limited cash, so a bad bulk
buy means money locked in a closet for months. Being wrong about a "buy" costs far more than
being wrong about a "pass" — when the data is thin or ambiguous, say so and lean toward PASS.

Rules of thumb for this market:
- Sell-through rate (sold in 90d / active listings) below 30% means slow-moving inventory.
- Combined eBay + payment fees run roughly 13-15%. Shipping is on top of that.
- A margin under 40% over landed cost leaves no room for returns, damage, or price drops.
- High active-listing counts with low sold counts means the market is saturated.
- If the price spread between p10 and p90 is very wide, the item likely has condition or
  authenticity variance the seller needs to understand before committing.

Never invent numbers that were not provided. If sold data is missing, say the analysis is
incomplete rather than guessing at demand.`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['BUY', 'PASS', 'NEED_MORE_DATA'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    suggested_list_price: { type: ['number', 'null'] },
    est_net_per_unit: { type: ['number', 'null'] },
    est_margin_pct: { type: ['number', 'null'] },
    weeks_to_clear: { type: ['number', 'null'] },
    reasoning: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    missing_data: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'reasoning', 'risks', 'missing_data'],
};

export async function analyze({ query, unitCost, qty, sold90d, soldAvg, condition }) {
  const started = Date.now();

  try {
    const active = await searchActive(query, { condition });

    const sellThrough =
      sold90d && active.totalMatches
        ? +(sold90d / active.totalMatches).toFixed(3)
        : null;

    const landed = unitCost * qty;

    const prompt = `Evaluate this potential bulk purchase.

PRODUCT: ${query}
Unit cost: $${unitCost}
Quantity: ${qty}
Total capital at risk: $${landed.toFixed(2)}

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
  "verdict": "BUY" | "PASS" | "NEED_MORE_DATA",
  "confidence": "high" | "medium" | "low",
  "suggested_list_price": number or null,
  "est_net_per_unit": number or null,
  "est_margin_pct": number or null,
  "weeks_to_clear": number or null,
  "reasoning": "2-4 sentences, plain language, lead with the single most important factor",
  "risks": ["short risk strings"],
  "missing_data": ["what would make this call more reliable"]
}`;

    const result = await askJSON(prompt, { system: SYSTEM, maxTokens: 1200, schema: SCHEMA });

    saveResearch({
      query,
      unit_cost: unitCost,
      qty,
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
      module: 'sourcing',
      status: 'ok',
      detail: `${query} -> ${result.verdict}`,
      durationMs: Date.now() - started,
    });

    return { ...result, active, sellThrough, landed };
  } catch (err) {
    logRun({
      module: 'sourcing',
      status: 'error',
      detail: err.message,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
