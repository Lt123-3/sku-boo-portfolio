// app/routes/app.ai-settings.jsx

import { authenticate }                          from "../shopify.server.js";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useState, useEffect }                   from "react";
import { validateSkuSession }                    from "../lib/access.server.js";
import {
  getAiSettingsForDisplay,
  saveAiSettings,
  clearApiKey,
  AI_MODEL_OPTIONS,
} from "../lib/ai.server.js";
// AI_MODEL_OPTIONS is only used by the loader below (to hand to the client
// as data), never imported directly into the rendered component — this file
// is a *.server.js module and React Router only strips loader/action from
// the client bundle, not other exports.

// ── Loader ────────────────────────────────────────────────────────────────────
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shopId       = session.shop;

  const url        = new URL(request.url);
  const sessionId  = url.searchParams.get("sessionId");
  const skuSession = await validateSkuSession({ sessionId, shopId });

  if (!skuSession)                 return new Response("Unauthorized", { status: 401 });
  if (skuSession.role !== "admin") return new Response("Forbidden — Admin access required", { status: 403 });

  const settings = await getAiSettingsForDisplay(shopId);
  return { settings, modelOptions: AI_MODEL_OPTIONS };
}

// ── Action ────────────────────────────────────────────────────────────────────
export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shopId       = session.shop;

  const formData  = await request.formData();
  const sessionId = formData.get("sessionId")?.toString();
  const intent    = formData.get("intent");

  const skuSession = await validateSkuSession({ sessionId, shopId });
  if (!skuSession)                 return new Response("Unauthorized", { status: 401 });
  if (skuSession.role !== "admin") return new Response("Forbidden",    { status: 403 });

  if (intent === "save_settings") {
    try {
      await saveAiSettings(shopId, {
        apiKey:                   formData.get("apiKey")?.toString() ?? "",
        titleSystemPrompt:        formData.get("titleSystemPrompt")?.toString() ?? "",
        descriptionSystemPrompt:  formData.get("descriptionSystemPrompt")?.toString() ?? "",
        model:                    formData.get("model")?.toString() ?? "",
        webSearchEnabled:         formData.get("webSearchEnabled") === "true",
        updatedBy:                skuSession.username,
      });
      return Response.json({ success: true, message: "Settings saved" });
    } catch (err) {
      console.error("[ai-settings] save failed:", err);
      return Response.json({ success: false, error: err.message });
    }
  }

  if (intent === "clear_api_key") {
    try {
      await clearApiKey(shopId);
      return Response.json({ success: true, message: "API key removed" });
    } catch (err) {
      console.error("[ai-settings] clear key failed:", err);
      return Response.json({ success: false, error: err.message });
    }
  }

  return Response.json({ success: false, error: "Unknown action" });
}

// ── Components ────────────────────────────────────────────────────────────────
function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize: "18px", fontWeight: "700", color: "#202223",
      marginBottom: "20px", paddingBottom: "10px",
      borderBottom: "2px solid #e1e3e5", letterSpacing: "-0.2px",
    }}>
      {children}
    </div>
  );
}

