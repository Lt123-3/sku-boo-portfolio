// app/lib/sync.server.js

import prisma from "../db.server.js";
import { SKU_STATUS, SKU_PROBLEMS } from "../config.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const INIT_PAGE_SIZE     = 250;
const CRON_PAGE_SIZE     = 75;
const DRIP_PAGE_SIZE     = 25;
const SKU_REGEX          = /^\d{6}$/;
const TITLE_PREFIX_REGEX = /^\d+ - .+/;

// ── Tracked fields for change detection ───────────────────────────────────────
const TRACKED_FIELDS = [
  "title",
  "vendor",
  "price",
  "weight",
  "condition",
  "inventory",
  "collections",
  "imageUrl",
];

// ── Rate limit helper ─────────────────────────────────────────────────────────
// Reads the API cost from a GraphQL response and returns ms to wait
function getThrottleDelay(responseData) {
  const cost = responseData?.extensions?.cost;
  if (!cost) return 500;

  const available  = cost.throttleStatus?.currentlyAvailable ?? 1000;
  const restore    = cost.throttleStatus?.restoreRate        ?? 50;
  const queryCost  = cost.actualQueryCost                    ?? 50;

  // --- If budget is running low, wait for it to refill ---
  if (available < queryCost * 2) {
    const neededPoints = (queryCost * 2) - available;
    const waitMs       = Math.ceil((neededPoints / restore) * 1000) + 200;
    console.log(`[sync] Rate limit low (${available} pts remaining), waiting ${waitMs}ms`);
    return waitMs;
  }

  return 300;
}

