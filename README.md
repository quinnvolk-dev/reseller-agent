# Reseller Agent

Modular agent system for a bulk-buy reselling operation. Modules 1-6 (sourcing analysis,
listing generation, eBay auto-lister, message drafter, books, dashboard) are built.

## Setup

```bash
npm install
cp .env.example .env      # then fill in your keys
npm run init-db
```

### Getting keys

**Anthropic** — https://console.anthropic.com → API Keys. Add ~$5 of credit; each sourcing
run costs well under a cent.

**eBay** — https://developer.ebay.com → register (free) → My Keys. You get a sandbox keyset
immediately and a production keyset after accepting the API license. Start with sandbox,
switch `EBAY_ENV=production` in `.env` once it runs clean.

## Usage

```bash
npm run source -- --q "nike tech fleece hoodie black" --cost 22 --qty 40
```

With sold data from Terapeak (better — see below):

```bash
npm run source -- --q "nike tech fleece hoodie black" --cost 22 --qty 40 --sold 412 --soldavg 58
```

Once you've bought, generate a listing draft from photos (jpg/png/webp/gif):

```bash
npm run list -- --photos "photos/1.jpg,photos/2.jpg" --q "nike tech fleece hoodie black" \
  --cost 22 --condition "used - excellent" --notes "size L, tags cut but unworn"
```

The model looks at the actual photos — not just your description — so it'll flag it if what
it sees doesn't match what you typed (wrong size tag, visible damage, etc). Price is grounded
in the same live eBay comps as the sourcing step.

Once you're ready to push it to eBay as a **draft** (see setup below):

```bash
npm run publish -- --listing 3 --photos "https://your-host.com/1.jpg,https://your-host.com/2.jpg" \
  --price 45 --qty 3 --condition USED_EXCELLENT
```

`--listing` is the item id the `list` step prints (`Item #3`). This never publishes
automatically — it creates an unpublished draft offer you review in Seller Hub. To make it
live and have the app track the eBay listing, run `npm run go-live -- --item 3 --yes` (see
Multi-shop below).

## eBay auto-lister setup (Module 3)

Unlike sourcing/listing, which only read public eBay data, publishing writes to *your* eBay
account, so it needs a user-authorized token and account-specific IDs that only exist once
you've configured them. One-time setup:

1. **Register a redirect (RuName).** developer.ebay.com → your app's keys → User Tokens →
   "Get a Token from eBay via Your Application" → add a redirect URL. It doesn't need to be a
   working server — after you approve access, eBay redirects your browser there with
   `?code=...` in the address bar, and you can copy the code out even if the page 404s. Put
   the RuName value it gives you in `.env` as `EBAY_REDIRECT_URI`.
2. **Authorize once:** `npm run ebay-auth` prints a consent URL. Open it, log in (a sandbox
   test user is fine for testing), approve. Copy the `code` from the redirected URL
   (URL-decode it — `%2F` → `/` etc.), then run
   `npm run ebay-auth -- --code "PASTE_HERE"`. It prints an `EBAY_REFRESH_TOKEN` — add that to
   `.env`. It's long-lived; you only do this once per environment.
3. **Set up Business Policies** on the eBay account (Seller Hub → Account → Business Policies,
   or the sandbox equivalent) — at least one payment, return, and fulfillment policy — and a
   merchant inventory location (Seller Hub → Shipping preferences). Sandbox test accounts
   sometimes need these created manually the first time.
4. **Pull the IDs:** `npm run ebay-policies` lists your policy IDs and merchant location keys.
   Copy them into `.env` as `EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID`,
   `EBAY_FULFILLMENT_POLICY_ID`, `EBAY_MERCHANT_LOCATION_KEY`.

Also note: the Inventory API needs **publicly hosted image URLs**, not local file paths —
that's a different input than `list`'s `--photos`, which reads local files for Claude's
vision. Host the same photos somewhere (your own site, S3, etc.) before running `publish`.

