// app/lib/sync.server.js

import prisma from "../db.server.js";
import { SKU_STATUS, SKU_PROBLEMS } from "../Config.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const INIT_PAGE_SIZE = 100;
const CRON_PAGE_SIZE = 75;
const DRIP_PAGE_SIZE = 25;
const SKU_REGEX          = /^\d{6}$/;
const TITLE_SKU_REGEX    = /^\d+\s*[-–]\s*/;
const TITLE_BODY_REGEX   = /^\d+\s*[-–]\s*.+/;
const TITLE_PREFIX_REGEX = TITLE_BODY_REGEX;

// ── Speed settings ────────────────────────────────────────────────────────────
export const SYNC_SPEEDS = {
  slow:   2000,
  medium: 800,
  fast:   200,
};

// ── Tracked fields for change detection ───────────────────────────────────────
const TRACKED_FIELDS = [
  "title", "vendor", "price", "weight",
  "condition", "inventory", "collections", "imageUrl",
];

// ── Rate limit helper ─────────────────────────────────────────────────────────
export function getThrottleDelay(responseData, baseDelay) {
  const cost = responseData?.extensions?.cost;
  if (!cost) return baseDelay;

  const available = cost.throttleStatus?.currentlyAvailable ?? 1000;
  const restore   = cost.throttleStatus?.restoreRate        ?? 50;
  const queryCost = cost.actualQueryCost                    ?? 50;

  if (available < queryCost * 3) {
    const neededPoints = (queryCost * 3) - available;
    const waitMs       = Math.ceil((neededPoints / restore) * 1000) + 500;
    console.log(`[sync] Rate limit low (${available} pts remaining), waiting ${waitMs}ms`);
    return waitMs;
  }

  return baseDelay;
}

// ── ETA helper ────────────────────────────────────────────────────────────────
export function formatEta(processed, total, startTime) {
  if (!startTime || processed === 0) return null;
  const elapsedMs     = Date.now() - new Date(startTime).getTime();
  const msPerProduct  = elapsedMs / processed;
  const remainingMs   = msPerProduct * (total - processed);
  const remainingMins = Math.ceil(remainingMs / 60000);
  if (remainingMins < 1)   return "less than a minute remaining";
  if (remainingMins === 1) return "~1 minute remaining";
  return `~${remainingMins} minutes remaining`;
}

// ── Image counting ───────────────────────────────────────────────────────────
// Count image-type media on a GraphQL product payload. Every sync path now
// selects `media(first: 10, query: "media_type:IMAGE")`, so this is the number
// of image edges (naturally capped at 10). Returns null when the payload carried
// no image data at all — neither `media` nor a legacy `featuredImage` — so
// callers can leave picture problems unjudged rather than guess from an absent
// field (`Product.featuredImage` is deprecated and often null on products that
// do have images).
export function countProductImages(product) {
  if (product?.media && Array.isArray(product.media.edges)) {
    return product.media.edges.filter((e) => e?.node?.image?.url).length;
  }
  if (product && "featuredImage" in product) {
    return product.featuredImage ? 1 : 0;
  }
  return null;
}

// ── Problem detection ─────────────────────────────────────────────────────────
export function detectProblems(product, variant) {
  const problems = [];
  const sku   = variant?.sku  ?? null;
  const title = product.title ?? null;

  if (!sku || !SKU_REGEX.test(sku)) problems.push(SKU_PROBLEMS.NO_SKU);

  if (!title) {
    problems.push(SKU_PROBLEMS.NO_TITLE);
  } else {
    const hasTitleSku  = TITLE_SKU_REGEX.test(title);
    const hasTitleBody = TITLE_BODY_REGEX.test(title);
    if (!hasTitleSku && !hasTitleBody) problems.push(SKU_PROBLEMS.NO_TITLE);
    if (!hasTitleSku && hasTitleBody)  problems.push(SKU_PROBLEMS.NO_TITLE_SKU);
    if (hasTitleSku  && !hasTitleBody) problems.push(SKU_PROBLEMS.NO_TITLE_BODY);
  }

  // Picture problems, bucketed by image count: 0 → no_pic, 1–2 → low_pic,
  // 3+ → fine. null (no image data fetched) leaves the dimension alone.
  const imageCount = countProductImages(product);
  if (imageCount === 0)                          problems.push(SKU_PROBLEMS.NO_PIC);
  else if (imageCount === 1 || imageCount === 2) problems.push(SKU_PROBLEMS.LOW_PIC);

  return problems;
}

