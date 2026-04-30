// app/routes/app.login.jsx

import { authenticate } from "../shopify.server.js";
import { validateAccessKey, createSkuSession } from "../lib/access.server.js";

// --- No loader needed — this route is action-only ---

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

  // --- Validate access key ---
  const accessKey = await validateAccessKey({ userId, shopId });
  if (!accessKey) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid or revoked access key" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

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