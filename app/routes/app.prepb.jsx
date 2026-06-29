// app/routes/app.prep.jsx

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useRouteError, useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
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
const PRODUCTS_COUNT = 50;
const SEARCH_COUNT   = 10;

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
  const { admin } = await authenticate.admin(request);
  const url          = new URL(request.url);
  const collectionId = url.searchParams.get("collectionId");

  const colRes = await admin.graphql(
    `#graphql
    query getRecentCollections($first: Int!) {
      collections(first: $first, sortKey: UPDATED_AT, reverse: true) {
        edges { node { id title productsCount { count } } }
      }
    }`,
    { variables: { first: RECENT_COUNT } }
  );
  const colData           = await colRes.json();
  const recentCollections = colData.data.collections.edges.map(e => e.node);

  if (!collectionId) return { recentCollections, collection: null, products: [] };

  const prodRes = await admin.graphql(
    `#graphql
    query getCollectionProducts($id: ID!, $first: Int!) {
      collection(id: $id) {
        id title
        products(first: $first) {
          edges {
            node {
              id title vendor productType tags bodyHtml
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
                    id title price sku
                    selectedOptions { name value }
                    inventoryQuantity
                    inventoryItem {
                      id tracked
                      measurement { weight { value unit } }
                      inventoryLevels(first: 5) {
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
      }
    }`,
    { variables: { id: collectionId, first: PRODUCTS_COUNT } }
  );
  const prodData   = await prodRes.json();
  const collection = prodData.data.collection;
  const products   = collection?.products?.edges?.map(e => e.node) ?? [];

  return { recentCollections, collection, products };
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
        { variables: { input: [{ filename, mimeType, resource: "IMAGE", fileSize }] } }
      );
      const stageData = await stageRes.json();
      const errs = stageData.data?.stagedUploadsCreate?.userErrors ?? [];
      if (stageData.errors || errs.length > 0) {
        return { stageError: errs[0]?.message ?? "Failed to create staged upload." };
      }
      const target = stageData.data.stagedUploadsCreate.stagedTargets[0];

      // POST file to staged URL — explicit Blob so Content-Type header is set correctly
      const fileBuffer = await file.arrayBuffer();
      const blob = new Blob([fileBuffer], { type: mimeType });
      const uploadForm = new FormData();
      for (const p of target.parameters) uploadForm.append(p.name, p.value);
      uploadForm.append("file", blob, filename);
      const uploadRes = await fetch(target.url, { method: "POST", body: uploadForm });
      if (!uploadRes.ok) return { stageError: `Upload failed (${uploadRes.status}).` };

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

    // 1. productUpdate — title, vendor, type, tags, description only
    const productInput = { id: productId, title, vendor, productType, tags, descriptionHtml };

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

    // 3. Variant prices (SKU is now managed via inventoryItemUpdate in step 4)
    const variantInputs = variants
      .map(v => ({
        id: v.id,
        ...(v.price !== "" && v.price != null ? { price: v.price } : {}),
      }))
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

    // 4. Per-variant SKU + weight + tracked + inventory qty
    const invErrors = [];
    for (const v of variants) {
      if (!v.inventoryItemId) continue;
      const invInput = {};
      if (v.sku != null) invInput.sku = v.sku;
      if (v.weightValue) invInput.measurement = { weight: { value: parseFloat(v.weightValue), unit: v.weightUnit || "GRAMS" } };
      if (typeof v.tracked === "boolean") invInput.tracked = v.tracked;
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
    if (newImageUrls.length > 0) {
      await admin.graphql(
        `#graphql
        mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) { userErrors { field message } }
        }`,
        { variables: { productId, media: newImageUrls.map(url => ({ originalSource: url, mediaContentType: "IMAGE" })) } }
      ).catch(err => console.error("[prep] createMedia failed:", err));
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

    return { saved: true };
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
function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  function add(raw) {
    const trimmed = raw.trim().replace(/,$/, "");
    if (trimmed && !tags.includes(trimmed)) onChange([...tags, trimmed]);
    setInput("");
  }

  function remove(tag) { onChange(tags.filter(t => t !== tag)); }

  function handleKeyDown(e) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input); }
    if (e.key === "Backspace" && input === "" && tags.length > 0) remove(tags[tags.length - 1]);
  }

  return (
    <div style={sx.bubbleBox}>
      {tags.map(tag => (
        <span key={tag} style={sx.tagBubble}>
          {tag}
          <button style={sx.bubbleX} onClick={() => remove(tag)}>×</button>
        </span>
      ))}
      <input
        style={sx.bubbleInput}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => input.trim() && add(input)}
        placeholder={tags.length === 0 ? "Add tag…" : ""}
      />
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
        <input
          style={{ ...sx.input, paddingRight: category.id ? 28 : undefined, background: category.id ? "#f0f7f4" : "#fff", cursor: "pointer" }}
          value={category.name || ""}
          readOnly
          onClick={() => setOpen(v => !v)}
          placeholder="Select category…"
        />
        {category.id && (
          <button style={sx.inlineClearBtn} onMouseDown={clear}>×</button>
        )}
      </div>

      {/* Panel */}
      {open && (
        <div style={sx.categoryPanel}>
          {/* Search input */}
          <div style={{ padding: "8px 8px 4px", borderBottom: "1px solid #f1f1f1" }}>
            <input
              style={sx.input}
              value={query}
              onChange={handleQuery}
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
    };
  }
  return edits;
}