// ── Write ProblemLog entries for newly detected problems ──────────────────────
async function writeProblemLogDetected(shopId, productId, skuNumber, newProblems, oldProblemsJson, excludedProblemsJson) {
  const oldProblems      = JSON.parse(oldProblemsJson      ?? "[]");
  const excludedProblems = JSON.parse(excludedProblemsJson ?? "[]");

  // --- Only log problems that are genuinely new and not excluded ---
  const trulyNew = newProblems.filter(
    (p) => !oldProblems.includes(p) && !excludedProblems.includes(p)
  );

  if (trulyNew.length === 0) return;

  try {
    await prisma.problemLog.createMany({
      data: trulyNew.map((problemType) => ({
        shopId,
        productId,
        skuNumber:   skuNumber ?? null,
        action:      "detected",
        problemType,
        changedBy:   "system",
      })),
    });
  } catch (err) {
    console.error("[writeProblemLogDetected] Failed:", err);
  }
}

// ── Inventory helpers ─────────────────────────────────────────────────────────
function buildInventoryJson(variant) {
  const levels    = variant?.inventoryItem?.inventoryLevels?.edges ?? [];
  const inventory = {};
  for (const edge of levels) {
    const locationId   = edge.node.location?.id;
    const locationName = edge.node.location?.name;
    const qty          = edge.node.quantities?.[0]?.quantity ?? 0;
    if (locationId) inventory[locationId] = { name: locationName, quantity: qty };
  }
  return JSON.stringify(inventory);
}

function extractWeight(variant) {
  const weightData = variant?.inventoryItem?.measurement?.weight;
  if (!weightData) return null;
  return `${weightData.value} ${weightData.unit ?? ""}`.trim();
}

// ── Canonical JSON for order-insensitive change detection ─────────────────────
// ProductInfo.inventory is a {locationId: {...}} map and .collections a list of
// titles; Shopify may return the same data in a different edge order between
// syncs. Sort keys and arrays before diffing so a reorder is not logged as a
// change. Non-JSON input falls back to a trimmed string.
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep).sort(cmpCanonical);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => { acc[key] = sortDeep(value[key]); return acc; }, {});
  }
  return value;
}
function cmpCanonical(a, b) {
  const sa = a && typeof a === "object" ? JSON.stringify(a) : String(a);
  const sb = b && typeof b === "object" ? JSON.stringify(b) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function canonicalJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.stringify(sortDeep(JSON.parse(raw)));
  } catch {
    return String(raw).trim();
  }
}

// ── Check if sync was cancelled ───────────────────────────────────────────────
async function isCancelled(shopId) {
  try {
    const state = await prisma.syncState.findUnique({ where: { shopId } });
    return state?.status === "cancelled";
  } catch {
    return false;
  }
}

