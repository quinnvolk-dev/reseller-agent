import { askJSON } from '../lib/claude.js';
import { getListing, saveMessage, logRun } from '../lib/db.js';

const SYSTEM = `You are drafting a reply to a buyer message for a small eBay/Depop reseller.
The seller reviews and sends every draft themselves — you are not sending anything.

Rules:
- Ground every factual claim (item condition, price, what's included, size) only in the
  LISTING INFO provided. Never invent details about the item that aren't given to you.
- Never make commitments the seller hasn't authorized: specific ship dates, refunds, price
  drops, exceptions to stated policy. If the buyer is asking for one of these, draft a reply
  that's warm but noncommittal, and put the actual decision in "flags" for the seller.
- Tone is friendly, concise, and professional — a couple of short sentences, not a form letter.
  Match the buyer's energy; don't over-apologize for routine questions.
- If the buyer's message is hostile, a complaint, or implies a return/dispute, keep the draft
  calm and factual and flag it clearly — don't try to smooth it over with promises.
- If SITUATION doesn't give you enough to answer part of the question (e.g. asked about
  tracking but no tracking info was given), say so honestly in the draft rather than guessing,
  and flag it.`;

const SCHEMA = {
  type: 'object',
  properties: {
    draft_reply: { type: 'string' },
    tone: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    flags: { type: 'array', items: { type: 'string' } },
  },
  required: ['draft_reply', 'tone', 'confidence', 'flags'],
};

export async function draftReply({ buyerMessage, listingId, situation }) {
  const started = Date.now();

  try {
    if (!buyerMessage?.trim()) throw new Error('Buyer message is required.');

    const listing = listingId ? getListing(listingId) : null;
    if (listingId && !listing) throw new Error(`No listing found with id ${listingId}`);

    const listingBlock = listing
      ? `LISTING INFO:
- Title: ${listing.title}
- Description: ${listing.description}
- Condition: ${listing.condition_assessment}
- Price: ${listing.suggested_price != null ? '$' + listing.suggested_price : 'n/a'}`
      : 'LISTING INFO: none provided — do not assume specifics about the item.';

    const prompt = `${listingBlock}

SITUATION (context you were given about this sale/order, may be incomplete): ${situation ?? 'none provided'}

BUYER MESSAGE:
"""
${buyerMessage}
"""

Return JSON with exactly these keys:
{
  "draft_reply": "the reply text, ready to send as-is or lightly edited",
  "tone": "short label, e.g. 'friendly', 'apologetic', 'firm'",
  "confidence": "high" | "medium" | "low",
  "flags": ["anything you couldn't confirm, or any decision the seller needs to make before sending"]
}`;

    const result = await askJSON(prompt, { system: SYSTEM, maxTokens: 800, schema: SCHEMA });

    saveMessage({
      listing_id: listingId ?? null,
      buyer_message: buyerMessage,
      situation: situation ?? null,
      draft_reply: result.draft_reply,
      tone: result.tone,
      confidence: result.confidence,
      flags: JSON.stringify(result.flags ?? []),
    });

    logRun({
      module: 'messaging',
      status: 'ok',
      detail: `reply drafted${listingId ? ` for listing ${listingId}` : ''}`,
      durationMs: Date.now() - started,
    });

    return result;
  } catch (err) {
    logRun({
      module: 'messaging',
      status: 'error',
      detail: err.message,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
