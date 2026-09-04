// app/routes/app.login.jsx

import { authenticate } from "../shopify.server.js";
import { validateAccessKey, createSkuSession } from "../lib/access.server.js";

// --- No loader needed — this route is action-only ---

// --- Simple in-memory PIN lockout ---
// Tracks failed attempts per shop+userId. Not persisted across server
// restarts — fine for throttling a 4-digit PIN on a small internal tool.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS    = 5 * 60 * 1000; // 5 minutes
const failedAttempts = new Map(); // key -> { count, lockedUntil }

function attemptKey(shopId, userId) {
  return `${shopId}:${userId}`;
}

function getLockout(key) {
  const record = failedAttempts.get(key);
  if (!record) return null;
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    failedAttempts.delete(key);
    return null;
  }
  return record;
}

function recordFailure(key) {
  const record = failedAttempts.get(key) ?? { count: 0, lockedUntil: null };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_MS;
    record.count = 0;
  }
  failedAttempts.set(key, record);
}

// lockedUntil is sent to the client so it can disable the PIN input for the
// remaining cooldown instead of just showing an error and letting them retry.
function lockedResponse(lockedUntil) {
  const secondsLeft = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
  return new Response(
    JSON.stringify({
      success:     false,
      error:       `Too many failed attempts. Try again in ${secondsLeft}s.`,
      lockedUntil,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// --- Action ---
// Validates PIN and creates a session
// Returns { success, sessionId, username, role } or { success: false, error }
export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const formData = await request.formData();
  const userId = formData.get("userId")?.toString().trim();

  // --- Validate input ---
  if (!userId || !/^\d{4}$/.test(userId)) {
    return new Response(
      JSON.stringify({ success: false, error: "Please enter a valid 4 digit access key" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const key = attemptKey(shopId, userId);

  // --- Locked out from too many recent failures ---
  const lockout = getLockout(key);
  if (lockout?.lockedUntil) {
    return lockedResponse(lockout.lockedUntil);
  }

  // --- Validate access key ---
  const accessKey = await validateAccessKey({ userId, shopId });
  if (!accessKey) {
    recordFailure(key);
    const afterFailure = getLockout(key);
    if (afterFailure?.lockedUntil) {
      return lockedResponse(afterFailure.lockedUntil);
    }
    return new Response(
      JSON.stringify({ success: false, error: "Invalid or revoked access key" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // --- Success — clear any failure history for this key ---
  failedAttempts.delete(key);

  // --- Create session in SQLite ---
  const skuSession = await createSkuSession({ userId, shopId });
  if (!skuSession) {
    return new Response(
      JSON.stringify({ success: false, error: "Failed to create session. Please try again." }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  console.log("[login action] Session created for userId:", userId, "username:", skuSession.username);

  return new Response(
    JSON.stringify({
      success:   true,
      sessionId: skuSession.sessionId,
      username:  skuSession.username,
      role:      skuSession.role,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// --- No default export needed — this route has no UI ---
// The PIN overlay UI lives in app._index.jsx
export default function LoginAction() {
  return null;
}