// ── Upsert SkuIndex row ───────────────────────────────────────────────────────
export async function upsertSkuIndexRow(product, shopId) {
  const variant   = product.variants?.edges?.[0]?.node;
  const sku       = variant?.sku ?? null;
  const title     = product.title ?? null;
  const rawProblems = detectProblems(product, variant);
  const imageCount  = countProductImages(product);
  const skuNumber = (sku && SKU_REGEX.test(sku)) ? sku : null;

  if (!skuNumber) {
    const placeholderKey = `gid-${product.id.replace(/\//g, "-")}`;
    try {
      const existing = await prisma.skuIndex.findUnique({ where: { skuNumber: placeholderKey } });

      await prisma.skuIndex.upsert({
        where:  { skuNumber: placeholderKey },
        update: {
          title,
          status:   SKU_STATUS.PROBLEM,
          problems: JSON.stringify([SKU_PROBLEMS.NO_SKU]),
          imageCount,
          syncedAt: new Date(),
        },
        create: {
          shopId,
          skuNumber:  placeholderKey,
          taken:      false,
          titleTaken: false,
          productId:  product.id,
          title,
          status:     SKU_STATUS.PROBLEM,
          problems:   JSON.stringify([SKU_PROBLEMS.NO_SKU]),
          imageCount,
          reservedAt: product.createdAt ? new Date(product.createdAt) : null,
          syncedAt:   new Date(),
        },
      });

      await writeProblemLogDetected(
        shopId, product.id, null,
        [SKU_PROBLEMS.NO_SKU],
        existing?.problems ?? "[]",
        existing?.excludedProblems ?? "[]"
      );
    } catch (err) {
      console.error("[upsertSkuIndexRow] Failed no-sku product:", product.id, err);
    }
    return;
  }

  try {
    const existing = await prisma.skuIndex.findUnique({ where: { skuNumber } });
    const excluded = JSON.parse(existing?.excludedProblems ?? "[]");

    // --- Filter out excluded problems before saving ---
    const problems = rawProblems.filter((p) => !excluded.includes(p));
    const status   = problems.length > 0 ? SKU_STATUS.PROBLEM : SKU_STATUS.ACTIVE;

    await prisma.skuIndex.upsert({
      where:  { skuNumber },
      update: {
        taken:      true,
        titleTaken: title ? TITLE_BODY_REGEX.test(title) : false,
        productId:  product.id,
        title,
        status,
        problems:   JSON.stringify(problems),
        imageCount,
        syncedAt:   new Date(),
      },
      create: {
        shopId,
        skuNumber,
        taken:      true,
        titleTaken: title ? TITLE_PREFIX_REGEX.test(title) : false,
        productId:  product.id,
        title,
        status,
        problems:   JSON.stringify(problems),
        imageCount,
        reservedAt: product.createdAt ? new Date(product.createdAt) : null,
        syncedAt:   new Date(),
      },
    });

    await writeProblemLogDetected(
      shopId, product.id, skuNumber,
      problems,
      existing?.problems ?? "[]",
      existing?.excludedProblems ?? "[]"
    );
  } catch (err) {
    console.error("[upsertSkuIndexRow] Failed:", skuNumber, err);
  }
}

// ── Upsert ProductInfo row ────────────────────────────────────────────────────
export async function upsertProductInfoRow(product, shopId) {
  const variant       = product.variants?.edges?.[0]?.node;
  const sku           = variant?.sku ?? null;
  const skuNumber     = (sku && SKU_REGEX.test(sku)) ? sku : null;
  const inventoryJson = buildInventoryJson(variant);
  const weight        = extractWeight(variant);
  const collections   = (product.collections?.edges ?? []).map((e) => e.node.title);
  const mediaEdges    = product.media?.edges ?? [];
  const imageCount    = countProductImages(product) ?? mediaEdges.length;
  const condition     = product.metafield?.value ?? null;
  const price         = variant?.price ?? null;

  try {
    await prisma.productInfo.upsert({
      where:  { productId: product.id },
      update: {
        title:       product.title,
        vendor:      product.vendor,
        price,
        weight,
        condition,
        inventory:   inventoryJson,
        collections: JSON.stringify(collections),
        imageUrl:    mediaEdges[0]?.node?.image?.url ?? null,
        imageCount,
        syncedAt:    new Date(),
      },
      create: {
        shopId,
        productId:   product.id,
        skuNumber,
        title:       product.title,
        vendor:      product.vendor,
        price,
        weight,
        condition,
        inventory:   inventoryJson,
        collections: JSON.stringify(collections),
        imageUrl:    mediaEdges[0]?.node?.image?.url ?? null,
        imageCount,
        syncedAt:    new Date(),
      },
    });
  } catch (err) {
    console.error("[upsertProductInfoRow] Failed:", product.id, err);
  }
}

