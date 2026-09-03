// app/routes/app.problem-dashboard.jsx

import { authenticate }              from "../shopify.server.js";
import { useFetcher, useLoaderData } from "react-router";
import { useState }                  from "react";
import { validateSkuSession }        from "../lib/access.server.js";
import prisma                        from "../db.server.js";

// ── Loader ────────────────────────────────────────────────────────────────────
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shopId      = session.shop;

  const url        = new URL(request.url);
  const sessionId  = url.searchParams.get("sessionId");
  const skuSession = await validateSkuSession({ sessionId, shopId });

  if (!skuSession)                 return new Response("Unauthorized", { status: 401 });
  if (skuSession.role !== "admin") return new Response("Forbidden", { status: 403 });

  const allSkuIndex = await prisma.skuIndex.findMany({
    where:  { shopId, problems: { not: null } },
    select: { problems: true, excludedProblems: true },
  });

  function countNotExcluded(problemType) {
    return allSkuIndex.filter((r) => {
      const problems = JSON.parse(r.problems  ?? "[]");
      const excluded = JSON.parse(r.excludedProblems ?? "[]");
      return problems.includes(problemType) && !excluded.includes(problemType);
    }).length;
  }

  const freeNumbersCount = countNotExcluded("no_title_body");
  const fixTitlesCount   = countNotExcluded("no_title");
  const noSkuCount       = countNotExcluded("no_sku");

  async function fetchSection(problemType, take = 5) {
    const rows = await prisma.skuIndex.findMany({
      where:   { shopId, problems: { contains: problemType } },
      orderBy: { updatedAt: "desc" },
      take:    take + 20,
    });
    return rows
      .filter((r) => {
        const excluded = JSON.parse(r.excludedProblems ?? "[]");
        return !excluded.includes(problemType);
      })
      .slice(0, take);
  }

  const [freeNumbers, fixTitles, noSkus] = await Promise.all([
    fetchSection("no_title_body"),
    fetchSection("no_title"),
    fetchSection("no_sku"),
  ]);

  const allProductIds = [
    ...freeNumbers.map((r) => r.productId),
    ...fixTitles.map((r)   => r.productId),
    ...noSkus.map((r)      => r.productId),
  ].filter(Boolean);

  const productInfoMap = {};
  if (allProductIds.length > 0) {
    const infos = await prisma.productInfo.findMany({ where: { productId: { in: allProductIds } } });
    for (const info of infos) productInfoMap[info.productId] = info;
  }

  const recentLog = await prisma.problemLog.findMany({
    where:   { shopId },
    orderBy: { createdAt: "desc" },
    take:    25,
  });

  const enrich = (rows) => rows.map((r) => ({ ...r, info: productInfoMap[r.productId] ?? null }));

  return {
    shopId,
    counts: { freeNumbersCount, fixTitlesCount, noSkuCount },
    freeNumbers: enrich(freeNumbers),
    fixTitles:   enrich(fixTitles),
    noSkus:      enrich(noSkus),
    recentLog,
  };
}

