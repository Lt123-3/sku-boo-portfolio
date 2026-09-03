// app/routes/app.packages.jsx
//
// Saved Packages admin — the list here is sku-boo's shared source of truth,
// read by both the Chrome extension (ext-api.packages) and the ESP32 relay
// (esp-server.js). Editing only happens here.

import { authenticate }         from "../shopify.server.js";
import { useFetcher, useLoaderData } from "react-router";
import { useState, useEffect }  from "react";
import { validateSkuSession }   from "../lib/access.server.js";
import prisma                   from "../db.server.js";
import { PinOverlay, UserBadge, useSkuSession } from "../components/PinGate.jsx";

// ── Loader ────────────────────────────────────────────────────────────────────
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shopId       = session.shop;

  // Not gated on the SKU Boo PIN session here — matches the homepage's
  // strategy: the loader reads freely (still behind Shopify's own
  // authenticate.admin above), the PinOverlay blocks interaction client-side,
  // and mutations are the actual enforcement point (see action below).
  const packages = await prisma.savedPackage.findMany({
    where: { shopId },
    orderBy: { name: "asc" },
  });

  return { shopId, packages };
}

// Shared by add_package and update_package below.
function parseDims(formData) {
  const length = parseFloat(formData.get("length"));
  const width  = parseFloat(formData.get("width"));
  const heightRaw = formData.get("height")?.toString().trim();
  const height = heightRaw ? parseFloat(heightRaw) : null;
  if (!Number.isFinite(length) || length <= 0) return { error: "Length must be a positive number" };
  if (!Number.isFinite(width)  || width  <= 0) return { error: "Width must be a positive number" };
  if (heightRaw && (!Number.isFinite(height) || height <= 0)) return { error: "Height must be a positive number, or left blank" };
  return { length, width, height };
}

// ── Action ────────────────────────────────────────────────────────────────────
export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shopId       = session.shop;

  const formData  = await request.formData();
  const sessionId = formData.get("sessionId")?.toString();
  const intent    = formData.get("intent");

  const skuSession = await validateSkuSession({ sessionId, shopId });
  if (!skuSession)                 return Response.json({ success: false, error: "Unauthorized — please sign in." });
  if (skuSession.role !== "admin") return Response.json({ success: false, error: "Forbidden — admin access required." });

  if (intent === "add_package") {
    const name = formData.get("name")?.toString().trim();
    if (!name) return Response.json({ success: false, error: "Name is required" });

    const dims = parseDims(formData);
    if (dims.error) return Response.json({ success: false, error: dims.error });

    try {
      await prisma.savedPackage.create({
        data: { shopId, name, length: dims.length, width: dims.width, height: dims.height },
      });
      return Response.json({ success: true, message: "Package added" });
    } catch {
      return Response.json({ success: false, error: "A package with that name already exists" });
    }
  }

  if (intent === "update_package") {
    const id = parseInt(formData.get("id"));
    const dims = parseDims(formData);
    if (dims.error) return Response.json({ success: false, error: dims.error });

    try {
      await prisma.savedPackage.update({
        where: { id },
        data: { length: dims.length, width: dims.width, height: dims.height },
      });
      return Response.json({ success: true, message: "Package updated" });
    } catch {
      return Response.json({ success: false, error: "Failed to update package" });
    }
  }

  if (intent === "delete_package") {
    const id = parseInt(formData.get("id"));
    try {
      await prisma.savedPackage.delete({ where: { id } });
      return Response.json({ success: true, message: "Package deleted" });
    } catch {
      return Response.json({ success: false, error: "Failed to delete package" });
    }
  }

  return Response.json({ success: false, error: "Unknown action" });
}

// ── Package Row ───────────────────────────────────────────────────────────────
function PackageRow({ pkg, sessionId, fetcher, index }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState({ length: pkg.length, width: pkg.width, height: pkg.height ?? "" });

  function save() {
    fetcher.submit(
      { intent: "update_package", id: String(pkg.id), length: String(draft.length), width: String(draft.width), height: String(draft.height), sessionId },
      { method: "POST", action: "/app/packages" },
    );
    setEditing(false);
  }

  function remove() {
    fetcher.submit(
      { intent: "delete_package", id: String(pkg.id), sessionId },
      { method: "POST", action: "/app/packages" },
    );
  }

  return (
    <tr style={{ background: index % 2 === 0 ? "#ffffff" : "#fafafa" }}>
      <td style={{ ...td, fontWeight: "600" }}>{pkg.name}</td>
      {editing ? (
        <>
          <td style={td}><input style={{ ...inputStyle, width: "80px" }} value={draft.length} onChange={(e) => setDraft((d) => ({ ...d, length: e.target.value }))} /></td>
          <td style={td}><input style={{ ...inputStyle, width: "80px" }} value={draft.width} onChange={(e) => setDraft((d) => ({ ...d, width: e.target.value }))} /></td>
          <td style={td}><input style={{ ...inputStyle, width: "80px" }} value={draft.height} onChange={(e) => setDraft((d) => ({ ...d, height: e.target.value }))} /></td>
          <td style={td}>
            <div style={{ display: "flex", gap: "8px" }}>
              <s-button variant="primary" onClick={save}>Save</s-button>
              <s-button variant="tertiary" onClick={() => setEditing(false)}>Cancel</s-button>
            </div>
          </td>
        </>
      ) : (
        <>
          <td style={td}>{pkg.length}{'"'}</td>
          <td style={td}>{pkg.width}{'"'}</td>
          <td style={td}>{pkg.height != null ? `${pkg.height}"` : <span style={{ color: "#6d7175" }}>— estimated</span>}</td>
          <td style={td}>
            <div style={{ display: "flex", gap: "8px" }}>
              <s-button variant="secondary" onClick={() => setEditing(true)}>Edit</s-button>
              <s-button variant="tertiary" tone="critical" onClick={remove}>Delete</s-button>
            </div>
          </td>
        </>
      )}
    </tr>
  );
}