// ── Change Detection ──────────────────────────────────────────────────────────
export async function detectAndWriteChanges(product, shopId) {
  const variant       = product.variants?.edges?.[0]?.node;
  const sku           = variant?.sku ?? null;
  const skuNumber     = (sku && SKU_REGEX.test(sku)) ? sku : null;
  const inventoryJson = buildInventoryJson(variant);
  const weight        = extractWeight(variant);
  const collections   = JSON.stringify(
    (product.collections?.edges ?? []).map((e) => e.node.title)
  );
  const condition  = product.metafield?.value ?? null;
  const price      = variant?.price ?? null;
  const mediaEdges = product.media?.edges ?? [];
  const imageUrl   = mediaEdges[0]?.node?.image?.url ?? null;

  const newValues = {
    title:       product.title  ?? null,
    vendor:      product.vendor ?? null,
    price, weight, condition,
    inventory:   canonicalJson(inventoryJson),
    collections: canonicalJson(collections),
    imageUrl,
  };

  let existing;
  try {
    existing = await prisma.productInfo.findUnique({ where: { productId: product.id } });
  } catch (err) {
    console.error("[detectAndWriteChanges] Failed to read ProductInfo:", product.id, err);
    return;
  }

  if (!existing) return;

  const oldValues = {
    title:       existing.title,
    vendor:      existing.vendor,
    price:       existing.price,
    weight:      existing.weight,
    condition:   existing.condition,
    inventory:   canonicalJson(existing.inventory),
    collections: canonicalJson(existing.collections),
    imageUrl:    existing.imageUrl,
  };

  const changedAt = new Date();

  for (const field of TRACKED_FIELDS) {
    const oldStr = oldValues[field] == null ? null : String(oldValues[field]).trim();
    const newStr = newValues[field] == null ? null : String(newValues[field]).trim();

    if (oldStr !== newStr) {
      try {
        await prisma.skuHistory.create({
          data: {
            shopId, productId: product.id, skuNumber, field,
            oldValue: oldStr, newValue: newStr, changedAt, changedBy: "system",
          },
        });
        console.log(`[detectAndWriteChanges] ${field} changed on ${product.id}`);
      } catch (err) {
        console.error("[detectAndWriteChanges] Failed to write SkuHistory:", field, err);
      }
    }
  }
}

// ── Handle product deleted ────────────────────────────────────────────────────
export async function handleProductDeleted(productId, shopId) {
  try {
    const existing = await prisma.skuIndex.findFirst({ where: { productId, shopId } });
    if (!existing) {
      // No match means the SKU is never freed. Log enough to tell an ID-format
      // mismatch apart from a shop mismatch apart from a genuinely unknown product
      // — a fixed ID format won't help if this starts failing for another reason.
      const anyShop = await prisma.skuIndex.findFirst({
        where: { productId },
        select: { shopId: true },
      });
      console.warn(
        "[handleProductDeleted] No SkuIndex match — SKU not freed:",
        JSON.stringify({
          productId,
          productIdType: typeof productId,
          shopId,
          existsUnderOtherShop: anyShop?.shopId ?? null,
        })
      );
      return;
    }

    await prisma.skuIndex.update({
      where: { id: existing.id },
      data: {
        status: SKU_STATUS.DELETED, taken: false, titleTaken: false,
        productId: null, title: null, syncedAt: new Date(),
      },
    });

    await prisma.problemLog.create({
      data: {
        shopId,
        productId,
        skuNumber:   existing.skuNumber ?? null,
        action:      "deleted",
        problemType: null,
        changedBy:   "system",
      },
    });

    console.log("[handleProductDeleted] Marked deleted:", productId);
  } catch (err) {
    console.error(
      "[handleProductDeleted] Failed:",
      JSON.stringify({ productId, shopId }),
      err
    );
  }
}

