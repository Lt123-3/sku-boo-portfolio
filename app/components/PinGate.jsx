// app/components/PinGate.jsx
//
// Shared PIN-login overlay + session tracking — the SKU Boo 4-digit access
// code system, layered on top of Shopify's own embedded-admin auth. Started
// as homepage-only code (app._index.jsx); extracted here once Prep and
// Packages needed the identical login experience, so the session logic has
// one home instead of three near-duplicate copies.

import { useFetcher } from "react-router";
import { useState, useEffect } from "react";

// --- Session state + sessionStorage sync, shared by every gated page ---
export function useSkuSession() {
  const [skuSession, setSkuSession]         = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    const sessionId = sessionStorage.getItem("skuboo_session_id");
    const username  = sessionStorage.getItem("skuboo_username");
    const role      = sessionStorage.getItem("skuboo_role");

    if (sessionId && username) {
      setSkuSession({ sessionId, username, role });
    }
    setSessionChecked(true);
  }, []);

  function handleAuthSuccess({ sessionId, username, role }) {
    setSkuSession({ sessionId, username, role });
  }

  function handleSignOut() {
    sessionStorage.removeItem("skuboo_session_id");
    sessionStorage.removeItem("skuboo_username");
    sessionStorage.removeItem("skuboo_role");
    setSkuSession(null);
  }

  return { skuSession, sessionChecked, handleAuthSuccess, handleSignOut };
}

// --- Full-screen PIN entry overlay — shown until a valid PIN is entered ---
export function PinOverlay({ onSuccess }) {
  const fetcher = useFetcher();
  const [code, setCode]   = useState("");
  const isLoading         = fetcher.state !== "idle";
  const error             = fetcher.data?.error;

  // --- Auto-submit on 4 digits ---
  useEffect(() => {
    if (code.length === 4) {
      fetcher.submit(
        { userId: code },
        { method: "POST", action: "/app/login" }
      );
    }
  }, [code]);

  // --- Handle response ---
  useEffect(() => {
    if (fetcher.data?.success === true) {
      sessionStorage.setItem("skuboo_session_id", fetcher.data.sessionId);
      sessionStorage.setItem("skuboo_username",   fetcher.data.username);
      sessionStorage.setItem("skuboo_role",       fetcher.data.role);
      onSuccess({
        sessionId: fetcher.data.sessionId,
        username:  fetcher.data.username,
        role:      fetcher.data.role,
      });
    } else if (fetcher.data?.success === false) {
      setCode("");
    }
  }, [fetcher.data]);

  function handleInput(e) {
    const val = e.target.value.replace(/\D/g, "");
    if (val.length <= 4) setCode(val);
  }

  return (
    <div style={overlayStyles.backdrop}>
      <div style={overlayStyles.card}>

        {/* --- Logo / Title only — subtitle removed --- */}
        <div style={overlayStyles.title}>SKU Boo</div>

        {/* --- PIN Input — type password hides the digits --- */}
        <div style={overlayStyles.inputWrapper}>
          <input
            type="password"
            inputMode="numeric"
            pattern="\d*"
            maxLength={4}
            value={code}
            onChange={handleInput}
            placeholder="····"
            autoFocus
            disabled={isLoading}
            style={{
              ...overlayStyles.input,
              borderColor: error
                ? "#d82c0d"
                : code.length === 4
                ? "#008060"
                : "#e1e3e5",
            }}
          />
        </div>

        {/* --- Status messages only — dots removed --- */}
        {isLoading && (
          <div style={overlayStyles.status}>Checking...</div>
        )}
        {error && !isLoading && (
          <div style={{ ...overlayStyles.status, color: "#d82c0d" }}>{error}</div>
        )}
        {!error && !isLoading && code.length === 0 && (
          <div style={overlayStyles.status}>Enter your 4 digit access key</div>
        )}

      </div>
    </div>
  );
}

// --- Small "logged in as X · Sign Out" badge for the top of a gated page ---
export function UserBadge({ username, onSignOut }) {
  return (
    <div style={userBadgeStyles.wrapper}>
      <div style={userBadgeStyles.badge}>
        <span style={userBadgeStyles.icon}>👤</span>
        <span style={userBadgeStyles.name}>{username}</span>
        <button onClick={onSignOut} style={userBadgeStyles.signOut}>
          Sign Out
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const overlayStyles = {
  backdrop: {
    position:        "fixed",
    top:             0,
    left:            0,
    right:           0,
    bottom:          0,
    backgroundColor: "rgba(0,0,0,0.6)",
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    zIndex:          9999,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius:    "12px",
    padding:         "48px 40px",
    boxShadow:       "0 2px 12px rgba(0,0,0,0.08)",
    display:         "flex",
    flexDirection:   "column",
    alignItems:      "center",
    gap:             "16px",
    minWidth:        "320px",
  },
  title: {
    fontSize:      "28px",
    fontWeight:    "700",
    color:         "#202223",
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize:  "14px",
    color:     "#6d7175",
    marginTop: "-8px",
  },
  inputWrapper: {
    marginTop: "8px",
    width:     "100%",
  },
  input: {
    width:         "100%",
    fontSize:      "32px",
    fontWeight:    "600",
    textAlign:     "center",
    letterSpacing: "16px",
    padding:       "16px",
    border:        "2px solid",
    borderRadius:  "8px",
    outline:       "none",
    transition:    "border-color 0.15s ease",
    backgroundColor: "#f6f6f7",
    boxSizing:     "border-box",
    color:         "#202223",
  },
  dots: {
    display:  "flex",
    gap:      "12px",
    marginTop:"4px",
  },
  dot: {
    width:        "10px",
    height:       "10px",
    borderRadius: "50%",
    transition:   "background-color 0.15s ease",
  },
  status: {
    fontSize:  "13px",
    color:     "#6d7175",
    marginTop: "4px",
    textAlign: "center",
    minHeight: "20px",
  },
};

const userBadgeStyles = {
  wrapper: {
    padding:      "8px 16px 0 16px",
    display:      "flex",
    alignItems:   "center",
  },
  badge: {
    display:         "flex",
    alignItems:      "center",
    gap:             "8px",
    backgroundColor: "#f1f1f1",
    borderRadius:    "999px",
    padding:         "4px 12px",
    fontSize:        "13px",
    color:           "#202223",
  },
  icon: {
    fontSize: "14px",
  },
  name: {
    fontWeight: "600",
  },
  signOut: {
    background:   "none",
    border:       "none",
    color:        "#6d7175",
    cursor:       "pointer",
    fontSize:     "12px",
    padding:      "0 0 0 4px",
    borderLeft:   "1px solid #c9cccf",
    marginLeft:   "4px",
  },
};