// ── ProductRow ────────────────────────────────────────────────────────────────
const ProductRow = forwardRef(function ProductRow({ product, allSkus, collectionId, onRemoved, alwaysOpen = false, onDraftChanged }, ref) {
  const fetcher       = useFetcher();
  const removeFetcher  = useFetcher();
  const removeTimerRef = useRef(null);
  const [open, setOpen]             = useState(false);
  const [removed, setRemoved]       = useState(false);
  const [pendingRemove, setPending] = useState(false);
  const savingRef  = useRef(null);
  const stateRef   = useRef({});

  useEffect(() => {
    if (removeFetcher.data?.removedFromCollection) { setRemoved(true); onRemoved?.(); }
  }, [removeFetcher.data]);

  function handleRemove(e) {
    e.stopPropagation();
    setPending(true);
    removeTimerRef.current = setTimeout(() => {
      removeFetcher.submit(
        { intent: "remove-from-collection", collectionId, productId: product.id },
        { method: "POST" }
      );
    }, 3500);
  }

  function handleUndoRemove(e) {
    e.stopPropagation();
    clearTimeout(removeTimerRef.current);
    setPending(false);
  }

  // Product-level fields
  const initProductFields = {
    title:       product.title            ?? "",
    vendor:      product.vendor           ?? "",
    productType: product.productType      ?? "",
    condition:   product.metafield?.value ?? "",
    bodyHtml:    product.bodyHtml ?? "",
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
      originalImageIdsRef.current = images.filter(img => !img.isNew).map(img => img.id);
      setImages(prev => prev.filter(img => !img.isNew));
      savingRef.current = null;
      sessionStorage.removeItem(`skuboo_draft_${product.id}`);
      onDraftChanged?.(product.id, false);
    }
  }, [fetcher.data]);

  // Dirty checks
  const isProductDirty  = Object.keys(productFields).some(k => productFields[k] !== baseProductFields[k]);
  const isTagsDirty     = tags.join("|||") !== baseTags.join("|||");
  const isCollsDirty    = collections.map(c => c.id).join(",") !== baseCollections.map(c => c.id).join(",");
  const isCategoryDirty = category.id !== baseCategory.id;
  const isVariantsDirty = Object.entries(variantEdits).some(([id, e]) => {
    const b = baseVariantEdits[id];
    return !b || e.sku !== b.sku || e.price !== b.price || e.weightValue !== b.weightValue || e.tracked !== b.tracked || e.inventoryQty !== b.inventoryQty;
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
    sessionStorage.removeItem(`skuboo_draft_${product.id}`);
    onDraftChanged?.(product.id, false);
  }

  function handleSave() {
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

  // Update stateRef on every render (in render body, not in effect) so unmount cleanup
  // always reads the latest state, including mid-keystroke changes.
  stateRef.current = { productFields, tags, collections, category, variantEdits, images, isDirty };

  // On mount: restore draft from sessionStorage if one exists
  useEffect(() => {
    if (!alwaysOpen) return;
    try {
      const raw = sessionStorage.getItem(`skuboo_draft_${product.id}`);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.productFields) setProductFields(d.productFields);
      if (d.tags) setTags(d.tags);
      if (d.collections) setCollections(d.collections);
      if (d.category) setCategory(d.category);
      if (d.variantEdits) setVariantEdits(d.variantEdits);
      if (d.images) setImages(d.images);
    } catch {}
  }, []);

  // On unmount: persist draft if dirty so navigating away doesn't lose changes
  useEffect(() => {
    return () => {
      if (!stateRef.current.isDirty) return;
      const { productFields, tags, collections, category, variantEdits, images } = stateRef.current;
      try {
        sessionStorage.setItem(`skuboo_draft_${product.id}`, JSON.stringify({
          productFields, tags, collections, category, variantEdits,
          // blob: URLs expire on unmount; persist sourceUrl for new uploads instead
          images: images.map(img => ({ ...img, url: img.isNew ? img.sourceUrl : img.url })),
        }));
      } catch {}
      onDraftChanged?.(product.id, true);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    save: () => { if (!isSaving && isDirty) handleSave(); },
    discard: () => { if (!isSaving && isDirty) handleDiscard(); },
    isDirty,
    isSaving,
    saved,
  }), [isDirty, isSaving, saved, handleSave, handleDiscard]);

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
    <div style={alwaysOpen ? {} : { borderBottom: "1px solid #e1e3e5" }}>
      {/* ── Row header ── */}
      {!alwaysOpen && (
        <div style={sx.rowHeader} onClick={() => setOpen(v => !v)}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            {product.featuredImage
              ? <img src={product.featuredImage.url} alt="" style={sx.thumb} />
              : <div style={sx.thumbEmpty}>📦</div>}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {product.title}
              </div>
              <div style={{ fontSize: 12, color: "#6d7175", marginTop: 2 }}>{headerSubtext}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {pendingRemove ? (
              <>
                <span style={{ fontSize: 12, color: "#d82c0d" }}>Removing…</span>
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
      )}

      {/* ── Expanded body ── */}
      {(open || alwaysOpen) && (
        <div style={{ ...sx.expandBody, ...(alwaysOpen ? { borderTop: "none", background: "#fff" } : {}) }}>
          {errors.length > 0 && (
            <div style={sx.errorBox}>{errors.map((e, i) => <div key={i}>• {e}</div>)}</div>
          )}
          {inventoryErrors.length > 0 && (
            <div style={sx.warningBox}>
              ⚠ Product saved, but inventory fields had errors:
              {inventoryErrors.map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}

          {/* Title — full width, header-style */}
          <div style={{ marginBottom: 12 }}>
            <Field label="Title">
              <input style={sx.titleInput} value={productFields.title} onChange={e => setField("title", e.target.value)} />
            </Field>
          </div>

          {/* Description */}
          <div style={{ marginBottom: 16 }}>
            <Field label="Description" span>
              <RichTextEditor
                content={productFields.bodyHtml}
                onChange={html => setField("bodyHtml", html)}
              />
            </Field>
          </div>

          {/* ── Images ── */}
          <div style={{ marginBottom: 20 }}>
            <ImageManager images={images} onUpdate={setImages} />
          </div>

          {/* Two-column layout */}
          <div style={{ ...sx.grid, marginBottom: 12, alignItems: "start" }}>
            {/* Left column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Type">
                <input style={sx.input} value={productFields.productType} onChange={e => setField("productType", e.target.value)} placeholder="e.g. Clothing" />
              </Field>
              <Field label="Vendor">
                <input style={sx.input} value={productFields.vendor} onChange={e => setField("vendor", e.target.value)} />
              </Field>
              <Field label="Condition">
                <select style={sx.select} value={productFields.condition} onChange={e => setField("condition", e.target.value)}>
                  <option value="">— Select condition —</option>
                  {EBAY_CONDITIONS.map(c => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
              </Field>
            </div>
            {/* Right column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Category">
                <CategoryEditor category={category} onChange={setCategory} />
              </Field>
              <Field label="Tags">
                <TagEditor tags={tags} onChange={setTags} />
              </Field>
            </div>
          </div>

          {/* ── Variants / Inventory ── */}
          <div style={sx.sectionLabel}>Variants</div>
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ ...sx.variantRow, background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
              <div style={sx.variantHead}>SKU</div>
              <div style={sx.variantHead}>Options</div>
              <div style={sx.variantHead}>Price ($)</div>
              <div style={sx.variantHead}>Weight</div>
              <div style={sx.variantHead}>Inventory</div>
              <div style={{ ...sx.variantHead, textAlign: "center" }}>Tracked</div>
            </div>
            {variantList.map((v, idx) => {
              const edit        = variantEdits[v.id] ?? {};
              const optionLabel = v.selectedOptions?.map(o => o.value).join(" / ") ?? v.title ?? "Default";
              // SKU duplicate: typed SKU exists in the collection's loaded SKUs (and isn't the original SKU for this variant)
              const skuDupe = edit.sku && edit.sku !== (v.sku ?? "") && allSkus.has(edit.sku);
              return (
                <div key={v.id} style={{ ...sx.variantRow, borderBottom: idx < variantList.length - 1 ? "1px solid #f1f1f1" : "none" }}>
                  {/* SKU — editable */}
                  <div>
                    <input
                      style={{ ...sx.input, width: "100%", borderColor: skuDupe ? "#d82c0d" : undefined }}
                      value={edit.sku ?? ""}
                      onChange={e => setVariant(v.id, "sku", e.target.value)}
                      placeholder="—"
                    />
                    {skuDupe && (
                      <div style={{ fontSize: 10, color: "#d82c0d", marginTop: 2, fontWeight: 600 }}>⚠ SKU already in use</div>
                    )}
                  </div>
                  {/* Options */}
                  <div style={{ fontSize: 12, color: "#6d7175", paddingTop: 9 }}>{optionLabel}</div>
                  {/* Price */}
                  <div>
                    <input style={{ ...sx.input, width: "100%" }} type="number" step="0.01" min="0"
                      value={edit.price ?? ""} onChange={e => setVariant(v.id, "price", e.target.value)} />
                  </div>
                  {/* Weight */}
                  <div style={{ display: "flex", gap: 4 }}>
                    <input style={{ ...sx.input, width: 60 }} type="number" step="0.01" min="0"
                      value={edit.weightValue ?? ""} onChange={e => setVariant(v.id, "weightValue", e.target.value)} placeholder="0" />
                    <select style={{ ...sx.input, width: 54 }} value={edit.weightUnit ?? "GRAMS"}
                      onChange={e => setVariant(v.id, "weightUnit", e.target.value)}>
                      <option value="GRAMS">g</option>
                      <option value="KILOGRAMS">kg</option>
                      <option value="OUNCES">oz</option>
                      <option value="POUNDS">lb</option>
                    </select>
                  </div>
                  {/* Inventory */}
                  <div>
                    <input style={{ ...sx.input, width: "100%" }} type="number" min="0" step="1"
                      value={edit.inventoryQty ?? 0} onChange={e => setVariant(v.id, "inventoryQty", e.target.value)}
                      disabled={!edit.tracked} />
                    {edit.locationName && <div style={{ fontSize: 10, color: "#6d7175", marginTop: 2 }}>{edit.locationName}</div>}
                  </div>
                  {/* Tracked */}
                  <div style={{ textAlign: "center", paddingTop: 9 }}>
                    <input type="checkbox" checked={edit.tracked ?? false}
                      onChange={e => setVariant(v.id, "tracked", e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

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
function CollectionSidebar({ activeCollection, products, onSelect, onDeselect, open, onToggle, onProductsChanged, selectedProductId, onSelectProduct, productStatuses = new Map() }) {
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
                const sku      = p.variants?.edges?.[0]?.node?.sku ?? "";
                const pending  = pendingIds.has(p.id);
                const isActive = p.id === selectedProductId;
                const status   = productStatuses.get(p.id);
                return (
                  <div key={p.id}
                    style={{ ...sx.sidebarCollRow, display: "flex", alignItems: "center", gap: 8, opacity: pending ? 0.55 : 1, background: isActive ? "#f0f7f4" : undefined, borderLeft: isActive ? "3px solid #008060" : "3px solid transparent", cursor: pending ? "default" : "pointer" }}
                    onClick={() => !pending && onSelectProduct?.(p)}>
                    {p.featuredImage?.url
                      ? <img src={p.featuredImage.url} alt="" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
                      : <div style={{ width: 32, height: 32, background: "#f1f1f1", borderRadius: 4, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: isActive ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        textDecoration: pending ? "line-through" : undefined }}>{p.title}</div>
                      {sku && <div style={{ fontSize: 10, color: "#6d7175" }}>SKU: {sku}</div>}
                      {status === "saved"   && <span style={sx.badgeSaved}>✓ Saved</span>}
                      {status === "unsaved" && <span style={sx.badgeDirty}>Unsaved</span>}
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
export default function Prep() {
  const { recentCollections, collection, products } = useLoaderData();
  const [, setSearchParams] = useSearchParams();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Auto-open sidebar when no collection is selected
  useEffect(() => {
    if (!collection) setSidebarOpen(true);
  }, [collection]);

  const [selectedProductId, setSelectedProductId] = useState(null);
  const productRowRef = useRef(null);
  const [productRowState, setProductRowState] = useState({ isDirty: false, isSaving: false, saved: false });
  const [savedProductIds, setSavedProductIds] = useState(new Set());
  const [draftProductIds, setDraftProductIds] = useState(new Set());

  // Reset selection + status sets when collection changes; scan sessionStorage for existing drafts
  useEffect(() => {
    setSelectedProductId(null);
    setSavedProductIds(new Set());
    setDraftProductIds(new Set(
      products.filter(p => sessionStorage.getItem(`skuboo_draft_${p.id}`) !== null).map(p => p.id)
    ));
  }, [collection?.id]);

  // Monitor ProductRow state changes
  useEffect(() => {
    const interval = setInterval(() => {
      setProductRowState({
        isDirty: productRowRef.current?.isDirty ?? false,
        isSaving: productRowRef.current?.isSaving ?? false,
        saved: productRowRef.current?.saved ?? false,
      });
    }, 100);
    return () => clearInterval(interval);
  }, [selectedProductId]);

  const selectedProduct = useMemo(
    () => products.find(p => p.id === selectedProductId) ?? products[0] ?? null,
    [products, selectedProductId]
  );

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

  // Called by ProductRow when it saves a draft to sessionStorage or clears it
  function handleDraftChanged(productId, hasDraft) {
    setDraftProductIds(prev => {
      const next = new Set(prev);
      hasDraft ? next.add(productId) : next.delete(productId);
      return next;
    });
  }

  // When the active product finishes saving, promote it to "saved" and clear any draft flag
  useEffect(() => {
    if (!selectedProduct?.id) return;
    if (productRowState.saved && !productRowState.isDirty) {
      setSavedProductIds(prev => new Set([...prev, selectedProduct.id]));
      setDraftProductIds(prev => { const n = new Set(prev); n.delete(selectedProduct.id); return n; });
    }
  }, [productRowState.saved, productRowState.isDirty, selectedProduct?.id]);

  // Map of productId → "saved" | "unsaved" for sidebar badges
  const productStatuses = useMemo(() => {
    const map = new Map();
    for (const id of savedProductIds) map.set(id, "saved");
    for (const id of draftProductIds) map.set(id, "unsaved");
    if (selectedProduct?.id) {
      if (productRowState.isDirty) map.set(selectedProduct.id, "unsaved");
      else if (productRowState.saved) map.set(selectedProduct.id, "saved");
      else if (!draftProductIds.has(selectedProduct.id)) map.delete(selectedProduct.id);
    }
    return map;
  }, [savedProductIds, draftProductIds, selectedProduct?.id, productRowState.isDirty, productRowState.saved]);

  function handleSelectCollection(c) {
    setSearchParams({ collectionId: c.id });
    setSidebarOpen(false);
    setSelectedProductId(null);
  }

  return (
    <s-page heading="Prep">
      <CollectionSidebar
        activeCollection={collection}
        products={products}
        onSelect={handleSelectCollection}
        onDeselect={() => setSearchParams({})}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(v => !v)}
        onProductsChanged={() => setSearchParams({ collectionId: collection?.id })}
        selectedProductId={selectedProduct?.id}
        onSelectProduct={p => setSelectedProductId(p.id)}
        productStatuses={productStatuses}
      />
      {collection && selectedProduct && (
        <div style={{
          position: "fixed",
          top: 0,
          left: sidebarOpen ? SIDEBAR_WIDTH : 0,
          right: 0,
          height: 60,
          background: "#fff",
          borderBottom: "1px solid #e1e3e5",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 16,
          paddingRight: 16,
          zIndex: 100,
          transition: "left 0.25s cubic-bezier(0.4,0,0.2,1)",
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#202223", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedProduct.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {productRowState.isDirty && !productRowState.isSaving && <span style={sx.badgeDirty}>Unsaved</span>}
            {productRowState.isSaving && <span style={sx.badgeSaving}>Saving…</span>}
            <button
              onClick={() => productRowRef.current?.discard?.()}
              disabled={productRowState.isSaving || !productRowState.isDirty}
              style={{ ...sx.discardBtn, opacity: productRowState.isSaving || !productRowState.isDirty ? 0.4 : 1, cursor: productRowState.isSaving || !productRowState.isDirty ? "default" : "pointer", padding: "8px 16px", fontSize: 13 }}
            >
              Discard
            </button>
            <button
              onClick={() => productRowRef.current?.save?.()}
              disabled={productRowState.isSaving || !productRowState.isDirty}
              style={{ ...sx.saveBtn, opacity: productRowState.isSaving || !productRowState.isDirty ? 0.5 : 1, cursor: productRowState.isSaving || !productRowState.isDirty ? "default" : "pointer", padding: "8px 16px", fontSize: 13 }}
            >
              {productRowState.isSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
      <div style={{
        marginLeft: sidebarOpen ? SIDEBAR_WIDTH : 0,
        transition: "margin-left 0.25s cubic-bezier(0.4,0,0.2,1)",
        paddingTop: collection && selectedProduct ? 60 : 0,
      }}>
        {collection ? (
          selectedProduct ? (
            <s-section heading={selectedProduct.title}>
              <ProductRow
                ref={productRowRef}
                key={selectedProduct.id}
                product={selectedProduct}
                allSkus={allSkus}
                collectionId={collection.id}
                onRemoved={() => { setSearchParams({ collectionId: collection.id }); setSelectedProductId(null); }}
                onDraftChanged={handleDraftChanged}
                alwaysOpen
              />
            </s-section>
          ) : (
            <s-section>
              <s-paragraph>No products in this collection yet. Use the sidebar to add one.</s-paragraph>
            </s-section>
          )
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
    boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 10, overflow: "hidden",
  },
  dropItem:    { padding: "10px 14px", fontSize: 14, color: "#6d7175" },
  dropItemBtn: { padding: "10px 14px", fontSize: 14, cursor: "pointer", borderBottom: "1px solid #f1f1f1" },
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
  variantRow: {
    display: "grid", gridTemplateColumns: "130px 1fr 90px 130px 80px 50px",
    alignItems: "start", padding: "10px 12px", gap: 10,
  },
  variantHead: { fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.4px" },
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
  bubbleX: {
    background: "none", border: "none", cursor: "pointer", padding: "0 0 0 4px",
    fontSize: 15, lineHeight: 1, color: "inherit", opacity: 0.55, fontWeight: 700,
  },
  tagBubble: {
    display: "inline-flex", alignItems: "center",
    background: "#e3f1df", color: "#2a5e34", border: "1px solid #b8dbb2",
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