// ── AI Settings Page ────────────────────────────────────────────────────────────
export default function AiSettingsPage() {
  const loaderData = useLoaderData();
  const fetcher     = useFetcher();
  const navigate    = useNavigate();

  const { settings, modelOptions } = loaderData ?? {};

  // Hooks must run unconditionally on every render — declare all of them
  // before the "session expired" early return below.
  const [titleSystemPrompt,       setTitleSystemPrompt]       = useState(settings?.titleSystemPrompt ?? "");
  const [descriptionSystemPrompt, setDescriptionSystemPrompt] = useState(settings?.descriptionSystemPrompt ?? "");
  const [model,                   setModel]                   = useState(settings?.model ?? "claude-sonnet-5");
  const [webSearchEnabled,        setWebSearchEnabled]         = useState(settings?.webSearchEnabled ?? false);
  const [apiKey,                  setApiKey]                  = useState("");
  const [message,                 setMessage]                 = useState(null);

  const sessionId = typeof window !== "undefined"
    ? sessionStorage.getItem("skuboo_session_id") ?? ""
    : "";

  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.success) {
      setMessage({ type: "success", text: fetcher.data.message ?? "Saved" });
      setApiKey(""); // clear the field — never re-display what was just saved
    } else if (fetcher.data.error) {
      setMessage({ type: "error", text: fetcher.data.error });
    }
  }, [fetcher.data]);

  // --- Session expired guard ---
  if (!settings) {
    return (
      <s-page heading="SKU Boo — AI Settings">
        <s-section>
          <div style={{ fontSize: "16px", color: "#6d7175", padding: "32px", textAlign: "center" }}>
            Session expired. Please sign in again from the main page.
          </div>
        </s-section>
      </s-page>
    );
  }

  function handleSave() {
    setMessage(null);
    fetcher.submit(
      {
        intent: "save_settings", apiKey, titleSystemPrompt, descriptionSystemPrompt, model,
        webSearchEnabled: String(webSearchEnabled), sessionId,
      },
      { method: "POST", action: "/app/ai-settings" }
    );
  }

  function handleClearKey() {
    const confirmed = window.confirm(
      "Remove the saved Claude API key? Generate/Regenerate on the Prep page will stop working until a new key is added."
    );
    if (!confirmed) return;
    setMessage(null);
    fetcher.submit({ intent: "clear_api_key", sessionId }, { method: "POST", action: "/app/ai-settings" });
  }

  return (
    <s-page heading="SKU Boo — AI Settings">

      {/* ── Top navigation ────────────────────────────────────────────────── */}
      <s-section>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <s-button variant="secondary" onClick={() => navigate(`/app/admin?sessionId=${sessionId}`)}>
            ← Back to Admin
          </s-button>
        </div>
      </s-section>

      {/* ══ API KEY ══════════════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>🔑 Claude API Key</SectionHeading>
        <div style={{ fontSize: "14px", color: "#6d7175", marginBottom: "16px", maxWidth: "600px", lineHeight: "1.6" }}>
          Stored encrypted. Once saved, the key is never shown again here or anywhere else —
          only this status line and the last 4 characters.
        </div>

        <div style={{ marginBottom: "14px", fontSize: "14px", color: "#202223" }}>
          Current key:{" "}
          {settings.hasApiKey
            ? <strong>{settings.apiKeyPreview}</strong>
            : <span style={{ color: "#d82c0d", fontWeight: "600" }}>not set</span>}
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={labelStyle}>{settings.hasApiKey ? "Replace key" : "API key"}</div>
            <input
              type="password"
              style={{ ...inputStyle, width: "360px", fontFamily: "monospace" }}
              placeholder={settings.hasApiKey ? "Leave blank to keep the current key" : "sk-ant-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          {settings.hasApiKey && (
            <button
              onClick={handleClearKey}
              style={{
                background: "none", border: "2px solid #d82c0d", color: "#d82c0d",
                borderRadius: "6px", padding: "9px 16px", cursor: "pointer", fontSize: "13px", fontWeight: "600",
              }}
            >
              Remove key
            </button>
          )}
        </div>
      </s-section>

      {/* ══ TITLE SYSTEM PROMPT ═════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>✍️ Title generation</SectionHeading>
        <div style={labelStyle}>System prompt</div>
        <textarea
          style={{ ...inputStyle, width: "100%", minHeight: "140px", fontFamily: "monospace", resize: "vertical" }}
          value={titleSystemPrompt}
          onChange={(e) => setTitleSystemPrompt(e.target.value)}
        />
      </s-section>

      {/* ══ DESCRIPTION SYSTEM PROMPT ═══════════════════════════════════════ */}
      <s-section>
        <SectionHeading>📝 Description generation</SectionHeading>
        <div style={labelStyle}>System prompt</div>
        <textarea
          style={{ ...inputStyle, width: "100%", minHeight: "180px", fontFamily: "monospace", resize: "vertical" }}
          value={descriptionSystemPrompt}
          onChange={(e) => setDescriptionSystemPrompt(e.target.value)}
        />
      </s-section>

      {/* ══ MODEL ════════════════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>🤖 Model</SectionHeading>
        <select
          style={{ ...selectStyle, width: "380px" }}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {(modelOptions ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </s-section>

      {/* ══ WEB SEARCH ═══════════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>🔎 Web Search</SectionHeading>
        <div style={{ fontSize: "14px", color: "#6d7175", marginBottom: "14px", maxWidth: "600px", lineHeight: "1.6" }}>
          When enabled, Claude looks up similar eBay listings before writing a title
          or description, so the output better matches real buyer-facing conventions. Restricted
          to that site only. Adds a small amount of cost and latency per generation.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "14px", fontWeight: "600", color: "#202223", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={webSearchEnabled}
            onChange={(e) => setWebSearchEnabled(e.target.checked)}
            style={{ width: "18px", height: "18px", cursor: "pointer" }}
          />
          Search eBay listings for similar products
        </label>
      </s-section>

      {/* ══ SAVE ═════════════════════════════════════════════════════════════ */}
      <s-section>
        <s-button onClick={handleSave} variant="primary" disabled={isSaving}>
          {isSaving ? "Saving…" : "Save Settings"}
        </s-button>

        {message && (
          <div style={{ marginTop: "14px", fontSize: "14px", fontWeight: "600", color: message.type === "error" ? "#d82c0d" : "#008060" }}>
            {message.type === "error" ? "✗" : "✓"} {message.text}
          </div>
        )}

        {settings.updatedAt && (
          <div style={{ marginTop: "10px", fontSize: "12px", color: "#6d7175" }}>
            Last updated {new Date(settings.updatedAt).toLocaleString()}
            {settings.updatedBy ? ` by ${settings.updatedBy}` : ""}
          </div>
        )}
      </s-section>

    </s-page>
  );
}

// ── Shared Styles ─────────────────────────────────────────────────────────────
const labelStyle = {
  fontSize: "13px", fontWeight: "600", color: "#202223",
  marginBottom: "6px", display: "block",
};

const inputStyle = {
  border: "2px solid #c9cccf", borderRadius: "6px",
  padding: "9px 12px", fontSize: "14px", outline: "none",
  background: "#ffffff", color: "#202223", lineHeight: "1.4", boxSizing: "border-box",
};

const selectStyle = {
  border: "2px solid #c9cccf", borderRadius: "6px",
  padding: "9px 12px", fontSize: "14px", outline: "none",
  background: "#ffffff", color: "#202223", lineHeight: "1.4",
  cursor: "pointer", minWidth: "220px",
};