None of this can be done on my end — steps 1 and 3 happen in your eBay account settings, and
step 2 needs your own eBay login in a browser.

## Drafting replies to buyer messages (Module 4)

There's no live eBay/Depop messaging API integration (that needs its own OAuth scope and
polling setup) — this reads a message you paste in and drafts a reply grounded in the actual
listing data, same "review before it goes anywhere" philosophy as `publish`:

```bash
npm run reply -- --message "Does this still have the tags?" --listing 3
```

`--listing` is optional but recommended — without it the draft can't cite anything specific
about the item (price, condition, what's included) and will say so. Add `--situation` for
anything the model wouldn't otherwise know (shipping status, tracking number, a prior
back-and-forth):

```bash
npm run reply -- --message "Any update on shipping?" --listing 3 \
  --situation "shipped 8/3 via USPS, tracking 9400111899223344556677"
```

It flags anything it couldn't confirm or that needs your judgment call (refunds, price drops,
exceptions to policy) instead of guessing or promising on your behalf. Nothing is ever sent
automatically — copy the draft into eBay/Depop yourself.

## Tracking real profit (Module 5)

Every other module estimates margin before you've sold anything. Books is the ledger of what
actually happened, once it does:

```bash
npm run sale-add -- --listing 3 --price 45 --cost 22 --shipping 6.20
```

`--cost` is the cost basis (unit/wholesale cost). If you don't pass `--fees`, it estimates
eBay's standard cut (13.25% of price+shipping-charged, plus $0.30) and marks the row as
estimated — swap in the real number from Seller Hub > Payouts once it lands, same "don't let a
guess quietly become the truth" rule as the Terapeak step. `--listing` pulls the item name from
the listing draft; pass `--item "..."` instead to log a sale standalone.

```bash
npm run books                              # everything logged
npm run books -- --since 2026-01-01        # this year only
npm run books -- --platform ebay
```

Prints total revenue, cost basis, fees, shipping, other costs, and net profit/margin across
whatever's logged, and flags how many rows are still running on estimated fees rather than
real payout numbers.

## Dashboard (Module 6)

A single-glance overview across everything logged so far. Opens a local web page (no data
leaves your machine — the page only talks to `localhost`):

```bash
npm run dashboard                       # opens http://localhost:4173 in your browser
npm run dashboard -- --port 8080        # different port
npm run dashboard -- --text             # the old plain-text CLI report instead
```

An **Overview** tab shows the headline numbers plus a card per module you can click straight
into. Each module (Sourcing, Listings, eBay, Messages, Books, Activity) gets its own tab with
just that module's stats and its own recent errors — Activity is the catch-all for full error
history and pending dropship orders. Tabs are keyboard-navigable (arrow keys) and deep-linkable
(`#books`, `#sourcing`, etc). Has a date-range selector and auto-refreshes
every 30 seconds; leave it open in a tab while you work.

## Dropshipping instead of bulk-buy

Everything above assumes you buy inventory, hold it, and ship it yourself — that's what
`source`'s capital/landed-cost math and the 2-day handling policy assume. If you're
dropshipping (supplier ships straight to the buyer, you never touch the item), use these
instead:

```bash
npm run source-wholesale -- --q "wireless earbuds case" --wcost 8.50 --handling 3
```

No bulk quantity or capital-at-risk framing — just margin on a single unit, weighted against
supplier handling time (slow suppliers are the main way dropshippers get bad feedback) and
thin-margin risk. It'll also flag if an item looks like it's sourced from retail
(Amazon/Walmart) rather than a genuine wholesale account — that pattern violates eBay's
dropshipping policy.

Track orders that still need to be placed with your supplier (there's no live eBay
order-sync yet — that needs the `sell.fulfillment` OAuth scope, which means redoing the
`ebay-auth` consent flow; log these by hand for now):

