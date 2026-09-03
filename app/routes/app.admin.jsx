// app/routes/app.admin.jsx

import { authenticate }                          from "../shopify.server.js";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useState, useEffect }                   from "react";
import { validateSkuSession }                    from "../lib/access.server.js";
import prisma                                    from "../db.server.js";

// ── Loader ────────────────────────────────────────────────────────────────────
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopId             = session.shop;

  const url        = new URL(request.url);
  const sessionId  = url.searchParams.get("sessionId");
  const skuSession = await validateSkuSession({ sessionId, shopId });

  if (!skuSession)                 return new Response("Unauthorized", { status: 401 });
  if (skuSession.role !== "admin") return new Response("Forbidden — Admin access required", { status: 403 });

  const { getSyncState, getProductsCount } = await import("../lib/sync.server.js");

  const [
    skuIndexTotal, skuIndexActive, skuIndexProblem,
    skuIndexFree, skuIndexDeleted, productInfoTotal,
    skuHistoryTotal, accessKeys, syncState, productsCount, recentChanges,
  ] = await Promise.all([
    prisma.skuIndex.count({ where: { shopId } }),
    prisma.skuIndex.count({ where: { shopId, status: "active"  } }),
    prisma.skuIndex.count({ where: { shopId, status: "problem" } }),
    prisma.skuIndex.count({ where: { shopId, status: "free"    } }),
    prisma.skuIndex.count({ where: { shopId, status: "deleted" } }),
    prisma.productInfo.count({ where: { shopId } }),
    prisma.skuHistory.count({ where: { shopId } }),
    prisma.accessKey.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } }),
    getSyncState(shopId),
    getProductsCount(admin),
    prisma.skuHistory.findMany({ where: { shopId }, orderBy: { changedAt: "desc" }, take: 10 }),
  ]);

  return {
    shopId,
    username: skuSession.username,
    stats: {
      skuIndexTotal, skuIndexActive, skuIndexProblem,
      skuIndexFree, skuIndexDeleted, productInfoTotal,
      skuHistoryTotal, productsCount,
    },
    accessKeys,
    syncState,
    recentChanges,
  };
}

