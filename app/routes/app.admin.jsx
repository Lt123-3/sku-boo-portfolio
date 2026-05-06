// app/routes/app.admin.jsx

import { authenticate }                    from "../shopify.server.js";
import { useFetcher, useLoaderData }       from "react-router";
import { useState, useEffect }             from "react";
import { validateSkuSession }              from "../lib/access.server.js";
import prisma                              from "../db.server.js";
import {
  getSyncState,
  getProductsCount,
  updateSyncState,
  runFullInitSync,
  forceCronRun,
}                                          from "../lib/sync.server.js";

// ── Loader ────────────────────────────────────────────────────────────────────
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopId             = session.shop;

  // --- Validate SKU Boo session from URL param ---
  const url       = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  const skuSession = await validateSkuSession({ sessionId, shopId });

  if (!skuSession) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (skuSession.role !== "admin") {
    return new Response("Forbidden — Admin access required", { status: 403 });
  }

  // --- Load all data in parallel ---
  const [
    skuIndexTotal,
    skuIndexActive,
    skuIndexProblem,
    skuIndexFree,
    skuIndexDeleted,
    productInfoTotal,
    skuHistoryTotal,
    accessKeys,
    syncState,
    productsCount,
    recentChanges,
  ] = await Promise.all([
    prisma.skuIndex.count({ where: { shopId } }),
    prisma.skuIndex.count({ where: { shopId, status: "active"   } }),
    prisma.skuIndex.count({ where: { shopId, status: "problem"  } }),
    prisma.skuIndex.count({ where: { shopId, status: "free"     } }),
    prisma.skuIndex.count({ where: { shopId, status: "deleted"  } }),
    prisma.productInfo.count({ where: { shopId } }),
    prisma.skuHistory.count({ where: { shopId } }),
    prisma.accessKey.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } }),
    getSyncState(shopId),
    getProductsCount(admin),
    prisma.skuHistory.findMany({
      where:   { shopId },
      orderBy: { changedAt: "desc" },
      take:    10,
    }),
  ]);

  return {
    shopId,
    username: skuSession.username,
    stats: {
      skuIndexTotal,
      skuIndexActive,
      skuIndexProblem,
      skuIndexFree,
      skuIndexDeleted,
      productInfoTotal,
      skuHistoryTotal,
      productsCount,
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

  // --- Validate SKU Boo session ---
  const skuSession = await validateSkuSession({ sessionId, shopId });
  if (!skuSession)                    return new Response("Unauthorized", { status: 401 });
  if (skuSession.role !== "admin")    return new Response("Forbidden",    { status: 403 });

  // ── Force cron ──────────────────────────────────────────────────────────────
  if (intent === "force_cron") {
    forceCronRun(admin, shopId).catch((err) => {
      console.error("[admin] Force cron failed:", err);
    });
    return new Response(
      JSON.stringify({ success: true, message: "Cron triggered — check terminal for progress" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Start init sync ──────────────────────────────────────────────────────────
  if (intent === "init_sync") {
    const pass          = formData.get("pass");
    const productsCount = parseInt(formData.get("productsCount") ?? "0");

    await updateSyncState(shopId, {
      status:      "running",
      currentPass: parseInt(pass),
      processed:   0,
      total:       productsCount,
      startedAt:   new Date(),
      lastError:   null,
    });

    // --- Run in background so the response returns immediately ---
    (async () => {
      try {
        if (pass === "1") {
          await runFullInitSync(admin, shopId);
        } else {
          const { runInitSyncPass2 } = await import("../lib/sync.server.js");
          await runInitSyncPass2(admin, shopId);
        }
        await updateSyncState(shopId, {
          status:      "complete",
          completedAt: new Date(),
        });
      } catch (err) {
        console.error("[admin] Init sync failed:", err);
        await updateSyncState(shopId, {
          status:    "error",
          lastError: err.message,
        });
      }
    })();

    return new Response(
      JSON.stringify({ success: true, message: "Sync started — progress bar will update" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Sync status poll ─────────────────────────────────────────────────────────
  if (intent === "sync_status") {
    const state = await getSyncState(shopId);
    return new Response(
      JSON.stringify({ success: true, syncState: state }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Add user ─────────────────────────────────────────────────────────────────
  if (intent === "add_user") {
    const userId   = formData.get("userId")?.toString().trim();
    const username = formData.get("username")?.toString().trim();
    const role     = formData.get("role")?.toString().trim();

    if (!userId || !/^\d{4}$/.test(userId)) {
      return new Response(
        JSON.stringify({ success: false, error: "Access code must be exactly 4 digits" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (!username) {
      return new Response(
        JSON.stringify({ success: false, error: "Username is required" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      await prisma.accessKey.create({
        data: { shopId, userId, username, role: role ?? "operator", active: true },
      });
      return new Response(
        JSON.stringify({ success: true, message: "User added successfully" }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "That access code is already in use for this shop" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // ── Toggle user active/revoked ───────────────────────────────────────────────
  if (intent === "toggle_user") {
    const keyId  = parseInt(formData.get("keyId"));
    const active = formData.get("active") === "true";

    try {
      await prisma.accessKey.update({
        where: { id: keyId },
        data:  { active: !active },
      });
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Failed to update user" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(
    JSON.stringify({ success: false, error: "Unknown action" }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// ── Stat Card Component ───────────────────────────────────────────────────────
function StatCard({ label, value, color }) {
  return (
    <div style={{
      background:    "#ffffff",
      border:        "2px solid #e1e3e5",
      borderRadius:  "10px",
      padding:       "20px 24px",
      minWidth:      "130px",
      textAlign:     "center",
      flex:          "1 1 130px",
    }}>
      <div style={{
        fontSize:   "32px",
        fontWeight: "800",
        color:      color ?? "#202223",
        lineHeight: "1.1",
        letterSpacing: "-0.5px",
      }}>
        {value?.toLocaleString() ?? 0}
      </div>
      <div style={{
        fontSize:   "13px",
        color:      "#6d7175",
        marginTop:  "6px",
        fontWeight: "500",
        lineHeight: "1.4",
      }}>
        {label}
      </div>
    </div>
  );
}

// ── Progress Bar Component ────────────────────────────────────────────────────
function ProgressBar({ processed, total, label }) {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{
        display:        "flex",
        justifyContent: "space-between",
        fontSize:       "14px",
        fontWeight:     "600",
        color:          "#202223",
        marginBottom:   "8px",
      }}>
        <span>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {processed?.toLocaleString()} / {total?.toLocaleString()} &nbsp;({pct}%)
        </span>
      </div>
      <div style={{
        background:   "#e1e3e5",
        borderRadius: "999px",
        height:       "12px",
        overflow:     "hidden",
      }}>
        <div style={{
          background:   "#008060",
          height:       "100%",
          width:        `${pct}%`,
          borderRadius: "999px",
          transition:   "width 0.5s ease",
        }} />
      </div>
    </div>
  );
}

// ── Section Heading Component ─────────────────────────────────────────────────
function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize:      "18px",
      fontWeight:    "700",
      color:         "#202223",
      marginBottom:  "20px",
      paddingBottom: "10px",
      borderBottom:  "2px solid #e1e3e5",
      letterSpacing: "-0.2px",
    }}>
      {children}
    </div>
  );
}

// ── Admin Page ────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const loaderData    = useLoaderData();
  const fetcher       = useFetcher();
  const statusFetcher = useFetcher();

  const { stats, accessKeys, syncState: initialSyncState, recentChanges } = loaderData;

  const [syncState,   setSyncState]   = useState(initialSyncState);
  const [newUser,     setNewUser]     = useState({ userId: "", username: "", role: "operator" });
  const [userMessage, setUserMessage] = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);

  const isRunning  = syncState?.status === "running";
  const sessionId  = typeof window !== "undefined"
    ? sessionStorage.getItem("skuboo_session_id") ?? ""
    : "";

  // --- Poll sync status every 2 seconds while a sync is running ---
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      statusFetcher.submit(
        { intent: "sync_status", sessionId },
        { method: "POST", action: "/app/admin" }
      );
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, sessionId]);

  // --- Update local sync state from poll response ---
  useEffect(() => {
    if (statusFetcher.data?.syncState) {
      setSyncState(statusFetcher.data.syncState);
    }
  }, [statusFetcher.data]);

  // --- Handle responses from actions ---
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.message) setSyncMessage(fetcher.data.message);
    if (fetcher.data.error)   setUserMessage({ type: "error",   text: fetcher.data.error });
    if (fetcher.data.success && fetcher.data.message === "User added successfully") {
      setUserMessage({ type: "success", text: "User added successfully" });
      setNewUser({ userId: "", username: "", role: "operator" });
    }
  }, [fetcher.data]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function handleForceCron() {
    setSyncMessage("Forcing cron run — check terminal for live progress...");
    fetcher.submit(
      { intent: "force_cron", sessionId },
      { method: "POST", action: "/app/admin" }
    );
  }

  function handleInitSync(pass) {
    setSyncMessage(`Starting Pass ${pass}...`);
    fetcher.submit(
      {
        intent:        "init_sync",
        pass:          String(pass),
        productsCount: String(stats.productsCount),
        sessionId,
      },
      { method: "POST", action: "/app/admin" }
    );
  }

  function handleToggleUser(keyId, active) {
    fetcher.submit(
      { intent: "toggle_user", keyId: String(keyId), active: String(active), sessionId },
      { method: "POST", action: "/app/admin" }
    );
  }

  function handleAddUser() {
    setUserMessage(null);
    fetcher.submit(
      { intent: "add_user", ...newUser, sessionId },
      { method: "POST", action: "/app/admin" }
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <s-page heading="SKU Boo — Admin Panel">

      {/* ══ DATABASE STATS ══════════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>📊 Database Stats</SectionHeading>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "14px" }}>
          <StatCard label="Total SKUs Indexed"   value={stats.skuIndexTotal}    />
          <StatCard label="Active"               value={stats.skuIndexActive}   color="#008060" />
          <StatCard label="Problems"             value={stats.skuIndexProblem}  color="#d82c0d" />
          <StatCard label="Free"                 value={stats.skuIndexFree}     color="#6d7175" />
          <StatCard label="Deleted"              value={stats.skuIndexDeleted}  color="#8c9196" />
          <StatCard label="ProductInfo Synced"   value={stats.productInfoTotal} />
          <StatCard label="Change History Rows"  value={stats.skuHistoryTotal}  />
          <StatCard label="Total in Shopify"     value={stats.productsCount}    color="#005bd3" />
        </div>
      </s-section>

      {/* ══ SYNC CONTROLS ═══════════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>🔄 Sync Controls</SectionHeading>

        {/* Last cron time */}
        <div style={{
          background:   "#f6f6f7",
          borderRadius: "8px",
          padding:      "12px 16px",
          marginBottom: "20px",
          fontSize:     "14px",
          color:        "#6d7175",
        }}>
          {syncState?.lastCronRun
            ? <>Last cron run: <strong style={{ color: "#202223" }}>{new Date(syncState.lastCronRun).toLocaleString()}</strong></>
            : "No cron run recorded yet — cron fires 5 minutes after app startup"
          }
        </div>

        {/* Force cron button */}
        <s-button onClick={handleForceCron} variant="secondary">
          ⚡ Force Cron Now
        </s-button>

        {syncMessage && (
          <div style={{
            marginTop:  "12px",
            fontSize:   "14px",
            color:      "#6d7175",
            lineHeight: "1.5",
          }}>
            {syncMessage}
          </div>
        )}

        {/* Init sync section */}
        <div style={{
          marginTop:    "28px",
          borderTop:    "2px solid #e1e3e5",
          paddingTop:   "24px",
        }}>
          <div style={{
            fontSize:     "16px",
            fontWeight:   "700",
            marginBottom: "8px",
            color:        "#202223",
          }}>
            Initial Full Sync
          </div>
          <div style={{
            fontSize:     "14px",
            color:        "#6d7175",
            marginBottom: "20px",
            lineHeight:   "1.6",
            maxWidth:     "600px",
          }}>
            <strong>Pass 1</strong> — Builds the SKU Index from all products. Fast.
            Run this first.<br />
            <strong>Pass 2</strong> — Fills in full product details (price, weight,
            inventory, collections). Slower. Run after Pass 1 completes.
          </div>

          <s-stack direction="inline" gap="base">
            <s-button
              onClick={() => handleInitSync(1)}
              variant="secondary"
              {...(isRunning ? { disabled: true } : {})}
            >
              ▶ Run Pass 1 — SKU Index
            </s-button>
            <s-button
              onClick={() => handleInitSync(2)}
              variant="secondary"
              {...(isRunning ? { disabled: true } : {})}
            >
              ▶ Run Pass 2 — Product Info
            </s-button>
          </s-stack>

          {/* Progress bar */}
          {isRunning && syncState && (
            <ProgressBar
              label={`Pass ${syncState.currentPass} in progress...`}
              processed={syncState.processed ?? 0}
              total={syncState.total ?? stats.productsCount}
            />
          )}

          {syncState?.status === "complete" && (
            <div style={{
              marginTop:    "16px",
              padding:      "12px 16px",
              background:   "#f0fff8",
              border:       "1px solid #008060",
              borderRadius: "8px",
              fontSize:     "14px",
              color:        "#008060",
              fontWeight:   "600",
            }}>
              ✓ Sync complete — {syncState.processed?.toLocaleString()} products processed
            </div>
          )}

          {syncState?.status === "error" && (
            <div style={{
              marginTop:    "16px",
              padding:      "12px 16px",
              background:   "#fff0f0",
              border:       "1px solid #d82c0d",
              borderRadius: "8px",
              fontSize:     "14px",
              color:        "#d82c0d",
              fontWeight:   "600",
            }}>
              ✗ Sync error: {syncState.lastError}
            </div>
          )}
        </div>
      </s-section>

      {/* ══ RECENT CHANGE HISTORY ═══════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>🕐 Recent Change History</SectionHeading>

        {recentChanges.length === 0 ? (
          <div style={{ fontSize: "14px", color: "#6d7175" }}>
            No changes recorded yet. Changes appear here after the cron detects them.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{
              width:           "100%",
              borderCollapse:  "separate",
              borderSpacing:   "0",
              fontSize:        "14px",
            }}>
              <thead>
                <tr style={{ background: "#f6f6f7" }}>
                  {["SKU", "Field", "Old Value", "New Value", "Changed By", "When"].map((h) => (
                    <th key={h} style={{
                      padding:     "12px 16px",
                      fontWeight:  "700",
                      color:       "#202223",
                      fontSize:    "13px",
                      textAlign:   "left",
                      borderBottom:"2px solid #e1e3e5",
                      whiteSpace:  "nowrap",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentChanges.map((row, i) => (
                  <tr key={row.id} style={{
                    background: i % 2 === 0 ? "#ffffff" : "#fafafa",
                  }}>
                    <td style={td}>{row.skuNumber ?? "—"}</td>
                    <td style={td}>
                      <span style={{
                        background:  "#f1f1f1",
                        padding:     "3px 10px",
                        borderRadius:"4px",
                        fontFamily:  "monospace",
                        fontSize:    "13px",
                      }}>
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

      {/* ══ USER MANAGEMENT ═════════════════════════════════════════════════════ */}
      <s-section>
        <SectionHeading>👥 User Management</SectionHeading>

        {/* Add user form */}
        <div style={{
          background:   "#f6f6f7",
          borderRadius: "10px",
          padding:      "20px 24px",
          marginBottom: "24px",
        }}>
          <div style={{
            fontSize:     "15px",
            fontWeight:   "700",
            color:        "#202223",
            marginBottom: "16px",
          }}>
            Add New User
          </div>

          <div style={{ display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={label}>Username</div>
              <input
                style={input}
                placeholder="Larrie"
                value={newUser.username}
                onChange={(e) => setNewUser((u) => ({ ...u, username: e.target.value }))}
              />
            </div>
            <div>
              <div style={label}>Access Code  <span style={{ color: "#6d7175", fontWeight: "400" }}>(4 digits)</span></div>
              <input
                style={{ ...input, width: "110px", letterSpacing: "4px", fontFamily: "monospace" }}
                placeholder="1234"
                maxLength={4}
                value={newUser.userId}
                onChange={(e) => setNewUser((u) => ({ ...u, userId: e.target.value.replace(/\D/g, "") }))}
              />
            </div>
            <div>
              <div style={label}>Role</div>
              <select
                style={{ ...input, width: "140px" }}
                value={newUser.role}
                onChange={(e) => setNewUser((u) => ({ ...u, role: e.target.value }))}
              >
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <s-button onClick={handleAddUser} variant="primary">
              Add User
            </s-button>
          </div>

          {userMessage && (
            <div style={{
              marginTop:    "14px",
              fontSize:     "14px",
              fontWeight:   "600",
              color:        userMessage.type === "error" ? "#d82c0d" : "#008060",
            }}>
              {userMessage.type === "error" ? "✗" : "✓"} {userMessage.text}
            </div>
          )}
        </div>

        {/* Users table */}
        <table style={{
          width:          "100%",
          borderCollapse: "separate",
          borderSpacing:  "0",
          fontSize:       "14px",
        }}>
          <thead>
            <tr style={{ background: "#f6f6f7" }}>
              {["Username", "Code", "Role", "Status", "Added", "Action"].map((h) => (
                <th key={h} style={{
                  padding:     "12px 16px",
                  fontWeight:  "700",
                  color:       "#202223",
                  fontSize:    "13px",
                  textAlign:   "left",
                  borderBottom:"2px solid #e1e3e5",
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accessKeys.map((key, i) => (
              <tr key={key.id} style={{ background: i % 2 === 0 ? "#ffffff" : "#fafafa" }}>
                <td style={{ ...td, fontWeight: "600", fontSize: "15px" }}>{key.username}</td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: "15px", letterSpacing: "2px" }}>
                  {key.userId}
                </td>
                <td style={td}>
                  <span style={{
                    background:   key.role === "admin"    ? "#fff0f0"
                                : key.role === "operator" ? "#f0f7ff"
                                :                           "#f6f6f7",
                    color:        key.role === "admin"    ? "#d82c0d"
                                : key.role === "operator" ? "#005bd3"
                                :                           "#6d7175",
                    padding:      "4px 12px",
                    borderRadius: "20px",
                    fontSize:     "12px",
                    fontWeight:   "700",
                    textTransform:"uppercase",
                    letterSpacing:"0.5px",
                  }}>
                    {key.role}
                  </span>
                </td>
                <td style={td}>
                  <span style={{
                    color:      key.active ? "#008060" : "#d82c0d",
                    fontWeight: "600",
                  }}>
                    {key.active ? "● Active" : "○ Revoked"}
                  </span>
                </td>
                <td style={{ ...td, color: "#6d7175" }}>
                  {new Date(key.createdAt).toLocaleDateString()}
                </td>
                <td style={td}>
                  <button
                    onClick={() => handleToggleUser(key.id, key.active)}
                    style={{
                      background:   "none",
                      border:       `2px solid ${key.active ? "#d82c0d" : "#008060"}`,
                      color:        key.active ? "#d82c0d" : "#008060",
                      borderRadius: "6px",
                      padding:      "5px 14px",
                      cursor:       "pointer",
                      fontSize:     "13px",
                      fontWeight:   "600",
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
const td = {
  padding:    "14px 16px",
  color:      "#202223",
  lineHeight: "1.4",
};

const label = {
  fontSize:     "13px",
  fontWeight:   "600",
  color:        "#202223",
  marginBottom: "6px",
  display:      "block",
};

const input = {
  border:       "2px solid #c9cccf",
  borderRadius: "6px",
  padding:      "9px 12px",
  fontSize:     "14px",
  outline:      "none",
  background:   "#ffffff",
  color:        "#202223",
  width:        "170px",
  lineHeight:   "1.4",
};