// ── ETA helper ────────────────────────────────────────────────────────────────
function formatEta(processed, total, startTime) {
  if (!startTime || processed === 0) return null;

  const elapsedMs     = Date.now() - new Date(startTime).getTime();
  const msPerProduct  = elapsedMs / processed;
  const remainingMs   = msPerProduct * (total - processed);
  const remainingMins = Math.ceil(remainingMs / 60000);

  if (remainingMins < 1)   return "less than a minute remaining";
  if (remainingMins === 1) return "~1 minute remaining";
  return `~${remainingMins} minutes remaining`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectProblems(product, variant) {
  const problems = [];
  const sku      = variant?.sku   ?? null;
  const title    = product.title  ?? null;

  if (!sku || !SKU_REGEX.test(sku))              problems.push(SKU_PROBLEMS.NO_SKU);
  if (!title || !TITLE_PREFIX_REGEX.test(title)) problems.push(SKU_PROBLEMS.NO_TITLE);
  if (!product.featuredImage)                    problems.push(SKU_PROBLEMS.NO_PIC);

  return problems;
}

function buildInventoryJson(variant) {
  const levels    = variant?.inventoryItem?.inventoryLevels?.edges ?? [];
  const inventory = {};

  for (const edge of levels) {
    const locationId   = edge.node.location?.id;
    const locationName = edge.node.location?.name;
    const qty          = edge.node.quantities?.[0]?.quantity ?? 0;
    if (locationId) {
      inventory[locationId] = { name: locationName, quantity: qty };
    }
  }

  return JSON.stringify(inventory);
}

function extractWeight(variant) {
  const weightData = variant?.inventoryItem?.measurement?.weight;
  if (!weightData) return null;
  return `${weightData.value} ${weightData.unit ?? ""}`.trim();
}

// ── Upsert SkuIndex row ───────────────────────────────────────────────────────
export async function upsertSkuIndexRow(product, shopId) {
  const variant   = product.variants?.edges?.[0]?.node;
  const sku       = variant?.sku ?? null;
  const title     = product.title ?? null;
  const problems  = detectProblems(product, variant);
  const status    = problems.length > 0 ? SKU_STATUS.PROBLEM : SKU_STATUS.ACTIVE;
  const skuNumber = (sku && SKU_REGEX.test(sku)) ? sku : null;

  // --- Products with no valid SKU get a GID-based placeholder ---
  if (!skuNumber) {
    const placeholderKey = `gid-${product.id.replace(/\//g, "-")}`;
    try {
      await prisma.skuIndex.upsert({
        where:  { skuNumber: placeholderKey },
        update: {
          title,
          status:   SKU_STATUS.PROBLEM,
          problems: JSON.stringify([SKU_PROBLEMS.NO_SKU]),
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
          reservedAt: product.createdAt ? new Date(product.createdAt) : null,
          syncedAt:   new Date(),
        },
      });
    } catch (err) {
      console.error("[upsertSkuIndexRow] Failed no-sku product:", product.id, err);
    }
    return;
  }

  try {
    await prisma.skuIndex.upsert({
      where:  { skuNumber },
      update: {
        taken:      true,
        titleTaken: title ? TITLE_PREFIX_REGEX.test(title) : false,
        productId:  product.id,
        title,
        status,
        problems:   JSON.stringify(problems),
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
        reservedAt: product.createdAt ? new Date(product.createdAt) : null,
        syncedAt:   new Date(),
      },
    });
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
  const imageCount    = mediaEdges.length;
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
    price,
    weight,
    condition,
    inventory:   inventoryJson,
    collections,
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
    inventory:   existing.inventory,
    collections: existing.collections,
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
            shopId,
            productId: product.id,
            skuNumber,
            field,
            oldValue:  oldStr,
            newValue:  newStr,
            changedAt,
            changedBy: "system",
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
    if (!existing) return;

    await prisma.skuIndex.update({
      where: { id: existing.id },
      data: {
        status:     SKU_STATUS.DELETED,
        taken:      false,
        titleTaken: false,
        productId:  null,
        title:      null,
        syncedAt:   new Date(),
      },
    });

    console.log("[handleProductDeleted] Marked deleted:", productId);
  } catch (err) {
    console.error("[handleProductDeleted] Failed:", err);
  }
}

// ── Drip sync — lightweight, runs on every page load ─────────────────────────
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
              id
              title
              status
              createdAt
              updatedAt
              variants(first: 1) {
                edges {
                  node {
                    sku
                  }
                }
              }
              featuredImage {
                url
              }
            }
          }
        }
      }`,
      { variables: { first: DRIP_PAGE_SIZE } }
    );

    const data = await response.json();
    if (data.errors) {
      console.error("[dripSync] GraphQL errors:", data.errors);
      return;
    }

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

// ── Background cron — every 5 minutes ────────────────────────────────────────
let cronTimer = null;

export function startBackgroundCron(admin, shopId) {
  if (cronTimer) return;

  console.log("[cron] Background cron scheduled — first run in 5 minutes");

  cronTimer = setInterval(async () => {
    console.log("[cron] Starting cron cycle");

    let products = [];
    try {
      const response = await admin.graphql(
        `#graphql
        query getCronProducts($first: Int!) {
          products(first: $first, sortKey: UPDATED_AT, reverse: true) {
            edges {
              node {
                id
                title
                vendor
                updatedAt
                media(first: 10) {
                  edges {
                    node {
                      ... on MediaImage {
                        image {
                          url
                        }
                      }
                    }
                  }
                }
                collections(first: 20) {
                  edges {
                    node {
                      title
                    }
                  }
                }
                metafield(namespace: "custom", key: "ebay_condition_id") {
                  value
                }
                variants(first: 1) {
                  edges {
                    node {
                      price
                      sku
                      inventoryItem {
                        measurement {
                          weight {
                            value
                            unit
                          }
                        }
                        inventoryLevels(first: 10) {
                          edges {
                            node {
                              location {
                                id
                                name
                              }
                              quantities(names: ["available"]) {
                                quantity
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
          }
        }`,
        { variables: { first: CRON_PAGE_SIZE } }
      );

      const data = await response.json();
      if (data.errors) {
        console.error("[cron] GraphQL errors:", data.errors);
        return;
      }

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

  }, 5 * 60 * 1000);
}

export function stopBackgroundCron() {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
    console.log("[cron] Background cron stopped");
  }
}

// ── Force cron — runs immediately and resets the timer ────────────────────────
export async function forceCronRun(admin, shopId) {
  console.log("[cron] Force run triggered");

  stopBackgroundCron();

  let products = [];
  try {
    const response = await admin.graphql(
      `#graphql
      query getForceCronProducts($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              title
              vendor
              updatedAt
              media(first: 10) {
                edges {
                  node {
                    ... on MediaImage {
                      image {
                        url
                      }
                    }
                  }
                }
              }
              collections(first: 20) {
                edges {
                  node {
                    title
                  }
                }
              }
              metafield(namespace: "custom", key: "ebay_condition_id") {
                value
              }
              variants(first: 1) {
                edges {
                  node {
                    price
                    sku
                    inventoryItem {
                      measurement {
                        weight {
                          value
                          unit
                        }
                      }
                      inventoryLevels(first: 10) {
                        edges {
                          node {
                            location {
                              id
                              name
                            }
                            quantities(names: ["available"]) {
                              quantity
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
        }
      }`,
      { variables: { first: CRON_PAGE_SIZE } }
    );

    const data = await response.json();
    if (data.errors) {
      console.error("[cron] Force run GraphQL errors:", data.errors);
    } else {
      products = data.data.products.edges.map((e) => e.node);
      for (const product of products) {
        await detectAndWriteChanges(product, shopId);
        await upsertSkuIndexRow(product, shopId);
        await upsertProductInfoRow(product, shopId);
      }
      console.log("[cron] Force run complete. Processed:", products.length);
      await updateSyncState(shopId, { lastCronRun: new Date() });
    }
  } catch (err) {
    console.error("[cron] Force run failed:", err);
  }

  startBackgroundCron(admin, shopId);
}

// ── Init sync Pass 1 — SkuIndex population ────────────────────────────────────
export async function runInitSyncPass1(admin, shopId, resumeCursor = null) {
  console.log("[initSync Pass 1] Starting for shop:", shopId, resumeCursor ? "RESUMING" : "FRESH");

  // --- Get total product count for progress + ETA ---
  const totalProducts = await getProductsCount(admin);

  // --- Record start time for ETA calculation ---
  await updateSyncState(shopId, {
    status:      "running",
    currentPass: 1,
    processed:   0,
    total:       totalProducts,
    startTime:   new Date(),
    lastError:   null,
    cursor:      resumeCursor ?? null,
  });

  let cursor  = resumeCursor;
  let hasMore = true;
  let total   = 0;

  while (hasMore) {
    let response;
    try {
      response = await admin.graphql(
        `#graphql
        query getProductsPass1($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                status
                createdAt
                updatedAt
                variants(first: 1) {
                  edges {
                    node {
                      sku
                    }
                  }
                }
                featuredImage {
                  url
                }
              }
            }
          }
        }`,
        { variables: { first: INIT_PAGE_SIZE, after: cursor } }
      );
    } catch (err) {
      console.error("[initSync Pass 1] Fetch failed:", err);
      await updateSyncState(shopId, {
        status:    "error",
        cursor,
        lastError: err.message,
      });
      break;
    }

    const data = await response.json();
    if (data.errors) {
      console.error("[initSync Pass 1] GraphQL errors:", data.errors);
      await updateSyncState(shopId, {
        status:    "error",
        cursor,
        lastError: data.errors[0]?.message ?? "GraphQL error",
      });
      break;
    }

    const page     = data.data.products;
    const products = page.edges.map((e) => e.node);

    for (const product of products) {
      await upsertSkuIndexRow(product, shopId);
    }

    total   += products.length;
    hasMore  = page.pageInfo.hasNextPage;
    cursor   = page.pageInfo.endCursor;

    // --- Read startTime for ETA ---
    const syncState = await getSyncState(shopId);
    const eta       = formatEta(total, totalProducts, syncState?.startTime);

    console.log(`[initSync Pass 1] ${total} / ${totalProducts} — ${eta ?? "calculating..."}`);

    // --- Save progress, cursor, and ETA after every page ---
    await updateSyncState(shopId, {
      status:      "running",
      currentPass: 1,
      processed:   total,
      total:       totalProducts,
      cursor,
      eta:         eta ?? null,
    });

    // --- Respect rate limits ---
    const delay = getThrottleDelay(data);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // --- Clear cursor on clean completion ---
  if (!hasMore) {
    await updateSyncState(shopId, { cursor: null });
  }

  console.log("[initSync Pass 1] Complete. Total:", total);
  return total;
}

// ── Init sync Pass 2 — ProductInfo population ─────────────────────────────────
export async function runInitSyncPass2(admin, shopId, resumeCursor = null) {
  console.log("[initSync Pass 2] Starting for shop:", shopId, resumeCursor ? "RESUMING" : "FRESH");

  const totalProducts = await getProductsCount(admin);

  await updateSyncState(shopId, {
    status:      "running",
    currentPass: 2,
    processed:   0,
    total:       totalProducts,
    startTime:   new Date(),
    lastError:   null,
    cursor:      resumeCursor ?? null,
  });

  let cursor  = resumeCursor;
  let hasMore = true;
  let total   = 0;

  while (hasMore) {
    let response;
    try {
      response = await admin.graphql(
        `#graphql
        query getProductsPass2($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                vendor
                updatedAt
                media(first: 10) {
                  edges {
                    node {
                      ... on MediaImage {
                        image {
                          url
                        }
                      }
                    }
                  }
                }
                collections(first: 20) {
                  edges {
                    node {
                      title
                    }
                  }
                }
                metafield(namespace: "custom", key: "ebay_condition_id") {
                  value
                }
                variants(first: 1) {
                  edges {
                    node {
                      price
                      sku
                      inventoryItem {
                        measurement {
                          weight {
                            value
                            unit
                          }
                        }
                        inventoryLevels(first: 10) {
                          edges {
                            node {
                              location {
                                id
                                name
                              }
                              quantities(names: ["available"]) {
                                quantity
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
          }
        }`,
        { variables: { first: INIT_PAGE_SIZE, after: cursor } }
      );
    } catch (err) {
      console.error("[initSync Pass 2] Fetch failed:", err);
      await updateSyncState(shopId, {
        status:    "error",
        cursor,
        lastError: err.message,
      });
      break;
    }

    const data = await response.json();
    if (data.errors) {
      console.error("[initSync Pass 2] GraphQL errors:", data.errors);
      await updateSyncState(shopId, {
        status:    "error",
        cursor,
        lastError: data.errors[0]?.message ?? "GraphQL error",
      });
      break;
    }

    const page     = data.data.products;
    const products = page.edges.map((e) => e.node);

    for (const product of products) {
      await upsertProductInfoRow(product, shopId);
    }

    total   += products.length;
    hasMore  = page.pageInfo.hasNextPage;
    cursor   = page.pageInfo.endCursor;

    const syncState = await getSyncState(shopId);
    const eta       = formatEta(total, totalProducts, syncState?.startTime);

    console.log(`[initSync Pass 2] ${total} / ${totalProducts} — ${eta ?? "calculating..."}`);

    await updateSyncState(shopId, {
      status:      "running",
      currentPass: 2,
      processed:   total,
      total:       totalProducts,
      cursor,
      eta:         eta ?? null,
    });

    const delay = getThrottleDelay(data);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (!hasMore) {
    await updateSyncState(shopId, { cursor: null });
  }

  console.log("[initSync Pass 2] Complete. Total:", total);
  return total;
}

// ── Full init sync — both passes sequentially ─────────────────────────────────
export async function runFullInitSync(admin, shopId, resumeCursor = null) {
  const pass1Total = await runInitSyncPass1(admin, shopId, resumeCursor);
  const pass2Total = await runInitSyncPass2(admin, shopId, null);
  return { pass1Total, pass2Total };
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
    const response = await admin.graphql(
      `#graphql
      query getProductsCount {
        productsCount {
          count
        }
      }`
    );
    const data = await response.json();
    return data.data?.productsCount?.count ?? 0;
  } catch (err) {
    console.error("[getProductsCount] Failed:", err);
    return 0;
  }
}