// app/routes/_index.jsx

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";
import { useFetcher, useLoaderData } from "react-router";
import { useState, useEffect } from "react";

import {
  METAFIELD_NAMESPACE,
  METAFIELD_KEY,
  DEFAULT_SKU_START,
  DEFAULT_PRICE,
  DEFAULT_VENDOR,
  PRODUCT_HANDLE_PREFIX,
  LOG_PAGE_SIZE,
  REFRESH_ROUTE,
} from "../config.js";

// ── BACKEND ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // --- Read recent SKU log from SQLite ---
  let recentSkus = [];
  try {
    recentSkus = await db.skuLog.findMany({
      orderBy: { createdAt: "desc" },
      take: LOG_PAGE_SIZE,
    });
  } catch (err) {
    console.error("[loader] Failed to read SkuLog from SQLite:", err);
    return { recentSkus: [], productMap: {}, loaderError: "Could not load SKU log." };
  }

  if (recentSkus.length === 0) {
    return { recentSkus: [], productMap: {} };
  }

  // --- Batch-fetch live product data from Shopify ---
  const productGids = recentSkus.map((entry) => entry.productId);

  let productMap = {};
  try {
    const nodesResponse = await admin.graphql(
      `#graphql
      query getProductNodes($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Product {
            id
            title
            featuredImage {
              url
            }
          }
        }
      }`,
      { variables: { ids: productGids } }
    );

    const nodesData = await nodesResponse.json();

    if (nodesData.errors) {
      console.error("[loader] GraphQL errors fetching product nodes:", nodesData.errors);
    } else {
      for (const node of nodesData.data.nodes) {
        if (node && node.__typename === "Product") {
          productMap[node.id] = {
            title: node.title,
            imageUrl: node.featuredImage?.url ?? null,
          };
        }
      }
    }
  } catch (err) {
    console.error("[loader] Failed to fetch product nodes from Shopify:", err);
  }

  return { recentSkus, productMap };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // --- Read metafield ---
  let metafieldData;
  try {
    const metafieldQuery = await admin.graphql(
  `#graphql
  query getShopAndSku {
    shop {
      id
      metafield(namespace: "inventory", key: "next_sku") {
        id
        value
      }
    }
  }`
);
    metafieldData = await metafieldQuery.json();
  } catch (err) {
    console.error("[action] Failed to query shop metafield:", err);
    return { error: "Failed to read SKU counter from Shopify." };
  }

  const shop = metafieldData.data.shop;
  const shopId = shop.id;
  const currentSku = shop.metafield ? parseInt(shop.metafield.value) : DEFAULT_SKU_START;
  const skuString = String(currentSku).padStart(6, "0");
  const titleString = `${currentSku} - `;

  console.log("[action] Shop ID:", shopId);
  console.log("[action] Current SKU:", currentSku);

  // --- Create product ---
  let product;
  try {
    const productResponse = await admin.graphql(
      `#graphql
      mutation productSet($input: ProductSetInput!) {
        productSet(input: $input) {
          product {
            id
            title
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            title: titleString,
            handle: `${PRODUCT_HANDLE_PREFIX}${skuString}`,
            status: "DRAFT",
            vendor: DEFAULT_VENDOR,
            productOptions: [
              { name: "Title", values: [{ name: "Default Title" }] },
            ],
            variants: [
              {
                sku: skuString,
                price: DEFAULT_PRICE,
                optionValues: [{ optionName: "Title", name: "Default Title" }],
              },
            ],
          },
        },
      }
    );

    const productData = await productResponse.json();
    const userErrors = productData.data.productSet.userErrors;

    if (userErrors.length > 0) {
      console.error("[action] productSet userErrors:", userErrors);
      return { error: userErrors.map((e) => e.message).join(", ") };
    }

    product = productData.data.productSet.product;
  } catch (err) {
    console.error("[action] Failed to create product:", err);
    return { error: "Failed to create product in Shopify." };
  }

  // --- Increment SKU counter ---
  try {
    const metafieldsResponse = await admin.graphql(
      `#graphql
      mutation setNextSku($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            value
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key: METAFIELD_KEY,
              ownerId: shopId,
              type: "number_integer",
              value: String(currentSku + 1),
            },
          ],
        },
      }
    );

    const metafieldsData = await metafieldsResponse.json();
    const metaUserErrors = metafieldsData.data.metafieldsSet.userErrors;
    if (metaUserErrors.length > 0) {
      console.error("[action] metafieldsSet userErrors:", metaUserErrors);
    }
    console.log("[action] Metafield result:", JSON.stringify(metafieldsData.data.metafieldsSet));
  } catch (err) {
    console.error("[action] Failed to increment SKU counter:", err);
  }

  // --- Write to SQLite log ---
  try {
    await db.skuLog.create({
      data: {
        sku: skuString,
        productId: product.id,
        title: titleString,
        imageUrl: null,
      },
    });
  } catch (err) {
    console.error("[action] Failed to write SkuLog to SQLite:", err);
  }

  // --- Trim log to most recent 50 entries ---
  try {
    const oldest = await db.skuLog.findMany({
      orderBy: { createdAt: "desc" },
      skip: LOG_PAGE_SIZE,
      select: { id: true },
    });

    if (oldest.length > 0) {
      await db.skuLog.deleteMany({
        where: { id: { in: oldest.map((r) => r.id) } },
      });
    }
  } catch (err) {
    console.error("[action] Failed to trim SkuLog:", err);
  }

  return { sku: skuString, productId: product.id };
};

