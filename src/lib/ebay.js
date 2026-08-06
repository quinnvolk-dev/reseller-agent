import 'dotenv/config';

const ENV = process.env.EBAY_ENV === 'production' ? 'production' : 'sandbox';
const BASE = ENV === 'production'
  ? 'https://api.ebay.com'
  : 'https://api.sandbox.ebay.com';

export const MARKETPLACE = process.env.EBAY_MARKETPLACE || 'EBAY_US';

const AUTH_BASE = ENV === 'production'
  ? 'https://auth.ebay.com'
  : 'https://auth.sandbox.ebay.com';

// Scopes needed to create draft listings and read your business policies/locations.
const USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
].join(' ');

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Application token via client_credentials.
 * This scope covers the Browse API (read-only, public data). Cached until ~1 min before expiry.
 */
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  });

  if (!res.ok) {
    throw new Error(`eBay token failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Step 1 of the one-time user consent flow. EBAY_REDIRECT_URI must be a RuName
 * registered under your app's keys (developer.ebay.com -> your app -> User Tokens ->
 * "Get a Token from eBay via Your Application" -> add a redirect URL). It does not
 * need to be a live server — after you approve access in the browser, eBay redirects
 * there with ?code=... in the URL, and you can copy the code straight from the address
 * bar even if the page itself doesn't load.
 */
function requireRedirectUri() {
  if (!process.env.EBAY_REDIRECT_URI) {
    throw new Error(
      'EBAY_REDIRECT_URI is not set in .env. Register a redirect (RuName) at ' +
        "developer.ebay.com -> your app's keys -> User Tokens, then put its value in .env. " +
        'See README "eBay auto-lister setup".'
    );
  }
}

export function consentUrl() {
  requireRedirectUri();
  const params = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID,
    redirect_uri: process.env.EBAY_REDIRECT_URI,
    response_type: 'code',
    scope: USER_SCOPES,
  });
  return `${AUTH_BASE}/oauth2/authorize?${params}`;
}

/**
 * Step 2: exchange the one-time authorization code (from the consent redirect) for a
 * refresh token. The code is URL-encoded in the address bar and single-use — decode it
 * before passing it in. The refresh token is long-lived; save it as EBAY_REFRESH_TOKEN.
 */
export async function exchangeCode(code) {
  requireRedirectUri();
  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.EBAY_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    throw new Error(`eBay code exchange failed (${res.status}): ${await res.text()}`);
  }

  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

let cachedUserToken = null;
let userTokenExpiry = 0;

/**
 * User access token via refresh_token grant. Needed for anything that writes to a
 * seller's account (Inventory/Offer/Account APIs) — the app token from getToken()
 * only covers public read-only endpoints like Browse search.
 */
async function getUserToken() {
  if (cachedUserToken && Date.now() < userTokenExpiry) return cachedUserToken;

  if (!process.env.EBAY_REFRESH_TOKEN) {
    throw new Error(
      'No EBAY_REFRESH_TOKEN in .env yet. Run the one-time consent flow first: ' +
        'npm run ebay-auth'
    );
  }

  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.EBAY_REFRESH_TOKEN,
      scope: USER_SCOPES,
    }),
  });

  if (!res.ok) {
    throw new Error(`eBay user token refresh failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  cachedUserToken = data.access_token;
  userTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedUserToken;
}

async function sellApi(path, opts = {}) {
  return apiCall(path, { ...opts, token: await getUserToken() });
}

// Taxonomy lookups aren't account-specific, so they use the app token — sidesteps needing
// a broader user consent scope (and a re-consent round trip) just to read category data.
async function publicApi(path, opts = {}) {
  return apiCall(path, { ...opts, token: await getToken() });
}

async function apiCall(path, { method = 'GET', body, token }) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
      // Required by the Sell Inventory API on writes; harmless elsewhere.
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    throw new Error(`eBay ${method} ${path} failed (${res.status}): ${await res.text()}`);
  }

  // 204 No Content on some writes
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Your saved payment/return/fulfillment policies, so you can copy the IDs into .env. */
export async function getBusinessPolicies() {
  const [payment, returns, fulfillment] = await Promise.all([
    sellApi(`/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE}`),
    sellApi(`/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE}`),
    sellApi(`/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE}`),
  ]);
  return {
    payment: payment?.paymentPolicies ?? [],
    return: returns?.returnPolicies ?? [],
    fulfillment: fulfillment?.fulfillmentPolicies ?? [],
  };
}

/** Your saved inventory locations, for EBAY_MERCHANT_LOCATION_KEY. */
export async function getMerchantLocations() {
  const data = await sellApi('/sell/inventory/v1/location?limit=50');
  return data?.locations ?? [];
}

/** Creates a ship-from location — required once before offers can be published. */
export async function createMerchantLocation(key, { line1, city, state, postalCode, country = 'US', name }) {
  return sellApi(`/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: {
      location: {
        address: { addressLine1: line1, city, stateOrProvince: state, postalCode, country },
      },
      name: name ?? key,
      merchantLocationStatus: 'ENABLED',
      locationTypes: ['WAREHOUSE'],
    },
  });
}

/** Create or replace an inventory item — the product record (photos, condition, stock). */
export async function upsertInventoryItem(sku, item) {
  return sellApi(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    body: item,
  });
}

/**
 * Create an offer against an inventory item. This does NOT go live — an offer is
 * UNPUBLISHED by default until you explicitly call publishOffer(). That's the draft.
 */
export async function createOffer(offer) {
  return sellApi('/sell/inventory/v1/offer', { method: 'POST', body: offer });
}

/** Makes a draft offer a real, live listing. Not called automatically anywhere. */
export async function publishOffer(offerId) {
  return sellApi(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish/`, {
    method: 'POST',
  });
}

let cachedCategoryTreeId = null;

async function getCategoryTreeId() {
  if (cachedCategoryTreeId) return cachedCategoryTreeId;
  const data = await publicApi(
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`
  );
  cachedCategoryTreeId = data.categoryTreeId;
  return cachedCategoryTreeId;
}

/** Suggested categories for a search string — eBay requires a valid categoryId per offer. */
export async function suggestCategory(query) {
  const treeId = await getCategoryTreeId();
  const data = await publicApi(
    `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query)}`
  );
  return (data?.categorySuggestions ?? []).map((s) => ({
    id: s.category.categoryId,
    name: s.category.categoryName,
  }));
}

/**
 * Search ACTIVE listings. The Browse API does not return sold data —
 * that lives behind Marketplace Insights, which is approval-gated.
 * Pull sold numbers from Terapeak (free in Seller Hub) and paste them in.
 */
export async function searchActive(query, { limit = 100, condition } = {}) {
  const token = await getToken();

  const params = new URLSearchParams({
    q: query,
    limit: String(Math.min(limit, 200)),
  });
  if (condition) params.set('filter', `conditions:{${condition}}`);

  const res = await fetch(
    `${BASE}/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`eBay search failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const items = data.itemSummaries ?? [];

  const prices = items
    .map((i) => parseFloat(i.price?.value))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  return {
    totalMatches: data.total ?? items.length,
    sampleSize: prices.length,
    median: prices.length ? prices[Math.floor(prices.length / 2)] : null,
    low: prices[0] ?? null,
    high: prices[prices.length - 1] ?? null,
    // 10th/90th percentile — trims the junk listings at both ends
    p10: prices.length ? prices[Math.floor(prices.length * 0.1)] : null,
    p90: prices.length ? prices[Math.floor(prices.length * 0.9)] : null,
    titles: items.slice(0, 15).map((i) => i.title),
  };
}
