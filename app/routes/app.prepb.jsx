// app/routes/app.prep.jsx

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useRouteError, useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useEffect, useRef, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

const RECENT_COUNT   = 20;
const SIDEBAR_WIDTH  = 260;

function useDebounce(fn, delay = 500) {
  const timer = useRef(null);
  return (...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  };
}
const PRODUCTS_COUNT       = 50;
const SEARCH_COUNT         = 10;
const SUGGEST_PAGE_SIZE    = 250;
const SUGGEST_AUTOLOAD_CAP = 2000;

// Normalizes a StringConnection (productVendors/productTypes/productTags) into
// the page shape usePaginatedSuggestions expects, whether it came from the
// loader's initial fetch or the "suggest-more" action.
function toSuggestionPage(conn) {
  return {
    nodes: conn?.nodes ?? [],
    hasNextPage: conn?.pageInfo?.hasNextPage ?? false,
    endCursor: conn?.pageInfo?.endCursor ?? null,
  };
}

// Static GraphQL queries for the "suggest-more" action intent — one per
// paginatable suggestion field, keyed by the field name the client sends.
const SUGGESTION_FIELD_QUERIES = {
  vendor: {
    key: "productVendors",
    query: `#graphql
      query moreVendorSuggestions($first: Int!, $after: String) {
        productVendors(first: $first, after: $after) {
          nodes
          pageInfo { hasNextPage endCursor }
        }
      }`,
  },
  type: {
    key: "productTypes",
    query: `#graphql
      query moreTypeSuggestions($first: Int!, $after: String) {
        productTypes(first: $first, after: $after) {
          nodes
          pageInfo { hasNextPage endCursor }
        }
      }`,
  },
  tag: {
    key: "productTags",
    query: `#graphql
      query moreTagSuggestions($first: Int!, $after: String) {
        productTags(first: $first, after: $after) {
          nodes
          pageInfo { hasNextPage endCursor }
        }
      }`,
  },
};

