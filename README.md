# SkuBoo

![CI](https://github.com/Lt123-3/sku-boo-portfolio/actions/workflows/ci.yml/badge.svg)

An internal operations platform for a small Shopify-based e-commerce retailer — SKU management, automated
catalog data-quality monitoring, AI-assisted product content generation, and a physical packing-station
tool, all in one app.

**This is a sanitized portfolio copy.** All real credentials, the live store domain, and any customer/order
data have been stripped or replaced with placeholders (see [`.env.example`](.env.example)). It's shared to
show the engineering, not to be deployed against a live store.

## Why this exists

I was hired to do Shopify product data entry. SKU assignment at the time meant a spreadsheet of raw
numbers and checkboxes — someone had to cross-reference it by hand every time a new product went up, and
nothing caught it if a product went live with no photos, no title, or no SKU at all until a customer or a
warehouse pick ran into it.

SkuBoo replaced the spreadsheet first: creating a new product in Shopify is now one click, pulling the
next free SKU and pre-filling what it can instead of someone hunting through rows of checkboxes. From
there it grew into catching the data-quality problems the spreadsheet never could.

I'm self-taught, with no formal CS background, so I built SkuBoo as I learned — first to fix the SKU
assignment problem, then to catch data-quality issues automatically, then to save time on writing product
descriptions, then to speed up the physical packing/shipping process. It's been in daily production use
since, and I'm still actively extending it.

## Impact

*Self-reported from the team using it day to day — not pulled from any formal analytics/instrumentation,
just what changed for them:*

- Prepping a collection went from clicking through each product one at a time (~40+ seconds of page loads
  per collection) to loading the whole collection once (~10 seconds) and editing it in place — roughly a
  75-80% cut in load time.
- The team estimates SkuBoo saves them about half the time and frustration of prepping products through
  the native Shopify UI.
- Adoption was organic — people started using it and showing it to leadership on their own before it was
  ever formally rolled out.

## What it does

- **SKU assignment** — one-click new-product creation that pulls the next free SKU and pre-fills what it
  can, backed by a searchable index of every SKU number and its status (free / active / reserved /
  problem), replacing what used to be a spreadsheet of numbers and checkboxes.
- **Problem Dashboard** — automatically flags catalog issues (missing SKU, missing title, missing or too
  few product photos) across the whole catalog, with live search/sort and a full audit trail of every
  field-level change that's ever synced in.
- **AI-assisted product content** — generates product titles/descriptions using the Claude API, plus a
  scoped web-search tool for pulling comparable listings as reference, with per-call cost tracking.
- **Shipping desk** — a physical ESP32 device at the packing station talks to the app over a local
  WebSocket relay for real-time weighing and Shippo rate lookups.
- **Role-based access** — a lightweight PIN-based login (viewer / operator / admin) layered on top of
  standard Shopify OAuth, since most of the day-to-day users aren't the store's Shopify admins.

## Screenshots

*Captured on a throwaway dev store with seed/demo data — nothing here is real inventory.*

**Problem Dashboard** — catalog-wide data-quality issues, flagged and searchable:

![Problem Dashboard](docs/screenshots/problem-dashboard.png)

**SKU Generator** — one click pulls the next free SKU and starts a new product:

![SKU Generator](docs/screenshots/sku-generator.png)

**Admin Panel** — sync controls, live stats, and a full change-history audit trail:

![Admin Panel](docs/screenshots/admin-panel.png)

**Saved Packages** — shared box/envelope presets used by both the rate-check tooling and the physical
shipping-desk device:

![Saved Packages](docs/screenshots/saved-packages.png)

**AI Settings** — configurable system prompts for Claude-generated titles and descriptions:

![AI Settings](docs/screenshots/ai-settings.png)

**Prep** — PIN-gated entry point for day-to-day users who aren't Shopify admins:

![Prep login](docs/screenshots/prep-b.png)

## How the sync engine works

Shopify doesn't offer a bulk "what changed" API, so SkuBoo layers four things to stay in sync without
either hammering the API or missing updates:

```mermaid
flowchart LR
    subgraph Shopify
        W[Product webhooks]
        G[Admin GraphQL API]
    end
    subgraph SkuBoo
        C[5-min background cron]
        B[Two-pass bulk sync]
        D[detectAndWriteChanges]
        I[(SkuIndex / ProductInfo)]
        H[(SkuHistory audit log)]
        P[Problem Dashboard]
    end
    W -->|real-time| D
    C -->|catch-all sweep| D
    B -->|initial / resumable| D
    D -->|writes| I
    D -->|logs field diffs| H
    G <-.paginated, cost-throttled.-> B
    G <-.re-fetch by GID.-> W
    I --> P
```

- **Webhooks** handle real-time changes, but re-fetch the full product via GraphQL rather than trusting
  the webhook payload shape.
- **A resumable, cursor-paginated bulk sync** walks the whole catalog on first run (and can pick back up
  if interrupted), with GraphQL cost-aware throttling that backs off when Shopify's rate-limit bucket runs
  low.
- **A 5-minute background sweep** catches anything a webhook missed.
- **Order-insensitive diffing** — Shopify's array fields (inventory, collections) don't preserve order
  between calls, so a naive diff would log a "change" every time the API just returned the same data in a
  different order. SkuBoo canonicalizes both sides before comparing.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | React 18, React Router 7 (SSR), Shopify App Bridge |
| Backend | Node.js, Shopify Admin GraphQL API, custom PIN-based RBAC on top of Shopify OAuth |
| Data | Prisma ORM, SQLite |
| AI | Anthropic Claude API — structured outputs, prompt caching, scoped web search |
| Hardware | ESP32 shipping-desk device ↔ standalone WebSocket relay (`esp-server.js`) |
| Shipping | Shippo API (rates & labels) |
| Testing / CI | Vitest (~140 tests, unit + integration), GitHub Actions |
| Deployment | Docker |

## Testing

```bash
npm test        # Vitest — unit tests colocated under app/lib, app/hooks; integration tests in test/
npm run typecheck
```

CI runs both on every push via [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Coverage includes
the sync/problem-detection engine, the viewer/operator/admin authorization gate, and webhook handling.

## Status

Actively maintained — this started as a data-entry fix and keeps growing as I find more of the business
that manual process was slowing down. Current rough edges and what's next live in
[`EXECUTION_PLAN.md`](EXECUTION_PLAN.md) and [`CHANGELOG.md`](CHANGELOG.md).

## Beyond SkuBoo

The same role also covers the office's day-to-day IT, none of which is code but all of which is part of
keeping the place running:

- Set up and maintain every office computer on a shared Windows workgroup.
- Keep an endpoint spreadsheet tracking every machine and appliance essential to daily operations — the
  closest thing the business has to a hardware inventory.
- Most support requests come in by word of mouth rather than a ticketing system, so I log, document, and
  review them in my own spreadsheet instead of letting that history disappear.
- Wrote guides for new-computer setup, ordering and shipping, and printer/driver installs — written for
  the next time the problem comes up, or for whoever's here after me.
