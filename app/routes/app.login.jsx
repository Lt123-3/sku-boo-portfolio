// app/routes/app.login.jsx

import { useState, useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { sessionStorage, getSession } from "../lib/access.server.js";

// --- Loader ---
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  return { shopId: session.shop };
}

// --- Action ---
// Validates access key, writes session cookie, returns success
// Navigation handled client-side to avoid Shopify iframe OAuth interception
export async function action({ request }) {
  const formData = await request.formData();
  const userId = formData.get("userId")?.toString().trim();
  const shopId = formData.get("shopId")?.toString().trim();

  // --- Validate input ---
  if (!userId || !/^\d{4}$/.test(userId)) {
    return new Response(
      JSON.stringify({
        error: "Please enter a valid 4 digit access key",
        success: false,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  if (!shopId) {
    return new Response(
      JSON.stringify({
        error: "Shop context missing. Please refresh and try again.",
        success: false,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // --- Check AccessKey table ---
  let accessKey;
  try {
    accessKey = await prisma.accessKey.findUnique({
      where: {
        shopId_userId: {
          shopId,
          userId,
        },
      },
    });
  } catch (err) {
    console.error("Login: database error", err);
    return new Response(
      JSON.stringify({
        error: "Something went wrong. Please try again.",
        success: false,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // --- Reject if not found or revoked ---
  if (!accessKey || !accessKey.active) {
    return new Response(
      JSON.stringify({
        error: "Invalid or revoked access key",
        success: false,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // --- Write session cookie and return success ---
  console.log("LOGIN: writing session cookie for userId:", userId);
  const session = await getSession(request);
  session.set("userId", userId);

  return new Response(
    JSON.stringify({ success: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": await sessionStorage.commitSession(session),
      },
    }
  );
}

// --- Login Page UI ---
export default function LoginPage() {
  const { shopId } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [code, setCode] = useState("");

  const isLoading = fetcher.state !== "idle";
  const error = fetcher.data?.error;

  // --- Fire submit the moment 4 digits are entered ---
  useEffect(() => {
    if (code.length === 4) {
      fetcher.submit(
        { userId: code, shopId },
        { method: "POST", action: "/app/login" }
      );
    }
  }, [code]);

  // --- Handle response ---
  // Success: use App Bridge history to navigate inside the Shopify iframe
  // Failure: clear the code and show error
  useEffect(() => {
    if (fetcher.data?.success === true) {
      shopify.idToken().then(() => {
        history.pushState({}, "", "/app");
        window.dispatchEvent(new PopStateEvent("popstate"));
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
    <div style={styles.page}>
      <div style={styles.card}>

        {/* --- Logo / Title --- */}
        <div style={styles.title}>SKU Boo</div>
        <div style={styles.subtitle}>Warehouse Management</div>

        {/* --- PIN Input --- */}
        <div style={styles.inputWrapper}>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={4}
            value={code}
            onChange={handleInput}
            placeholder="····"
            autoFocus
            disabled={isLoading}
            style={{
              ...styles.input,
              borderColor: error
                ? "#d82c0d"
                : code.length === 4
                ? "#008060"
                : "#e1e3e5",
            }}
          />
        </div>

        {/* --- Digit indicators --- */}
        <div style={styles.dots}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                ...styles.dot,
                backgroundColor:
                  i < code.length
                    ? error
                      ? "#d82c0d"
                      : "#008060"
                    : "#e1e3e5",
              }}
            />
          ))}
        </div>

        {/* --- Status messages --- */}
        {isLoading && (
          <div style={styles.status}>Checking...</div>
        )}
        {error && !isLoading && (
          <div style={{ ...styles.status, color: "#d82c0d" }}>
            {error}
          </div>
        )}
        {!error && !isLoading && code.length === 0 && (
          <div style={styles.status}>Enter your 4 digit access key</div>
        )}

      </div>
    </div>
  );
}

// --- Styles ---
const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f6f6f7",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: "12px",
    padding: "48px 40px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    minWidth: "320px",
  },
  title: {
    fontSize: "28px",
    fontWeight: "700",
    color: "#202223",
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize: "14px",
    color: "#6d7175",
    marginTop: "-8px",
  },
  inputWrapper: {
    marginTop: "8px",
    width: "100%",
  },
  input: {
    width: "100%",
    fontSize: "32px",
    fontWeight: "600",
    textAlign: "center",
    letterSpacing: "16px",
    padding: "16px",
    border: "2px solid",
    borderRadius: "8px",
    outline: "none",
    transition: "border-color 0.15s ease",
    backgroundColor: "#f6f6f7",
    boxSizing: "border-box",
    color: "#202223",
  },
  dots: {
    display: "flex",
    gap: "12px",
    marginTop: "4px",
  },
  dot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    transition: "background-color 0.15s ease",
  },
  status: {
    fontSize: "13px",
    color: "#6d7175",
    marginTop: "4px",
    textAlign: "center",
    minHeight: "20px",
  },
};