const EBAY_CONDITIONS = [
  { code: "1000", label: "New" },
  { code: "1500", label: "New Other / Open Box" },
  { code: "2750", label: "Like New" },
  { code: "2990", label: "Excellent" },
  { code: "3000", label: "Used" },
  { code: "4000", label: "Very Good" },
  { code: "5000", label: "Good" },
  { code: "6000", label: "Acceptable" },
  { code: "7000", label: "For Parts" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function aspectRatio(w, h) { const d = gcd(w, h); return `${w / d}:${h / d}`; }

function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textToHtml(text) {
  if (!text) return "";
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split("\n\n")
    .filter(p => p.trim())
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ── Validation ────────────────────────────────────────────────────────────────
function validatePrepFields({ title }) {
  const errors  = [];
  const trimmed = title?.trim() ?? "";
  const body    = /^\d+\s*[-–]\s*(.+)/.exec(trimmed);
  if (!trimmed) {
    errors.push("Title is required.");
  } else if (!body || !body[1]?.trim()) {
    errors.push("Title must have a description after the SKU number (e.g. '001234 - Blue Widget').");
  }
  return errors;
}

// ── Backend ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url          = new URL(request.url);
  const collectionId = url.searchParams.get("collectionId");
  const shop          = session.shop;

  const [colRes, suggestRes] = await Promise.all([
    admin.graphql(
      `#graphql
      query getRecentCollections($first: Int!) {
        collections(first: $first, sortKey: UPDATED_AT, reverse: true) {
          edges { node { id title productsCount { count } } }
        }
      }`,
      { variables: { first: RECENT_COUNT } }
    ),
    admin.graphql(
      `#graphql
      query getFieldSuggestions($first: Int!) {
        productVendors(first: $first) { nodes pageInfo { hasNextPage endCursor } }
        productTypes(first: $first) { nodes pageInfo { hasNextPage endCursor } }
        productTags(first: $first) { nodes pageInfo { hasNextPage endCursor } }
      }`,
      { variables: { first: SUGGEST_PAGE_SIZE } }
    ),
  ]);
  const colData           = await colRes.json();
  const recentCollections = colData.data.collections.edges.map(e => e.node);

  const suggestData       = await suggestRes.json();
  const vendorSuggestions = toSuggestionPage(suggestData.data?.productVendors);
  const typeSuggestions   = toSuggestionPage(suggestData.data?.productTypes);
  const tagSuggestions    = toSuggestionPage(suggestData.data?.productTags);

  if (!collectionId) {
    return { recentCollections, collection: null, products: [], vendorSuggestions, typeSuggestions, tagSuggestions, shop };
  }

  const prodRes = await admin.graphql(
    `#graphql
    query getCollectionProducts($id: ID!, $first: Int!) {
      collection(id: $id) {
        id title
        products(first: $first) {
          edges {
            node {
              id title vendor productType tags bodyHtml status
              category { id name }
              featuredImage { url }
              media(first: 20) {
                edges {
                  node {
                    __typename
                    ... on MediaImage { id image { url altText } }
                  }
                }
              }
              collections(first: 10) { edges { node { id title } } }
              metafield(namespace: "custom", key: "ebay_condition_id") { id value }
              variants(first: 10) {
                edges {
                  node {
                    id title price sku barcode inventoryPolicy taxable
                    selectedOptions { name value }
                    inventoryQuantity
                    inventoryItem {
                      id tracked requiresShipping
                      unitCost { amount }
                      measurement { weight { value unit } }
                      inventoryLevels(first: 5) {
                        edges {
                          node {
                            location { id name }
                            quantities(names: ["on_hand"]) { quantity }
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
    { variables: { id: collectionId, first: PRODUCTS_COUNT } }
  );
  const prodData   = await prodRes.json();
  const collection = prodData.data.collection;
  const products   = collection?.products?.edges?.map(e => e.node) ?? [];

  return { recentCollections, collection, products, vendorSuggestions, typeSuggestions, tagSuggestions, shop };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form       = await request.formData();
  const intent     = form.get("intent");

  // ── Search collections ────────────────────────────────────────────────────
  if (intent === "search") {
    try {
      const res  = await admin.graphql(
        `#graphql
        query searchCollections($query: String!, $first: Int!) {
          collections(first: $first, query: $query) {
            edges { node { id title productsCount { count } } }
          }
        }`,
        { variables: { query: form.get("query") ?? "", first: SEARCH_COUNT } }
      );
      const data = await res.json();
      return { searchResults: data.data?.collections?.edges?.map(e => e.node) ?? [] };
    } catch {
      return { searchResults: [] };
    }
  }

  // ── Search taxonomy categories ────────────────────────────────────────────
  if (intent === "search-category") {
    const search = form.get("query") ?? "";
    try {
      const res = await admin.graphql(
        `#graphql
        query searchCategories($search: String!, $first: Int!) {
          taxonomy {
            categories(first: $first, search: $search) {
              nodes { id name fullName isLeaf }
            }
          }
        }`,
        { variables: { search, first: SEARCH_COUNT } }
      );
      const data = await res.json();
      if (data.errors) return { categoryResults: [] };
      return { categoryResults: data.data.taxonomy.categories.nodes };
    } catch {
      return { categoryResults: [] };
    }
  }

  // ── Browse top-level taxonomy categories ─────────────────────────────────
  if (intent === "browse-categories") {
    try {
      const res = await admin.graphql(
        `#graphql
        query browseCategories($first: Int!) {
          taxonomy {
            categories(first: $first) {
              nodes { id name isLeaf }
            }
          }
        }`,
        { variables: { first: 30 } }
      );
      const data = await res.json();
      if (data.errors) return { categoryResults: [] };
      return { categoryResults: data.data.taxonomy.categories.nodes };
    } catch {
      return { categoryResults: [] };
    }
  }

  // ── Browse children of a taxonomy category ────────────────────────────────
  if (intent === "browse-children") {
    const parentId = form.get("parentId") ?? "";
    try {
      const res = await admin.graphql(
        `#graphql
        query browseChildren($parentId: ID!, $first: Int!) {
          taxonomy {
            categories(first: $first, childrenOf: $parentId) {
              nodes { id name isLeaf }
            }
          }
        }`,
        { variables: { parentId, first: 50 } }
      );
      const data = await res.json();
      if (data.errors) return { categoryResults: [] };
      return { categoryResults: data.data.taxonomy.categories.nodes };
    } catch {
      return { categoryResults: [] };
    }
  }

  // ── Load more field suggestions (vendor / type / tag) ─────────────────────
  if (intent === "suggest-more") {
    const field = form.get("field") ?? "";
    const after = form.get("after") || null;

    const entry = SUGGESTION_FIELD_QUERIES[field];
    if (!entry) return { suggestMoreError: "Unknown field." };

    try {
      const res  = await admin.graphql(entry.query, { variables: { first: SUGGEST_PAGE_SIZE, after } });
      const data = await res.json();
      return { suggestMore: { field, ...toSuggestionPage(data.data?.[entry.key]) } };
    } catch (err) {
      return { suggestMoreError: String(err) };
    }
  }

  // ── Stage image upload ────────────────────────────────────────────────────
  if (intent === "stage-image") {
    const file     = form.get("file");
    const filename = form.get("filename") ?? "upload.jpg";
    const mimeType = form.get("mimeType") ?? "image/jpeg";
    const fileSize = form.get("fileSize") ?? "0";

    try {
      const stageRes = await admin.graphql(
        `#graphql
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
            userErrors { field message }
          }
        }`,
        { variables: { input: [{ filename, mimeType, resource: "IMAGE", fileSize, httpMethod: "PUT" }] } }
      );
      const stageData = await stageRes.json();
      const errs = stageData.data?.stagedUploadsCreate?.userErrors ?? [];
      if (stageData.errors || errs.length > 0) {
        return { stageError: errs[0]?.message ?? "Failed to create staged upload." };
      }
      const target = stageData.data.stagedUploadsCreate.stagedTargets[0];

      // This shop's staged uploads go to Google Cloud Storage via a V4
      // query-string-signed URL (signature lives in target.url's query string,
      // only the `host` header is signed, payload is unsigned) for a PUT
      // request — not an S3-style POST policy. HTTP method is part of what's
      // cryptographically signed, so this must match httpMethod above exactly.
      const fileBuffer = await file.arrayBuffer();
      const blob = new Blob([fileBuffer], { type: mimeType });
      const paramMap = Object.fromEntries(target.parameters.map(p => [p.name, p.value]));
      const uploadHeaders = {};
      if (paramMap.content_type) uploadHeaders["Content-Type"] = paramMap.content_type;
      const uploadRes = await fetch(target.url, { method: "PUT", headers: uploadHeaders, body: blob });
      if (!uploadRes.ok) {
        const bodyText = await uploadRes.text().catch(() => "");
        const diag = `paramNames=[${Object.keys(paramMap).join(", ")}] declaredFileSize=${fileSize} actualBlobSize=${blob.size} url=${target.url}`;
        console.error("[stage-image] upload to staged target failed", uploadRes.status, bodyText, diag);
        return { stageError: `Upload failed (${uploadRes.status}): ${bodyText.slice(0, 400) || "no response body"} || DIAG: ${diag}` };
      }

      return { stagedUrl: target.resourceUrl };
    } catch (err) {
      return { stageError: String(err) };
    }
  }

  // ── Save product ──────────────────────────────────────────────────────────
  if (intent === "save") {
    const productId              = form.get("productId");
    const title                  = form.get("title");
    const vendor                 = form.get("vendor");
    const productType            = form.get("productType") ?? "";
    const status                 = form.get("status") ?? "ACTIVE";
    const tagsRaw                = form.get("tags") ?? "";
    const condition              = form.get("condition") ?? "";
    const categoryId             = form.get("categoryId") ?? "";
    const descriptionHtml        = form.get("bodyHtml") ?? "";
    const addedCollectionIds     = JSON.parse(form.get("addedCollectionIdsJson")   ?? "[]");
    const removedCollectionIds   = JSON.parse(form.get("removedCollectionIdsJson") ?? "[]");
    const removedImageIds        = JSON.parse(form.get("removedImageIdsJson")      ?? "[]");
    const imageOrderIds          = JSON.parse(form.get("imageOrderIdsJson")        ?? "[]");
    const newImageUrls           = JSON.parse(form.get("newImageUrlsJson")         ?? "[]");
    const variantsJson           = form.get("variantsJson") ?? "[]";

    const tags = tagsRaw.split(",").map(t => t.trim()).filter(Boolean);
    let variants = [];
    try { variants = JSON.parse(variantsJson); } catch { /* ignore */ }

    const errors = validatePrepFields({ title });
    if (errors.length > 0) return { saved: false, errors };

    // 1. productUpdate — title, vendor, type, tags, description, status only
    const productInput = { id: productId, title, vendor, productType, tags, descriptionHtml, status };

    const pRes   = await admin.graphql(
      `#graphql
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }`,
      { variables: { input: productInput } }
    );
    const pData   = await pRes.json();
    const pErrors = pData.data.productUpdate.userErrors;
    if (pErrors.length > 0) return { saved: false, errors: pErrors.map(e => e.message) };

    // 1b. Category — separate call using verified 2024-10+ field: product.category
    if (categoryId) {
      await admin.graphql(
        `#graphql
        mutation setCategory($productId: ID!, $categoryId: ID!) {
          productUpdate(product: { id: $productId, category: $categoryId }) {
            product { id }
            userErrors { field message }
          }
        }`,
        { variables: { productId, categoryId } }
      ).catch(err => console.error("[prep] category set failed:", err));
    }

    // 2. Condition metafield
    if (condition) {
      await admin.graphql(
        `#graphql
        mutation setCondition($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
        { variables: { metafields: [{ ownerId: productId, namespace: "custom", key: "ebay_condition_id", type: "single_line_text_field", value: condition }] } }
      ).catch(err => console.error("[prep] condition failed:", err));
    }

    // 3. Variant price + barcode + inventory policy + taxable (SKU is managed via inventoryItemUpdate in step 4)
    const variantInputs = variants
      .map(v => {
        const input = { id: v.id };
        if (v.price !== "" && v.price != null) input.price = v.price;
        if (v.barcode != null) input.barcode = v.barcode;
        if (v.inventoryPolicy) input.inventoryPolicy = v.inventoryPolicy;
        if (typeof v.taxable === "boolean") input.taxable = v.taxable;
        return input;
      })
      .filter(v => Object.keys(v).length > 1); // skip if only id (nothing to update)
    if (variantInputs.length > 0) {
      try {
        const varRes  = await admin.graphql(
          `#graphql
          mutation updateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
          { variables: { productId, variants: variantInputs } }
        );
        const varData   = await varRes.json();
        const varErrors = varData.data?.productVariantsBulkUpdate?.userErrors ?? [];
        if (varErrors.length > 0) {
          return { saved: false, errors: varErrors.map(e => e.message) };
        }
      } catch (err) {
        console.error("[prep] variant update failed:", err);
        return { saved: false, errors: ["Failed to update variant price."] };
      }
    }

    // 4. Per-variant SKU + weight + tracked + inventory qty + cost
    const invErrors = [];
    for (const v of variants) {
      if (!v.inventoryItemId) continue;
      const invInput = {};
      if (v.sku != null) invInput.sku = v.sku;
      if (v.weightValue) invInput.measurement = { weight: { value: parseFloat(v.weightValue), unit: v.weightUnit || "GRAMS" } };
      if (typeof v.tracked === "boolean") invInput.tracked = v.tracked;
      if (v.costPerItem !== "" && v.costPerItem != null) invInput.cost = v.costPerItem;
      if (typeof v.requiresShipping === "boolean") invInput.requiresShipping = v.requiresShipping;
      if (Object.keys(invInput).length > 0) {
        try {
          const r    = await admin.graphql(
            `#graphql
            mutation updateInvItem($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) { userErrors { field message } }
            }`,
            { variables: { id: v.inventoryItemId, input: invInput } }
          );
          const d    = await r.json();
          const errs = d.data?.inventoryItemUpdate?.userErrors ?? [];
          if (errs.length > 0) invErrors.push(...errs.map(e => e.message));
        } catch (err) {
          invErrors.push("Weight/tracked update failed: " + String(err).split("\n")[0]);
        }
      }
      if (v.locationId && v.inventoryQty != null) {
        try {
          const r    = await admin.graphql(
            `#graphql
            mutation setInventory($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) { userErrors { field message } }
            }`,
            { variables: { input: { name: "on_hand", reason: "correction", ignoreCompareQuantity: true, quantities: [{ inventoryItemId: v.inventoryItemId, locationId: v.locationId, quantity: parseInt(v.inventoryQty, 10) }] } } }
          );
          const d    = await r.json();
          const errs = d.data?.inventorySetQuantities?.userErrors ?? [];
          if (errs.length > 0) invErrors.push(...errs.map(e => e.message));
        } catch (err) {
          invErrors.push("Inventory quantity update failed: " + String(err).split("\n")[0]);
        }
      }
    }
    if (invErrors.length > 0) {
      return { saved: true, inventoryErrors: invErrors };
    }

    // 5. Collections — add
    for (const collectionId of addedCollectionIds) {
      await admin.graphql(
        `#graphql
        mutation addToCollection($id: ID!, $productIds: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $productIds) { userErrors { field message } }
        }`,
        { variables: { id: collectionId, productIds: [productId] } }
      ).catch(err => console.error("[prep] addCollection failed:", err));
    }

    // 5. Collections — remove
    for (const collectionId of removedCollectionIds) {
      await admin.graphql(
        `#graphql
        mutation removeFromCollection($id: ID!, $productIds: [ID!]!) {
          collectionRemoveProducts(id: $id, productIds: $productIds) { userErrors { field message } }
        }`,
        { variables: { id: collectionId, productIds: [productId] } }
      ).catch(err => console.error("[prep] removeCollection failed:", err));
    }

    // 6. Images — delete
    if (removedImageIds.length > 0) {
      await admin.graphql(
        `#graphql
        mutation deleteMedia($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { deletedMediaIds userErrors { field message } }
        }`,
        { variables: { productId, mediaIds: removedImageIds } }
      ).catch(err => console.error("[prep] deleteMedia failed:", err));
    }

    // 6. Images — add
    let createdMedia = [];
    if (newImageUrls.length > 0) {
      try {
        const mediaRes = await admin.graphql(
          `#graphql
          mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $productId, media: $media) {
              media { id ... on MediaImage { image { url } } }
              userErrors { field message }
            }
          }`,
          { variables: { productId, media: newImageUrls.map(url => ({ originalSource: url, mediaContentType: "IMAGE" })) } }
        );
        const mediaData = await mediaRes.json();
        createdMedia = mediaData.data?.productCreateMedia?.media ?? [];
      } catch (err) {
        console.error("[prep] createMedia failed:", err);
      }
    }

    // 6. Images — reorder
    if (imageOrderIds.length > 1) {
      await admin.graphql(
        `#graphql
        mutation reorderMedia($id: ID!, $moves: [MoveInput!]!) {
          productReorderMedia(id: $id, moves: $moves) { userErrors { field message } }
        }`,
        { variables: { id: productId, moves: imageOrderIds.map((id, idx) => ({ id, newPosition: String(idx) })) } }
      ).catch(err => console.error("[prep] reorderMedia failed:", err));
    }

    return { saved: true, newMedia: createdMedia.map(m => ({ id: m.id, url: m.image?.url ?? null })) };
  }

  // ── Remove product from collection ───────────────────────────────────────
  if (intent === "remove-from-collection") {
    const collectionId = form.get("collectionId") ?? "";
    const productId    = form.get("productId") ?? "";
    try {
      await admin.graphql(
        `#graphql
        mutation removeFromColl($id: ID!, $productIds: [ID!]!) {
          collectionRemoveProducts(id: $id, productIds: $productIds) {
            userErrors { field message }
          }
        }`,
        { variables: { id: collectionId, productIds: [productId] } }
      );
      return { removedFromCollection: true, productId };
    } catch (err) {
      return { removeError: String(err) };
    }
  }

  // ── Search products ───────────────────────────────────────────────────────
  if (intent === "search-products") {
    const q = form.get("query") ?? "";
    try {
      const res = await admin.graphql(
        `#graphql
        query searchProducts($query: String!, $first: Int!) {
          products(first: $first, query: $query) {
            edges { node {
              id title
              featuredImage { url }
              variants(first: 1) { edges { node { sku price } } }
            }}
          }
        }`,
        { variables: { query: q, first: 10 } }
      );
      const data = await res.json();
      return { productResults: data.data?.products?.edges?.map(e => e.node) ?? [] };
    } catch (err) {
      return { productResults: [] };
    }
  }

  // ── Add products to collection ────────────────────────────────────────────
  if (intent === "add-products") {
    const collectionId = form.get("collectionId") ?? "";
    const productIds   = JSON.parse(form.get("productIdsJson") ?? "[]");
    if (!collectionId || productIds.length === 0) return { addError: "Missing data." };
    try {
      const res = await admin.graphql(
        `#graphql
        mutation addProducts($id: ID!, $productIds: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $productIds) {
            userErrors { field message }
          }
        }`,
        { variables: { id: collectionId, productIds } }
      );
      const data = await res.json();
      const errs = data.data?.collectionAddProducts?.userErrors ?? [];
      if (errs.length > 0) return { addError: errs[0].message };
      return { addedProducts: true };
    } catch (err) {
      return { addError: String(err) };
    }
  }

  // ── Create collection ─────────────────────────────────────────────────────
  if (intent === "create-collection") {
    const title = form.get("title") ?? "";
    if (!title.trim()) return { createError: "Collection name is required." };
    try {
      const res = await admin.graphql(
        `#graphql
        mutation createCollection($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id title productsCount { count } }
            userErrors { field message }
          }
        }`,
        { variables: { input: { title: title.trim() } } }
      );
      const data = await res.json();
      const errs = data.data?.collectionCreate?.userErrors ?? [];
      if (errs.length > 0) return { createError: errs[0].message };
      return { createdCollection: data.data.collectionCreate.collection };
    } catch (err) {
      return { createError: String(err) };
    }
  }

  return { error: "Unknown intent" };
};

// ── TagEditor ─────────────────────────────────────────────────────────────────
function TagEditor({ tags, onChange, suggestions = [], hasNextPage = false, loading = false, onLoadMore }) {
  const [input, setInput] = useState("");
  const [open, setOpen]   = useState(false);
  const wrapRef           = useRef(null);
  const suppressBlurAdd   = useRef(false);

  function add(raw) {
    const trimmed = raw.trim().replace(/,$/, "");
    if (trimmed && !tags.includes(trimmed)) onChange([...tags, trimmed]);
    setInput("");
  }

  function remove(tag) { onChange(tags.filter(t => t !== tag)); }

  function selectSuggestion(tag) {
    suppressBlurAdd.current = true;
    add(tag);
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input); setOpen(false); }
    if (e.key === "Backspace" && input === "" && tags.length > 0) remove(tags[tags.length - 1]);
    if (e.key === "Escape") setOpen(false);
  }

  // Close suggestion panel on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const filtered = suggestions
    .filter(s => !tags.includes(s))
    .filter(s => !input.trim() || s.toLowerCase().includes(input.trim().toLowerCase()));

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={sx.bubbleBox}>
        {tags.map(tag => (
          <span key={tag} style={sx.tagBubble}>
            {tag}
            <button style={sx.bubbleX} onClick={() => remove(tag)}>×</button>
          </span>
        ))}
        <input
          aria-label="Add tag"
          style={sx.bubbleInput}
          value={input}
          onChange={e => { setInput(e.currentTarget.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (suppressBlurAdd.current) { suppressBlurAdd.current = false; return; }
            if (input.trim()) add(input);
          }}
          placeholder={tags.length === 0 ? "Add tag…" : ""}
        />
      </div>
      {open && (filtered.length > 0 || hasNextPage || (input.trim() && !tags.includes(input.trim()))) && (
        <div style={sx.dropdown}>
          {input.trim() && !tags.includes(input.trim()) && (
            <div style={{ ...sx.dropItemBtn, fontWeight: 600 }} onMouseDown={() => selectSuggestion(input.trim())}>
              Add &quot;{input.trim()}&quot;
            </div>
          )}
          {filtered.map(s => (
            <div key={s} style={sx.dropItemBtn} onMouseDown={() => selectSuggestion(s)}>{s}</div>
          ))}
          {hasNextPage && (
            <div
              style={{ ...sx.dropItemBtn, ...sx.dropLoadMore, borderBottom: "none" }}
              onMouseDown={e => { e.preventDefault(); onLoadMore?.(); }}
            >
              {loading ? "Loading…" : "Load more"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── usePaginatedSuggestions — cursor-paginated, store-wide suggestion list ────
// Shared at the Prep page level (like allSkus) rather than per-row: vendor/type/
// tag values aren't per-product, so every row should see the same loaded pages.
function usePaginatedSuggestions(field, initialPage) {
  const fetcher = useFetcher();
  const [state, setState] = useState({
    nodes: initialPage.nodes,
    hasNextPage: initialPage.hasNextPage,
    endCursor: initialPage.endCursor,
  });

  useEffect(() => {
    const result = fetcher.data?.suggestMore;
    if (!result || result.field !== field) return;
    setState(prev => ({
      nodes: [...new Set([...prev.nodes, ...result.nodes])],
      hasNextPage: result.hasNextPage,
      endCursor: result.endCursor,
    }));
  }, [fetcher.data, field]);

  function loadMore() {
    if (!state.hasNextPage || fetcher.state !== "idle") return;
    fetcher.submit({ intent: "suggest-more", field, after: state.endCursor ?? "" }, { method: "POST" });
  }

  // Auto-walk every page in the background (typing should be able to search
  // the whole store, not just whatever's been manually loaded) up to a safety
  // cap, past which "Load more" becomes a manual fallback for huge stores.
  useEffect(() => {
    if (!state.hasNextPage) return;
    if (state.nodes.length >= SUGGEST_AUTOLOAD_CAP) return;
    if (fetcher.state !== "idle") return;
    loadMore();
  }, [state.hasNextPage, state.nodes.length, fetcher.state]);

  return { nodes: state.nodes, hasNextPage: state.hasNextPage, loading: fetcher.state !== "idle", loadMore };
}

// ── SuggestField — text field with a filtered, paginated suggestion dropdown ──
function SuggestField({ label, value, onChange, suggestions = [], placeholder, hasNextPage = false, loading = false, onLoadMore }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const filtered = suggestions
    .filter(s => s !== value)
    .filter(s => !value.trim() || s.toLowerCase().includes(value.trim().toLowerCase()));

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <s-text-field
        label={label}
        labelAccessibilityVisibility="exclusive"
        value={value}
        onInput={e => { onChange(e.currentTarget.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
      />
      {open && (filtered.length > 0 || hasNextPage) && (
        <div style={sx.dropdown}>
          {filtered.map(s => (
            <div key={s} style={sx.dropItemBtn} onMouseDown={() => { onChange(s); setOpen(false); }}>{s}</div>
          ))}
          {hasNextPage && (
            <div
              style={{ ...sx.dropItemBtn, ...sx.dropLoadMore, borderBottom: "none" }}
              onMouseDown={e => { e.preventDefault(); onLoadMore?.(); }}
            >
              {loading ? "Loading…" : "Load more"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CollectionEditor ──────────────────────────────────────────────────────────
function CollectionEditor({ collections, onChange }) {
  const fetcher   = useFetcher();
  const [query, setQuery] = useState("");
  const results   = fetcher.data?.searchResults ?? null;
  const searching = fetcher.state !== "idle";

  const debouncedSearch = useDebounce(val => {
    if (val.trim().length >= 2) fetcher.submit({ intent: "search", query: val }, { method: "POST" });
  });

  function handleQuery(e) {
    const val = e.target.value;
    setQuery(val);
    debouncedSearch(val);
  }

  function add(c) {
    if (!collections.find(col => col.id === c.id)) onChange([...collections, c]);
    setQuery("");
  }
  function remove(id) { onChange(collections.filter(c => c.id !== id)); }

  return (
    <div>
      <div style={sx.bubbleBox}>
        {collections.map(c => (
          <span key={c.id} style={sx.collectionBubble}>
            {c.title}
            <button style={sx.bubbleX} onClick={() => remove(c.id)}>×</button>
          </span>
        ))}
        <input
          style={sx.bubbleInput}
          value={query}
          onChange={handleQuery}
          placeholder={collections.length === 0 ? "Add to collection…" : ""}
        />
      </div>
      {query.length >= 2 && (
        <div style={{ position: "relative" }}>
          <div style={sx.dropdown}>
            {searching && <div style={sx.dropItem}>Searching…</div>}
            {!searching && results?.length === 0 && <div style={sx.dropItem}>No results.</div>}
            {!searching && results
              ?.filter(r => !collections.find(c => c.id === r.id))
              .map(r => (
                <div key={r.id} style={sx.dropItemBtn} onMouseDown={() => add(r)}>
                  {r.title}
                  <span style={{ color: "#6d7175", marginLeft: 6, fontSize: 11 }}>
                    {r.productsCount?.count ?? 0} products
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── RichTextEditor — TipTap rich text editor ─────────────────────────────────
function RichTextEditor({ content, onChange }) {
  const prevContent = useRef(content);

  const editor = useEditor({
    extensions: [StarterKit],
    content: content || "",
    immediatelyRender: false,
    onUpdate({ editor }) {
      const html = editor.getHTML();
      prevContent.current = html; // mark as editor-originated so useEffect skips it
      onChange(html);
    },
  });

  // Sync only when content changes from outside (Discard, row switch, etc.)
  useEffect(() => {
    if (!editor) return;
    if (content !== prevContent.current) {
      prevContent.current = content;
      editor.commands.setContent(content || "", false);
    }
  }, [content, editor]);

  const btn = (label, action, active) => (
    <button
      key={label}
      onMouseDown={e => { e.preventDefault(); action(); }}
      style={{
        ...sx.rteBtn,
        background: active ? "#e3e5e8" : "transparent",
        fontWeight: label === "B" ? 700 : label === "I" ? undefined : undefined,
        fontStyle:  label === "I" ? "italic" : undefined,
      }}
      title={label}
    >
      {label}
    </button>
  );

  return (
    <div style={sx.rteWrap}>
      {/* Toolbar */}
      <div style={sx.rteToolbar}>
        {editor && (<>
          {btn("B",  () => editor.chain().focus().toggleBold().run(),        editor.isActive("bold"))}
          {btn("I",  () => editor.chain().focus().toggleItalic().run(),      editor.isActive("italic"))}
          {btn("S",  () => editor.chain().focus().toggleStrike().run(),      editor.isActive("strike"))}
          <span style={sx.rteSep} />
          {btn("H1", () => editor.chain().focus().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
          {btn("H2", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
          {btn("H3", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
          <span style={sx.rteSep} />
          {btn("• List",  () => editor.chain().focus().toggleBulletList().run(),  editor.isActive("bulletList"))}
          {btn("1. List", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"))}
          <span style={sx.rteSep} />
          {btn("❝",  () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"))}
          {btn("—",  () => editor.chain().focus().setHorizontalRule().run(), false)}
          {btn("↩",  () => editor.chain().focus().setHardBreak().run(), false)}
          <span style={sx.rteSep} />
          {btn("↺",  () => editor.chain().focus().undo().run(), false)}
          {btn("↻",  () => editor.chain().focus().redo().run(), false)}
        </>)}
      </div>
      {/* Editor area */}
      <div style={sx.rteContent}>
        <style>{`
          .ProseMirror { outline: none; }
          .ProseMirror p { margin: 0 0 8px; }
          .ProseMirror p:last-child { margin-bottom: 0; }
          .ProseMirror h1 { font-size: 1.6em; font-weight: 700; margin: 0 0 8px; }
          .ProseMirror h2 { font-size: 1.3em; font-weight: 700; margin: 0 0 8px; }
          .ProseMirror h3 { font-size: 1.1em; font-weight: 700; margin: 0 0 8px; }
          .ProseMirror ul, .ProseMirror ol { padding-left: 1.4em; margin: 0 0 8px; }
          .ProseMirror li { margin-bottom: 2px; }
          .ProseMirror blockquote { border-left: 3px solid #c9cccf; padding-left: 12px; margin: 0 0 8px; color: #6d7175; }
          .ProseMirror hr { border: none; border-top: 2px solid #e1e3e5; margin: 12px 0; }
          .ProseMirror strong { font-weight: 700; }
          .ProseMirror em { font-style: italic; }
          .ProseMirror s { text-decoration: line-through; }
          .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; color: #adb5bd; pointer-events: none; height: 0; }
        `}</style>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// ── CategoryEditor — tree browser + search ────────────────────────────────────
function CategoryEditor({ category, onChange }) {
  const browseF  = useFetcher();
  const searchF  = useFetcher();
  const panelRef = useRef(null);
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  // stack = [{ id, name }, ...] — trail of drilled-in categories
  const [stack, setStack] = useState([]);

  // On open: if category already selected, search for it; else load root browse
  useEffect(() => {
    if (!open) return;
    if (category.id) {
      setQuery(category.name);
      searchF.submit({ intent: "search-category", query: category.name }, { method: "POST" });
    } else if (stack.length === 0 && browseF.state === "idle" && !browseF.data) {
      browseF.submit({ intent: "browse-categories" }, { method: "POST" });
    }
  }, [open]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
        setStack([]);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const debouncedCategorySearch = useDebounce(val => {
    if (val.trim().length >= 2) searchF.submit({ intent: "search-category", query: val }, { method: "POST" });
  });

  function handleQuery(e) {
    const val = e.target.value;
    setQuery(val);
    debouncedCategorySearch(val);
  }

  function drillIn(cat) {
    const newStack = [...stack, { id: cat.id, name: cat.name }];
    setStack(newStack);
    browseF.submit({ intent: "browse-children", parentId: cat.id }, { method: "POST" });
  }

  function drillOut() {
    const newStack = stack.slice(0, -1);
    setStack(newStack);
    if (newStack.length === 0) {
      browseF.submit({ intent: "browse-categories" }, { method: "POST" });
    } else {
      browseF.submit({ intent: "browse-children", parentId: newStack[newStack.length - 1].id }, { method: "POST" });
    }
  }

  function select(cat) {
    onChange({ id: cat.id, name: cat.name });
    setOpen(false);
    setQuery("");
    setStack([]);
  }

  function clear(e) {
    e.stopPropagation();
    onChange({ id: "", name: "" });
  }

  const isSearchMode = query.trim().length >= 2;
  const loading  = isSearchMode ? searchF.state !== "idle" : browseF.state !== "idle";
  const results  = isSearchMode
    ? (searchF.data?.categoryResults ?? [])
    : (browseF.data?.categoryResults ?? []);

  return (
    <div ref={panelRef} style={{ position: "relative" }}>
      {/* Read-only trigger */}
      <div style={{ position: "relative" }}>
        <s-text-field
          label="Category"
          labelAccessibilityVisibility="exclusive"
          style={{ cursor: "pointer" }}
          value={category.name || ""}
          readOnly
          onClick={() => setOpen(v => !v)}
          placeholder="Select category…"
        />
        {/* Shadow-DOM readonly fill/text can't be restyled directly — an opaque
            cover hides both, then a custom dark text layer redraws the value
            on top, decoupling text color from the background fix. */}
        <div style={{ position: "absolute", inset: 0, background: "#fbfbfc", borderRadius: 6, pointerEvents: "none" }} />
        {category.name && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center",
            paddingLeft: 12, paddingRight: 32, fontSize: 13, color: "#202223",
            pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {category.name}
          </div>
        )}
        {category.id && (
          <button style={sx.inlineClearBtn} onMouseDown={clear}>×</button>
        )}
      </div>

      {/* Panel */}
      {open && (
        <div style={sx.categoryPanel}>
          {/* Search input */}
          <div style={{ padding: "8px 8px 4px", borderBottom: "1px solid #f1f1f1" }}>
            <s-text-field
              label="Search categories"
              labelAccessibilityVisibility="exclusive"
              value={query}
              onInput={handleQuery}
              placeholder="Search categories…"
              autoFocus
            />
          </div>

          {/* Breadcrumb trail when drilled in (browse mode only) */}
          {!isSearchMode && stack.length > 0 && (
            <div style={sx.catBreadcrumb}>
              <button style={sx.catBackBtn} onMouseDown={drillOut}>← Back</button>
              <span style={{ fontSize: 11, color: "#6d7175", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {stack.map(s => s.name).join(" › ")}
              </span>
            </div>
          )}

          {/* Category list */}
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {loading && <div style={sx.dropItem}>Loading…</div>}
            {!loading && results.length === 0 && (
              <div style={sx.dropItem}>{isSearchMode ? "No results." : "No categories found."}</div>
            )}
            {!loading && results.map(c => (
              <div
                key={c.id}
                style={sx.catRow}
                onMouseDown={() => (isSearchMode || c.isLeaf) ? select(c) : drillIn(c)}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13 }}>{c.name}</span>
                  {isSearchMode && c.fullName && c.fullName !== c.name && (
                    <span style={{ fontSize: 11, color: "#6d7175", display: "block", marginTop: 1 }}>{c.fullName}</span>
                  )}
                </span>
                {!isSearchMode && !c.isLeaf && (
                  <span style={{ color: "#6d7175", fontSize: 14, paddingLeft: 8, flexShrink: 0 }}>›</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ImageManager — drag-to-reorder, file upload, X top-right ──────────────────
function ImageManager({ images, onUpdate }) {
  const uploadFetcher     = useFetcher();
  const fileInputRef      = useRef(null);
  const pendingPreviewRef = useRef(null);
  const dragSrcRef        = useRef(null);
  const [dragOver, setDragOver]     = useState(null);
  const [uploading, setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState("");

  // Handle staged upload response
  useEffect(() => {
    if (uploadFetcher.data?.stagedUrl && pendingPreviewRef.current) {
      onUpdate([...images, {
        id: null,
        url: pendingPreviewRef.current,
        altText: "",
        isNew: true,
        sourceUrl: uploadFetcher.data.stagedUrl,
      }]);
      pendingPreviewRef.current = null;
      setUploading(false);
    }
    if (uploadFetcher.data?.stageError) {
      setUploadError(uploadFetcher.data.stageError);
      pendingPreviewRef.current = null;
      setUploading(false);
    }
  }, [uploadFetcher.data]);

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setUploadError("Please select an image file."); return; }
    setUploadError("");
    setUploading(true);
    pendingPreviewRef.current = URL.createObjectURL(file);

    const fd = new FormData();
    fd.append("intent",   "stage-image");
    fd.append("file",     file);
    fd.append("filename", file.name);
    fd.append("mimeType", file.type);
    fd.append("fileSize", String(file.size));
    uploadFetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
    e.target.value = "";
  }

  function remove(idx) { onUpdate(images.filter((_, i) => i !== idx)); }

  function handleDragStart(e, idx) {
    dragSrcRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  }
  function handleDragOver(e, idx) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(idx);
  }
  function handleDrop(e, idx) {
    e.preventDefault();
    setDragOver(null);
    const src = dragSrcRef.current;
    if (src == null || src === idx) return;
    const next = [...images];
    const [moved] = next.splice(src, 1);
    next.splice(idx, 0, moved);
    onUpdate(next);
    dragSrcRef.current = null;
  }
  function handleDragEnd() { setDragOver(null); dragSrcRef.current = null; }

  const featured = images[0] ?? null;
  const [lbIndex, setLbIndex]   = useState(null);
  const [lbZoomed, setLbZoomed] = useState(false);
  const [imgRatios, setImgRatios] = useState({});

  function handleImgLoad(e, url) {
    const { naturalWidth: w, naturalHeight: h } = e.target;
    if (w && h) setImgRatios(prev => ({ ...prev, [url]: aspectRatio(w, h) }));
  }

  function openLightbox(idx) { setLbIndex(idx); setLbZoomed(false); }
  function closeLightbox()   { setLbIndex(null); setLbZoomed(false); }
  function lbPrev()          { setLbIndex(i => (i - 1 + images.length) % images.length); setLbZoomed(false); }
  function lbNext()          { setLbIndex(i => (i + 1) % images.length); setLbZoomed(false); }

  useEffect(() => {
    if (lbIndex === null) return;
    const onKey = e => {
      if (e.key === "Escape")     closeLightbox();
      if (e.key === "ArrowLeft")  lbPrev();
      if (e.key === "ArrowRight") lbNext();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lbIndex, images.length]);

  return (
    <>
      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileChange} />

      {/* Featured image + thumbnail strip */}
      <div style={sx.mediaInner}>

        {/* Featured (first) image */}
        <div
          style={{
            ...sx.mediaFeatured,
            outline: dragOver === 0 ? "2px dashed #005bd3" : "none",
            background: featured ? "#000" : "#f6f6f7",
          }}
          draggable={!!featured}
          onDragStart={e => featured && handleDragStart(e, 0)}
          onDragOver={e => handleDragOver(e, 0)}
          onDragLeave={() => setDragOver(null)}
          onDrop={e => handleDrop(e, 0)}
          onDragEnd={handleDragEnd}
        >
          {featured ? (
            <>
              <img
                src={featured.url}
                alt={featured.altText || ""}
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", cursor: "zoom-in" }}
                onClick={() => openLightbox(0)}
                onLoad={e => handleImgLoad(e, featured.url)}
                onError={e => { e.target.style.opacity = "0.3"; }}
              />
              {featured.isNew && <div style={sx.imgNewBadge}>New</div>}
              {imgRatios[featured.url] && <div style={sx.imgRatioBadge}>{imgRatios[featured.url]}</div>}
              <button style={sx.imgXBtn} onClick={() => remove(0)} title="Remove">✕</button>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "#8c9196" }}>
              <span style={{ fontSize: 32 }}>🖼</span>
              <span style={{ fontSize: 13 }}>No images</span>
            </div>
          )}
        </div>

        {/* Thumbnail grid + add tile */}
        <div style={sx.mediaThumbs}>
          {images.slice(1).map((img, i) => {
            const idx = i + 1;
            return (
              <div
                key={img.id ?? img.sourceUrl ?? idx}
                draggable
                onDragStart={e => handleDragStart(e, idx)}
                onDragOver={e => handleDragOver(e, idx)}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => handleDrop(e, idx)}
                onDragEnd={handleDragEnd}
                style={{
                  ...sx.mediaThumbCell,
                  opacity: dragOver === idx ? 0.5 : 1,
                  outline: dragOver === idx ? "2px dashed #005bd3" : "none",
                  cursor: "grab",
                }}
              >
                <img
                  src={img.url}
                  alt={img.altText || ""}
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", cursor: "zoom-in" }}
                  onClick={e => { e.stopPropagation(); openLightbox(idx); }}
                  onLoad={e => handleImgLoad(e, img.url)}
                  onError={e => { e.target.style.opacity = "0.3"; }}
                />
                {img.isNew && <div style={sx.imgNewBadge}>New</div>}
                {imgRatios[img.url] && <div style={sx.imgRatioBadge}>{imgRatios[img.url]}</div>}
                <button style={sx.imgXBtn} onClick={() => remove(idx)} title="Remove">✕</button>
              </div>
            );
          })}

          {/* Upload tile */}
          <button
            style={{ ...sx.mediaAddTile, opacity: uploading ? 0.6 : 1, cursor: uploading ? "default" : "pointer" }}
            onClick={() => !uploading && fileInputRef.current?.click()}
            disabled={uploading}
            title="Upload image"
          >
            {uploading ? <span style={{ fontSize: 11, color: "#6d7175" }}>…</span> : <span style={{ fontSize: 22, color: "#8c9196" }}>+</span>}
          </button>
        </div>
      </div>

      {/* Error / hint row */}
      {(uploadError || images.length > 1) && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10 }}>
          {uploadError && <span style={{ fontSize: 12, color: "#d82c0d" }}>{uploadError}</span>}
          {images.length > 1 && !uploadError && <span style={{ fontSize: 11, color: "#8c9196" }}>Drag to reorder · click to view</span>}
        </div>
      )}

      {/* Lightbox */}
      {lbIndex !== null && images[lbIndex] && (
        <div
          style={{
            ...sx.lightboxOverlay,
            overflowY: lbZoomed ? "auto" : "hidden",
            alignItems: lbZoomed ? "flex-start" : "center",
            justifyContent: lbZoomed ? "center" : "center",
            cursor: lbZoomed ? "zoom-out" : "default",
          }}
          onClick={closeLightbox}
        >
          {/* Close */}
          <button style={sx.lightboxClose} onClick={e => { e.stopPropagation(); closeLightbox(); }}>✕</button>

          {/* Prev arrow */}
          {images.length > 1 && (
            <button style={{ ...sx.lightboxNav, left: 16 }} onClick={e => { e.stopPropagation(); lbPrev(); }}>‹</button>
          )}

          {/* Image */}
          <img
            src={images[lbIndex].url}
            alt=""
            style={{
              display: "block",
              borderRadius: lbZoomed ? 0 : 8,
              boxShadow: lbZoomed ? "none" : "0 8px 40px rgba(0,0,0,0.6)",
              cursor: lbZoomed ? "zoom-out" : "zoom-in",
              ...(lbZoomed
                ? { width: "auto", height: "auto", maxWidth: "none", maxHeight: "none", margin: "40px auto" }
                : { maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain" }
              ),
            }}
            onClick={e => { e.stopPropagation(); setLbZoomed(z => !z); }}
          />

          {/* Next arrow */}
          {images.length > 1 && (
            <button style={{ ...sx.lightboxNav, right: 16 }} onClick={e => { e.stopPropagation(); lbNext(); }}>›</button>
          )}

          {/* Counter */}
          {images.length > 1 && (
            <div style={sx.lightboxCounter}>{lbIndex + 1} / {images.length}</div>
          )}
        </div>
      )}
    </>
  );
}

// ── Field wrapper ─────────────────────────────────────────────────────────────
function Field({ label, children, span }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: span ? "1 / -1" : undefined }}>
      <label style={sx.label}>{label}</label>
      {children}
    </div>
  );
}

// ── Variant state init ────────────────────────────────────────────────────────
function initVariantEdits(product) {
  const edits = {};
  for (const edge of product.variants?.edges ?? []) {
    const v          = edge.node;
    const invItem    = v.inventoryItem;
    const weight     = invItem?.measurement?.weight;
    const firstLevel = invItem?.inventoryLevels?.edges?.[0]?.node;
    edits[v.id] = {
      sku:             v.sku             ?? "",
      price:           v.price           ?? "",
      weightValue:     weight?.value != null ? String(weight.value) : "",
      weightUnit:      weight?.unit       ?? "GRAMS",
      tracked:         invItem?.tracked   ?? false,
      inventoryQty:    firstLevel?.quantities?.[0]?.quantity ?? 0,
      locationId:      firstLevel?.location?.id   ?? null,
      locationName:    firstLevel?.location?.name ?? null,
      inventoryItemId: invItem?.id ?? null,
      barcode:          v.barcode ?? "",
      inventoryPolicy:  v.inventoryPolicy ?? "DENY",
      costPerItem:      invItem?.unitCost?.amount ?? "",
      taxable:          v.taxable ?? true,
      requiresShipping: invItem?.requiresShipping ?? true,
    };
  }
  return edits;
}

// ── ProductRow ────────────────────────────────────────────────────────────────
function ProductRow({
  product, shop, allSkus,
  vendorSuggestions, vendorSuggestionsHasMore, vendorSuggestionsLoading, onLoadMoreVendors,
  typeSuggestions, typeSuggestionsHasMore, typeSuggestionsLoading, onLoadMoreTypes,
  tagSuggestions, tagSuggestionsHasMore, tagSuggestionsLoading, onLoadMoreTags,
  collectionId, onRemoved, highlighted,
}) {
  const REMOVE_DELAY_MS = 3500;
  const fetcher       = useFetcher();
  const removeFetcher  = useFetcher();
  const removeTimerRef = useRef(null);
  const removeIntervalRef = useRef(null);
  const [open, setOpen]             = useState(false);
  const [removed, setRemoved]       = useState(false);
  const [pendingRemove, setPending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(REMOVE_DELAY_MS / 1000));
  const savingRef = useRef(null);

  useEffect(() => {
    if (removeFetcher.data?.removedFromCollection) { setRemoved(true); onRemoved?.(); }
  }, [removeFetcher.data]);

  useEffect(() => () => clearInterval(removeIntervalRef.current), []);

  function handleRemove(e) {
    e.stopPropagation();
    setPending(true);
    setSecondsLeft(Math.ceil(REMOVE_DELAY_MS / 1000));
    const startedAt = Date.now();
    removeIntervalRef.current = setInterval(() => {
      const remaining = REMOVE_DELAY_MS - (Date.now() - startedAt);
      setSecondsLeft(Math.max(0, Math.ceil(remaining / 1000)));
    }, 200);
    removeTimerRef.current = setTimeout(() => {
      clearInterval(removeIntervalRef.current);
      removeFetcher.submit(
        { intent: "remove-from-collection", collectionId, productId: product.id },
        { method: "POST" }
      );
    }, REMOVE_DELAY_MS);
  }

  function handleUndoRemove(e) {
    e.stopPropagation();
    clearTimeout(removeTimerRef.current);
    clearInterval(removeIntervalRef.current);
    setPending(false);
  }

  // Product-level fields
  const initProductFields = {
    title:       product.title            ?? "",
    vendor:      product.vendor           ?? "",
    productType: product.productType      ?? "",
    condition:   product.metafield?.value ?? "",
    bodyHtml:    product.bodyHtml ?? "",
    status:      product.status           ?? "ACTIVE",
  };
  const [productFields, setProductFields]         = useState({ ...initProductFields });
  const [baseProductFields, setBaseProductFields] = useState({ ...initProductFields });

  // Tags
  const [tags, setTags]         = useState(product.tags ?? []);
  const [baseTags, setBaseTags] = useState(product.tags ?? []);

  // Collections
  const initCollections = product.collections?.edges?.map(e => e.node) ?? [];
  const [collections, setCollections]         = useState(initCollections);
  const [baseCollections, setBaseCollections] = useState(initCollections);

  // Category
  const initCategory = { id: product.category?.id ?? "", name: product.category?.name ?? "" };
  const [category, setCategory]         = useState(initCategory);
  const [baseCategory, setBaseCategory] = useState(initCategory);

  // Images
  const parseImages = () =>
    (product.media?.edges ?? [])
      .map(e => e.node)
      .filter(n => n.__typename === "MediaImage" && n.image)
      .map(n => ({ id: n.id, url: n.image.url, altText: n.image.altText ?? "", isNew: false }));

  const [images, setImages] = useState(parseImages);
  const originalImageIdsRef = useRef(parseImages().map(img => img.id));

  // Variants
  const [variantEdits, setVariantEdits]         = useState(() => initVariantEdits(product));
  const [baseVariantEdits, setBaseVariantEdits] = useState(() => initVariantEdits(product));

  // After successful save — update all base states
  useEffect(() => {
    if (fetcher.data?.saved === true && savingRef.current) {
      const s = savingRef.current;
      setBaseProductFields({ ...s.productFields });
      setBaseTags([...s.tags]);
      setBaseCollections([...s.collections]);
      setBaseCategory({ ...s.category });
      setBaseVariantEdits(JSON.parse(JSON.stringify(s.variantEdits)));
      // Replace each newly-uploaded placeholder with its real Shopify media
      // (id + CDN url) instead of dropping it — the CDN url may briefly be
      // null while Shopify's async processing finishes, so fall back to the
      // local preview blob url until a real page load picks up the final one.
      const newMedia = fetcher.data.newMedia ?? [];
      let newMediaIdx = 0;
      const reconciledImages = images.map(img => {
        if (!img.isNew) return img;
        const m = newMedia[newMediaIdx++];
        return m ? { id: m.id, url: m.url ?? img.url, altText: img.altText, isNew: false } : img;
      });
      setImages(reconciledImages);
      originalImageIdsRef.current = reconciledImages.map(img => img.id).filter(Boolean);
      savingRef.current = null;
    }
  }, [fetcher.data]);

  // Dirty checks
  const isProductDirty  = Object.keys(productFields).some(k => productFields[k] !== baseProductFields[k]);
  const isTagsDirty     = tags.join("|||") !== baseTags.join("|||");
  const isCollsDirty    = collections.map(c => c.id).join(",") !== baseCollections.map(c => c.id).join(",");
  const isCategoryDirty = category.id !== baseCategory.id;
  const isVariantsDirty = Object.entries(variantEdits).some(([id, e]) => {
    const b = baseVariantEdits[id];
    return !b || e.sku !== b.sku || e.price !== b.price || e.weightValue !== b.weightValue || e.tracked !== b.tracked || e.inventoryQty !== b.inventoryQty
      || e.barcode !== b.barcode || e.inventoryPolicy !== b.inventoryPolicy || e.costPerItem !== b.costPerItem || e.taxable !== b.taxable
      || e.requiresShipping !== b.requiresShipping;
  });
  const removedImageIds    = originalImageIdsRef.current.filter(id => !images.find(img => img.id === id));
  const currentImageOrder  = images.filter(img => !img.isNew).map(img => img.id).join(",");
  const originalImageOrder = originalImageIdsRef.current.join(",");
  const isImagesDirty = images.some(img => img.isNew) || removedImageIds.length > 0 || currentImageOrder !== originalImageOrder;
  const isDirty = isProductDirty || isTagsDirty || isCollsDirty || isCategoryDirty || isVariantsDirty || isImagesDirty;

  const isSaving        = fetcher.state !== "idle";
  const saved           = fetcher.data?.saved === true;
  const errors          = fetcher.data?.errors ?? [];
  const inventoryErrors = fetcher.data?.inventoryErrors ?? [];

  function setField(k, v)       { setProductFields(p => ({ ...p, [k]: v })); }
  function setVariant(id, k, v) { setVariantEdits(p => ({ ...p, [id]: { ...p[id], [k]: v } })); }

  function handleDiscard() {
    setProductFields({ ...baseProductFields });
    setTags([...baseTags]);
    setCollections([...baseCollections]);
    setCategory({ ...baseCategory });
    setVariantEdits(JSON.parse(JSON.stringify(baseVariantEdits)));
    setImages(parseImages());
    originalImageIdsRef.current = parseImages().map(img => img.id);
  }

  function handleSave() {
    const sellingOutOfStock = Object.values(variantEdits).some(e => e.inventoryPolicy === "CONTINUE");
    if (sellingOutOfStock) {
      const confirmed = window.confirm("ARE YOU SURE YOU WANT TO SELL WHEN... OUT OF STOCK????");
      if (!confirmed) return;
    }

    const imageOrderIds = images.filter(img => !img.isNew).map(img => img.id);
    const newImageUrls  = images.filter(img => img.isNew).map(img => img.sourceUrl);
    const addedColIds   = collections.filter(c => !baseCollections.find(b => b.id === c.id)).map(c => c.id);
    const removedColIds = baseCollections.filter(b => !collections.find(c => c.id === b.id)).map(b => b.id);

    savingRef.current = {
      productFields: { ...productFields },
      tags: [...tags],
      collections: [...collections],
      category: { ...category },
      variantEdits: JSON.parse(JSON.stringify(variantEdits)),
    };

    fetcher.submit(
      {
        intent:                   "save",
        productId:                product.id,
        title:                    productFields.title,
        vendor:                   productFields.vendor,
        productType:              productFields.productType,
        status:                   productFields.status,
        condition:                productFields.condition,
        bodyHtml:                 productFields.bodyHtml,
        tags:                     tags.join(","),
        categoryId:               category.id,
        addedCollectionIdsJson:   JSON.stringify(addedColIds),
        removedCollectionIdsJson: JSON.stringify(removedColIds),
        removedImageIdsJson:      JSON.stringify(removedImageIds),
        imageOrderIdsJson:        JSON.stringify(imageOrderIds),
        newImageUrlsJson:         JSON.stringify(newImageUrls),
        variantsJson:             JSON.stringify(
          Object.entries(variantEdits).map(([id, edit]) => ({ id, ...edit }))
        ),
      },
      { method: "POST" }
    );
  }

  const variantList = product.variants?.edges?.map(e => e.node) ?? [];

  // Subtext for header
  const headerSubtext = (() => {
    const totalQty = variantList.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0);
    const prices   = variantList.map(v => parseFloat(v.price)).filter(p => !isNaN(p));
    const minP     = prices.length ? Math.min(...prices) : null;
    const maxP     = prices.length ? Math.max(...prices) : null;
    const priceStr = minP === null ? "—"
      : minP === maxP ? `$${minP.toFixed(2)}`
      : `$${minP.toFixed(2)} – $${maxP.toFixed(2)}`;
    return `Qty: ${totalQty} · ${priceStr}${variantList.length > 1 ? ` · ${variantList.length} variants` : ""}`;
  })();

  if (removed) return null;

  return (
    <div
      id={`product-row-${product.id}`}
      style={{
        borderBottom: "1px solid #e1e3e5",
        background: highlighted ? "#e3f1df" : "transparent",
        transition: "background 0.6s ease",
      }}
    >
      {/* ── Row header ── */}
      <div style={sx.rowHeader} onClick={() => setOpen(v => !v)}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
          {product.featuredImage
            ? <img src={product.featuredImage.url} alt="" style={sx.thumb} />
            : <div style={sx.thumbEmpty}>📦</div>}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{
                ...(productFields.status === "ACTIVE" ? sx.statusBadgeActive :
                    productFields.status === "DRAFT" ? sx.statusBadgeDraft :
                    sx.statusBadgeUnlisted),
                marginTop: 15,
              }}>
                {productFields.status === "ACTIVE" ? "Active" : productFields.status === "DRAFT" ? "Draft" : "Unlisted"}
              </span>
              <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {product.title}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginTop: -18 }}>
              {/* Invisible clone of the badge — matches its exact width so the subtext lines up under the title, not the badge */}
              <span style={{
                ...(productFields.status === "ACTIVE" ? sx.statusBadgeActive :
                    productFields.status === "DRAFT" ? sx.statusBadgeDraft :
                    sx.statusBadgeUnlisted),
                visibility: "hidden",
              }}>
                {productFields.status === "ACTIVE" ? "Active" : productFields.status === "DRAFT" ? "Draft" : "Unlisted"}
              </span>
              <span style={{ fontSize: 12, color: "#6d7175" }}>{headerSubtext}</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {pendingRemove ? (
            <>
              <span style={{ fontSize: 12, color: "#d82c0d" }}>Removing in {secondsLeft}s…</span>
              <button
                style={{ fontSize: 12, fontWeight: 600, color: "#005bd3", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
                onClick={handleUndoRemove}
              >Undo</button>
            </>
          ) : (
            <>
              {saved    && !isDirty  && <span style={sx.badgeSaved}>✓ Saved</span>}
              {isDirty  && !isSaving && <span style={sx.badgeDirty}>Unsaved</span>}
              {isSaving              && <span style={sx.badgeSaving}>Saving…</span>}
              <span style={{ color: "#6d7175", fontSize: 14 }}>{open ? "▲" : "▼"}</span>
              {collectionId && (
                <button
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#8c9196", fontSize: 18, lineHeight: 1, padding: "0 2px" }}
                  onClick={handleRemove}
                  title="Remove from collection"
                >×</button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Expanded body ── */}
      {open && (
        <div style={{ ...sx.expandBody, background: highlighted ? "#e3f1df" : sx.expandBody.background, transition: "background 0.6s ease" }}>
          {errors.length > 0 && (
            <div style={sx.errorBox}>{errors.map((e, i) => <div key={i}>• {e}</div>)}</div>
          )}
          {inventoryErrors.length > 0 && (
            <div style={sx.warningBox}>
              ⚠ Product saved, but inventory fields had errors:
              {inventoryErrors.map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}

          {/* ── Images ── */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#202223", marginBottom: 4, textAlign: "left" }}>Status</div>
                <div style={{ width: 130 }}>
                  <s-select
                    label="Status"
                    labelAccessibilityVisibility="exclusive"
                    style={{ width: "100%" }}
                    value={productFields.status}
                    onChange={e => setField("status", e.currentTarget.value)}
                  >
                    <s-option value="ACTIVE">Active</s-option>
                    <s-option value="DRAFT">Draft</s-option>
                    <s-option value="UNLISTED">Unlisted</s-option>
                  </s-select>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleDiscard}
                  disabled={isSaving || !isDirty}
                  style={{ ...sx.discardBtn, opacity: isSaving || !isDirty ? 0.4 : 1, cursor: isSaving || !isDirty ? "default" : "pointer" }}
                >
                  Discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaving || !isDirty}
                  style={{ ...sx.saveBtn, opacity: isSaving || !isDirty ? 0.5 : 1, cursor: isSaving || !isDirty ? "default" : "pointer" }}
                >
                  {isSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            <ImageManager images={images} onUpdate={setImages} />
          </div>

          {/* ── Open in new tab ── */}
          <div style={{ marginBottom: 20 }}>
            <a
              href={`https://${shop}/admin/products/${product.id.split("/").pop()}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block", fontSize: 13, fontWeight: 600, color: "#202223",
                background: "#fff", border: "1px solid #c9cccf", borderRadius: 6,
                padding: "8px 14px", textDecoration: "none",
              }}
            >
              Open in new tab ↗
            </a>
          </div>

          {/* Title — full width, header-style */}
          <div style={{ marginBottom: 12 }}>
            <Field label="Title">
              <s-text-field
                label="Title"
                labelAccessibilityVisibility="exclusive"
                value={productFields.title}
                onInput={e => setField("title", e.currentTarget.value)}
              />
            </Field>
          </div>

          {/* Two-column layout */}
          <div style={{ ...sx.grid, marginBottom: 12, alignItems: "start" }}>
            {/* Left column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={sx.relatedFieldsBox}>
                <Field label="Category">
                  <CategoryEditor category={category} onChange={setCategory} />
                </Field>
                <Field label="Vendor">
                  <SuggestField
                    label="Vendor"
                    value={productFields.vendor}
                    onChange={v => setField("vendor", v)}
                    suggestions={vendorSuggestions}
                    hasNextPage={vendorSuggestionsHasMore}
                    loading={vendorSuggestionsLoading}
                    onLoadMore={onLoadMoreVendors}
                  />
                </Field>
                <Field label="Condition">
                  <s-select
                    label="Condition"
                    labelAccessibilityVisibility="exclusive"
                    value={productFields.condition}
                    onChange={e => setField("condition", e.currentTarget.value)}
                  >
                    <s-option value="">— Select condition —</s-option>
                    {EBAY_CONDITIONS.map(c => (
                      <s-option key={c.code} value={c.code}>{c.label}</s-option>
                    ))}
                  </s-select>
                </Field>
              </div>
            </div>
            {/* Right column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Type">
                <SuggestField
                  label="Type"
                  value={productFields.productType}
                  onChange={v => setField("productType", v)}
                  suggestions={typeSuggestions}
                  hasNextPage={typeSuggestionsHasMore}
                  loading={typeSuggestionsLoading}
                  onLoadMore={onLoadMoreTypes}
                  placeholder="e.g. Clothing"
                />
              </Field>
              <Field label="Tags">
                <TagEditor
                  tags={tags}
                  onChange={setTags}
                  suggestions={tagSuggestions}
                  hasNextPage={tagSuggestionsHasMore}
                  loading={tagSuggestionsLoading}
                  onLoadMore={onLoadMoreTags}
                />
              </Field>
            </div>
          </div>

          {/* ── Primary fields (most-used — checked every time) — no table header, each field carries its own label ── */}
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
            {variantList.map((v, idx) => {
              const edit = variantEdits[v.id] ?? {};
              // SKU duplicate: typed SKU exists in the collection's loaded SKUs (and isn't the original SKU for this variant)
              const skuDupe = edit.sku && edit.sku !== (v.sku ?? "") && allSkus.has(edit.sku);
              return (
                <div key={v.id} style={{ ...sx.variantRow5col, borderBottom: idx < variantList.length - 1 ? "1px solid #f1f1f1" : "none" }}>
                  {/* SKU */}
                  <div style={{ display: "flex", justifyContent: "center" }}>
                    <div style={{ width: `${Math.min(220, Math.max(48, Math.max((edit.sku ?? "").length, (edit.barcode ?? "").length) * 8 + 26))}px` }}>
                      <s-text-field
                        label="SKU"
                        error={skuDupe ? "SKU already in use" : undefined}
                        value={edit.sku ?? ""}
                        onInput={e => setVariant(v.id, "sku", e.currentTarget.value)}
                        placeholder="—"
                      />
                    </div>
                  </div>
                  {/* Price */}
                  <div style={{ display: "flex", justifyContent: "center", maxWidth: 110, margin: "0 auto" }}>
                    <s-number-field
                      label="Price"
                      style={{ width: 110, maxWidth: 110, minWidth: 0, boxSizing: "border-box", flex: "0 0 auto" }}
                      prefix="$"
                      step="0.01"
                      min="0"
                      value={edit.price ?? ""}
                      onInput={e => setVariant(v.id, "price", e.currentTarget.value)}
                    />
                  </div>
                  {/* Weight */}
                  <div style={{ display: "flex", justifyContent: "flex-end", maxWidth: 90, margin: 0, marginLeft: "auto" }}>
                    <s-number-field
                      label="Weight"
                      style={{ width: 90, maxWidth: 90, minWidth: 0, boxSizing: "border-box", flex: "0 0 auto" }}
                      step="0.01"
                      min="0"
                      value={edit.weightValue ?? ""}
                      onInput={e => setVariant(v.id, "weightValue", e.currentTarget.value)}
                      placeholder="0"
                    />
                  </div>
                  {/* Unit */}
                  <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-start", maxWidth: 120, margin: 0, marginRight: "auto" }}>
                    <div style={{ height: 24 }} />
                    <s-select
                      label="Unit"
                      labelAccessibilityVisibility="exclusive"
                      style={{ width: 120, maxWidth: 120, minWidth: 0, boxSizing: "border-box", flex: "0 0 auto" }}
                      value={edit.weightUnit ?? "GRAMS"}
                      onChange={e => setVariant(v.id, "weightUnit", e.currentTarget.value)}
                    >
                      <s-option value="GRAMS">g</s-option>
                      <s-option value="KILOGRAMS">kg</s-option>
                      <s-option value="OUNCES">oz</s-option>
                      <s-option value="POUNDS">lb</s-option>
                    </s-select>
                  </div>
                  {/* Qty (Available qty) */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ width: `${Math.min(120, Math.max(70, String(edit.inventoryQty ?? 0).length * 9 + 50))}px` }}>
                      <s-number-field
                        label="Inventory"
                        style={{ width: "100%" }}
                        min="0"
                        step="1"
                        value={String(edit.inventoryQty ?? 0)}
                        onInput={e => setVariant(v.id, "inventoryQty", e.currentTarget.value)}
                        disabled={!edit.tracked}
                      />
                    </div>
                    {edit.locationName && <div style={{ fontSize: 10, color: "#6d7175", marginTop: 2, whiteSpace: "nowrap" }}>{edit.locationName}</div>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Secondary fields (checked less often) — no table header, each field carries its own label ── */}
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
            {variantList.map((v, idx) => {
              const edit = variantEdits[v.id] ?? {};
              return (
                <div key={v.id} style={{ ...sx.variantRow5col, borderBottom: idx < variantList.length - 1 ? "1px solid #f1f1f1" : "none" }}>
                  {/* Barcode */}
                  <div style={{ display: "flex", justifyContent: "center", marginTop: -7 }}>
                    <div style={{ width: `${Math.min(220, Math.max(48, Math.max((edit.sku ?? "").length, (edit.barcode ?? "").length) * 8 + 26))}px` }}>
                      <s-text-field
                        label="Barcode"
                        value={edit.barcode ?? ""}
                        onInput={e => setVariant(v.id, "barcode", e.currentTarget.value)}
                        placeholder="—"
                      />
                    </div>
                  </div>
                  {/* Charge tax */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={sx.fieldCaption}>Charge tax</div>
                    <s-checkbox
                      accessibilityLabel="Charge tax"
                      checked={edit.taxable ?? true}
                      onChange={e => setVariant(v.id, "taxable", e.currentTarget.checked)}
                    />
                  </div>
                  {/* Tracked */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={sx.fieldCaption}>Tracked</div>
                    <s-checkbox
                      accessibilityLabel="Inventory tracked"
                      checked={edit.tracked ?? false}
                      onChange={e => setVariant(v.id, "tracked", e.currentTarget.checked)}
                    />
                  </div>
                  {/* Physical product */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={sx.fieldCaption}>Physical product</div>
                    <s-checkbox
                      accessibilityLabel="Physical product"
                      checked={edit.requiresShipping ?? true}
                      onChange={e => setVariant(v.id, "requiresShipping", e.currentTarget.checked)}
                    />
                  </div>
                  {/* Sell out-of-stock */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={sx.fieldCaption}>Sell out-of-stock</div>
                    <s-checkbox
                      accessibilityLabel="Sell when out of stock"
                      checked={edit.inventoryPolicy === "CONTINUE"}
                      onChange={e => setVariant(v.id, "inventoryPolicy", e.currentTarget.checked ? "CONTINUE" : "DENY")}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Description — rich text editor */}
          <div style={{ marginBottom: 16 }}>
            <Field label="Description" span>
              <RichTextEditor
                content={productFields.bodyHtml}
                onChange={html => setField("bodyHtml", html)}
              />
            </Field>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              onClick={handleDiscard}
              disabled={isSaving || !isDirty}
              style={{ ...sx.discardBtn, opacity: isSaving || !isDirty ? 0.4 : 1, cursor: isSaving || !isDirty ? "default" : "pointer" }}
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !isDirty}
              style={{ ...sx.saveBtn, opacity: isSaving || !isDirty ? 0.5 : 1, cursor: isSaving || !isDirty ? "default" : "pointer" }}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CollectionSelector ────────────────────────────────────────────────────────
function CollectionSelector({ recentCollections, activeCollectionId, onSelect }) {
  const fetcher = useFetcher();
  const [query, setQuery] = useState("");
  const searchResults = fetcher.data?.searchResults ?? null;
  const isSearching   = fetcher.state !== "idle";

  const debouncedCollectionSearch = useDebounce(val => {
    if (val.trim().length >= 2) fetcher.submit({ intent: "search", query: val }, { method: "POST" });
  });

  function handleQueryChange(e) {
    const val = e.target.value;
    setQuery(val);
    debouncedCollectionSearch(val);
  }
  function handleSelect(c) { onSelect(c); setQuery(""); }

  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ marginBottom: 12 }}>
        <label style={sx.label}>Collection</label>
        <select style={sx.select} value={activeCollectionId ?? ""}
          onChange={e => { const found = recentCollections.find(c => c.id === e.target.value); if (found) handleSelect(found); }}>
          <option value="">— Select a recent collection —</option>
          {recentCollections.map(c => (
            <option key={c.id} value={c.id}>{c.title} ({c.productsCount?.count ?? 0})</option>
          ))}
        </select>
      </div>
      <div style={{ position: "relative" }}>
        <label style={sx.label}>Search collections</label>
        <input style={sx.input} value={query} onChange={handleQueryChange} placeholder="Type to search…" />
        {query.length >= 2 && (
          <div style={sx.dropdown}>
            {isSearching && <div style={sx.dropItem}>Searching…</div>}
            {!isSearching && searchResults?.length === 0 && <div style={sx.dropItem}>No results.</div>}
            {!isSearching && searchResults?.map(c => (
              <div key={c.id} style={sx.dropItemBtn} onClick={() => handleSelect(c)}>
                <strong>{c.title}</strong>
                <span style={{ color: "#6d7175", marginLeft: 6, fontSize: 12 }}>{c.productsCount?.count ?? 0} products</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AddProductsRow — compact expandable row at top of product list ────────────
function AddProductsRow({ collectionId, onAdded }) {
  const searchFetcher = useFetcher();
  const addFetcher    = useFetcher();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery]       = useState("");
  const [selected, setSelected] = useState(new Set());

  const debouncedSearch = useDebounce(val => {
    if (val.trim().length >= 2) searchFetcher.submit({ intent: "search-products", query: val }, { method: "POST" });
  });

  useEffect(() => {
    if (addFetcher.data?.addedProducts) {
      setSelected(new Set());
      setQuery("");
      setExpanded(false);
      onAdded?.();
    }
  }, [addFetcher.data]);

  function toggleProduct(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleAdd() {
    addFetcher.submit(
      { intent: "add-products", collectionId, productIdsJson: JSON.stringify([...selected]) },
      { method: "POST" }
    );
  }

  const results     = Array.isArray(searchFetcher.data?.productResults) ? searchFetcher.data.productResults : [];
  const isSearching = searchFetcher.state !== "idle";
  const isAdding    = addFetcher.state !== "idle";

  if (!expanded) {
    return (
      <div style={sx.addProductsRow} onClick={() => setExpanded(true)}>
        <span style={{ fontSize: 18, color: "#6d7175", marginRight: 8 }}>+</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#6d7175" }}>Add Products</span>
      </div>
    );
  }

  return (
    <div style={{ ...sx.addProductsRow, flexDirection: "column", alignItems: "stretch", height: "auto", padding: "12px 16px", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          style={{ ...sx.input, flex: 1 }}
          value={query}
          autoFocus
          placeholder="Search products to add…"
          onChange={e => { setQuery(e.target.value); debouncedSearch(e.target.value); }}
        />
        <button style={sx.discardBtn} onClick={() => { setExpanded(false); setQuery(""); setSelected(new Set()); }}>Cancel</button>
        {selected.size > 0 && (
          <button style={{ ...sx.saveBtn, opacity: isAdding ? 0.5 : 1 }} disabled={isAdding} onClick={handleAdd}>
            {isAdding ? "Adding…" : `Add ${selected.size}`}
          </button>
        )}
      </div>
      {addFetcher.data?.addError && <div style={{ fontSize: 12, color: "#d82c0d" }}>{addFetcher.data.addError}</div>}
      {query.length >= 2 && (
        <div style={{ border: "1px solid #e1e3e5", borderRadius: 6, overflow: "hidden", maxHeight: 240, overflowY: "auto" }}>
          {isSearching && <div style={sx.dropItem}>Searching…</div>}
          {!isSearching && results.length === 0 && <div style={sx.dropItem}>No products found.</div>}
          {!isSearching && results.map(p => {
            const sku   = p.variants?.edges?.[0]?.node?.sku ?? "";
            const price = p.variants?.edges?.[0]?.node?.price ?? "";
            return (
              <div key={p.id} style={{ ...sx.sidebarCollRow, display: "flex", alignItems: "center", gap: 10 }}
                onClick={() => toggleProduct(p.id)}>
                <input type="checkbox" readOnly checked={selected.has(p.id)} style={{ width: 15, height: 15, flexShrink: 0 }} />
                {p.featuredImage?.url
                  ? <img src={p.featuredImage.url} alt="" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
                  : <div style={{ width: 32, height: 32, background: "#f1f1f1", borderRadius: 4, flexShrink: 0 }} />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                  <div style={{ fontSize: 11, color: "#6d7175" }}>{sku ? `SKU: ${sku}` : ""}{sku && price ? " · " : ""}{price ? `$${price}` : ""}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── CollectionSidebar — floating left panel ───────────────────────────────────
function CollectionSidebar({ activeCollection, products, onSelect, onDeselect, open, onToggle, onProductsChanged, onJumpToProduct }) {
  const searchFetcher  = useFetcher();
  const createFetcher  = useFetcher();
  const prodSearchF    = useFetcher();
  const removeFetcher  = useFetcher();
  const [query, setQuery]           = useState("");
  const [prodQuery, setProdQuery]   = useState("");
  const [addingProd, setAddingProd] = useState(false);
  const [removedIds, setRemovedIds]           = useState(new Set());
  const [pendingIds, setPendingIds]           = useState(new Set());
  const pendingTimers                         = useRef({});
  const addFetcher = useFetcher();

  const debouncedCollSearch = useDebounce(val => {
    if (val.trim().length >= 2) searchFetcher.submit({ intent: "search", query: val }, { method: "POST" });
  });
  const debouncedProdSearch = useDebounce(val => {
    if (val.trim().length >= 2) prodSearchF.submit({ intent: "search-products", query: val }, { method: "POST" });
  });

  useEffect(() => {
    if (createFetcher.data?.createdCollection) { onSelect(createFetcher.data.createdCollection); setQuery(""); }
  }, [createFetcher.data]);

  useEffect(() => {
    if (removeFetcher.data?.removedFromCollection) {
      const pid = removeFetcher.data.productId;
      setRemovedIds(prev => new Set([...prev, pid]));
      setPendingIds(prev => { const n = new Set(prev); n.delete(pid); return n; });
      onProductsChanged?.();
    }
  }, [removeFetcher.data]);

  useEffect(() => {
    if (addFetcher.data?.addedProducts) { setProdQuery(""); setAddingProd(false); onProductsChanged?.(); }
  }, [addFetcher.data]);

  useEffect(() => { setRemovedIds(new Set()); setPendingIds(new Set()); }, [products]);

  function handleCollSearch(e) { const v = e.target.value; setQuery(v); debouncedCollSearch(v); }
  function handleProdSearch(e)  { const v = e.target.value; setProdQuery(v); debouncedProdSearch(v); }
  function handleSelect(c)      { onSelect(c); setQuery(""); }
  function handleDeselect()     { setQuery(""); onDeselect(); }
  function quickCreate(name)    { createFetcher.submit({ intent: "create-collection", title: name.trim() }, { method: "POST" }); }

  function removeProduct(productId) {
    setPendingIds(prev => new Set([...prev, productId]));
    pendingTimers.current[productId] = setTimeout(() => {
      removeFetcher.submit(
        { intent: "remove-from-collection", collectionId: activeCollection.id, productId },
        { method: "POST" }
      );
      delete pendingTimers.current[productId];
    }, 3500);
  }

  function undoRemove(productId) {
    clearTimeout(pendingTimers.current[productId]);
    delete pendingTimers.current[productId];
    setPendingIds(prev => { const n = new Set(prev); n.delete(productId); return n; });
  }

  function addProduct(productId) {
    addFetcher.submit(
      { intent: "add-products", collectionId: activeCollection.id, productIdsJson: JSON.stringify([productId]) },
      { method: "POST" }
    );
  }

  const collResults  = Array.isArray(searchFetcher.data?.searchResults) ? searchFetcher.data.searchResults : null;
  const prodResults  = Array.isArray(prodSearchF.data?.productResults) ? prodSearchF.data.productResults : [];
  const isCollSearch = searchFetcher.state !== "idle";
  const isProdSearch = prodSearchF.state !== "idle";
  const isCreating   = createFetcher.state !== "idle";
  const showCollRes  = query.length >= 2 && !isCollSearch && collResults !== null;
  const visibleProds = (products ?? []).filter(p => !removedIds.has(p.id));

  return (
    <>
      {!open && (
        <button style={sx.sidebarCollapseTab} onClick={onToggle} title="Open Collections">☰</button>
      )}

      <div style={{ ...sx.sidebarPanel, transform: open ? "translateX(0)" : "translateX(-100%)" }}>
        {/* Header */}
        <div style={sx.sidebarHeader}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#202223" }}>Collections</span>
          <button style={sx.sidebarCloseBtn} onClick={onToggle} title="Collapse">‹</button>
        </div>

        {/* ── No collection selected: show search ── */}
        {!activeCollection && (
          <div style={{ padding: "12px 16px" }}>
            <label style={sx.label}>Search Collections</label>
            <input style={{ ...sx.input, marginTop: 4 }} value={query} onChange={handleCollSearch}
              placeholder="Search or create…" autoFocus={open} />
            {query.length >= 2 && (
              <div style={{ marginTop: 6, border: "1px solid #e1e3e5", borderRadius: 6, overflow: "hidden" }}>
                <div style={{ ...sx.sidebarCollRow, borderBottom: "1px solid #e1e3e5" }}
                  onClick={() => !isCreating && quickCreate(query)}>
                  <div style={{ color: "#005bd3", fontWeight: 600, fontSize: 13 }}>
                    {isCreating ? "Creating…" : `+ Create "${query}"`}
                  </div>
                </div>
                {isCollSearch && <div style={sx.dropItem}>Searching…</div>}
                {showCollRes && collResults.length === 0 && <div style={sx.dropItem}>No matches.</div>}
                {showCollRes && collResults.map(c => (
                  <div key={c.id} style={sx.sidebarCollRow} onClick={() => handleSelect(c)}>
                    <div>{c.title}</div>
                    <div style={{ fontSize: 11, color: "#6d7175" }}>{c.productsCount?.count ?? 0} products</div>
                  </div>
                ))}
              </div>
            )}
            {createFetcher.data?.createError && (
              <div style={{ fontSize: 12, color: "#d82c0d", marginTop: 6 }}>{createFetcher.data.createError}</div>
            )}
          </div>
        )}

        {/* ── Collection selected: bubble + product list ── */}
        {activeCollection && (
          <>
            {/* Collection bubble */}
            <div style={{ padding: "12px 16px 10px" }}>
              <label style={sx.label}>Prepping</label>
              <div style={{ marginTop: 4 }}>
                <span style={sx.sidebarActiveBubble}>
                  {activeCollection.title}
                  <button style={sx.bubbleX} onClick={handleDeselect} title="Remove">×</button>
                </span>
              </div>
            </div>

            {/* Product list */}
            <div style={{ borderTop: "1px solid #e1e3e5", flex: 1, overflowY: "auto" }}>

              {/* Add product row */}
              {!addingProd ? (
                <div style={sx.sidebarAddRow} onClick={() => setAddingProd(true)}>
                  <span style={{ fontSize: 15, color: "#6d7175", marginRight: 6 }}>+</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#6d7175" }}>Add Product</span>
                </div>
              ) : (
                <div style={{ padding: "10px 12px", borderBottom: "1px solid #e1e3e5", background: "#fafafa" }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input style={{ ...sx.input, flex: 1 }} value={prodQuery} onChange={handleProdSearch}
                      placeholder="Search products…" autoFocus />
                    <button style={sx.sidebarCloseBtn} onClick={() => { setAddingProd(false); setProdQuery(""); }}>✕</button>
                  </div>
                  {prodQuery.length >= 2 && (
                    <div style={{ border: "1px solid #e1e3e5", borderRadius: 6, overflow: "hidden", maxHeight: 200, overflowY: "auto" }}>
                      {isProdSearch && <div style={sx.dropItem}>Searching…</div>}
                      {!isProdSearch && prodResults.length === 0 && <div style={sx.dropItem}>No products found.</div>}
                      {!isProdSearch && prodResults.map(p => (
                        <div key={p.id} style={{ ...sx.sidebarCollRow, display: "flex", alignItems: "center", gap: 8 }}
                          onClick={() => addProduct(p.id)}>
                          {p.featuredImage?.url
                            ? <img src={p.featuredImage.url} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 3, flexShrink: 0 }} />
                            : <div style={{ width: 28, height: 28, background: "#f1f1f1", borderRadius: 3, flexShrink: 0 }} />}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                            <div style={{ fontSize: 10, color: "#6d7175" }}>{p.variants?.edges?.[0]?.node?.sku ?? ""}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Product rows */}
              {visibleProds.length === 0 && !addingProd && (
                <div style={sx.dropItem}>No products in collection.</div>
              )}
              {visibleProds.map(p => {
                const sku     = p.variants?.edges?.[0]?.node?.sku ?? "";
                const pending = pendingIds.has(p.id);
                return (
                  <div
                    key={p.id}
                    style={{ ...sx.sidebarCollRow, display: "flex", alignItems: "center", gap: 8, opacity: pending ? 0.55 : 1, cursor: "pointer" }}
                    onClick={() => onJumpToProduct?.(p.id)}
                  >
                    {p.featuredImage?.url
                      ? <img src={p.featuredImage.url} alt="" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
                      : <div style={{ width: 32, height: 32, background: "#f1f1f1", borderRadius: 4, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        textDecoration: pending ? "line-through" : undefined }}>{p.title}</div>
                      {sku && <div style={{ fontSize: 10, color: "#6d7175" }}>SKU: {sku}</div>}
                    </div>
                    {pending ? (
                      <button
                        style={{ fontSize: 11, fontWeight: 600, color: "#005bd3", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", flexShrink: 0 }}
                        onClick={e => { e.stopPropagation(); undoRemove(p.id); }}
                      >Undo</button>
                    ) : (
                      <button
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#8c9196", fontSize: 16, flexShrink: 0, padding: "0 2px" }}
                        onClick={e => { e.stopPropagation(); removeProduct(p.id); }}
                        title="Remove from collection"
                      >×</button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function PrepB() {
  const { recentCollections, collection, products, vendorSuggestions, typeSuggestions, tagSuggestions, shop } = useLoaderData();
  const [, setSearchParams] = useSearchParams();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [highlightedProductId, setHighlightedProductId] = useState(null);
  const highlightTimerRef = useRef(null);

  // Auto-open sidebar when no collection is selected
  useEffect(() => {
    if (!collection) setSidebarOpen(true);
  }, [collection]);

  function jumpToProduct(productId) {
    document.getElementById(`product-row-${productId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    clearTimeout(highlightTimerRef.current);
    setHighlightedProductId(productId);
    highlightTimerRef.current = setTimeout(() => setHighlightedProductId(null), 1500);
  }

  const [listSearch, setListSearch]   = useState("");
  const [listSort,   setListSort]     = useState("default");
  const [listVendor, setListVendor]   = useState("");

  // Reset filters when collection changes
  useEffect(() => {
    setListSearch("");
    setListSort("default");
    setListVendor("");
  }, [collection?.id]);

  const allSkus = useMemo(() => {
    const set = new Set();
    for (const p of products) {
      for (const edge of p.variants?.edges ?? []) {
        const sku = edge.node.sku;
        if (sku) set.add(sku);
      }
    }
    return set;
  }, [products]);

  // Store-wide suggestion lists — shared across every ProductRow, like allSkus above.
  const vendorSuggest = usePaginatedSuggestions("vendor", vendorSuggestions);
  const typeSuggest   = usePaginatedSuggestions("type",   typeSuggestions);
  const tagSuggest    = usePaginatedSuggestions("tag",    tagSuggestions);

  const vendors = useMemo(() => {
    const set = new Set(products.map(p => p.vendor).filter(v => v && v !== "0"));
    return [...set].sort();
  }, [products]);

  const filteredProducts = useMemo(() => {
    let list = [...products];
    if (listSearch.trim()) {
      const q = listSearch.toLowerCase();
      list = list.filter(p =>
        p.title?.toLowerCase().includes(q) ||
        p.variants?.edges?.some(e => e.node.sku?.toLowerCase().includes(q))
      );
    }
    if (listVendor) list = list.filter(p => p.vendor === listVendor);
    if (listSort === "title-asc")   list.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
    if (listSort === "title-desc")  list.sort((a, b) => (b.title ?? "").localeCompare(a.title ?? ""));
    if (listSort === "sku-asc")     list.sort((a, b) => (a.variants?.edges?.[0]?.node?.sku ?? "").localeCompare(b.variants?.edges?.[0]?.node?.sku ?? ""));
    if (listSort === "sku-desc")    list.sort((a, b) => (b.variants?.edges?.[0]?.node?.sku ?? "").localeCompare(a.variants?.edges?.[0]?.node?.sku ?? ""));
    if (listSort === "price-asc")   list.sort((a, b) => parseFloat(a.variants?.edges?.[0]?.node?.price ?? 0) - parseFloat(b.variants?.edges?.[0]?.node?.price ?? 0));
    if (listSort === "price-desc")  list.sort((a, b) => parseFloat(b.variants?.edges?.[0]?.node?.price ?? 0) - parseFloat(a.variants?.edges?.[0]?.node?.price ?? 0));
    return list;
  }, [products, listSearch, listSort, listVendor]);

  const isFiltered = listSearch.trim() || listVendor || listSort !== "default";

  const bulkEditUrl = (() => {
    if (!collection || !shop) return null;
    const storeHandle = shop.replace(".myshopify.com", "");
    const numericCollectionId = collection.id.split("/").pop();
    const productIds = products.map(p => p.id.split("/").pop()).join(",");
    const returnTo = `/store/${storeHandle}/products?query=collection_id:${numericCollectionId}`;
    const params = new URLSearchParams({
      resource_name: "Product",
      edit: "description,media,tags,status,product_taxonomy_node_id,product_type,vendor,sales_channels,variants.price,variants.cost,variants.taxable,variants.sku,variants.barcode,variants.inventory_policy,variants.inventory_management,variants.defaultPackage,variants.weight,variants.requires_shipping",
      return_to: returnTo,
      query: `collection_id:${numericCollectionId}`,
      order: "created_at desc",
      ids: productIds,
    });
    return `https://admin.shopify.com/store/${storeHandle}/bulk/product?${params.toString()}`;
  })();

  function handleSelectCollection(c) {
    setSearchParams({ collectionId: c.id });
    setSidebarOpen(false);
  }

  return (
    <s-page heading="Prep B">
      <CollectionSidebar
        activeCollection={collection}
        products={products}
        onSelect={handleSelectCollection}
        onDeselect={() => setSearchParams({})}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(v => !v)}
        onProductsChanged={() => setSearchParams({ collectionId: collection?.id })}
        onJumpToProduct={jumpToProduct}
      />
      <div style={{ position: "relative" }}>
        {collection && (
          <a
            href={bulkEditUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              position: "absolute", top: 0, right: 0, zIndex: 1,
              display: "inline-block", fontSize: 11, fontWeight: 600, color: "#202223",
              background: "#fff", border: "1px solid #c9cccf", borderRadius: 5,
              padding: "2px 8px", textDecoration: "none", lineHeight: 1.4,
            }}
          >
            Bulk Edit ↗
          </a>
        )}
        {collection ? (
          <s-section heading={collection.title}>
            <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
              {/* ── Search / Filter / Sort toolbar ── */}
              {products.length > 0 && (
                <div style={sx.listToolbar}>
                  <input
                    style={{ ...sx.input, flex: "1 1 180px", minWidth: 0 }}
                    value={listSearch}
                    onChange={e => setListSearch(e.target.value)}
                    placeholder="Search by title or SKU…"
                  />
                  {vendors.length > 1 && (
                    <select
                      style={{ ...sx.select, width: "auto", flex: "0 0 auto", minWidth: 110 }}
                      value={listVendor}
                      onChange={e => setListVendor(e.target.value)}
                    >
                      <option value="">All vendors</option>
                      {vendors.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  )}
                  <select
                    style={{ ...sx.select, width: "auto", flex: "0 0 auto", minWidth: 140 }}
                    value={listSort}
                    onChange={e => setListSort(e.target.value)}
                  >
                    <option value="default">Sort: Default</option>
                    <option value="title-asc">Title A → Z</option>
                    <option value="title-desc">Title Z → A</option>
                    <option value="sku-asc">SKU ↑</option>
                    <option value="sku-desc">SKU ↓</option>
                    <option value="price-asc">Price ↑</option>
                    <option value="price-desc">Price ↓</option>
                  </select>
                  {isFiltered && (
                    <button
                      style={{ ...sx.discardBtn, padding: "6px 12px", fontSize: 12, flexShrink: 0 }}
                      onClick={() => { setListSearch(""); setListVendor(""); setListSort("default"); }}
                    >
                      Clear
                    </button>
                  )}
                  <span style={{ fontSize: 12, color: "#6d7175", flexShrink: 0, whiteSpace: "nowrap" }}>
                    {filteredProducts.length}{isFiltered ? ` of ${products.length}` : ""} item{products.length !== 1 ? "s" : ""}
                  </span>
                </div>
              )}

              {products.length === 0 ? (
                <div style={{ padding: "16px", fontSize: 13, color: "#6d7175" }}>No products in this collection yet.</div>
              ) : filteredProducts.length === 0 ? (
                <div style={{ padding: "16px", fontSize: 13, color: "#6d7175" }}>No products match your search.</div>
              ) : (
                filteredProducts.map(p => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    shop={shop}
                    allSkus={allSkus}
                    vendorSuggestions={vendorSuggest.nodes}
                    vendorSuggestionsHasMore={vendorSuggest.hasNextPage}
                    vendorSuggestionsLoading={vendorSuggest.loading}
                    onLoadMoreVendors={vendorSuggest.loadMore}
                    typeSuggestions={typeSuggest.nodes}
                    typeSuggestionsHasMore={typeSuggest.hasNextPage}
                    typeSuggestionsLoading={typeSuggest.loading}
                    onLoadMoreTypes={typeSuggest.loadMore}
                    tagSuggestions={tagSuggest.nodes}
                    tagSuggestionsHasMore={tagSuggest.hasNextPage}
                    tagSuggestionsLoading={tagSuggest.loading}
                    onLoadMoreTags={tagSuggest.loadMore}
                    collectionId={collection.id}
                    onRemoved={() => setSearchParams({ collectionId: collection.id })}
                    highlighted={highlightedProductId === p.id}
                  />
                ))
              )}

              <AddProductsRow
                collectionId={collection.id}
                onAdded={() => setSearchParams({ collectionId: collection.id })}
              />
            </div>
          </s-section>
        ) : (
          <s-section>
            <s-paragraph>Open the Collections panel to select or create a collection to prep.</s-paragraph>
          </s-section>
        )}
      </div>
    </s-page>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const sx = {
  label:       { fontSize: 12, fontWeight: 600, color: "#202223" },
  sectionLabel: {
    fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase",
    letterSpacing: "0.5px", marginBottom: 8,
  },
  input: {
    padding: "7px 9px", fontSize: 13, border: "1px solid #c9cccf", borderRadius: 6,
    outline: "none", background: "#fff", boxSizing: "border-box", color: "#202223", width: "100%",
  },
  select: {
    width: "100%", padding: "8px 10px", fontSize: 14, border: "1px solid #c9cccf",
    borderRadius: 6, outline: "none", background: "#fff", boxSizing: "border-box", color: "#202223", cursor: "pointer",
  },
  dropdown: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
    border: "1px solid #e1e3e5", borderRadius: 6, background: "#fff",
    boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 10,
    maxHeight: 280, overflowY: "auto", overflowX: "hidden",
  },
  dropItem:    { padding: "10px 14px", fontSize: 14, color: "#6d7175" },
  dropItemBtn: { padding: "10px 14px", fontSize: 14, cursor: "pointer", borderBottom: "1px solid #f1f1f1" },
  dropLoadMore: { textAlign: "center", fontWeight: 600, color: "#005bd3", background: "#f9fafb" },
  categoryPanel: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
    border: "1px solid #e1e3e5", borderRadius: 6, background: "#fff",
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 20, overflow: "hidden",
  },
  inlineClearBtn: {
    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
    background: "none", border: "none", cursor: "pointer",
    fontSize: 17, color: "#6d7175", padding: "0 2px", lineHeight: 1,
  },
  catRow: {
    display: "flex", alignItems: "center", padding: "9px 14px",
    fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f1f1f1",
    transition: "background 0.1s",
  },
  catBreadcrumb: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "6px 10px", background: "#f6f6f7", borderBottom: "1px solid #e1e3e5",
    minHeight: 32,
  },
  catBackBtn: {
    background: "none", border: "1px solid #c9cccf", borderRadius: 4,
    cursor: "pointer", fontSize: 12, color: "#202223", padding: "2px 8px",
    flexShrink: 0, lineHeight: 1.5,
  },
  rowHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 16px", cursor: "pointer", userSelect: "none",
  },
  thumb:      { width: 48, height: 48, objectFit: "cover", borderRadius: 6, flexShrink: 0 },
  thumbEmpty: {
    width: 48, height: 48, background: "#f1f1f1", borderRadius: 6, flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
  },
  expandBody: { padding: 16, borderTop: "1px solid #e1e3e5", background: "#f9fafb" },
  titleInput: {
    width: "100%", fontSize: 22, fontWeight: 600, lineHeight: 1.3,
    padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 6,
    background: "#fff", color: "#202223", outline: "none", boxSizing: "border-box",
  },
  rteWrap: {
    border: "1px solid #c9cccf", borderRadius: 6, background: "#fff", overflow: "hidden",
  },
  rteToolbar: {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2,
    padding: "6px 8px", borderBottom: "1px solid #e1e3e5", background: "#f6f6f7",
  },
  rteBtn: {
    border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12,
    padding: "3px 7px", lineHeight: 1.5, color: "#202223", minWidth: 28,
    transition: "background 0.1s",
  },
  rteSep: {
    width: 1, height: 18, background: "#c9cccf", margin: "0 4px", flexShrink: 0,
  },
  rteContent: {
    padding: "10px 12px", minHeight: 120, fontSize: 14, lineHeight: 1.6, color: "#202223",
    cursor: "text",
  },
  grid:       { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  relatedFieldsBox: {
    display: "flex", flexDirection: "column", gap: 12,
    padding: 12, background: "#eaebed", borderRadius: 8,
  },
  variantRow: {
    display: "grid", gridTemplateColumns: "1fr",
    alignItems: "start", padding: "10px 12px", gap: 10,
  },
  variantRowShipping: {
    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
    alignItems: "start", padding: "10px 12px", gap: 10,
  },
  variantRowInventory: {
    display: "grid", gridTemplateColumns: "1.3fr 1.3fr 1.3fr 70px 1fr",
    alignItems: "start", padding: "10px 12px", gap: 10,
  },
  variantRowPrice: {
    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
    alignItems: "start", padding: "10px 12px", gap: 10,
  },
  variantRow5col: {
    display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
    alignItems: "start", padding: "10px 12px", gap: 10,
  },
  fieldCaption: { fontSize: 11, fontWeight: 600, color: "#202223", textAlign: "center", marginBottom: 4 },
  variantHead: { fontSize: 11, fontWeight: 700, color: "#202223", textTransform: "uppercase", letterSpacing: "0.4px" },
  errorBox: {
    background: "#fff4f4", border: "1px solid #ffd2d2", borderRadius: 6,
    padding: "10px 14px", fontSize: 13, color: "#d82c0d", marginBottom: 12,
  },
  warningBox: {
    background: "#fffbea", border: "1px solid #ffc453", borderRadius: 6,
    padding: "10px 14px", fontSize: 13, color: "#7d5a00", marginBottom: 12,
  },
  badgeDirty:  { background: "#fff3cd", color: "#856404", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid #ffc107" },
  badgeSaved:  { background: "#d4edda", color: "#155724", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid #c3e6cb" },
  badgeSaving: { background: "#e8f0fe", color: "#005bd3", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid #c2d4f8" },
  statusBadgeActive:   { background: "#d4edda", color: "#155724", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid #c3e6cb", flexShrink: 0 },
  statusBadgeDraft:    { background: "#e8f0fe", color: "#005bd3", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid #c2d4f8", flexShrink: 0 },
  statusBadgeUnlisted: { background: "#e4e5e7", color: "#494b4f", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid #c9cccf", flexShrink: 0 },
  saveBtn: {
    background: "#008060", color: "#fff", border: "none",
    borderRadius: 6, padding: "10px 20px", fontSize: 14, fontWeight: 600,
  },
  discardBtn: {
    background: "#fff", color: "#d82c0d", border: "1px solid #d82c0d",
    borderRadius: 6, padding: "10px 20px", fontSize: 14, fontWeight: 600,
  },
  // Bubble editors
  bubbleBox: {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6,
    minHeight: 36, padding: "6px 8px",
    border: "1px solid #c9cccf", borderRadius: 6, background: "#fff",
  },
  bubbleInput: {
    border: "none", outline: "none", fontSize: 13, color: "#202223",
    background: "transparent", minWidth: 80, flex: 1,
  },
  bubbleFieldStyle: { minWidth: 120, flex: 1 },
  bubbleX: {
    background: "none", border: "none", cursor: "pointer", padding: "0 0 0 4px",
    fontSize: 15, lineHeight: 1, color: "inherit", opacity: 0.55, fontWeight: 700,
  },
  tagBubble: {
    display: "inline-flex", alignItems: "center",
    background: "#e4e5e7", color: "#494b4f", border: "1px solid #c9cccf",
    borderRadius: 999, padding: "3px 8px 3px 10px", fontSize: 12, fontWeight: 500,
  },
  collectionBubble: {
    display: "inline-flex", alignItems: "center",
    background: "#e8f0fe", color: "#005bd3", border: "1px solid #c2d4f8",
    borderRadius: 999, padding: "3px 8px 3px 10px", fontSize: 12, fontWeight: 500,
  },
  // Image gallery
  mediaInner: {
    display: "flex", gap: 10, alignItems: "flex-start",
  },
  mediaFeatured: {
    position: "relative", flexShrink: 0,
    width: 220, height: 220, borderRadius: 8,
    display: "flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden", userSelect: "none",
    border: "1px solid #e1e3e5",
  },
  lightboxOverlay: {
    position: "fixed", inset: 0, zIndex: 9999,
    background: "rgba(0,0,0,0.85)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  lightboxClose: {
    position: "fixed", top: 20, right: 24,
    background: "rgba(255,255,255,0.15)", border: "none", color: "#fff",
    fontSize: 22, width: 40, height: 40, borderRadius: "50%",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 10000,
  },
  lightboxNav: {
    position: "fixed", top: "50%", transform: "translateY(-50%)",
    background: "rgba(255,255,255,0.15)", border: "none", color: "#fff",
    fontSize: 40, width: 52, height: 52, borderRadius: "50%",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 10000, lineHeight: 1, paddingBottom: 2,
  },
  lightboxCounter: {
    position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)",
    color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: 600,
    background: "rgba(0,0,0,0.5)", padding: "6px 16px", borderRadius: 999,
    zIndex: 10000, pointerEvents: "none",
  },
  mediaThumbs: {
    display: "flex", flexWrap: "wrap", alignContent: "flex-start",
    gap: 6, flex: 1,
  },
  mediaThumbCell: {
    position: "relative", width: 72, height: 72,
    borderRadius: 6, overflow: "hidden", flexShrink: 0,
    border: "1px solid #e1e3e5", background: "#f6f6f7", userSelect: "none",
  },
  mediaAddTile: {
    width: 72, height: 72, borderRadius: 6, flexShrink: 0,
    border: "2px dashed #c9cccf", background: "transparent",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  imgNewBadge: {
    position: "absolute", top: 4, left: 4,
    background: "#005bd3", color: "#fff",
    fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4,
    pointerEvents: "none",
  },
  imgRatioBadge: {
    position: "absolute", bottom: 4, left: 4,
    background: "rgba(0,0,0,0.52)", color: "#fff",
    fontSize: 9, fontWeight: 600, padding: "2px 4px", borderRadius: 3,
    pointerEvents: "none", letterSpacing: "0.2px",
  },
  imgXBtn: {
    position: "absolute", top: 4, right: 4,
    width: 20, height: 20, borderRadius: "50%",
    background: "rgba(0,0,0,0.65)", border: "none", color: "#fff",
    fontSize: 11, cursor: "pointer", display: "flex",
    alignItems: "center", justifyContent: "center", padding: 0, lineHeight: 1,
  },
  listToolbar: {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
    padding: "10px 12px", borderBottom: "1px solid #e1e3e5",
    background: "#f6f6f7",
  },
  // Add products row
  addProductsRow: {
    display: "flex", alignItems: "center", padding: "0 16px",
    height: 44, borderBottom: "1px solid #e1e3e5",
    cursor: "pointer", background: "#fafafa",
  },
  // Collection sidebar
  sidebarToggle: {
    position: "fixed", left: 0, top: "50%", transform: "translateY(-50%)",
    background: "#202223", color: "#fff", border: "none",
    padding: "14px 7px", borderRadius: "0 6px 6px 0",
    fontSize: 16, cursor: "pointer", zIndex: 300, lineHeight: 1,
    boxShadow: "2px 0 8px rgba(0,0,0,0.2)",
  },
  sidebarBackdrop: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 301,
  },
  sidebarPanel: {
    position: "fixed", left: 0, top: 0, bottom: 0, width: SIDEBAR_WIDTH,
    background: "#fff", boxShadow: "2px 0 12px rgba(0,0,0,0.08)", borderRight: "1px solid #e1e3e5",
    zIndex: 200, display: "flex", flexDirection: "column",
    transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
    overflowY: "auto",
  },
  sidebarCollapseTab: {
    position: "fixed", left: 0, top: "50%", transform: "translateY(-50%)",
    background: "#202223", color: "#fff", border: "none",
    padding: "12px 7px", borderRadius: "0 6px 6px 0",
    fontSize: 16, cursor: "pointer", zIndex: 201, lineHeight: 1,
    boxShadow: "2px 0 8px rgba(0,0,0,0.2)",
  },
  sidebarHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "16px 16px 12px", borderBottom: "1px solid #e1e3e5", flexShrink: 0,
  },
  sidebarCloseBtn: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: 22, color: "#6d7175", padding: "0 4px", lineHeight: 1, fontWeight: 400,
  },
  sidebarCurrent: {
    padding: "10px 16px", background: "#f0f7f4",
    borderBottom: "1px solid #c6e0d8", flexShrink: 0,
  },
  sidebarCollRow: {
    padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #f1f1f1",
    fontSize: 13,
  },
  sidebarActiveBubble: {
    display: "inline-flex", alignItems: "center", gap: 4,
    background: "#f0f7f4", border: "1px solid #95c9b4", borderRadius: 999,
    padding: "5px 10px 5px 12px", fontSize: 13, fontWeight: 600, color: "#202223",
    maxWidth: "100%",
  },
  sidebarCreateBtn: {
    width: "100%", padding: "10px 14px", border: "2px dashed #c9cccf",
    background: "transparent", borderRadius: 6, cursor: "pointer",
    fontSize: 13, fontWeight: 600, color: "#202223",
  },
  sidebarAddRow: {
    padding: "11px 14px", display: "flex", alignItems: "center",
    cursor: "pointer", borderBottom: "1px solid #e1e3e5",
    background: "#fafafa",
  },
};

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
