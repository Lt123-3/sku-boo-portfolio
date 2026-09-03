// app/lib/extAuth.server.js
//
// Shared bearer-token auth for ext-api.* routes — the extension-facing API,
// separate from Shopify's own embedded-admin session auth. Used by every
// ext-api.* route so the check (and its diagnostics) only exist once.

export function checkExtensionToken(request) {
  if (!process.env.EXTENSION_API_TOKEN) {
    console.error("[ext-api] EXTENSION_API_TOKEN is not set on this server");
    return Response.json(
      { success: false, error: "Server misconfigured: EXTENSION_API_TOKEN not set" },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return Response.json({ success: false, error: "Missing Authorization header" }, { status: 401 });
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return Response.json(
      { success: false, error: "Authorization header must be 'Bearer <token>'" },
      { status: 401 },
    );
  }

  const token = match[1].trim();
  if (token !== process.env.EXTENSION_API_TOKEN) {
    // Fingerprint only — never echo back the expected token, just enough of
    // what was *received* to tell dev-vs-prod mixups and stray whitespace
    // apart from an actually-wrong value.
    const fingerprint =
      token.length > 10 ? `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)` : `"${token}"`;
    console.warn(`[ext-api] Token mismatch — received: ${fingerprint}`);
    return Response.json({ success: false, error: "Unauthorized", received: fingerprint }, { status: 401 });
  }

  return null; // authorized
}
