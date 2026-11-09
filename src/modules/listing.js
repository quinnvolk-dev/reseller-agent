import { readFileSync } from 'fs';
import { extname } from 'path';
import { searchActive } from '../lib/ebay.js';
import { askJSON } from '../lib/claude.js';
import { saveListing, logRun } from '../lib/db.js';
import { getShop } from './shops.js';

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function loadImage(filePath) {
  const mediaType = MEDIA_TYPES[extname(filePath).toLowerCase()];
  if (!mediaType) {
    throw new Error(`Unsupported image type: ${filePath} (use jpg, png, webp, or gif)`);
  }
  return { mediaType, data: readFileSync(filePath).toString('base64') };
}

const SYSTEM = `You are a listing copywriter for a small eBay/Depop reseller. You are given
photos of an actual item and must write a listing draft grounded in what you can SEE, not
what's claimed about the product.

Rules:
- Look closely at the photos for brand tags, size tags, material, visible flaws (stains,
  pilling, scuffs, missing parts), and anything that contradicts the seller's stated
  product/condition. Flag contradictions instead of ignoring them.
- Title must be eBay-safe: under 80 characters, front-load brand/item/key attributes,
  no promotional filler ("L@@K", "WOW", excessive punctuation).
- Description is factual and scannable: what it is, material/size/color, condition detail
  (specific, not just "good"), what's included, what's not.
- Tags are search keywords a buyer would actually type, not hashtags.
- Ground suggested_price in the active-listing comps provided. If photos show condition worse
  than a typical listing, price below the comp median; if better/rarer, price above.
- Never invent details you cannot see or were not given. If the photos are too unclear to
  confirm something important (size tag, authenticity marks), say so in flags rather than
  guessing.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    condition_assessment: { type: 'string' },
    suggested_price: { type: ['number', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    flags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'description', 'tags', 'condition_assessment', 'confidence', 'flags'],
};

export async function generate({ photos, query, unitCost, condition, notes, shopId = 1 }) {
  const started = Date.now();

  try {
    if (!photos?.length) throw new Error('At least one photo is required.');
    // Fail before spending an eBay search + Claude call on a typo'd shop id.
    getShop(shopId);

    const images = photos.map(loadImage);
    // condition is free text for the prompt, not an eBay condition enum — don't filter comps with it
    const active = await searchActive(query);

    const prompt = `Write a listing draft for this item from the attached photos.

CLAIMED PRODUCT: ${query}
CLAIMED CONDITION: ${condition ?? 'not specified'}
UNIT COST (for price-floor context, not for the listing text): $${unitCost ?? 'n/a'}
SELLER NOTES: ${notes ?? 'none'}

ACTIVE LISTINGS ON EBAY (live comps for this product):
- Total matching active listings: ${active.totalMatches}
- Median asking price: ${active.median != null ? '$' + active.median : 'n/a'}
- 10th percentile: ${active.p10 != null ? '$' + active.p10 : 'n/a'}
- 90th percentile: ${active.p90 != null ? '$' + active.p90 : 'n/a'}
- Range: ${active.low != null ? '$' + active.low + ' - $' + active.high : 'n/a'}

SAMPLE ACTIVE TITLES (for tone/keyword reference, not copying):
${active.titles.map((t) => '- ' + t).join('\n')}

Return JSON with exactly these keys:
{
  "title": "under 80 characters",
  "description": "2-4 short paragraphs, plain text",
  "tags": ["search keyword strings"],
  "condition_assessment": "specific, based on what the photos actually show",
  "suggested_price": number,
  "confidence": "high" | "medium" | "low",
  "flags": ["contradictions between claim and photos, or anything unclear/unverifiable"]
}`;

    const result = await askJSON(prompt, { system: SYSTEM, maxTokens: 1500, images, schema: SCHEMA });

    const itemId = saveListing({
      shop_id: shopId,
      status: 'review', // a draft exists; waiting on you to review/publish it
      query,
      photos: JSON.stringify(photos),
      title: result.title,
      description: result.description,
      tags: JSON.stringify(result.tags ?? []),
      condition_assessment: result.condition_assessment,
      suggested_price: result.suggested_price ?? null,
      confidence: result.confidence,
      flags: JSON.stringify(result.flags ?? []),
    });

    logRun({
      module: 'listing',
      status: 'ok',
      detail: `${query} -> "${result.title}"`,
      durationMs: Date.now() - started,
    });

    return { ...result, active, itemId, shopId };
  } catch (err) {
    logRun({
      module: 'listing',
      status: 'error',
      detail: err.message,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