// ── Action ────────────────────────────────────────────────────────────────────
export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopId             = session.shop;

  const formData  = await request.formData();
  const sessionId = formData.get("sessionId")?.toString();
  const intent    = formData.get("intent");

  const { updateSyncState, runInitSyncPass1, runInitSyncPass2, getSyncState, forceCronRun } =
    await import("../lib/sync.server.js");

  const skuSession = await validateSkuSession({ sessionId, shopId });
  if (!skuSession)                 return new Response("Unauthorized", { status: 401 });
  if (skuSession.role !== "admin") return new Response("Forbidden",    { status: 403 });

  if (intent === "force_cron") {
    forceCronRun(admin, shopId).catch((err) => console.error("[admin] Force cron failed:", err));
    return Response.json({ success: true, message: "Cron triggered" });
  }

  if (intent === "cancel_sync") {
    await updateSyncState(shopId, { status: "cancelled" });
    return Response.json({ success: true, message: "Sync cancellation requested" });
  }

  if (intent === "reset_sync") {
    await updateSyncState(shopId, {
      status: "idle", processed: 0, total: 0,
      cursor: null, lastError: null, currentPass: null, eta: null,
    });
    return Response.json({ success: true, message: "Sync state reset" });
  }

  if (intent === "init_sync") {
    const pass          = formData.get("pass");
    const speed         = formData.get("speed") ?? "medium";
    const resumeCursor  = formData.get("resumeCursor") ?? null;
    const productsCount = parseInt(formData.get("productsCount") ?? "0");

    await updateSyncState(shopId, {
      status:      "running",
      currentPass: pass === "both" ? 1 : parseInt(pass),
      processed:   0,
      total:       productsCount,
      startedAt:   new Date(),
      startTime:   new Date(),
      lastError:   null,
      cursor:      resumeCursor ?? null,
    });

    (async () => {
      try {
        if (pass === "1") {
          await runInitSyncPass1(admin, shopId, resumeCursor || null, speed);
        } else if (pass === "2") {
          await runInitSyncPass2(admin, shopId, resumeCursor || null, speed);
        } else if (pass === "both") {
          await runInitSyncPass1(admin, shopId, null, speed);
          const stateAfterPass1 = await getSyncState(shopId);
          if (stateAfterPass1?.status !== "cancelled") {
            await runInitSyncPass2(admin, shopId, null, speed);
          }
        }
        const finalState = await getSyncState(shopId);
        if (finalState?.status === "running") {
          await updateSyncState(shopId, { status: "complete", completedAt: new Date(), cursor: null });
        }
      } catch (err) {
        console.error("[admin] Init sync failed:", err);
        await updateSyncState(shopId, { status: "error", lastError: err.message });
      }
    })();

    return Response.json({ success: true, message: "Sync started" });
  }

  if (intent === "sync_status") {
    const state = await getSyncState(shopId);
    const [skuIndexTotal, productInfoTotal] = await Promise.all([
      prisma.skuIndex.count({ where: { shopId } }),
      prisma.productInfo.count({ where: { shopId } }),
    ]);
    return Response.json({ success: true, syncState: state, skuIndexTotal, productInfoTotal });
  }
  
  if (intent === "add_user") {
    const userId   = formData.get("userId")?.toString().trim();
    const username = formData.get("username")?.toString().trim();
    const initials = formData.get("initials")?.toString().trim().toLowerCase();
    const role     = formData.get("role")?.toString().trim();

    if (!userId || !/^\d{4}$/.test(userId))
      return Response.json({ success: false, error: "Access code must be exactly 4 digits" });
    if (!username)
      return Response.json({ success: false, error: "Username is required" });
    if (!initials || !/^[a-z]{1,4}$/.test(initials))
      return Response.json({ success: false, error: "Initials must be 1-4 letters" });

    try {
      await prisma.accessKey.create({
        data: { shopId, userId, username, initials, role: role ?? "operator", active: true },
      });
      return Response.json({ success: true, message: "User added successfully" });
    } catch {
      return Response.json({ success: false, error: "That access code is already in use" });
    }
  }

  if (intent === "toggle_user") {
    const keyId  = parseInt(formData.get("keyId"));
    const active = formData.get("active") === "true";
    try {
      await prisma.accessKey.update({ where: { id: keyId }, data: { active: !active } });
      return Response.json({ success: true });
    } catch {
      return Response.json({ success: false, error: "Failed to update user" });
    }
  }

  if (intent === "update_initials") {
    const keyId    = parseInt(formData.get("keyId"));
    const initials = formData.get("initials")?.toString().trim().toLowerCase();
    if (!initials || !/^[a-z]{1,4}$/.test(initials))
      return Response.json({ success: false, error: "Initials must be 1-4 letters" });
    try {
      await prisma.accessKey.update({ where: { id: keyId }, data: { initials } });
      return Response.json({ success: true });
    } catch {
      return Response.json({ success: false, error: "Failed to update initials" });
    }
  }

  return Response.json({ success: false, error: "Unknown action" });
}

// ── Components ────────────────────────────────────────────────────────────────
function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: "#ffffff", border: "2px solid #e1e3e5",
      borderRadius: "10px", padding: "20px 24px",
      minWidth: "130px", textAlign: "center", flex: "1 1 130px",
    }}>
      <div style={{ fontSize: "32px", fontWeight: "800", color: color ?? "#202223", lineHeight: "1.1", letterSpacing: "-0.5px" }}>
        {value?.toLocaleString() ?? 0}
      </div>
      <div style={{ fontSize: "13px", color: "#6d7175", marginTop: "6px", fontWeight: "500" }}>{label}</div>
    </div>
  );
}

