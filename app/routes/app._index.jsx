// app/routes/app._index.jsx

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { validateSkuSession, cleanExpiredSessions } from "../lib/access.server.js";
import { runDripSync, startBackgroundCron } from "../lib/sync.server.js";
import { PinOverlay, UserBadge, useSkuSession } from "../components/PinGate.jsx";

import {
  METAFIELD_NAMESPACE,
  METAFIELD_KEY,
  DEFAULT_SKU_START,
  DEFAULT_PRICE,
  DEFAULT_VENDOR,
  PRODUCT_HANDLE_PREFIX,
  LOG_PAGE_SIZE,
  REFRESH_ROUTE,
} from "../Config.js";




// ── BACKEND ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId = session.shop;

  // Waits 5 minutes before first run
  startBackgroundCron(admin, shopId);

  // --- Drip sync on every page load ---
  runDripSync(admin, shopId).catch((err) => {
    console.error("[loader] Drip sync failed:", err);
  });

  // --- Clean up expired sessions occasionally ---
  await cleanExpiredSessions();

  // --- Read recent SKU log from SQLite ---
  let recentSkus = [];
  try {
    recentSkus = await prisma.skuLog.findMany({
      orderBy: { createdAt: "desc" },
      take: LOG_PAGE_SIZE,
    });
  } catch (err) {
    console.error("[loader] Failed to read SkuLog from SQLite:", err);
    return { recentSkus: [], productMap: {}, loaderError: "Could not load SKU log.", shopId };
  }

  if (recentSkus.length === 0) {
    return { recentSkus: [], productMap: {}, shopId };
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
            featuredImage { url }
          }
        }
      }`,
      { variables: { ids: productGids } }
    );

    const nodesData = await nodesResponse.json();

    if (nodesData.errors) {
      console.error("[loader] GraphQL errors:", nodesData.errors);
    } else {
      for (const node of nodesData.data.nodes) {
        if (node && node.__typename === "Product") {
          productMap[node.id] = {
            title:    node.title,
            imageUrl: node.featuredImage?.url ?? null,
          };
        }
      }
    }
  } catch (err) {
    console.error("[loader] Failed to fetch product nodes:", err);
  }

  return { recentSkus, productMap, shopId };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId = session.shop;

  const formData = await request.formData();
  const intent    = formData.get("intent");
  const sessionId = formData.get("sessionId")?.toString().trim();

  // --- Validate SKU Boo session on every action ---
  const skuSession = await validateSkuSession({ sessionId, shopId });
  if (!skuSession) {
    return new Response(
      JSON.stringify({ needsAuth: true }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // --- Handle delete ---
  if (intent === "delete") {
    const productId = formData.get("productId");
    const skuLogId  = formData.get("skuLogId");

    if (!productId || !skuLogId) {
      return { error: "Missing product ID or log ID for deletion." };
    }

    try {
      const deleteResponse = await admin.graphql(
        `#graphql
        mutation productDelete($id: ID!) {
          productDelete(input: { id: $id }) {
            deletedProductId
            userErrors { field message }
          }
        }`,
        { variables: { id: productId } }
      );

      const deleteData  = await deleteResponse.json();
      const userErrors  = deleteData.data.productDelete.userErrors;

      if (userErrors.length > 0) {
        console.error("[action] productDelete userErrors:", userErrors);
        return { error: userErrors.map((e) => e.message).join(", ") };
      }

      console.log("[action] Deleted product:", deleteData.data.productDelete.deletedProductId);
    } catch (err) {
      console.error("[action] Failed to delete product:", err);
      return { error: "Failed to delete product from Shopify." };
    }

    try {
      await prisma.skuLog.delete({ where: { id: parseInt(skuLogId) } });
    } catch (err) {
      console.error("[action] Failed to delete SkuLog entry:", err);
      return { error: "Product deleted from Shopify but failed to remove from log." };
    }

    return { deleted: true };
  }

  // --- Read metafield ---
  let metafieldData;
  try {
    const metafieldQuery = await admin.graphql(
      `#graphql
      query getShopAndSku {
        shop {
          id
          metafield(namespace: "custom", key: "next_sku") {
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

  const shop    = metafieldData.data.shop;
  const shopGid = shop.id;

  // --- Get primary location ---
  let locationId;
  try {
    const locationResponse = await admin.graphql(
      `#graphql
      query getLocation {
        locations(first: 1) {
          edges { node { id } }
        }
      }`
    );
    const locationData = await locationResponse.json();
    locationId = locationData.data.locations.edges[0]?.node?.id;
    if (!locationId) throw new Error("No location found");
  } catch (err) {
    console.error("[action] Failed to get location ID:", err);
    return { error: "Failed to get store location." };
  }

  const currentSku  = shop.metafield ? parseInt(shop.metafield.value) : DEFAULT_SKU_START;
  const skuString   = String(currentSku).padStart(6, "0");
  const titleString = `${currentSku} - `;

  console.log("[action] Shop GID:", shopGid);
  console.log("[action] Current SKU:", currentSku);
  console.log("[action] Generated by:", skuSession.username);

  // --- Create product ---
  let product;
  try {
    const productResponse = await admin.graphql(
      `#graphql
      mutation productSet($input: ProductSetInput!) {
        productSet(input: $input) {
          product { id title }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            title:  titleString,
            handle: `${PRODUCT_HANDLE_PREFIX}${skuString}`,
            status: "DRAFT",
            vendor: DEFAULT_VENDOR,
            productOptions: [
              { name: "Title", values: [{ name: "Default Title" }] },
            ],
            variants: [
              {
                sku:          skuString,
                price:        DEFAULT_PRICE,
                optionValues: [{ optionName: "Title", name: "Default Title" }],
                inventoryItem: { tracked: true },
                inventoryQuantities: [
                  { locationId, name: "available", quantity: 0 },
                ],
              },
            ],
          },
        },
      }
    );

    const productData = await productResponse.json();
    const userErrors  = productData.data.productSet.userErrors;

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
          metafields { id value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key:       METAFIELD_KEY,
              ownerId:   shopGid,
              type:      "number_integer",
              value:     String(currentSku + 1),
            },
          ],
        },
      }
    );

    const metafieldsData  = await metafieldsResponse.json();
    const metaUserErrors  = metafieldsData.data.metafieldsSet.userErrors;
    if (metaUserErrors.length > 0) {
      console.error("[action] metafieldsSet userErrors:", metaUserErrors);
    }
  } catch (err) {
    console.error("[action] Failed to increment SKU counter:", err);
  }

  // --- Write to SQLite log ---
  try {
    await prisma.skuLog.create({
      data: { sku: skuString, productId: product.id, title: titleString, imageUrl: null },
    });
  } catch (err) {
    console.error("[action] Failed to write SkuLog:", err);
  }

  // --- Trim log to 50 entries ---
  try {
    const oldest = await prisma.skuLog.findMany({
      orderBy: { createdAt: "desc" },
      skip:    LOG_PAGE_SIZE,
      select:  { id: true },
    });
    if (oldest.length > 0) {
      await prisma.skuLog.deleteMany({
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
          display:      "inline-block",
          background:   "#e8f0fe",
          color:        "#005bd3",
          fontWeight:   500,
          cursor:       "pointer",
          fontSize:     "12px",
          padding:      "3px 10px",
          borderRadius: "999px",
          border:       "1px solid #c2d4f8",
        }}
      >
        {getTimeAgo(date)}
      </span>
      {showTooltip && (
        <div style={{
          position:    "absolute",
          bottom:      "calc(100% + 6px)",
          left:        "50%",
          transform:   "translateX(-50%)",
          background:  "#1a1a1a",
          color:       "#fff",
          padding:     "5px 10px",
          borderRadius:"6px",
          fontSize:    "12px",
          whiteSpace:  "nowrap",
          zIndex:      100,
          pointerEvents: "none",
        }}>
          {exact}
        </div>
      )}
    </div>
  );
}

// ── Main Index Component ──────────────────────────────────────────────────────
export default function Index() {
  const navigate = useNavigate();

  const { skuSession, sessionChecked, handleAuthSuccess, handleSignOut } = useSkuSession();

  // --- Navigate to admin page with session ---
  function handleAdminNav() {
  const sessionId = sessionStorage.getItem("skuboo_session_id");
  console.log("handleAdminNav called, sessionId:", sessionId);
  if (!sessionId) {
    alert("Session expired. Please sign in again.");
    return;
  }
  navigate(`/app/admin?sessionId=${sessionId}`);
}

  const fetcher        = useFetcher();
  const refreshFetcher = useFetcher();

  const isRefreshing = refreshFetcher.state === "loading";
  const refreshLog   = () => refreshFetcher.load(REFRESH_ROUTE);

  const shopify    = useAppBridge();
  const loaderData = useLoaderData();
  const refreshedData = refreshFetcher.data;

  const recentSkus  = refreshedData?.recentSkus ?? loaderData?.recentSkus ?? [];
  const productMap  = refreshedData?.productMap ?? loaderData?.productMap ?? {};

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  // --- If action returns needsAuth, session expired ---
  useEffect(() => {
    if (fetcher.data?.needsAuth || refreshFetcher.data?.needsAuth) {
      handleSignOut();
    }
  }, [fetcher.data, refreshFetcher.data]);

  const generateSku = () => {
    if (!skuSession?.sessionId) return;
    fetcher.submit(
      { intent: "generate", sessionId: skuSession.sessionId },
      { method: "POST" }
    );
  };

  const openProductEditor = (productId) => {
    shopify.intents.invoke?.("edit:shopify/Product", { value: productId });
  };

  // --- Don't render until we've checked sessionStorage ---
  if (!sessionChecked) return null;

  return (
    <>
      {/* ── PIN Overlay — shown when not authenticated ── */}
      {!skuSession && (
        <PinOverlay onSuccess={handleAuthSuccess} />
      )}

      {/* ── Main App ── */}
      <s-page heading="SKU Boo">

        {/* ── User Badge Top Left ── */}
        {skuSession && (
          <UserBadge username={skuSession.username} onSignOut={handleSignOut} />
        )}

        {/* ── Admin link — only visible to admins ── */}
{skuSession?.role === "admin" && (
  <div style={{ padding: "4px 16px 0 16px" }}>
    <button
      onClick={handleAdminNav}
      style={{
        background:   "none",
        border:       "none",
        color:        "#6d7175",
        fontSize:     "11px",
        cursor:       "pointer",
        padding:      "0",
        textDecoration: "underline",
      }}
    >
      ⚙ Admin
    </button>
  </div>
)}


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
                    const live         = productMap?.[entry.productId];
                    const displayTitle = live?.title    ?? entry.title;
                    const displayImage = live?.imageUrl ?? entry.imageUrl;

                    return (
                      <s-table-row key={entry.id}>
                        <s-table-cell>
                          <div style={{ width: "60px", height: "60px", flexShrink: 0 }}>
                            {displayImage ? (
                              <img
                                src={displayImage}
                                alt={displayTitle}
                                style={{
                                  width: "60px", height: "60px",
                                  objectFit: "cover", borderRadius: "6px", display: "block",
                                }}
                              />
                            ) : (
                              <div style={{
                                width: "60px", height: "60px",
                                background: "#f1f1f1", borderRadius: "6px",
                                display: "flex", alignItems: "center",
                                justifyContent: "center", fontSize: "20px", color: "#999",
                              }}>
                                📦
                              </div>
                            )}
                          </div>
                        </s-table-cell>

                        <s-table-cell>
                          <s-box paddingBlock="small">
                            <s-text type="strong">{displayTitle}</s-text>
                          </s-box>
                        </s-table-cell>

                        <s-table-cell>
                          <TimeAgo date={entry.createdAt} />
                        </s-table-cell>

                        <s-table-cell>
                          <s-stack direction="inline" gap="small">
                            <s-button
                              variant="tertiary"
                              onClick={() => openProductEditor(entry.productId)}
                            >
                              Edit
                            </s-button>
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              onClick={() => {
                                const confirmed = window.confirm(
                                  `Delete SKU ${entry.sku}?\n\nThis will permanently remove the product from Shopify and the log. This cannot be undone.`
                                );
                                if (confirmed) {
                                  fetcher.submit(
                                    {
                                      intent:    "delete",
                                      productId: entry.productId,
                                      skuLogId:  String(entry.id),
                                      sessionId: skuSession?.sessionId ?? "",
                                    },
                                    { method: "POST" }
                                  );
                                }
                              }}
                            >
                              Delete
                            </s-button>
                          </s-stack>
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
    </>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};