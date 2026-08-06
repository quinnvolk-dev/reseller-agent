import {
  MARKETPLACE,
  upsertInventoryItem,
  createOffer,
  suggestCategory,
} from '../lib/ebay.js';
import { getListing, saveOffer, logRun } from '../lib/db.js';

const VALID_CONDITIONS = [
  'NEW', 'LIKE_NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS',
  'CERTIFIED_REFURBISHED', 'EXCELLENT_REFURBISHED', 'VERY_GOOD_REFURBISHED', 'GOOD_REFURBISHED',
  'SELLER_REFURBISHED', 'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
];

const CURRENCY_BY_MARKETPLACE = {
  EBAY_US: 'USD', EBAY_GB: 'GBP', EBAY_DE: 'EUR', EBAY_AU: 'AUD', EBAY_CA: 'CAD',
};

const REQUIRED_ENV = [
  'EBAY_FULFILLMENT_POLICY_ID',
  'EBAY_PAYMENT_POLICY_ID',
  'EBAY_RETURN_POLICY_ID',
  'EBAY_MERCHANT_LOCATION_KEY',
];

function slugSku(query) {
  const base = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Creates a DRAFT offer on eBay: an inventory item + an unpublished offer. Nothing here
 * ever goes live — createOffer() leaves the offer UNPUBLISHED by default, and this module
 * never calls publishOffer(). Review the draft in Seller Hub before publishing it yourself.
 */
export async function createDraft({
  listingId, title, description, photos, price, qty, condition, categoryId, sku,
}) {
  const started = Date.now();

  try {
    const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missingEnv.length) {
      throw new Error(
        `Missing from .env: ${missingEnv.join(', ')}. Run "npm run ebay-policies" to look up ` +
          'your business policy IDs and merchant location key first.'
      );
    }

    let listing = null;
    if (listingId != null) {
      listing = getListing(listingId);
      if (!listing) throw new Error(`No listing found with id ${listingId}`);
    }

    const finalTitle = title ?? listing?.title;
    const finalDescription = description ?? listing?.description;
    const finalCondition = (condition ?? '').toUpperCase();

    if (!finalTitle || !finalDescription) {
      throw new Error('title/description are required (pass --listing <id> or --title/--desc directly).');
    }
    if (!photos?.length) {
      throw new Error(
        'photos must be public image URLs (the eBay Inventory API cannot accept local file ' +
          'paths or the ones used to generate the listing draft — host them first).'
      );
    }
    if (!Number.isFinite(price) || price <= 0) throw new Error('--price is required and must be > 0.');
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('--qty is required and must be > 0.');
    if (!VALID_CONDITIONS.includes(finalCondition)) {
      throw new Error(`--condition must be one of: ${VALID_CONDITIONS.join(', ')}`);
    }

    let finalCategoryId = categoryId;
    let categorySource = 'provided';
    if (!finalCategoryId) {
      const suggestions = await suggestCategory(finalTitle);
      if (!suggestions.length) {
        throw new Error('No category suggestions found — pass --category <id> explicitly.');
      }
      finalCategoryId = suggestions[0].id;
      categorySource = `auto-suggested: "${suggestions[0].name}" (pass --category to override)`;
    }

    const finalSku = sku ?? `sku-${slugSku(finalTitle)}`;

    await upsertInventoryItem(finalSku, {
      condition: finalCondition,
      product: {
        title: finalTitle.slice(0, 80),
        description: finalDescription,
        imageUrls: photos,
      },
      availability: {
        shipToLocationAvailability: { quantity: qty },
      },
    });

    const currency = CURRENCY_BY_MARKETPLACE[MARKETPLACE] ?? process.env.EBAY_CURRENCY ?? 'USD';

    const offerResult = await createOffer({
      sku: finalSku,
      marketplaceId: MARKETPLACE,
      format: 'FIXED_PRICE',
      availableQuantity: qty,
      categoryId: finalCategoryId,
      listingDescription: `<p>${finalDescription.replace(/\n+/g, '</p><p>')}</p>`,
      listingPolicies: {
        fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
        paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
        returnPolicyId: process.env.EBAY_RETURN_POLICY_ID,
      },
      pricingSummary: { price: { value: String(price), currency } },
      merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY,
    });

    saveOffer({
      listing_id: listingId ?? null,
      sku: finalSku,
      offer_id: offerResult.offerId,
      category_id: finalCategoryId,
      price,
      qty,
      status: 'draft',
      detail: offerResult.warnings?.length ? JSON.stringify(offerResult.warnings) : null,
    });

    logRun({
      module: 'publish',
      status: 'ok',
      detail: `${finalTitle} -> draft offer ${offerResult.offerId}`,
      durationMs: Date.now() - started,
    });

    return { sku: finalSku, offerId: offerResult.offerId, categoryId: finalCategoryId, categorySource, warnings: offerResult.warnings ?? [] };
  } catch (err) {
    logRun({ module: 'publish', status: 'error', detail: err.message, durationMs: Date.now() - started });
    throw err;
  }
}
