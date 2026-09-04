# Sku-Boo Execution Plan

Consolidated from two prior AI-written review passes, reconciled against the actual codebase on `review` as of **2026-09-04**. Written to be run as a sequence of separate AI-agent conversations ("sessions") — see **How to run this with AI agents** below before starting Session 1.

## Confirmed decisions

- **Role policy**: mutating actions require `operator` or `admin`. `viewer` is read-only everywhere.
- **Chrome extension is retired.** The ESP32 shipping-desk device talks directly to `esp-server.js`, which talks directly to Prisma/Shopify/Shippo — never through the `/ext-api/*` HTTP routes. Confirmed by reading `esp-server.js`: it imports `app/db.server.js`, `app/lib/orderLookup.server.js`, and `app/lib/shippo.server.js` directly, and its own header comment states the old hand-off "isn't needed once sku-boo calls Shippo directly."

## Verified state (2026-09-04)

Facts below were re-checked directly against the working tree before writing this plan, because the two source documents had already drifted from each other once (the second explicitly supersedes a version of itself that missed 6 Prisma models) — recommendations below are grounded in what's actually on disk today, not carried forward blind.

| Claim | Status |
|---|---|
| `app/routes/app.prep.jsx` deleted | **Already done and committed** (commit `0fe516a`). 2,850 lines removed. Zero references to `/app/prep` anywhere else in the repo. |
| `app/routes/app.prepb.jsx` has no top-level auth gate | **Confirmed.** 3,694 lines. Its `action` has 17 `if (intent === ...)` blocks covering 18 intent values (one block handles two intents together). No call to `.role` anywhere in the file. Only 2 of 17 blocks touch session state at all (`create-named-collection`, `suggest-my-collections`, both via `resolveAccessKey` — used only to read `.initials`, not for authorization). |
| `app._index.jsx` doesn't check role | **Confirmed.** Its action calls `validateSkuSession` and checks existence, never `.role`. The only `.role` check in the file is a client-side nav-link toggle (cosmetic, not a gate). |
| `validate.server.js` imports the wrong config path | **Confirmed.** Imports `../config.js` (lowercase); the real file is `app/Config.js` (capital C — confirmed exists; lowercase `config.js` does not). Only works today because Windows is case-insensitive. Note: `app._index.jsx` already imports it correctly as `../Config.js` — this file was the only straggler. |
| `app.admin.jsx`'s `add_user` writes `role` unvalidated | **Confirmed.** `userId` and `initials` validate in the same handler; `role` doesn't. Separately: `app.admin.jsx` *does* already have a correct top-level `role !== "admin" → 403` gate (lines 67-69) guarding the whole action — so only the inner field is the gap, not entry to the handler. |
| Extension files (`ext-api.*.jsx` ×4, `extAuth.server.js`) still present | **Confirmed**, all 5 exist. |
| `PendingSubmission` model still in schema, still dead | **Confirmed.** 15 models total in `prisma/schema.prisma`: `Session, SkuLog, SkuIndex, AccessKey, SkuSession, ProductInfo, SkuHistory, SyncState, ProblemLog, CollectionSequence, SavedPackage, OrderSaving, AiSettings, AiUsageLog, PendingSubmission`. Nothing calls `prisma.pendingSubmission.create`. |
| No tests, no CI exist | **Confirmed, greenfield.** No `vitest` anywhere in `package.json`, no `vitest.config.*`, no `.github/workflows/`, no `test` script. |
| Webhook handlers feed REST payloads into GraphQL-shaped functions | **Confirmed**, plus one extra detail: `webhooks.products.delete.jsx` calls `handleProductDeleted(payload.id, shop)` with a bare integer against a GID-formatted `productId` column; the lookup inside is wrapped in a try/catch that only logs, so a failed match fails **silently**, not loudly. |
| Cron falsely flags `no_pic` | **Confirmed.** `detectProblems` checks `!product.featuredImage` unconditionally; cron's query only fetches `media(first:10)`, never `featuredImage`, so the field is always `undefined` when cron runs it. |
| Pass 2 skips change detection | **Confirmed.** `runInitSyncPass2` calls `upsertProductInfoRow` but never `detectAndWriteChanges`. Only `runCronCycle` calls it. |
| `skuLog_backup.csv` is safe to publish | **Not confirmed — open item.** It's tracked in git (26 lines: 1 header + 25 data rows; columns `id,sku,productId,title,imageUrl,createdAt,createdBy,problems,shopId,skuNumber,status,warehouseStatus`). The "Redacted baseline for review branch" commit's own message lists what it scrubbed (API keys, client IDs, `seed.js` hardcoded values) — **it does not mention this file.** Check the 25 rows yourself before any public push. |
| `vite.config.js` hardcodes a real domain | **Confirmed.** Line 40: `allowedHosts: [host, "skuboo.com"]` — literal string alongside the env-derived `host`. |