// ── Packages Page ─────────────────────────────────────────────────────────────
export default function PackagesPage() {
  const loaderData = useLoaderData();
  const fetcher     = useFetcher();
  const { skuSession, sessionChecked, handleAuthSuccess, handleSignOut } = useSkuSession();

  const { packages } = loaderData ?? {};

  // Hooks above must run unconditionally on every render — all early
  // returns live below, after every hook has been declared.
  const [newPackage, setNewPackage] = useState({ name: "", length: "", width: "", height: "" });
  const [message, setMessage]       = useState(null);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.error)   setMessage({ type: "error", text: fetcher.data.error });
    if (fetcher.data.success) {
      setMessage({ type: "success", text: fetcher.data.message ?? "Saved" });
      setNewPackage({ name: "", length: "", width: "", height: "" });
    }
  }, [fetcher.data]);

  function handleAdd() {
    setMessage(null);
    fetcher.submit(
      { intent: "add_package", ...newPackage, sessionId: skuSession?.sessionId ?? "" },
      { method: "POST", action: "/app/packages" }
    );
  }

  if (!sessionChecked) return null;

  if (!packages) {
    return (
      <s-page heading="SKU Boo — Saved Packages">
        <s-section>
          <div style={{ fontSize: "16px", color: "#6d7175", padding: "32px", textAlign: "center" }}>
            Something went wrong loading this page. Please refresh.
          </div>
        </s-section>
      </s-page>
    );
  }

  const isForbidden = skuSession && skuSession.role !== "admin";

  return (
    <>
      {!skuSession && <PinOverlay onSuccess={handleAuthSuccess} />}
      <s-page heading="SKU Boo — Saved Packages">
        {skuSession && <UserBadge username={skuSession.username} onSignOut={handleSignOut} />}

        {isForbidden ? (
          <s-section>
            <div style={{ fontSize: "16px", color: "#d82c0d", padding: "32px", textAlign: "center" }}>
              Forbidden — Saved Packages requires admin access.
              <br />
              Signed in as {skuSession.username} ({skuSession.role}).
            </div>
          </s-section>
        ) : (
      <s-section>
        <div style={{ fontSize: "14px", color: "#6d7175", marginBottom: "20px", lineHeight: "1.6", maxWidth: "600px" }}>
          This is the shared list of box/envelope presets used both by the rate-check
          extension and the shipping-desk device — editing here updates it everywhere.
        </div>

        <div style={{ background: "#f6f6f7", borderRadius: "10px", padding: "20px 24px", marginBottom: "24px" }}>
          <div style={{ fontSize: "15px", fontWeight: "700", color: "#202223", marginBottom: "16px" }}>Add a Package</div>
          <div style={{ display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={labelStyle}>Name</div>
              <input
                style={inputStyle}
                placeholder="17 Cube (Default)"
                value={newPackage.name}
                onChange={(e) => setNewPackage((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div>
              <div style={labelStyle}>Length (in)</div>
              <input style={{ ...inputStyle, width: "90px" }} value={newPackage.length} onChange={(e) => setNewPackage((p) => ({ ...p, length: e.target.value }))} />
            </div>
            <div>
              <div style={labelStyle}>Width (in)</div>
              <input style={{ ...inputStyle, width: "90px" }} value={newPackage.width} onChange={(e) => setNewPackage((p) => ({ ...p, width: e.target.value }))} />
            </div>
            <div>
              <div style={labelStyle}>Height (in) <span style={{ color: "#6d7175", fontWeight: "400" }}>(optional)</span></div>
              <input style={{ ...inputStyle, width: "90px" }} value={newPackage.height} onChange={(e) => setNewPackage((p) => ({ ...p, height: e.target.value }))} />
            </div>
            <s-button onClick={handleAdd} variant="primary">Add Package</s-button>
          </div>

          {message && (
            <div style={{ marginTop: "14px", fontSize: "14px", fontWeight: "600", color: message.type === "error" ? "#d82c0d" : "#008060" }}>
              {message.type === "error" ? "✗" : "✓"} {message.text}
            </div>
          )}
        </div>

        {packages.length === 0 ? (
          <div style={{ fontSize: "14px", color: "#6d7175" }}>No saved packages yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "14px" }}>
            <thead>
              <tr style={{ background: "#f6f6f7" }}>
                {["Name", "Length", "Width", "Height", "Action"].map((h) => (
                  <th key={h} style={{ padding: "12px 16px", fontWeight: "700", color: "#202223", fontSize: "13px", textAlign: "left", borderBottom: "2px solid #e1e3e5" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {packages.map((pkg, i) => (
                <PackageRow key={pkg.id} pkg={pkg} sessionId={skuSession?.sessionId ?? ""} fetcher={fetcher} index={i} />
              ))}
            </tbody>
          </table>
        )}
      </s-section>
        )}
      </s-page>
    </>
  );
}

// ── Shared Styles ─────────────────────────────────────────────────────────────
const td = { padding: "14px 16px", color: "#202223", lineHeight: "1.4" };

const labelStyle = {
  fontSize: "13px", fontWeight: "600", color: "#202223",
  marginBottom: "6px", display: "block",
};

const inputStyle = {
  border: "2px solid #c9cccf", borderRadius: "6px",
  padding: "9px 12px", fontSize: "14px", outline: "none",
  background: "#ffffff", color: "#202223", width: "170px", lineHeight: "1.4",
};