// ── Drip sync ─────────────────────────────────────────────────────────────────
export async function runDripSync(admin, shopId) {
  console.log("[dripSync] Starting drip cycle");

  let products = [];
  try {
    const response = await admin.graphql(
      `#graphql
      query getDripProducts($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id title status createdAt updatedAt
              variants(first: 1) { edges { node { sku } } }
              media(first: 10, query: "media_type:IMAGE") {
                edges { node { ... on MediaImage { image { url } } } }
              }
            }
          }
        }
      }`,
      { variables: { first: DRIP_PAGE_SIZE } }
    );

    const data = await response.json();
    if (data.errors) { console.error("[dripSync] GraphQL errors:", data.errors); return; }
    products = data.data.products.edges.map((e) => e.node);
  } catch (err) {
    console.error("[dripSync] Failed to fetch:", err);
    return;
  }

  for (const product of products) {
    await upsertSkuIndexRow(product, shopId);
  }

  console.log("[dripSync] Complete. Processed:", products.length);
}

// ── Webhook re-fetch ─────────────────────────────────────────────────────────
// Keep this field selection identical to getDripProducts above.
const WEBHOOK_PRODUCT_QUERY = `#graphql
  query getWebhookProduct($id: ID!) {
    product(id: $id) {
      id title status createdAt updatedAt
      variants(first: 1) { edges { node { sku } } }
      media(first: 10, query: "media_type:IMAGE") {
        edges { node { ... on MediaImage { image { url } } } }
      }
    }
  }`;

// products/create and products/update webhooks deliver REST-shaped payloads, but
// upsertSkuIndexRow expects a GraphQL product node. Re-fetch by the admin GID
// (payload.admin_graphql_api_id) in the drip shape, then upsert. Mirrors
// runDripSync's guard style: log and bail rather than feed a partial object in.
export async function syncSkuIndexRowFromWebhook(admin, adminGraphqlApiId, shopId) {
  if (!admin) {
    console.warn(
      "[syncSkuIndexRowFromWebhook] No admin client (shop uninstalled / CLI-triggered). Skipping:",
      adminGraphqlApiId,
      shopId
    );
    return;
  }

  let product;
  try {
    const response = await admin.graphql(WEBHOOK_PRODUCT_QUERY, {
      variables: { id: adminGraphqlApiId },
    });
    const data = await response.json();
    if (data.errors) {
      console.error(
        "[syncSkuIndexRowFromWebhook] GraphQL errors:",
        adminGraphqlApiId,
        JSON.stringify(data.errors)
      );
      return;
    }
    product = data.data?.product;
  } catch (err) {
    console.error(
      "[syncSkuIndexRowFromWebhook] Re-fetch failed:",
      adminGraphqlApiId,
      err
    );
    return;
  }

  if (!product) {
    console.warn(
      "[syncSkuIndexRowFromWebhook] Product not found (deleted before re-fetch?):",
      adminGraphqlApiId
    );
    return;
  }

  await upsertSkuIndexRow(product, shopId);
}

// ── Background cron ───────────────────────────────────────────────────────────
let cronTimer  = null;
let cronAdmin  = null;
let cronShopId = null;

export function startBackgroundCron(admin, shopId) {
  cronAdmin  = admin;
  cronShopId = shopId;

  if (cronTimer) return;

  console.log("[cron] Background cron scheduled — first run in 5 minutes");

  cronTimer = setInterval(async () => {
    if (!cronAdmin || !cronShopId) return;
    await runCronCycle(cronAdmin, cronShopId);
  }, 5 * 60 * 1000);
}

export function stopBackgroundCron() {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
    console.log("[cron] Background cron stopped");
  }
}