function ProgressBar({ processed, total, label, eta }) {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px", fontWeight: "600", color: "#202223", marginBottom: "6px" }}>
        <span>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {(processed ?? 0).toLocaleString()} / {(total ?? 0).toLocaleString()} ({pct}%)
        </span>
      </div>
      <div style={{ background: "#e1e3e5", borderRadius: "999px", height: "14px", overflow: "hidden" }}>
        <div style={{ background: "#008060", height: "100%", width: `${pct}%`, borderRadius: "999px", transition: "width 0.5s ease" }} />
      </div>
      {eta && <div style={{ fontSize: "13px", color: "#6d7175", marginTop: "6px" }}>⏱ {eta}</div>}
    </div>
  );
}

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

function speedLabel(speed) {
  if (speed === "slow")   return "🐢 Slow (2s) — safest";
  if (speed === "medium") return "🚶 Medium (0.8s) — recommended";
  if (speed === "fast")   return "⚡ Fast (0.2s) — may impact storefront";
  return speed;
}

// ── Admin Page ────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const loaderData    = useLoaderData();
  const fetcher       = useFetcher();
  const statusFetcher = useFetcher();
  const navigate      = useNavigate();

  const { stats, accessKeys, syncState: initialSyncState, recentChanges } = loaderData ?? {};

  // Hooks must run unconditionally on every render — the "session expired"
  // early return lives below, after every hook has been declared.
  const [syncState,    setSyncState]    = useState(initialSyncState);
  const [liveStats,    setLiveStats]    = useState(stats ?? {});
  const [newUser,      setNewUser]      = useState({ userId: "", username: "", initials: "", role: "operator" });
  const [userMessage,  setUserMessage]  = useState(null);
  const [syncMessage,  setSyncMessage]  = useState(null);
  const [speed,        setSpeed]        = useState("medium");
  const [selectedPass, setSelectedPass] = useState("both");
  const [isPolling,    setIsPolling]    = useState(false);

  const sessionId = typeof window !== "undefined"
    ? sessionStorage.getItem("skuboo_session_id") ?? ""
    : "";

  const isRunning   = syncState?.status === "running";
  const isCancelled = syncState?.status === "cancelled";
  const isComplete  = syncState?.status === "complete";
  const isError     = syncState?.status === "error";
  const hasCursor   = !!syncState?.cursor;

  useEffect(() => { if (isRunning) setIsPolling(true); }, [isRunning]);

  useEffect(() => {
    if (!isPolling) return;
    const interval = setInterval(() => {
      statusFetcher.submit(
        { intent: "sync_status", sessionId },
        { method: "POST", action: "/app/admin" }
      );
    }, 2000);
    return () => clearInterval(interval);
  }, [isPolling, sessionId]);

  useEffect(() => {
    if (!statusFetcher.data) return;
    if (statusFetcher.data.syncState) {
      const s = statusFetcher.data.syncState;
      setSyncState(s);
      if (s.status !== "running") setIsPolling(false);
    }
    if (statusFetcher.data.skuIndexTotal !== undefined) {
      setLiveStats((prev) => ({
        ...prev,
        skuIndexTotal:    statusFetcher.data.skuIndexTotal,
        productInfoTotal: statusFetcher.data.productInfoTotal,
      }));
    }
  }, [statusFetcher.data]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.message) setSyncMessage(fetcher.data.message);
    if (fetcher.data.error)   setUserMessage({ type: "error", text: fetcher.data.error });
    if (fetcher.data.success && fetcher.data.message === "User added successfully") {
      setUserMessage({ type: "success", text: "User added successfully" });
      setNewUser({ userId: "", username: "", role: "operator" });
    }
  }, [fetcher.data]);

  // --- Session expired guard ---
  if (!stats || !accessKeys) {
    return (
      <s-page heading="SKU Boo — Admin Panel">
        <s-section>
          <div style={{ fontSize: "16px", color: "#6d7175", padding: "32px", textAlign: "center" }}>
            Session expired. Please sign in again from the main page.
          </div>
        </s-section>
      </s-page>
    );
  }

  function handleForceCron() {
    setSyncMessage("Forcing cron run...");
    fetcher.submit({ intent: "force_cron", sessionId }, { method: "POST", action: "/app/admin" });
  }

  function handleStartSync() {
    setSyncMessage(`Starting Pass ${selectedPass}...`);
    setIsPolling(true);
    fetcher.submit(
      { intent: "init_sync", pass: selectedPass, speed, productsCount: String(liveStats.productsCount), resumeCursor: "", sessionId },
      { method: "POST", action: "/app/admin" }
    );
  }

  function handleResumeSync() {
    setSyncMessage(`Resuming Pass ${syncState?.currentPass}...`);
    setIsPolling(true);
    fetcher.submit(
      { intent: "init_sync", pass: String(syncState?.currentPass ?? "1"), speed, productsCount: String(liveStats.productsCount), resumeCursor: syncState?.cursor ?? "", sessionId },
      { method: "POST", action: "/app/admin" }
    );
  }

  function handleCancelSync() {
    setSyncMessage("Cancelling sync — will stop after current page...");
    fetcher.submit({ intent: "cancel_sync", sessionId }, { method: "POST", action: "/app/admin" });
  }

  function handleResetSync() {
    setSyncMessage("Sync state reset.");
    setIsPolling(false);
    fetcher.submit({ intent: "reset_sync", sessionId }, { method: "POST", action: "/app/admin" });
    setSyncState(null);
  }

  function handleToggleUser(keyId, active) {
    fetcher.submit(
      { intent: "toggle_user", keyId: String(keyId), active: String(active), sessionId },
      { method: "POST", action: "/app/admin" }
    );
  }

  function handleAddUser() {
    setUserMessage(null);
    fetcher.submit({ intent: "add_user", ...newUser, sessionId }, { method: "POST", action: "/app/admin" });
  }

  function handleUpdateInitials(keyId, initials) {
    fetcher.submit(
      { intent: "update_initials", keyId: String(keyId), initials, sessionId },
      { method: "POST", action: "/app/admin" }
    );
  }

  return (
    <s-page heading="SKU Boo — Admin Panel">

      {/* ── Top navigation ────────────────────────────────────────────────── */}
      <s-section>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <s-button
            variant="secondary"
            onClick={() => navigate(`/app/problem-dashboard?sessionId=${sessionId}`)}
          >
            ⚠ Problem Dashboard
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => navigate(`/app/packages?sessionId=${sessionId}`)}
          >
            📦 Saved Packages
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => navigate(`/app/ai-settings?sessionId=${sessionId}`)}
          >
            🤖 AI Settings
          </s-button>
        </div>
      </s-section>

      {/* ══ DATABASE STATS ══════════════════════════════════════════════════ */}
      <s-section>
        <div style={{ display: "flex", gap: "14px" }}>
          <StatCard label="Total Products" value={liveStats.productInfoTotal} color="#202223" />
          <StatCard label="Active"         value={liveStats.skuIndexActive}   color="#008060" />
          <StatCard label="Problems"       value={liveStats.skuIndexProblem}  color="#d82c0d" />
        </div>
      </s-section>

      {/* ══ SYNC CONTROLS ═══════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>🔄 Sync Controls</SectionHeading>

        <div style={{ background: "#f6f6f7", borderRadius: "8px", padding: "12px 16px", marginBottom: "20px", fontSize: "14px", color: "#6d7175" }}>
          {syncState?.lastCronRun
            ? <>Last cron run: <strong style={{ color: "#202223" }}>{new Date(syncState.lastCronRun).toLocaleString()}</strong></>
            : "No cron run recorded yet"
          }
        </div>

        <s-button onClick={handleForceCron} variant="secondary">⚡ Force Cron Now</s-button>

        <div style={{ marginTop: "28px", borderTop: "2px solid #e1e3e5", paddingTop: "24px" }}>
          <div style={{ fontSize: "16px", fontWeight: "700", marginBottom: "8px", color: "#202223" }}>
            Initial Full Sync
          </div>
          <div style={{ fontSize: "14px", color: "#6d7175", marginBottom: "20px", lineHeight: "1.6", maxWidth: "600px" }}>
            <strong>Pass 1</strong> — Builds the SKU Index. Fast.<br />
            <strong>Pass 2</strong> — Fills in full product details. Slower.<br />
            <strong>Both</strong> — Runs Pass 1 then Pass 2 sequentially.
          </div>

          <div style={{ display: "flex", gap: "24px", alignItems: "flex-end", flexWrap: "wrap", marginBottom: "20px" }}>
            <div>
              <div style={labelStyle}>Which pass?</div>
              <select style={selectStyle} value={selectedPass} onChange={(e) => setSelectedPass(e.target.value)} disabled={isRunning}>
                <option value="both">▶▶ Run Both (1 then 2)</option>
                <option value="1">▶ Pass 1 — SKU Index only</option>
                <option value="2">▶ Pass 2 — Product Info only</option>
              </select>
            </div>
            <div>
              <div style={labelStyle}>Sync speed</div>
              <select style={selectStyle} value={speed} onChange={(e) => setSpeed(e.target.value)} disabled={isRunning}>
                <option value="slow">🐢 Slow (2s) — safest</option>
                <option value="medium">🚶 Medium (0.8s) — recommended</option>
                <option value="fast">⚡ Fast (0.2s) — may impact storefront</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            {!isRunning && (
              <s-button onClick={handleStartSync} variant="primary">▶ Start Sync</s-button>
            )}
            {!isRunning && hasCursor && (
              <s-button onClick={handleResumeSync} variant="secondary">↩ Resume from checkpoint</s-button>
            )}
            {isRunning && (
              <s-button onClick={handleCancelSync} variant="secondary" tone="critical">⏹ Stop Sync</s-button>
            )}
            {!isRunning && syncState && syncState.status !== "idle" && (
              <s-button onClick={handleResetSync} variant="tertiary">↺ Reset State</s-button>
            )}
          </div>

          {isRunning && syncState && (
            <ProgressBar
              label={`Pass ${syncState.currentPass} running at ${speedLabel(speed)}`}
              processed={syncState.processed ?? 0}
              total={syncState.total ?? 0}
              eta={syncState.eta}
            />
          )}

          {syncMessage && (
            <div style={{ marginTop: "12px", fontSize: "14px", color: "#6d7175" }}>{syncMessage}</div>
          )}

          {isComplete && (
            <div style={{ marginTop: "16px", padding: "12px 16px", background: "#f0fff8", border: "1px solid #008060", borderRadius: "8px", fontSize: "14px", color: "#008060", fontWeight: "600" }}>
              ✓ Sync complete — {syncState.processed?.toLocaleString()} products processed
            </div>
          )}

          {isCancelled && (
            <div style={{ marginTop: "16px", padding: "12px 16px", background: "#fff8e1", border: "1px solid #f0a500", borderRadius: "8px", fontSize: "14px", color: "#8a6200", fontWeight: "600" }}>
              ⏹ Sync stopped. {syncState.processed?.toLocaleString()} products processed.
              {hasCursor && " A checkpoint was saved — you can resume."}
            </div>
          )}

          {isError && (
            <div style={{ marginTop: "16px", padding: "12px 16px", background: "#fff0f0", border: "1px solid #d82c0d", borderRadius: "8px", fontSize: "14px", color: "#d82c0d", fontWeight: "600" }}>
              ✗ Sync error: {syncState.lastError}
              {hasCursor && <div style={{ marginTop: "4px", fontWeight: "400" }}>A checkpoint was saved — you can resume.</div>}
            </div>
          )}

          {hasCursor && !isRunning && (
            <div style={{ marginTop: "12px", fontSize: "13px", color: "#6d7175", background: "#f6f6f7", borderRadius: "6px", padding: "8px 12px" }}>
              📍 Checkpoint saved at Pass {syncState?.currentPass} — {syncState?.processed?.toLocaleString()} products processed
            </div>
          )}
        </div>
      </s-section>

      {/* ══ RECENT CHANGE HISTORY ═══════════════════════════════════════════ */}
      <s-section>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: "20px", paddingBottom: "10px", borderBottom: "2px solid #e1e3e5",
        }}>
          <div style={{ fontSize: "18px", fontWeight: "700", color: "#202223", letterSpacing: "-0.2px" }}>
            🕐 Recent Change History
          </div>
          <div style={{
            background: "#e8f0fe", border: "1px solid #c2d4f8",
            borderRadius: "8px", padding: "6px 16px",
            fontSize: "14px", fontWeight: "600", color: "#005bd3",
          }}>
            Total Logged Changes: {liveStats.skuHistoryTotal?.toLocaleString() ?? 0}
          </div>
        </div>

        {recentChanges.length === 0 ? (
          <div style={{ fontSize: "14px", color: "#6d7175" }}>No changes recorded yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "14px" }}>
              <thead>
                <tr style={{ background: "#f6f6f7" }}>
                  {["SKU", "Field", "Old Value", "New Value", "Changed By", "When"].map((h) => (
                    <th key={h} style={{ padding: "12px 16px", fontWeight: "700", color: "#202223", fontSize: "13px", textAlign: "left", borderBottom: "2px solid #e1e3e5", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentChanges.map((row, i) => (
                  <tr key={row.id} style={{ background: i % 2 === 0 ? "#ffffff" : "#fafafa" }}>
                    <td style={td}>{row.skuNumber ?? "—"}</td>
                    <td style={td}>
                      <span style={{ background: "#f1f1f1", padding: "3px 10px", borderRadius: "4px", fontFamily: "monospace", fontSize: "13px" }}>
                        {row.field}
                      </span>
                    </td>
                    <td style={{ ...td, color: "#d82c0d", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.oldValue ?? "—"}
                    </td>
                    <td style={{ ...td, color: "#008060", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.newValue ?? "—"}
                    </td>
                    <td style={{ ...td, fontWeight: "600" }}>{row.changedBy}</td>
                    <td style={{ ...td, color: "#6d7175", whiteSpace: "nowrap" }}>
                      {new Date(row.changedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {/* ══ USER MANAGEMENT ═════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>👥 User Management</SectionHeading>

        <div style={{ background: "#f6f6f7", borderRadius: "10px", padding: "20px 24px", marginBottom: "24px" }}>
          <div style={{ fontSize: "15px", fontWeight: "700", color: "#202223", marginBottom: "16px" }}>Add New User</div>
          <div style={{ display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={labelStyle}>Username</div>
              <input
                style={inputStyle}
                placeholder="Larrie"
                value={newUser.username}
                onChange={(e) => setNewUser((u) => ({ ...u, username: e.target.value }))}
              />
            </div>
            <div>
              <div style={labelStyle}>Access Code <span style={{ color: "#6d7175", fontWeight: "400" }}>(4 digits)</span></div>
              <input
                style={{ ...inputStyle, width: "110px", letterSpacing: "4px", fontFamily: "monospace" }}
                placeholder="1234"
                maxLength={4}
                value={newUser.userId}
                onChange={(e) => setNewUser((u) => ({ ...u, userId: e.target.value.replace(/\D/g, "") }))}
              />
            </div>
            <div>
              <div style={labelStyle}>Initials <span style={{ color: "#6d7175", fontWeight: "400" }}>(names auto-created collections)</span></div>
              <input
                style={{ ...inputStyle, width: "90px", letterSpacing: "2px", fontFamily: "monospace" }}
                placeholder="lt"
                maxLength={4}
                value={newUser.initials}
                onChange={(e) => setNewUser((u) => ({ ...u, initials: e.target.value.replace(/[^a-zA-Z]/g, "").toLowerCase() }))}
              />
            </div>
            <div>
              <div style={labelStyle}>Role</div>
              <select
                style={{ ...inputStyle, width: "140px" }}
                value={newUser.role}
                onChange={(e) => setNewUser((u) => ({ ...u, role: e.target.value }))}
              >
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <s-button onClick={handleAddUser} variant="primary">Add User</s-button>
          </div>

          {userMessage && (
            <div style={{ marginTop: "14px", fontSize: "14px", fontWeight: "600", color: userMessage.type === "error" ? "#d82c0d" : "#008060" }}>
              {userMessage.type === "error" ? "✗" : "✓"} {userMessage.text}
            </div>
          )}
        </div>

        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "14px" }}>
          <thead>
            <tr style={{ background: "#f6f6f7" }}>
              {["Username", "Code", "Initials", "Role", "Status", "Added", "Action"].map((h) => (
                <th key={h} style={{ padding: "12px 16px", fontWeight: "700", color: "#202223", fontSize: "13px", textAlign: "left", borderBottom: "2px solid #e1e3e5" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accessKeys.map((key, i) => (
              <tr key={key.id} style={{ background: i % 2 === 0 ? "#ffffff" : "#fafafa" }}>
                <td style={{ ...td, fontWeight: "600", fontSize: "15px" }}>{key.username}</td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: "15px", letterSpacing: "2px" }}>{key.userId}</td>
                <td style={td}>
                  <input
                    key={key.id}
                    defaultValue={key.initials ?? ""}
                    maxLength={4}
                    placeholder="—"
                    style={{ ...inputStyle, width: "60px", fontFamily: "monospace", letterSpacing: "1px" }}
                    onBlur={(e) => {
                      const next = e.target.value.replace(/[^a-zA-Z]/g, "").toLowerCase();
                      e.target.value = next;
                      if (next && next !== (key.initials ?? "")) handleUpdateInitials(key.id, next);
                    }}
                  />
                </td>
                <td style={td}>
                  <span style={{
                    background:    key.role === "admin" ? "#fff0f0" : key.role === "operator" ? "#f0f7ff" : "#f6f6f7",
                    color:         key.role === "admin" ? "#d82c0d" : key.role === "operator" ? "#005bd3" : "#6d7175",
                    padding:       "4px 12px", borderRadius: "20px",
                    fontSize:      "12px", fontWeight: "700",
                    textTransform: "uppercase", letterSpacing: "0.5px",
                  }}>
                    {key.role}
                  </span>
                </td>
                <td style={td}>
                  <span style={{ color: key.active ? "#008060" : "#d82c0d", fontWeight: "600" }}>
                    {key.active ? "● Active" : "○ Revoked"}
                  </span>
                </td>
                <td style={{ ...td, color: "#6d7175" }}>{new Date(key.createdAt).toLocaleDateString()}</td>
                <td style={td}>
                  <button
                    onClick={() => handleToggleUser(key.id, key.active)}
                    style={{
                      background: "none",
                      border:     `2px solid ${key.active ? "#d82c0d" : "#008060"}`,
                      color:      key.active ? "#d82c0d" : "#008060",
                      borderRadius: "6px", padding: "5px 14px",
                      cursor: "pointer", fontSize: "13px", fontWeight: "600",
                    }}
                  >
                    {key.active ? "Revoke" : "Restore"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

    </s-page>
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

const selectStyle = {
  border: "2px solid #c9cccf", borderRadius: "6px",
  padding: "9px 12px", fontSize: "14px", outline: "none",
  background: "#ffffff", color: "#202223", lineHeight: "1.4",
  cursor: "pointer", minWidth: "220px",
};