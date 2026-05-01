// app/lib/sync.server.js

import prisma from "../db.server.js";
import { SKU_STATUS, SKU_PROBLEMS } from "../config.js";

// --- Constants ---
const SYNC_PAGE_SIZE    = 250;  // products per page during initial sync
const DRIP_PAGE_SIZE    = 25;   // products per drip cycle
const SKU_REGEX         = /^\d{6}$/; // valid SKU Boo SKU format

// --- Build a SkuIndex row from a Shopify product ---
function buildSkuIndexRow(product, shopId) {
  const variant  = product.variants?.edges?.[0]?.node;
  const sku      = variant?.sku ?? null;
  const title    = product.title ?? null;
  const problems = [];

  // --- Detect problems ---
  if (!sku || !SKU_REGEX.test(sku)) {
    problems.push(SKU_PROBLEMS.NO_SKU);
  }
  if (!title || title.trim() === "" || title.endsWith(" - ")) {
    problems.push(SKU_PROBLEMS.NO_TITLE);
  }
  if (!product.featuredImage) {
    problems.push(SKU_PROBLEMS.NO_PIC);
  }

  const status = problems.length > 0 ? SKU_STATUS.PROBLEM : SKU_STATUS.ACTIVE;

  return {
    shopId,
    skuNumber:       sku ?? product.id, // fall back to GID if no SKU
    taken:           true,
    titleTaken:      !!title,
    productId:       product.id,
    title,
    status,
    problems:        JSON.stringify(problems),
    warehouseStatus: null,
  };
}

// --- Upsert a single product into SkuIndex ---
export async function upsertSkuIndexRow(product, shopId) {
  const row = buildSkuIndexRow(product, shopId);

  try {
    await prisma.skuIndex.upsert({
      where:  { skuNumber: row.skuNumber },
      update: {
        taken:           row.taken,
        titleTaken:      row.titleTaken,
        productId:       row.productId,
        title:           row.title,
        status:          row.status,
        problems:        row.problems,
        warehouseStatus: row.warehouseStatus,
      },
      create: row,
    });
  } catch (err) {
    console.error("[upsertSkuIndexRow] Failed to upsert:", row.skuNumber, err);
  }
}

// --- Handle product deleted webhook ---
export async function handleProductDeleted(productId, shopId) {
  try {
    const existing = await prisma.skuIndex.findFirst({
      where: { productId, shopId },
    });

    if (!existing) return;

    await prisma.skuIndex.update({
      where: { id: existing.id },
      data: {
        status:    SKU_STATUS.DELETED,
        taken:     false,
        titleTaken:false,
        productId: null,
        title:     null,
      },
    });

    console.log("[handleProductDeleted] Marked as deleted:", productId);
  } catch (err) {
    console.error("[handleProductDeleted] Failed:", err);
  }
}

// --- Slow drip reconciliation ---
// Pulls DRIP_PAGE_SIZE products from Shopify sorted by updatedAt
// Updates SkuIndex for any that have changed
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
              featuredImage { url }
              variants(first: 1) {
                edges {
                  node {
                    sku
                  }
                }
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
    console.error("[dripSync] Failed to fetch products:", err);
    return;
  }

  // --- Upsert each product ---
  for (const product of products) {
    await upsertSkuIndexRow(product, shopId);
  }

  console.log("[dripSync] Drip cycle complete. Processed:", products.length);
}

// --- Initial full sync ---
// Pulls all products paginated by SYNC_PAGE_SIZE
// Designed to be called once from the admin UI
export async function runInitialSync(admin, shopId, onProgress) {
  console.log("[initialSync] Starting full sync for shop:", shopId);

  let cursor    = null;
  let hasMore   = true;
  let total     = 0;

  while (hasMore) {
    let response;
    try {
      response = await admin.graphql(
        `#graphql
        query getProductsPage($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                featuredImage { url }
                variants(first: 1) {
                  edges {
                    node {
                      sku
                    }
                  }
                }
              }
            }
          }
        }`,
        { variables: { first: SYNC_PAGE_SIZE, after: cursor } }
      );
    } catch (err) {
      console.error("[initialSync] GraphQL fetch failed:", err);
      break;
    }

    const data = await response.json();
    if (data.errors) {
      console.error("[initialSync] GraphQL errors:", data.errors);
      break;
    }

    const page     = data.data.products;
    const products = page.edges.map((e) => e.node);

    // --- Upsert each product in this page ---
    for (const product of products) {
      await upsertSkuIndexRow(product, shopId);
    }

    total   += products.length;
    hasMore  = page.pageInfo.hasNextPage;
    cursor   = page.pageInfo.endCursor;

    console.log("[initialSync] Progress:", total, "products synced");

    // --- Report progress to caller if callback provided ---
    if (onProgress) onProgress(total);

    // --- Small delay between pages to avoid rate limiting ---
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("[initialSync] Complete. Total synced:", total);
  return total;
}