// ── Action ────────────────────────────────────────────────────────────────────
export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopId             = session.shop;

  const formData  = await request.formData();
  const sessionId = formData.get("sessionId")?.toString();
  const intent    = formData.get("intent");

  const skuSession = await validateSkuSession({ sessionId, shopId });
  if (!skuSession)                 return Response.json({ success: false, error: "Unauthorized" });
  if (skuSession.role !== "admin") return Response.json({ success: false, error: "Forbidden" });

  const changedBy = skuSession.userId ?? skuSession.username ?? "admin";

  if (intent === "take_number") {
    const skuIndexId = parseInt(formData.get("skuIndexId"));
    const productId  = formData.get("productId");
    const mode       = formData.get("mode");

    let skuNumber = null;
    try {
      const row = await prisma.skuIndex.findUnique({ where: { id: skuIndexId }, select: { skuNumber: true } });
      skuNumber = row?.skuNumber ?? null;
    } catch {}

    if (productId) {
      try {
        if (mode === "archive") {
          await admin.graphql(
            `#graphql
            mutation archiveProduct($id: ID!) {
              productUpdate(input: { id: $id, status: ARCHIVED }) {
                product { id status }
                userErrors { field message }
              }
            }`,
            { variables: { id: productId } }
          );
        } else {
          await admin.graphql(
            `#graphql
            mutation deleteProduct($id: ID!) {
              productDelete(input: { id: $id }) {
                deletedProductId
                userErrors { field message }
              }
            }`,
            { variables: { id: productId } }
          );
        }
      } catch (err) {
        console.error("[take_number] Shopify error:", err);
        return Response.json({ success: false, error: "Failed to update product in Shopify" });
      }
    }

    try {
      await prisma.skuIndex.update({
        where: { id: skuIndexId },
        data: {
          status: "free", taken: false, titleTaken: false,
          productId: null, title: null, problems: null,
          excludedProblems: null, syncedAt: new Date(),
        },
      });
      await prisma.problemLog.create({
        data: {
          shopId, productId: productId ?? "unknown", skuNumber,
          action: "deleted", problemType: null, changedBy,
          note: mode === "archive" ? "Product archived and SKU freed" : "Product deleted and SKU freed",
        },
      });
      const verb = mode === "archive" ? "archived" : "deleted";
      return Response.json({ success: true, message: `Product ${verb} — SKU marked as free for generation` });
    } catch (err) {
      return Response.json({ success: false, error: err.message });
    }
  }

  if (intent === "pass_problem") {
    const skuIndexId  = parseInt(formData.get("skuIndexId"));
    const problemType = formData.get("problemType");

    try {
      const existing = await prisma.skuIndex.findUnique({ where: { id: skuIndexId } });
      if (!existing) return Response.json({ success: false, error: "Not found" });

      const excluded = JSON.parse(existing.excludedProblems ?? "[]");
      if (!excluded.includes(problemType)) excluded.push(problemType);

      const problems = JSON.parse(existing.problems ?? "[]");
      const updated  = problems.filter((p) => p !== problemType);

      await prisma.skuIndex.update({
        where: { id: skuIndexId },
        data: {
          excludedProblems: JSON.stringify(excluded),
          problems:         JSON.stringify(updated),
          status:           updated.length > 0 ? "problem" : "active",
        },
      });
      await prisma.problemLog.create({
        data: {
          shopId, productId: existing.productId ?? "unknown",
          skuNumber: existing.skuNumber ?? null,
          action: "excluded", problemType, changedBy,
        },
      });
      return Response.json({ success: true, message: `Problem excluded — won't be re-detected` });
    } catch (err) {
      return Response.json({ success: false, error: err.message });
    }
  }

  if (intent === "move_to_new_sku") {
    const productId = formData.get("productId");

    let currentSku, shopGid;
    try {
      const res  = await admin.graphql(`#graphql
        query getShopAndSku {
          shop { id metafield(namespace: "custom", key: "next_sku") { id value } }
        }`);
      const data = await res.json();
      shopGid    = data.data.shop.id;
      currentSku = data.data.shop.metafield ? parseInt(data.data.shop.metafield.value) : 1000;
    } catch {
      return Response.json({ success: false, error: "Failed to read SKU counter" });
    }

    const newSkuString   = String(currentSku).padStart(6, "0");
    const newTitlePrefix = `${currentSku} - `;

    let existingTitle = "";
    try {
      const res  = await admin.graphql(`#graphql
        query getProduct($id: ID!) {
          product(id: $id) { id title variants(first: 1) { edges { node { id sku } } } }
        }`, { variables: { id: productId } });
      const data = await res.json();
      existingTitle = data.data?.product?.title ?? "";
    } catch {
      return Response.json({ success: false, error: "Failed to fetch product" });
    }

    const titleBody = existingTitle.replace(/^\d+\s*[-–]\s*/, "").trim();
    const newTitle  = `${newTitlePrefix}${titleBody}`;

    try {
      const res  = await admin.graphql(`#graphql
        mutation productSet($input: ProductSetInput!) {
          productSet(input: $input) {
            product { id title }
            userErrors { field message }
          }
        }`, { variables: { input: { id: productId, title: newTitle, variants: [{ sku: newSkuString }] } } });
      const data   = await res.json();
      const errors = data.data?.productSet?.userErrors ?? [];
      if (errors.length > 0) return Response.json({ success: false, error: errors.map((e) => e.message).join(", ") });
    } catch {
      return Response.json({ success: false, error: "Failed to update product in Shopify" });
    }

    try {
      await admin.graphql(`#graphql
        mutation setNextSku($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { metafields { id value } userErrors { field message } }
        }`, { variables: { metafields: [{ namespace: "custom", key: "next_sku", ownerId: shopGid, type: "number_integer", value: String(currentSku + 1) }] } });
    } catch (err) {
      console.error("[move_to_new_sku] Failed to increment counter:", err);
    }

    try {
      const existing = await prisma.skuIndex.findFirst({ where: { productId, shopId } });
      if (existing) {
        await prisma.skuIndex.update({
          where: { id: existing.id },
          data:  { skuNumber: newSkuString, title: newTitle, taken: true, titleTaken: true, status: "active", problems: null, syncedAt: new Date() },
        });
        await prisma.problemLog.create({
          data: { shopId, productId, skuNumber: newSkuString, action: "resolved", problemType: "no_sku", changedBy, note: `Moved to new SKU ${newSkuString}` },
        });
      }
    } catch (err) {
      console.error("[move_to_new_sku] Failed to update SkuIndex:", err);
    }

    return Response.json({ success: true, message: `Moved to SKU ${newSkuString}` });
  }

  if (intent === "load_more") {
    const problemType = formData.get("problemType");
    const skip        = parseInt(formData.get("skip") ?? "5");

    const rows = await prisma.skuIndex.findMany({
      where:   { shopId, problems: { contains: problemType } },
      orderBy: { updatedAt: "desc" },
      skip:    0,
      take:    skip + 25,
    });

    const filtered = rows
      .filter((r) => {
        const excluded = JSON.parse(r.excludedProblems ?? "[]");
        return !excluded.includes(problemType);
      })
      .slice(skip, skip + 5);

    const productIds = filtered.map((r) => r.productId).filter(Boolean);
    const infos      = productIds.length > 0 ? await prisma.productInfo.findMany({ where: { productId: { in: productIds } } }) : [];
    const infoMap    = Object.fromEntries(infos.map((i) => [i.productId, i]));

    return Response.json({ success: true, rows: filtered.map((r) => ({ ...r, info: infoMap[r.productId] ?? null })) });
  }

  return Response.json({ success: false, error: "Unknown action" });
}