```bash
npm run order-add -- --item "..." --wcost 8.50 --price 24.99 --supplier "..." --buyer "..." --address "..."
npm run orders                                    # everything not yet delivered
npm run order-update -- --id 1 --status ordered --supplier-ref "PO-123" --tracking "1Z..."
```

## Multi-shop (listing for local shops)

The app can list inventory for other shops on consignment, alongside your own. Every item
belongs to a shop. Shop #1, "Quinn (own inventory)", is your own stock: you keep 100%, and it
can list on eBay and Depop. Everything that existed before multi-shop belongs to shop #1.

### Adding a shop

```bash
npm run shop-add -- --name "Fremont Vintage" --contact "Pat Lee" --email pat@example.com \
  --phone "206-555-0100" --platforms ebay,depop --floor 15 --split 25
npm run shops                       # list shops and their settings
```

| Setting | Flag | Default | What it does |
|---|---|---|---|
| Allowed platforms | `--platforms ebay,depop` | `ebay` | Items can only be listed on these platforms. |
| Price floor | `--floor 15` (dollars) | none | Nothing is drafted, published or recorded below this price. |
| Your split | `--split 25` (%) | 25 | Your cut of net (sale price minus platform fees). |
| Account mode | `--mode mine\|theirs` | `mine` | `mine` = listed on your eBay account. `theirs` = listed on the shop's own account. Per-shop eBay accounts aren't built yet, so eBay listing is refused for `theirs` shops. |
| eBay connected | `--ebay-connected` | off | Records that the shop has linked its eBay account. For future per-shop accounts. |

### An item's lifecycle

```bash
# 1. Intake: draft from photos, for a shop (default shop 1)
npm run list -- --shop 2 --photos "photos/1.jpg" --q "pendleton wool shirt"      # prints Item #N

# 2. eBay draft: checks the shop allows eBay and the price is above its floor
npm run publish -- --listing N --photos "https://..." --price 45 --qty 1 --condition USED_EXCELLENT

# 3. Go live: publishes the draft, saves the eBay listing ID and URL, and sets the item to 'listed'
npm run go-live -- --item N --yes

#    Listed on Depop (or on eBay through Seller Hub) by hand? Record it so a sale can end it:
npm run listing-add -- --item N --platform depop --price 45 --url "https://www.depop.com/products/..."

# 4. Sold: logs the sale and closes the item out everywhere
npm run sale-add -- --listing N --platform depop --price 45 --cost 0 --fees 4.50
```

Item statuses: `intake` → `review` (a draft exists) → `listed` → `sold`. `shipped` and
`returned` exist in the schema, but no command sets them yet.

When an item sells (`sale-add --listing N`), the app:

1. writes the sale, in integer cents for payouts and in dollars for `npm run books`,
2. sets the item to `sold` and the listing on the platform where it sold to `sold`,
3. ends the item's other active listings:
   - **eBay**: ended through the API (withdraws the offer).
   - **Depop**: Depop's API is partner-only, so the listing is flagged for you to take down by
     hand. The same happens if the eBay API call fails. The sale is recorded either way.

```bash
npm run delist-queue                                  # still live somewhere, take these down
npm run delist-done -- --item N --platform depop      # after you've removed it
```

The same item can't be sold twice: a second `sale-add` for it is refused.

### Monthly payouts

```bash
npm run payouts                                  # every shop, every month
npm run payouts -- --month 2026-11 --shop 2
```

This reads the `shop_payouts` view. For each shop and month it shows items sold, gross (item
sale price), platform fees, net (gross minus fees), your cut (net × your split) and the shop's
share (the rest). Shipping charged to the buyer isn't included in gross. Sales logged with
`--item` instead of `--listing` count toward shop #1. The split used is the shop's *current*
split, so changing a shop's split later also changes its past months in the report.

### Database