// ── FRONTEND ──────────────────────────────────────────────────────────────────

// ── TimeAgo Component ─────────────────────────────────────────────────────────
function getTimeAgo(date) {
  const seconds = Math.floor((Date.now() - new Date(date)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function TimeAgo({ date }) {
  const [, forceUpdate] = useState(0);
  const [showTooltip, setShowTooltip] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => forceUpdate((n) => n + 1), 30000);
    return () => clearInterval(interval);
  }, []);

  const exact = new Date(date).toLocaleString();

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <span
        onClick={() => setShowTooltip((v) => !v)}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        style={{
          display: "inline-block",
          background: "#e8f0fe",
          color: "#005bd3",
          fontWeight: 500,
          cursor: "pointer",
          fontSize: "12px",
          padding: "3px 10px",
          borderRadius: "999px",
          border: "1px solid #c2d4f8",
        }}
      >
        {getTimeAgo(date)}
      </span>

      {showTooltip && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#1a1a1a",
            color: "#fff",
            padding: "5px 10px",
            borderRadius: "6px",
            fontSize: "12px",
            whiteSpace: "nowrap",
            zIndex: 100,
            pointerEvents: "none",
          }}
        >
          {exact}
        </div>
      )}
    </div>
  );
}

export default function Index() {
  const fetcher = useFetcher();
  const refreshFetcher = useFetcher();

  const isRefreshing = refreshFetcher.state === "loading";
  const refreshLog = () => refreshFetcher.load(REFRESH_ROUTE);

  const shopify = useAppBridge();
  const loaderData = useLoaderData();
  const refreshedData = refreshFetcher.data;

  const recentSkus = refreshedData?.recentSkus ?? loaderData?.recentSkus ?? [];
  const productMap = refreshedData?.productMap ?? loaderData?.productMap ?? {};
  const loaderError = refreshedData?.loaderError ?? loaderData?.loaderError;

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const generateSku = () => fetcher.submit({}, { method: "POST" });

  const openProductEditor = (productId) => {
    shopify.intents.invoke?.("edit:shopify/Product", { value: productId });
  };

  return (
    <s-page heading="SKU Boo">

      {/* ── SKU Generator + Log ── */}
      <s-section heading="SKU Generator">
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={generateSku}
            {...(isLoading ? { loading: true } : {})}
          >
            Generate Next SKU
          </s-button>

          {fetcher.data?.productId && (
            <s-button
              onClick={() => openProductEditor(fetcher.data.productId)}
              variant="primary"
              tone="success"
            >
              ✏️ Edit Product
            </s-button>
          )}
        </s-stack>

        {fetcher.data?.sku && (
          <s-box padding="small" background="success-subdued" borderRadius="base">
            <s-paragraph>
              ✓ Created SKU <strong>{fetcher.data.sku}</strong>
            </s-paragraph>
          </s-box>
        )}

        {fetcher.data?.error && (
          <s-box padding="small" background="critical-subdued" borderRadius="base">
            <s-paragraph>Error: {fetcher.data.error}</s-paragraph>
          </s-box>
        )}

        <s-box border="base" background="base" borderRadius="base" padding="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" padding="small-300">
            <s-heading>Recently Generated SKUs</s-heading>
            <s-button
              variant="tertiary"
              onClick={refreshLog}
              {...(isRefreshing ? { loading: true } : {})}
            >
              Refresh
            </s-button>
          </s-stack>
          <div style={{ maxHeight: "75vh", overflowY: "auto" }}>
            <s-table>
              <s-table-header-row>
                <s-table-header list-slot="primary">Product</s-table-header>
                <s-table-header list-slot="labeled">Title</s-table-header>
                <s-table-header list-slot="labeled">Date Created</s-table-header>
                <s-table-header list-slot="inline">Actions</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {recentSkus.length === 0 && (
                  <s-table-row>
                    <s-table-cell>
                      <s-paragraph>No SKUs generated yet.</s-paragraph>
                    </s-table-cell>
                  </s-table-row>
                )}

                {recentSkus.map((entry) => {
                  const live = productMap?.[entry.productId];
                  const displayTitle = live?.title ?? entry.title;
                  const displayImage = live?.imageUrl ?? entry.imageUrl;

                  return (
                    <s-table-row key={entry.id}>

                      {/* Col 1 — Image */}
                      <s-table-cell>
                        <div style={{ width: "60px", height: "60px", flexShrink: 0 }}>
                          {displayImage ? (
                            <img
                              src={displayImage}
                              alt={displayTitle}
                              style={{
                                width: "60px",
                                height: "60px",
                                objectFit: "cover",
                                borderRadius: "6px",
                                display: "block",
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: "60px",
                                height: "60px",
                                background: "#f1f1f1",
                                borderRadius: "6px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "20px",
                                color: "#999",
                              }}
                            >
                              📦
                            </div>
                          )}
                        </div>
                      </s-table-cell>

                      {/* Col 2+3 — Title */}
                      <s-table-cell>
                        <s-box paddingBlock="small">
                          <s-text type="strong">{displayTitle}</s-text>
                        </s-box>
                      </s-table-cell>

                      {/* Col 4 — Time ago */}
                      <s-table-cell>
                        <TimeAgo date={entry.createdAt} />
                      </s-table-cell>

                      {/* Col 5 — Edit button */}
                      <s-table-cell>
                        <s-button
                          variant="tertiary"
                          onClick={() => openProductEditor(entry.productId)}
                        >
                          Edit
                        </s-button>
                      </s-table-cell>

                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </div>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};