async function runCronCycle(admin, shopId) {
  console.log("[cron] Starting cron cycle");

  let products = [];
  try {
    const response = await admin.graphql(
      `#graphql
      query getCronProducts($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id title vendor updatedAt
              media(first: 10, query: "media_type:IMAGE") {
                edges { node { ... on MediaImage { image { url } } } }
              }
              collections(first: 20) { edges { node { title } } }
              metafield(namespace: "custom", key: "ebay_condition_id") { value }
              variants(first: 1) {
                edges {
                  node {
                    price sku
                    inventoryItem {
                      measurement { weight { value unit } }
                      inventoryLevels(first: 10) {
                        edges {
                          node {
                            location { id name }
                            quantities(names: ["available"]) { quantity }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { first: CRON_PAGE_SIZE } }
    );

    const data = await response.json();
    if (data.errors) { console.error("[cron] GraphQL errors:", data.errors); return; }
    products = data.data.products.edges.map((e) => e.node);
  } catch (err) {
    console.error("[cron] Failed to fetch:", err);
    return;
  }

  for (const product of products) {
    await detectAndWriteChanges(product, shopId);
    await upsertSkuIndexRow(product, shopId);
    await upsertProductInfoRow(product, shopId);
  }

  console.log("[cron] Cycle complete. Processed:", products.length);
  await updateSyncState(shopId, { lastCronRun: new Date() });
}

// ── Force cron ────────────────────────────────────────────────────────────────
export async function forceCronRun(admin, shopId) {
  console.log("[cron] Force run triggered");
  stopBackgroundCron();
  await runCronCycle(admin, shopId);
  startBackgroundCron(admin, shopId);
}

// ── Init sync Pass 1 ──────────────────────────────────────────────────────────
export async function runInitSyncPass1(admin, shopId, resumeCursor = null, speed = "medium") {
  const baseDelay     = SYNC_SPEEDS[speed] ?? SYNC_SPEEDS.medium;
  const totalProducts = await getProductsCount(admin);

  console.log(`[initSync Pass 1] Starting — speed: ${speed} (${baseDelay}ms), ${resumeCursor ? "RESUMING" : "FRESH"}`);

  await updateSyncState(shopId, {
    status:      "running",
    currentPass: 1,
    processed:   resumeCursor ? null : 0,
    total:       totalProducts,
    startTime:   new Date(),
    lastError:   null,
    cursor:      resumeCursor ?? null,
  });

  let cursor  = resumeCursor;
  let hasMore = true;
  let total   = 0;

  while (hasMore) {
    if (await isCancelled(shopId)) {
      console.log("[initSync Pass 1] Cancelled by user");
      await updateSyncState(shopId, { status: "cancelled" });
      return total;
    }

    let response;
    try {
      response = await admin.graphql(
        `#graphql
        query getProductsPass1($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title status createdAt updatedAt
                variants(first: 1) { edges { node { sku } } }
                media(first: 10, query: "media_type:IMAGE") {
                  edges { node { ... on MediaImage { image { url } } } }
                }
              }
            }
          }
        }`,
        { variables: { first: INIT_PAGE_SIZE, after: cursor } }
      );
    } catch (err) {
      console.error("[initSync Pass 1] Fetch failed:", err);
      await updateSyncState(shopId, { status: "error", cursor, lastError: err.message });
      return total;
    }

    const data = await response.json();
    if (data.errors) {
      await updateSyncState(shopId, { status: "error", cursor, lastError: data.errors[0]?.message ?? "GraphQL error" });
      return total;
    }

    const page     = data.data.products;
    const products = page.edges.map((e) => e.node);

    for (const product of products) {
      await upsertSkuIndexRow(product, shopId);
    }

    total   += products.length;
    hasMore  = page.pageInfo.hasNextPage;
    cursor   = page.pageInfo.endCursor;

    const syncState = await getSyncState(shopId);
    const eta       = formatEta(total, totalProducts, syncState?.startTime);

    console.log(`[initSync Pass 1] ${total} / ${totalProducts} — ${eta ?? "calculating..."}`);

    await updateSyncState(shopId, {
      status: "running", currentPass: 1, processed: total,
      total: totalProducts, cursor, eta: eta ?? null,
    });

    const delay = getThrottleDelay(data, baseDelay);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (!hasMore) await updateSyncState(shopId, { cursor: null });
  console.log("[initSync Pass 1] Complete. Total:", total);
  return total;
}

// ── Init sync Pass 2 ──────────────────────────────────────────────────────────
export async function runInitSyncPass2(admin, shopId, resumeCursor = null, speed = "medium") {
  const baseDelay     = SYNC_SPEEDS[speed] ?? SYNC_SPEEDS.medium;
  const totalProducts = await prisma.skuIndex.count({ where: { shopId } });

  console.log(`[initSync Pass 2] Starting — speed: ${speed} (${baseDelay}ms), ${resumeCursor ? "RESUMING" : "FRESH"}`);

  await updateSyncState(shopId, {
    status:      "running",
    currentPass: 2,
    processed:   resumeCursor ? null : 0,
    total:       totalProducts,
    startTime:   new Date(),
    lastError:   null,
    cursor:      resumeCursor ?? null,
  });

  let cursor  = resumeCursor;
  let hasMore = true;
  let total   = 0;

  while (hasMore) {
    if (await isCancelled(shopId)) {
      console.log("[initSync Pass 2] Cancelled by user");
      await updateSyncState(shopId, { status: "cancelled" });
      return total;
    }

    let response;
    try {
      response = await admin.graphql(
        `#graphql
        query getProductsPass2($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title vendor updatedAt
                media(first: 10, query: "media_type:IMAGE") {
                  edges { node { ... on MediaImage { image { url } } } }
                }
                collections(first: 20) { edges { node { title } } }
                metafield(namespace: "custom", key: "ebay_condition_id") { value }
                variants(first: 1) {
                  edges {
                    node {
                      price sku
                      inventoryItem {
                        measurement { weight { value unit } }
                        inventoryLevels(first: 10) {
                          edges {
                            node {
                              location { id name }
                              quantities(names: ["available"]) { quantity }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { variables: { first: INIT_PAGE_SIZE, after: cursor } }
      );
    } catch (err) {
      console.error("[initSync Pass 2] Fetch failed:", err);
      await updateSyncState(shopId, { status: "error", cursor, lastError: err.message });
      return total;
    }

    const data = await response.json();
    if (data.errors) {
      await updateSyncState(shopId, { status: "error", cursor, lastError: data.errors[0]?.message ?? "GraphQL error" });
      return total;
    }

    const page     = data.data.products;
    const products = page.edges.map((e) => e.node);

    for (const product of products) {
      // Match runCronCycle: diff against the pre-cycle ProductInfo row before
      // upsertProductInfoRow overwrites it, so full-catalog re-syncs also feed
      // SkuHistory. (No-op on the first Pass 2 — no row to diff against yet.)
      await detectAndWriteChanges(product, shopId);
      await upsertProductInfoRow(product, shopId);
    }

    total   += products.length;
    hasMore  = page.pageInfo.hasNextPage;
    cursor   = page.pageInfo.endCursor;

    const syncState = await getSyncState(shopId);
    const eta       = formatEta(total, totalProducts, syncState?.startTime);

    console.log(`[initSync Pass 2] ${total} / ${totalProducts} — ${eta ?? "calculating..."}`);

    await updateSyncState(shopId, {
      status: "running", currentPass: 2, processed: total,
      total: totalProducts, cursor, eta: eta ?? null,
    });

    const delay = getThrottleDelay(data, baseDelay);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (!hasMore) await updateSyncState(shopId, { cursor: null });
  console.log("[initSync Pass 2] Complete. Total:", total);
  return total;
}

// ── Sync State Helpers ────────────────────────────────────────────────────────
export async function getSyncState(shopId) {
  try {
    return await prisma.syncState.findUnique({ where: { shopId } });
  } catch (err) {
    console.error("[syncState] Failed to read:", err);
    return null;
  }
}

export async function updateSyncState(shopId, data) {
  try {
    await prisma.syncState.upsert({
      where:  { shopId },
      update: { ...data, updatedAt: new Date() },
      create: { shopId, ...data },
    });
  } catch (err) {
    console.error("[syncState] Failed to update:", err);
  }
}

export async function getProductsCount(admin) {
  try {
    const response = await admin.graphql(`#graphql
      query getProductsCount { productsCount { count } }`
    );
    const data = await response.json();
    return data.data?.productsCount?.count ?? 0;
  } catch (err) {
    console.error("[getProductsCount] Failed:", err);
    return 0;
  }
}