// ── Confirm Modal ─────────────────────────────────────────────────────────────
function ConfirmModal({ row, onConfirm, onCancel }) {
  const [mode, setMode] = useState("archive");

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: "#ffffff", borderRadius: "12px", padding: "32px", maxWidth: "440px", width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <div style={{ fontSize: "20px", fontWeight: "700", color: "#202223", marginBottom: "8px" }}>Take #{row.skuNumber}?</div>
        <div style={{ fontSize: "14px", color: "#6d7175", marginBottom: "24px", lineHeight: "1.6" }}>
          This will free up <strong style={{ fontFamily: "monospace", color: "#202223" }}>{row.skuNumber}</strong> for the generator.
          The original product <strong>"{row.title}"</strong> will be removed from Shopify.
        </div>
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#202223", marginBottom: "10px" }}>What should happen to the Shopify product?</div>
          <div style={{ display: "flex", gap: "10px" }}>
            {["archive", "delete"].map((m) => (
              <button key={m} onClick={() => setMode(m)} style={{
                flex: 1, padding: "12px 10px", borderRadius: "8px", cursor: "pointer",
                border:     `2px solid ${mode === m ? (m === "delete" ? "#d82c0d" : "#005bd3") : "#e1e3e5"}`,
                background: mode === m ? (m === "delete" ? "#fff0f0" : "#f0f7ff") : "#ffffff",
                color:      mode === m ? (m === "delete" ? "#d82c0d" : "#005bd3") : "#6d7175",
                fontSize: "13px", fontWeight: "600", textAlign: "center",
              }}>
                {m === "archive" ? "📦 Archive" : "🗑 Delete"}
                <div style={{ fontSize: "11px", fontWeight: "400", marginTop: "3px" }}>
                  {m === "archive" ? "Hidden, recoverable" : "Permanent, cannot undo"}
                </div>
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{ background: "#f6f6f7", border: "2px solid #e1e3e5", borderRadius: "8px", padding: "9px 20px", cursor: "pointer", fontSize: "14px", fontWeight: "600", color: "#202223" }}>Cancel</button>
          <button onClick={() => onConfirm(mode)} style={{ background: mode === "delete" ? "#d82c0d" : "#005bd3", border: "none", borderRadius: "8px", padding: "9px 20px", cursor: "pointer", fontSize: "14px", fontWeight: "700", color: "#ffffff" }}>
            {mode === "delete" ? "Delete & Free #" : "Archive & Free #"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function ProblemCard({ label, count, color, description, active, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: active ? color + "18" : "#ffffff",
      border: `2px solid ${active ? color : "#e1e3e5"}`,
      borderRadius: "10px", padding: "16px 20px",
      cursor: "pointer", flex: "1 1 180px", transition: "all 0.15s ease",
    }}>
      <div style={{ fontSize: "28px", fontWeight: "800", color, lineHeight: "1.1" }}>{count?.toLocaleString() ?? 0}</div>
      <div style={{ fontSize: "14px", fontWeight: "700", color: "#202223", marginTop: "4px" }}>{label}</div>
      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px", lineHeight: "1.4" }}>{description}</div>
    </div>
  );
}

function ActionDropdown({ options }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ background: "#f6f6f7", border: "2px solid #e1e3e5", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
        ▾ More
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, background: "#ffffff", border: "2px solid #e1e3e5", borderRadius: "8px", zIndex: 100, minWidth: "160px", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
          {options.map((opt) => (
            <button key={opt.label} onClick={() => { setOpen(false); opt.onClick(); }} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: "500", color: opt.danger ? "#d82c0d" : "#202223" }}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function actionBadge(action) {
  const map = {
    detected: { bg: "#fff0f0", color: "#d82c0d", label: "Detected" },
    passed:   { bg: "#fff8e1", color: "#8a6200", label: "Passed"   },
    excluded: { bg: "#f0f7ff", color: "#005bd3", label: "Excluded" },
    resolved: { bg: "#f0fff8", color: "#008060", label: "Resolved" },
    deleted:  { bg: "#f6f6f7", color: "#6d7175", label: "Deleted"  },
  };
  const s = map[action] ?? { bg: "#f6f6f7", color: "#6d7175", label: action };
  return (
    <span style={{ background: s.bg, color: s.color, padding: "3px 10px", borderRadius: "4px", fontSize: "12px", fontWeight: "700" }}>
      {s.label}
    </span>
  );
}

// ── Inline label/value pair ───────────────────────────────────────────────────
function Meta({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "4px", marginRight: "16px", fontSize: "13px" }}>
      <span style={{ color: "#6d7175", fontWeight: "500" }}>{label}</span>
      <span style={{ color: "#202223", fontWeight: "600" }}>{value}</span>
    </span>
  );
}

// ── Collections tag strip ─────────────────────────────────────────────────────
function CollectionTags({ collections }) {
  if (!collections) return null;
  let parsed = collections;
  if (typeof collections === "string") {
    try { parsed = JSON.parse(collections); } catch { return null; }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
      {parsed.slice(0, 6).map((tag) => (
        <span key={tag} style={{ background: "#f1f1f1", borderRadius: "4px", padding: "2px 8px", fontSize: "11px", color: "#202223" }}>{tag}</span>
      ))}
      {parsed.length > 6 && <span style={{ fontSize: "11px", color: "#6d7175" }}>+{parsed.length - 6} more</span>}
    </div>
  );
}

// ── Rich product row ──────────────────────────────────────────────────────────
function RichRow({ row, sectionKey, onAction, sessionId, shopHandle, setConfirmRow }) {
  const info = row.info;

  // --- Inventory total ---
  let qty = null;
  if (info?.inventory) {
    try { qty = Object.values(JSON.parse(info.inventory)).reduce((s, l) => s + (l.quantity ?? 0), 0); } catch {}
  }

  // --- Notes (description) ---
  const [notesOpen, setNotesOpen] = useState(false);
  let notes = null;
  if (info?.notes) {
    try {
      const parsed = JSON.parse(info.notes);
      if (Array.isArray(parsed) && parsed.length > 0) {
        notes = parsed.map((n) => n.text ?? n).join(" · ");
      }
    } catch { notes = info.notes; }
  }

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", justifyContent: "space-between",
      gap: "24px", padding: "18px 20px",
      borderBottom: "1px solid #e1e3e5", background: "#ffffff",
    }}>

      {/* ── Left: all product info stacked ── */}
      <div style={{ flex: 1, minWidth: 0 }}>

        {/* Row 1: title (large) + SKU badge */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "16px", fontWeight: "700", color: "#202223", lineHeight: "1.3" }}>
            {row.title ?? "—"}
          </span>
          {row.skuNumber && (
            <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#6d7175", background: "#f1f1f1", borderRadius: "4px", padding: "2px 8px" }}>
              {row.skuNumber}
            </span>
          )}
          {sectionKey === "fix_titles" && (
            <span style={{ fontSize: "11px", color: "#d82c0d", fontWeight: "600" }}>Missing SKU prefix</span>
          )}
          {sectionKey === "no_sku" && (
            <span style={{ fontSize: "11px", color: "#d82c0d", fontWeight: "600" }}>No valid SKU</span>
          )}
        </div>

        {/* Row 2: meta strip — vendor, price, weight, condition, qty */}
        <div style={{ marginTop: "8px", lineHeight: "1.8" }}>
          <Meta label="Vendor"    value={info?.vendor    ?? null} />
          <Meta label="Price"     value={info?.price     ? `$${info.price}` : null} />
          <Meta label="Weight"    value={info?.weight    ?? null} />
          <Meta label="Condition" value={info?.condition ?? null} />
          <Meta label="Qty"       value={qty !== null ? qty : null} />
        </div>

        {/* Row 3: collections */}
        <CollectionTags collections={info?.collections ?? null} />

        {/* Row 4: notes/description — collapsed by default */}
        {notes && (
          <div style={{ marginTop: "6px" }}>
            <button onClick={() => setNotesOpen((v) => !v)} style={{ background: "none", border: "none", padding: 0, color: "#005bd3", fontSize: "12px", cursor: "pointer", fontWeight: "600" }}>
              {notesOpen ? "▾ Hide notes" : "▸ Show notes"}
            </button>
            {notesOpen && (
              <div style={{ marginTop: "4px", fontSize: "13px", color: "#6d7175", lineHeight: "1.6", maxWidth: "600px" }}>
                {notes}
              </div>
            )}
          </div>
        )}

        {/* Row 5: synced timestamp */}
        {row.syncedAt && (
          <div style={{ marginTop: "6px", fontSize: "11px", color: "#adb5bd" }}>
            Synced {new Date(row.syncedAt).toLocaleString()}
          </div>
        )}
      </div>

      {/* ── Right: actions stacked vertically ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", flexShrink: 0, alignItems: "flex-end" }}>
        {sectionKey === "free_numbers" && (
          <>
            <s-button variant="primary" tone="success" onClick={() => setConfirmRow(row)}>Take #</s-button>
            <s-button variant="secondary" onClick={() => onAction("pass_problem", { skuIndexId: String(row.id), problemType: "no_title_body" })}>Exclude</s-button>
            <ActionDropdown options={[
              { label: "Edit in Shopify", onClick: () => window.open(`https://admin.shopify.com/store/${shopHandle}/products/${row.productId?.split("/").pop()}`, "_blank") },
            ]} />
          </>
        )}
        {sectionKey === "fix_titles" && (
          <>
            <s-button variant="secondary" onClick={() => window.open(`https://admin.shopify.com/store/${shopHandle}/products/${row.productId?.split("/").pop()}`, "_blank")}>Edit</s-button>
            <s-button variant="secondary" onClick={() => onAction("pass_problem", { skuIndexId: String(row.id), problemType: "no_title" })}>Exclude</s-button>
            <ActionDropdown options={[
              { label: "Archive", danger: true, onClick: () => onAction("take_number", { skuIndexId: String(row.id), productId: row.productId ?? "", mode: "archive" }) },
              { label: "Delete",  danger: true, onClick: () => { if (window.confirm(`Delete "${row.title}"? This cannot be undone.`)) onAction("take_number", { skuIndexId: String(row.id), productId: row.productId ?? "", mode: "delete" }); } },
            ]} />
          </>
        )}
        {sectionKey === "no_sku" && (
          <>
            <s-button variant="primary" onClick={() => onAction("move_to_new_sku", { productId: row.productId })}>Move to new #</s-button>
            <s-button variant="secondary" onClick={() => window.open(`https://admin.shopify.com/store/${shopHandle}/products/${row.productId?.split("/").pop()}`, "_blank")}>Edit</s-button>
            <s-button variant="secondary" onClick={() => onAction("pass_problem", { skuIndexId: String(row.id), problemType: "no_sku" })}>Exclude</s-button>
            <ActionDropdown options={[
              { label: "Archive", danger: true, onClick: () => onAction("take_number", { skuIndexId: String(row.id), productId: row.productId ?? "", mode: "archive" }) },
              { label: "Delete",  danger: true, onClick: () => { if (window.confirm(`Delete "${row.title}"? This cannot be undone.`)) onAction("take_number", { skuIndexId: String(row.id), productId: row.productId ?? "", mode: "delete" }); } },
            ]} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Rich List (replaces ProblemTable) ─────────────────────────────────────────
function RichList({ initialRows, totalCount, problemType, sectionKey, sessionId, onAction, shopId }) {
  const fetcher   = useFetcher();
  const [rows, setRows] = useState(initialRows ?? []);
  const [skip, setSkip] = useState(initialRows?.length ?? 5);
  const [confirmRow, setConfirmRow] = useState(null);

  const canLoadMore = rows.length < totalCount;
  const shopHandle  = shopId?.replace(".myshopify.com", "") ?? "";

  function handleLoadMore() {
    fetcher.submit(
      { intent: "load_more", problemType, skip: String(skip), sessionId },
      { method: "POST", action: "/app/problem-dashboard" }
    );
  }

  if (fetcher.data?.rows && fetcher.data.rows.length > 0) {
    const newIds = new Set(rows.map((r) => r.id));
    const fresh  = fetcher.data.rows.filter((r) => !newIds.has(r.id));
    if (fresh.length > 0) {
      setRows((prev) => [...prev, ...fresh]);
      setSkip((prev) => prev + fresh.length);
      fetcher.data.rows = [];
    }
  }

  function handleConfirm(mode) {
    onAction("take_number", { skuIndexId: String(confirmRow.id), productId: confirmRow.productId ?? "", mode });
    setRows((prev) => prev.filter((r) => r.id !== confirmRow.id));
    setConfirmRow(null);
  }

  if (rows.length === 0) {
    return <div style={{ fontSize: "14px", color: "#6d7175", padding: "16px 0" }}>No products with this problem.</div>;
  }

  return (
    <div>
      {confirmRow && <ConfirmModal row={confirmRow} onConfirm={handleConfirm} onCancel={() => setConfirmRow(null)} />}

      <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
        {rows.map((row) => (
          <RichRow
            key={row.id}
            row={row}
            sectionKey={sectionKey}
            onAction={onAction}
            sessionId={sessionId}
            shopHandle={shopHandle}
            setConfirmRow={setConfirmRow}
          />
        ))}
      </div>

      {canLoadMore && (
        <div style={{ marginTop: "16px", textAlign: "center" }}>
          <s-button variant="secondary" onClick={handleLoadMore} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
            View more ({totalCount - rows.length} remaining)
          </s-button>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ProblemDashboard() {
  const loaderData = useLoaderData();
  const fetcher    = useFetcher();

  const { counts, freeNumbers, fixTitles, noSkus, shopId, recentLog } = loaderData ?? {};

  const [activeSection, setActiveSection] = useState("free_numbers");
  const [message, setMessage]             = useState(null);

  const sessionId = typeof window !== "undefined" ? sessionStorage.getItem("skuboo_session_id") ?? "" : "";

  function handleAction(intent, extraData) {
    setMessage(null);
    fetcher.submit(
      { intent, sessionId, ...extraData },
      { method: "POST", action: "/app/problem-dashboard" }
    );
  }

  if (fetcher.data?.message && fetcher.data.message !== message) {
    setMessage(fetcher.data.message);
  }

  const sections = {
    free_numbers: { label: "Free Numbers", count: counts?.freeNumbersCount, color: "#005bd3", description: "Has a SKU prefix but no title body — slot may be reusable", rows: freeNumbers, problemType: "no_title_body" },
    fix_titles:   { label: "Fix Titles",   count: counts?.fixTitlesCount,   color: "#f0a500", description: "Has a title body but missing the SKU number prefix",         rows: fixTitles,  problemType: "no_title"      },
    no_sku:       { label: "No SKU",       count: counts?.noSkuCount,       color: "#d82c0d", description: "Product has no valid 6-digit SKU assigned",                  rows: noSkus,     problemType: "no_sku"        },
  };

  const active = sections[activeSection];

  return (
    <div style={{ marginRight: "auto", width: "100%", boxSizing: "border-box" }}>
      <s-page heading="Problem Dashboard">

        {/* ── Problem Cards ── */}
        <s-section>
          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
            {Object.entries(sections).map(([key, sec]) => (
              <ProblemCard
                key={key} label={sec.label} count={sec.count} color={sec.color}
                description={sec.description} active={activeSection === key}
                onClick={() => setActiveSection(key)}
              />
            ))}
          </div>
        </s-section>

        {/* ── Active Section ── */}
        <s-section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", paddingBottom: "10px", borderBottom: "2px solid #e1e3e5" }}>
            <div style={{ fontSize: "18px", fontWeight: "700", color: active.color }}>
              {active.label}
              <span style={{ fontSize: "14px", color: "#6d7175", fontWeight: "400", marginLeft: "10px" }}>
                {active.count?.toLocaleString()} products
              </span>
            </div>
          </div>

          {message && (
            <div style={{
              marginBottom: "16px", padding: "10px 16px",
              background: fetcher.data?.success ? "#f0fff8" : "#fff0f0",
              border: `1px solid ${fetcher.data?.success ? "#008060" : "#d82c0d"}`,
              borderRadius: "8px", fontSize: "14px", fontWeight: "600",
              color: fetcher.data?.success ? "#008060" : "#d82c0d",
            }}>
              {fetcher.data?.success ? "✓" : "✗"} {message}
            </div>
          )}

          <RichList
            key={activeSection}
            initialRows={active.rows}
            totalCount={active.count ?? 0}
            problemType={active.problemType}
            sectionKey={activeSection}
            sessionId={sessionId}
            onAction={handleAction}
            shopId={shopId}
          />
        </s-section>

        {/* ── Recent Problem Log ── */}
        <s-section>
          <div style={{ fontSize: "18px", fontWeight: "700", color: "#202223", marginBottom: "20px", paddingBottom: "10px", borderBottom: "2px solid #e1e3e5" }}>
            📋 Recent Problem Activity
          </div>

          {(!recentLog || recentLog.length === 0) ? (
            <div style={{ fontSize: "14px", color: "#6d7175" }}>No problem activity logged yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "14px" }}>
                <thead>
                  <tr style={{ background: "#f6f6f7" }}>
                    {["Action", "Problem", "SKU", "Product ID", "By", "When"].map((h) => (
                      <th key={h} style={{ padding: "10px 16px", fontWeight: "700", color: "#202223", fontSize: "13px", textAlign: "left", borderBottom: "2px solid #e1e3e5", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentLog.map((row, i) => (
                    <tr key={row.id} style={{ background: i % 2 === 0 ? "#ffffff" : "#fafafa" }}>
                      <td style={td}>{actionBadge(row.action)}</td>
                      <td style={td}>
                        {row.problemType
                          ? <span style={{ background: "#f1f1f1", padding: "3px 10px", borderRadius: "4px", fontFamily: "monospace", fontSize: "12px" }}>{row.problemType}</span>
                          : <span style={{ color: "#6d7175" }}>—</span>
                        }
                      </td>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: "13px" }}>{row.skuNumber ?? "—"}</td>
                      <td style={{ ...td, fontSize: "12px", color: "#6d7175", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.productId?.split("/").pop() ?? "—"}
                      </td>
                      <td style={{ ...td, fontWeight: "600" }}>{row.changedBy}</td>
                      <td style={{ ...td, color: "#6d7175", whiteSpace: "nowrap" }}>
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </s-section>

      </s-page>
    </div>
  );
}

const td = { padding: "14px 16px", color: "#202223", lineHeight: "1.4", verticalAlign: "top" };