Schema changes live in `src/migrations/` and run automatically the next time any command
starts. Before a migration runs, the database is copied to `src/data/backups/`.
`npm run migrate` shows which migrations have been applied. Money in the multi-shop tables is
stored as integer cents.

Names: `listings` was already the table of items, so it stays the items table and gained
`shop_id` and `status`. Per-platform listings live in `platform_listings` (`item_id`,
`platform`, `external_id`, `url`, `offer_id`, `status`, `delist_pending`). The existing
`sales` table gained `sale_price_cents`, `fees_cents`, `shipped_at` and `paid_out_at`.
`sales.listing_id` is the item id.

### Tests

```bash
npm test
```

The tests run against a throwaway database in your temp folder and never call eBay: the eBay
functions are swapped for fakes.

## The Terapeak step

eBay's Marketplace Insights API (the only official source of sold data) is a Limited Release
that requires business-level approval and is closed to new individual developers. The Finding
API that used to serve this was decommissioned in Feb 2025.

So sold data comes from **Terapeak**, free inside eBay Seller Hub → Research. Search your
product, set the window to 90 days, and read off two numbers: units sold and average sold
price. Pass them in with `--sold` and `--soldavg`.

Takes about 20 seconds and it's the difference between a real verdict and a guess. Without it
the agent will tell you the analysis is incomplete, which is correct behavior — don't ignore it.

## Structure

```
src/
  lib/
    ebay.js              Browse API (active listings) + Sell API (inventory/offers, OAuth)
    claude.js            Anthropic client, ask() and askJSON() (text + vision)
    db.js                SQLite schema: research, listings (items), ebay_offers, messages, sales, dropship_orders, runs
    migrate.js           runs src/migrations/ in order, backing up the DB first
    money.js             dollars <-> integer cents
  migrations/
    001_multi_shop.js    shops, platform_listings, shop_payouts view; shop_id/status on items
  modules/
    shops.js             shops, allowed-platform/price-floor rules, payout queries
    inventory.js         record listings, record sales and end other listings, delist queue
    sourcing.js          Module 1 — bulk-buy
    wholesaleSourcing.js Module 1b — dropship (no bulk/capital framing)
    listing.js           Module 2
    publish.js           Module 3
    messaging.js         Module 4 — buyer message reply drafts
    books.js             Module 5 — real cost/fees/profit per sale
    dashboard.js         Module 6 — cross-module overview (data)
    dashboardServer.js   Module 6 — local web server for the dashboard
  dashboard/
    index.html           Module 6 — dashboard page (served by dashboardServer.js)
  index.js        CLI
  data/agent.db   created by init-db
  data/backups/   pre-migration copies of agent.db
test/             npm test (node:test, throwaway DB, eBay faked)
```

## Roadmap

- [x] **1. Sourcing analyzer** — buy/pass verdict before you spend money
- [x] **2. Listing generator** — photos in, title/description/tags/price out
- [x] **3. eBay auto-lister** — Sell API, draft-first (needs one-time account setup — see below)
- [x] **4. Message drafter** — buyer DMs in, replies out for approval
- [x] **5. Books** — cost basis, fees, shipping, real profit per unit
- [x] **6. Dashboard** — cross-module overview (CLI report)

Etsy is a known gap — `.env` already has `ETSY_API_KEY`/`ETSY_CLIENT_SECRET` slots, but no
Etsy module exists yet. Deliberately on hold until the eBay auto-lister has some real sales
under it.

Depop has no open listing API (theirs is partner-gated), so Depop stays copy-paste from
module 2's output. eBay is the automated channel.

## The feedback loop

The `research` table has `actually_bought` and `actual_outcome` columns that stay null until
you fill them in. Do it. After 20-30 products you can query how often the agent's BUY calls
actually sold through, and that tells you whether to trust it or retune the prompt.

```sql
SELECT verdict, COUNT(*), AVG(actually_bought) FROM research GROUP BY verdict;
```

An agent you can't score is just a vibe.