## How to run this with AI agents

You said you're using AI to write this, not doing it by hand — so the unit of work below is a **session** (one fresh AI conversation), not a day. A day is usually 2-3 sessions.

1. **One session, one goal, one commit.** Each session below lists exactly the files it should touch. If it starts sprawling past that list, stop and commit what's done first rather than letting scope creep into one giant diff.
2. **Start fresh per session.** Point the new conversation at this file and the session number instead of re-explaining context — each "Kickoff prompt" below is written to be pasted as the first message with no other setup.
3. **Use plan mode for the risky sessions**: Session 3 (the auth gate), all of Day 3 (Sessions 6-8 — real data-correctness bugs on a live app), and every Day 4 session (the file split). Let the agent propose its exact diff before it touches anything. These all touch a live business app; a plan review is cheap, a bad mutation isn't.
4. **Delegate research before code, inside a session.** E.g. in Session 6, have the agent look up `dripSync`'s exact GraphQL field selection in `sync.server.js` before writing the new re-fetch query, rather than guessing field names.
5. **Run `/code-review` before committing** (use `/security-review` specifically for Session 3 and Sessions 6-8) — cheap insurance while the test suite is still thin.
6. **Check off sessions as they land** (edit this file, or use the linked tracker). That's what lets the *next* conversation orient from one file read instead of re-deriving repo state from scratch.

---

## Day 1 — Security & dead-code cleanup

### Session 1 — Retire the extension surface ✅ Done
**Files:** `app/routes/ext-api.order-lookup.jsx`, `app/routes/ext-api.packages.jsx`, `app/routes/ext-api.pending-submission.jsx`, `app/routes/ext-api.report-rate.jsx`, `app/lib/extAuth.server.js`, `prisma/schema.prisma`, `.env.example`, `start-skuboo.sh`, `start-skuboo-dev.sh`

Mechanical deletion — pure cleanup, low risk, good first session. (`app/routes/app.prep.jsx`'s deletion — originally step 1 here — is already committed as of commit `0fe516a`, so it's dropped from this session's scope.)

1. Delete the four `ext-api.*.jsx` routes and `app/lib/extAuth.server.js`. Keep `esp-server.js`, `app/lib/orderLookup.server.js`, `app/routes/app.packages.jsx`, and the `SavedPackage`/`OrderSaving` models untouched.
2. Remove the `PendingSubmission` model from `prisma/schema.prisma`, then `npx prisma migrate dev --name drop_pending_submission` (don't hand-edit old migration files — they're append-only history).
3. Remove `EXTENSION_API_TOKEN` from `.env.example`, `start-skuboo.sh`, `start-skuboo-dev.sh`.

**Verify:** grep for `ext-api|extAuth|PendingSubmission|EXTENSION_API_TOKEN` returns nothing outside migration history; `node esp-server.js` still starts cleanly; app boots and `/ext-api/*` now 404s.

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 1" section
for full context. Note: app/routes/app.prep.jsx's deletion is already committed —
this session only covers the extension surface now.

1. Delete app/routes/ext-api.order-lookup.jsx, ext-api.packages.jsx,
   ext-api.pending-submission.jsx, ext-api.report-rate.jsx, and app/lib/extAuth.server.js
2. Remove the PendingSubmission model from prisma/schema.prisma, then run
   npx prisma migrate dev --name drop_pending_submission
3. Remove EXTENSION_API_TOKEN from .env.example, start-skuboo.sh, start-skuboo-dev.sh

Do NOT touch esp-server.js, app/lib/orderLookup.server.js, app/routes/app.packages.jsx,
or the SavedPackage/OrderSaving models — esp-server.js reads/writes those directly.

Verify when done: grep confirms no references to the deleted files/model/env var remain
outside migration history, `node esp-server.js` still starts, and the app boots. Commit
as one commit.
```

### Session 2 — Fix validation import + PIN rate-limiting
**Files:** `app/lib/validate.server.js`, `app/routes/app.admin.jsx`, `app/routes/app.login.jsx`

1. Fix the import in `validate.server.js`: `../config.js` → `../Config.js`.
2. Wire `validateRole` into `app.admin.jsx`'s `add_user` handler (~line 141-162):
   ```jsx
   import { validateRole } from "../lib/validate.server.js";
   let role;
   try {
     role = validateRole(formData.get("role")?.toString().trim() || "operator");
   } catch (err) {
     return Response.json({ success: false, error: err.message });
   }
   ```
3. Add basic rate-limiting/lockout to `app.login.jsx`'s PIN check (currently unlimited attempts against a 4-digit code). Keep it simple — track failures per session, lock out after N for a cooldown.

Leave `validateSkuStatus`/`validateProblems` unused for now — current write sites always construct those values from enums internally.

**Verify:** `npm run typecheck` passes; adding a user with a garbage role string via the admin UI is rejected; repeated wrong PINs get throttled.

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 2" section
for context, then:

1. In app/lib/validate.server.js, fix the config import: change `../config.js` to
   `../Config.js` (the real file is capitalized; this only worked by accident on
   case-insensitive filesystems).
2. In app/routes/app.admin.jsx's add_user handler, import validateRole from
   ../lib/validate.server.js and validate the `role` field from form data before
   writing it (userId and initials already validate in this same handler — role
   currently doesn't). Use:
     let role;
     try {
       role = validateRole(formData.get("role")?.toString().trim() || "operator");
     } catch (err) {
       return Response.json({ success: false, error: err.message });
     }
3. Add simple rate-limiting/lockout to app/routes/app.login.jsx's PIN check — it's
   currently an unthrottled 4-digit compare. Track failed attempts and lock out
   after a few, for a cooldown window. Keep the implementation simple.

Verify: npm run typecheck passes; an invalid role is rejected from the admin Add User
form; repeated wrong PINs get throttled. Commit as one commit.
```

### Session 3 — Close the authorization gap (the main fix)
**Files:** `app/lib/access.server.js`, `app/routes/app._index.jsx`, `app/routes/app.prepb.jsx`

The most important fix in this plan. A signed-in `viewer` can currently POST to mutating actions in two routes with zero server-side role check — `app.prepb.jsx` has *no* session check at all before any of its 17 intent branches.

1. Add to `access.server.js`:
   ```jsx
   export function isMutationAllowed(skuSession) {
     return !!skuSession && skuSession.role !== "viewer";
   }
   ```
2. `app._index.jsx`: right after the existing `if (!skuSession) → 401`, add `if (!isMutationAllowed(skuSession)) return new Response("Forbidden", { status: 403 });`.
3. `app.prepb.jsx`: add the same two-line gate as the *first* thing in `action`, before `intent` is read — matching the pattern already correct in `app.admin.jsx` (lines 67-69), `app.packages.jsx`, `app.ai-settings.jsx`, `app.problem-dashboard.jsx`. Leave the two existing `resolveAccessKey` calls (`create-named-collection`, `suggest-my-collections`) as-is — still needed for `.initials`, just redundant for auth now.

Optional same-session add-on if it fits cleanly: `AiUsageLog` has no user/session column, so AI spend can't be attributed to anyone. Add a `createdBy` column, populate from `skuSession.userId` in `ai.server.js`'s logging call. Skip if it doesn't fit — not required.

**Verify (by hand — this is the point of the session):** create one `viewer` and one `operator` `AccessKey` via the admin Add User form. As viewer: Prep loads read-only, a direct POST to `save`/`generate-title`/`delete-collection` returns 403. As operator: the same actions succeed. Admin still works for everything.

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 3" section
for full context — this is the most important fix in the plan. Confirmed today:
app/routes/app.prepb.jsx's action (3,694 lines, 17 intent branches) has ZERO
session/role check before any branch; app/routes/app._index.jsx checks the session
exists but never checks .role.

1. Add to app/lib/access.server.js:
     export function isMutationAllowed(skuSession) {
       return !!skuSession && skuSession.role !== "viewer";
     }
2. In app/routes/app._index.jsx, right after the existing `if (!skuSession)` 401
   check, add: `if (!isMutationAllowed(skuSession)) return new Response("Forbidden",
   { status: 403 });`
3. In app/routes/app.prepb.jsx, add a validateSkuSession call + the same
   isMutationAllowed check as the very first thing in the action function, before
   `intent` is read. Match the reference pattern in app/routes/app.admin.jsx
   (~lines 67-69): !skuSession -> 401, then the mutation-allowed check -> 403.
   Leave the existing resolveAccessKey calls in the create-named-collection and
   suggest-my-collections branches alone — still needed for .initials.

Don't touch anything else. Verification for this session is manual, not automated:
walk me through creating a viewer AccessKey and an operator AccessKey via the admin
Add User form, then confirm (tell me what you tested) that a viewer session gets 403
on a mutating action and an operator session succeeds. Commit as one commit once
verified.
```

---

## Day 2 — Test foundation + CI

Greenfield — confirmed no vitest, no config, no CI, no test script exist yet.

### Session 4 — Vitest setup + unit tests
**Files:** `vitest.config.js` (new), `vitest.setup.js` (new), `package.json`, new test files under `app/lib/`

1. `npm install -D vitest`
2. `vitest.config.js` (deliberately separate from `vite.config.js` — its `reactRouter()` plugin drives SSR/route-manifest machinery Vitest shouldn't load):
   ```js
   import { defineConfig } from "vitest/config";
   import tsconfigPaths from "vite-tsconfig-paths";

   export default defineConfig({
     plugins: [tsconfigPaths()],
     test: { environment: "node", setupFiles: ["./vitest.setup.js"] },
   });
   ```
3. `vitest.setup.js` sets a fixed `AI_SETTINGS_ENCRYPTION_KEY` so `crypto.server.js`'s `getKey()` doesn't depend on `.env`.
4. `package.json`: add `"test": "vitest run"` and `"pretest": "prisma generate"` (several `app/lib/*.js` files construct `PrismaClient` at module load — needs the generated client present).
5. Tests, in this order:
   1. `encrypt`/`decrypt` round-trip (`app/lib/crypto.server.js`)
   2. `validateRole`/`validateSkuStatus`/`validateProblems` (`app/lib/validate.server.js`, fixed in Session 2)
   3. `getShipFromAddress` (`app/lib/shippo.server.js`)
   4. `sanitizeGeneratedText`/`htmlToText`/`truncateAtWordBoundary` (`app/lib/ai.server.js`)
   5. `detectProblems`/`getThrottleDelay`/`formatEta` (`app/lib/sync.server.js` — `vi.useFakeTimers()` for `formatEta`, it calls `Date.now()`)

**Verify:** `npm test` green, ~15-20 tests.

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 4" section
for context. No test infrastructure exists yet — this is greenfield.

1. npm install -D vitest
2. Create vitest.config.js at repo root (separate from vite.config.js):
     import { defineConfig } from "vitest/config";
     import tsconfigPaths from "vite-tsconfig-paths";
     export default defineConfig({
       plugins: [tsconfigPaths()],
       test: { environment: "node", setupFiles: ["./vitest.setup.js"] },
     });
3. Create vitest.setup.js that sets a fixed AI_SETTINGS_ENCRYPTION_KEY env value
   (check app/lib/crypto.server.js's getKey() for what shape it needs).
4. Add to package.json scripts: "test": "vitest run", "pretest": "prisma generate"
5. Write tests in this order: crypto.server.js encrypt/decrypt round-trip,
   validate.server.js's three validators, shippo.server.js's getShipFromAddress,
   ai.server.js's sanitizeGeneratedText/htmlToText/truncateAtWordBoundary, then
   sync.server.js's detectProblems/getThrottleDelay/formatEta (fake timers for
   formatEta). Read each function first — don't guess behavior, the ai.server.js
   helpers already have documenting comments.

Verify: npm test passes green. Commit as one commit.
```

### Session 5 — Integration test for the auth fix + CI
**Files:** new integration test file, `.github/workflows/ci.yml` (new)

1. Construct a `Request` and call the exported `action` from `app._index.jsx` and `app.prepb.jsx` directly, using a `viewer`-role session → expect 403; `operator` → expect success. This is the highest-value test in the suite — it's the one that catches a future accidental removal of Session 3's gate.
2. `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on: [push, pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20 }
         - run: npm ci
         - run: npx prisma generate
         - run: npm test
   ```
3. Run `npm run lint`/`npm run typecheck` locally before adding either to CI. If either fails on pre-existing issues, fix separately or leave out for now — don't ship a red badge on day one.

**Verify:** `npm test` green (~20-25 tests total), push, confirm Actions tab shows green. This is also when a README CI badge becomes honest (add it Day 5).

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 5" section
for context. Vitest was set up in the previous session.

1. Write an integration test that constructs a Request and calls the exported
   `action` function from app/routes/app._index.jsx and app/routes/app.prepb.jsx
   directly (or via React Router test utilities), using a constructed viewer-role
   session — confirm it's rejected (403). Repeat with an operator-role session —
   confirm it succeeds. This proves the Session 3 auth-gate fix and should catch
   any future regression if that check is ever accidentally removed.
2. Add .github/workflows/ci.yml running on push/pull_request: checkout, setup-node
   (v20), npm ci, npx prisma generate, npm test.
3. Before adding lint or typecheck as CI steps: run `npm run lint` and
   `npm run typecheck` locally first. Tell me if either currently fails on
   pre-existing issues — if so, leave them out of CI for now rather than shipping
   a red badge.

Verify: npm test green locally, then push and confirm (or tell me how to confirm)
the Actions tab shows a green run. Commit as one commit (or two: test, then CI).
```

---

## Day 3 — Real correctness bugs

Not in the original 4-day plan — these are live-data-integrity bugs from the deeper review, reconciled against the extension retirement in Session 1 (which already resolves two related items — see note below).

> Two items from the original deeper review are already resolved by Session 1 and don't need their own session: the `PendingSubmission` dead-lifecycle question (resolved — the model is deleted), and the duplicate rate-comparison logic between `esp-server.js` and `ext-api.report-rate.jsx` (resolved — `ext-api.report-rate.jsx` is deleted, so `esp-server.js`'s copy is now the only copy).

### Session 6 — Fix the webhook payload shape mismatch
**Files:** `app/routes/webhooks.products.create.jsx`, `app/routes/webhooks.products.update.jsx`, `app/routes/webhooks.products.delete.jsx`, `app/lib/sync.server.js`

Webhook-driven create/update currently feed REST-shaped Shopify payloads into functions that expect GraphQL shape — confirmed this silently misflags nearly every webhook-touched product as missing its picture and/or SKU, and writes a `productId` that never matches the GID format the rest of the app uses. Delete webhooks have the same GID mismatch, plus the lookup failure is currently swallowed silently by a log-only try/catch.

1. Don't translate REST fields into a fake GraphQL shape (rejected — `image`/`featuredImage` aren't reliably the same fact, and the payload structurally lacks `collections`/`media`/`inventory`). Webhook payloads carry `admin_graphql_api_id` alongside `id` for exactly this. In `create.jsx`/`update.jsx`, use it to run a single-product GraphQL `product(id: ID!)` query with the same field selection `dripSync` already uses, then feed *that* into `upsertSkuIndexRow`.
2. In `delete.jsx`, use `payload.admin_graphql_api_id` instead of `payload.id` — no re-fetch needed.
3. While in `handleProductDeleted`'s lookup: make a failed match visible in the log (enough detail to actually debug), not just a silent catch.

**Verify:** in the dev store, edit a product's title/image/inventory one at a time, confirm each webhook produces a correct `SkuIndex`/`ProductInfo` row. Delete a product in Shopify admin directly, confirm its SKU actually frees up.

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 6" section
for full context on this bug — it's a real data-integrity issue affecting nearly
every webhook-driven product edit today.

First, look up how app/lib/sync.server.js's dripSync function queries a product via
GraphQL (its exact field selection) — the new webhook re-fetch needs to match it.

1. In app/routes/webhooks.products.create.jsx and webhooks.products.update.jsx:
   instead of passing the raw webhook payload into upsertSkuIndexRow, use the
   payload's `admin_graphql_api_id` field to run a single-product GraphQL
   product(id: ID!) query (same field selection as dripSync), then pass that
   GraphQL-shaped result into upsertSkuIndexRow.
2. In webhooks.products.delete.jsx: pass payload.admin_graphql_api_id instead of
   payload.id into handleProductDeleted (no re-fetch needed for a delete).
3. In sync.server.js's handleProductDeleted: the lookup for the product to delete
   is currently wrapped in a try/catch that only logs on failure — make a failed
   match log with enough detail to actually debug it, since fixing the ID format
   won't help if this fails again silently for some other reason later.

Do not change the query shapes used by dripSync, cron, or the two init-sync passes
— those are deliberately tiered by API cost and out of scope here.

Verify: edit a real product's title, then its image, then its inventory, in the
dev store, one at a time, and confirm each resulting webhook produces a correct
SkuIndex/ProductInfo row (right productId format, accurate no_pic/no_sku flags).
Delete a product directly in Shopify admin and confirm its SKU frees up. Commit as
one commit.
```

### Session 7 — Fix cron's false `no_pic` flag + Pass 2's missing change log
**Files:** `app/lib/sync.server.js`

Two "wrote a field based on data we didn't fetch" bugs. Cron's query fetches `media(first:10)`, never `featuredImage` — but still runs through the same `detectProblems` check that reads `!product.featuredImage`, which is always `undefined` there, so every product a cron cycle touches gets falsely flagged `no_pic`. Separately, Pass 2 upserts `ProductInfo` but never calls `detectAndWriteChanges` (only cron does), so changes found during the initial full-catalog sync never reach `SkuHistory`.

1. Make `detectProblems` dimension-aware: only judge `no_pic` when the payload actually included image data for whichever shape it is; leave that dimension untouched otherwise.
2. Add a `detectAndWriteChanges` call into Pass 2's per-product loop, matching `runCronCycle`.

**Verify:** run a cron cycle against products with real images, confirm no false `no_pic`. Run Pass 2, confirm `SkuHistory` gets new rows for products that actually changed.

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 7" section
for context. Both bugs are in app/lib/sync.server.js and follow the same rule:
never write a field's value based on the absence of data you didn't fetch.

1. Find detectProblems' no_pic check (currently `if (!product.featuredImage)`).
   Cron's GraphQL query only fetches media(first:10), never featuredImage, so this
   is always a false positive when called from the cron path. Make the check
   dimension-aware: only judge no_pic when the payload actually included image
   data for whatever shape it is (featuredImage where present, media where that's
   what was fetched) — leave the dimension alone when neither was fetched.
2. Find runInitSyncPass2 — it calls upsertProductInfoRow per product but never
   detectAndWriteChanges (only runCronCycle does, see how runCronCycle sequences
   its calls). Add the same detectAndWriteChanges call into Pass 2's loop.

Don't change what data each pass fetches — only how the results are interpreted
and logged.

Verify: run (or walk me through running) a cron cycle against products you know
have real images and confirm they're no longer flagged no_pic. Run Pass 2 (or a
subset) and confirm SkuHistory gets new rows for products that actually changed.
Commit as one commit (or two, if you want the two fixes separately reviewable).
```

### Session 8 — Align `SavedPackage` shop-scoping
**Files:** `app/routes/app.packages.jsx` (write path, scopes by live session shop), `esp-server.js` (the one remaining read path, scopes by `SHOP_DOMAIN` env var)

Narrower than it first looked — Session 1 already deleted `ext-api.packages.jsx`, so there's only one read path left to reconcile, not two.

1. Pick one scoping source and use it consistently. Single-shop deployment today makes the simpler direction likely: have `esp-server.js` resolve `shopId` the same way the write path does, rather than trusting the env var. `app/lib/orderLookup.server.js` already flags this same single-shop assumption elsewhere — worth resolving both together.

**Verify:** this touches the physical ESP32 code path. Save a package from the admin UI, confirm it shows up via `esp-server.js`'s read path (or the ESP32 device itself, if available) before calling it done.

**Kickoff prompt:**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Session 8" section
for context. This is a smaller fix than it might sound — the extension read path
for SavedPackage was already deleted in an earlier session, so esp-server.js is the
only remaining read path to reconcile against app/routes/app.packages.jsx's write
path.

app.packages.jsx scopes SavedPackage by the live Shopify session's shop.
esp-server.js scopes its SavedPackage reads by a SHOP_DOMAIN env var instead. Under
today's single-shop deployment this doesn't cause visible bugs, but it's a latent
mismatch. Also check app/lib/orderLookup.server.js — it has a comment flagging this
same single-shop assumption elsewhere; resolve both the same way.

Pick one scoping approach and make both paths use it consistently — the simplest
direction is probably having esp-server.js resolve shopId the same way the admin
route does, rather than trusting the env var, but use your judgment once you've
read both code paths.

Verify: this touches the physical shipping-desk code path, so be extra careful.
Save a package from the admin UI, then confirm it's visible via esp-server.js's
read path. Tell me exactly what you tested. Commit as one commit.
```

---

## Day 4 — Split `app.prepb.jsx`

Confirmed via `@react-router/fs-routes`'s own source: a route can live at `app/routes/app.prepb/route.jsx`; any other files/folders in that directory are invisible to the route scanner. URL stays `/app/prepb`.

**Target structure:**
```
app/routes/app.prepb/
  route.jsx                     — loader, action (dispatcher), component, ErrorBoundary
  actions/aiActions.server.js         — generate-title, generate-description
  actions/discoveryActions.server.js  — search, search-category, browse-categories,
                                         browse-children, suggest-more
  actions/productActions.server.js    — stage-image, save
  actions/collectionActions.server.js — the 9 collection intents
  components/                   — ~14 sub-components (TagEditor, ProductRow,
                                   CollectionSidebar, category browser, image
                                   stager, etc.)
```

**Ground rule for all 5 sessions:** extraction is mechanical, not a rewrite. Each handler function takes the same inputs the inline `if` block currently closes over (`form`, `admin`, `shopId`, and for collection actions, `resolveAccessKey`) and returns the same response shape. Keep `action`'s control flow as sequential `if`s calling into the newly-imported functions until the *last* session — don't change control-flow shape and move code in the same step. This is the highest-risk phase of the whole plan (biggest diffs, live business app) — smaller sessions with a working app after every step is what keeps it safe.

### Session 9 — Scaffold + extract `aiActions`
Move `generate-title`/`generate-description` into `actions/aiActions.server.js`. Set up the `app.prepb/` folder and `route.jsx` shell.
**Verify:** generate a title and a description on a real product, identical behavior. Commit.

### Session 10 — Extract `discoveryActions`
Move `search`, `search-category`, `browse-categories`, `browse-children`, `suggest-more`.
**Verify:** click through search, category browse, "suggest more." Commit.

### Session 11 — Extract `productActions`
Move `stage-image`, `save`.
**Verify:** stage an image and save a product end to end. Commit.

### Session 12 — Extract `collectionActions`
Move the 9 collection intents (`create-collection`, `rename-collection`, `delete-collection`, `add-products`, `remove-from-collection`, `find-or-create-singles`, `create-named-collection`, `suggest-my-collections`, `search-products`) — the biggest group; fine to split into two commits mid-session if it's unwieldy in one sitting.
**Verify:** create, rename, delete a collection; add and remove a product from one. Commit.

### Session 13 — Dispatch map, component extraction, final pass
Collapse the 17 sequential `if`s into a lookup/dispatch over `intent`, keeping Session 3's top-level auth gate as the first thing the function does. Extract the ~14 inline sub-components into `components/`. Fix the stale header comment (`// app/routes/app.prep.jsx`, left over from when this file was cloned).
**Verify (be careful here — hardest session to spot a mistake in):** `npm test` still passes (update any import paths from Sessions 4-5), `npm run build` succeeds, and a full click-through of every Prep feature (search, generate title/description, save, stage an image, create/rename/delete a collection, add/remove a product from a collection) behaves identically to before.

**Kickoff prompt (use for Sessions 9-13, filling in the group name/intents/verify step for each):**
```
Working in sku-boo on branch `review`. Read EXECUTION_PLAN.md's "Day 4" section for
the full target structure and ground rules, and "Session N" for this session's
specific scope.

This is an incremental extraction of app/routes/app.prepb.jsx (3,694 lines, being
split into app/routes/app.prepb/route.jsx + actions/*.server.js + components/).
Earlier sessions in this sequence may have already created some of this structure —
check what exists before scaffolding.

This session: move [INTENT LIST] out of the inline action into
actions/[GROUP]Actions.server.js. Each extracted function takes the same inputs the
inline if-block currently closes over (form, admin, shopId, and for collection
actions, resolveAccessKey) and returns the same response shape — this should be a
mechanical move, not a rewrite. Do NOT convert the action's control flow to a
dispatch map yet (that's the last session in this sequence, once everything is
extracted) — keep it as sequential ifs that now call into the imported functions.

Verify: [SESSION-SPECIFIC CLICK-THROUGH STEPS]. Commit as one commit once verified.
```

---

## Day 5 — Presentation layer

### Session 14 — README + architecture diagram
Problem statement (a real resale-shop inventory workflow), architecture section — lead with the embedded app + SQLite + `esp-server.js` WebSocket relay talking to physical ESP32 hardware, the most distinctive part of this project — a short "decisions & tradeoffs" section (encryption design, prompt caching, throttle-aware sync), setup instructions, and the CI badge (honest now that Session 5 shipped a green workflow). Diagram as inline Mermaid in the README, or its own Artifact if you want it interactive.

### Session 15 — Private case study
A separate, more narrative document — good fit for an Artifact. The problem, what shipped, what was found and fixed in the security/duplication pass (this plan doc is good raw material), what you'd do differently.

### Session 16 — Pre-publish gate
Not a code session — a checklist before anything goes public:
- Open `skuLog_backup.csv` and check the 25 data rows yourself for real inventory/customer data — confirmed the redaction commit's message never mentions this file.
- `vite.config.js:40`'s hardcoded `"skuboo.com"` in `allowedHosts` — decide: keep public, or move to an env var.
- License file: MIT is the default portfolio choice, but this is a live business tool — make it a deliberate yes, not a default.
- One more full-repo secret scan right before the push.

---

## Phase 2 — deferred, not scheduled

The deeper review's schema redesign: 9 of the 15 models restructured (`SkuLog` trimmed to a pointer list, `SkuIndex`'s `problems`/`excludedProblems` become typed tri-state columns instead of JSON arrays, title consolidated onto `ProductInfo` as sole source of truth, a new `NoteLog` model), plus call-site updates across `app.problem-dashboard.jsx` (4 spots) and `app._index.jsx` (title/image fallback logic). Confirmed today: all 15 current model names still match the draft's assumptions exactly, so it's still grounded if you pick it up later.

**Why deferred:** this is a real breaking migration with call-site fanout, on a live business app, at the same time as a portfolio deadline. Rushing it risks landing exactly the kind of half-finished refactor the original review flagged as a problem in the first place. Worth its own session-by-session plan later, same methodology as Day 4 — one model or call-site group at a time, verify, commit.

## Housekeeping — fold in opportunistically, no dedicated session

- Dead `web_search_20260209` branch in `ai.server.js`'s tool selection (unreachable) — remove or leave when touching that file for Session 6/7.
- Stale comment in `ai.server.js` claiming the settings page "never decrypts the key for display" (it does, server-side, for a 4-char mask) — fix when nearby.
- Naming overlap: `access.server.js` (session/PIN auth) vs. `validate.server.js` (plain enum validators, unrelated) — a rename someday, not urgent.
- `detectAndWriteChanges` diffs `inventory`/`collections` by stringifying JSON and comparing as strings — fragile to key ordering. Convenient to fix alongside Session 7.
- `handleProductDeleted` never touches `ProductInfo`, leaving a permanently orphaned row — fix alongside Session 6, you're already in that function.
- `dripSync`/Pass 1 already returns `featuredImage.url` and `title` cheaply — a `ProductInfo` stub-upsert from the cheap passes could exist immediately instead of waiting for Pass 2/cron. Nice-to-have.
