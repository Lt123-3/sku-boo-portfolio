/* eslint-env node */
// app/routes/ext-api.order-lookup.jsx
//
// Order lookup for the Shippo Rate Check Chrome extension — returns a Shopify
// order's shipping address, line items, and a suggested weight so the
// extension doesn't need those typed in by hand.
//
// Not part of the embedded admin app: the caller is outside Shopify's admin
// iframe entirely, so there's no App Bridge session to authenticate with —
// see lib/extAuth.server.js for the bearer-token check used here instead.
// The actual Shopify lookup lives in lib/orderLookup.server.js, shared with
// the ESP relay.

import { checkExtensionToken } from "../lib/extAuth.server.js";
import { getShopAdmin, lookupOrderByName } from "../lib/orderLookup.server.js";

export async function loader({ request }) {
  const authError = checkExtensionToken(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const orderNumber = url.searchParams.get("order");
  if (!orderNumber) {
    return Response.json({ success: false, error: "Missing ?order= parameter" }, { status: 400 });
  }

  try {
    const admin = await getShopAdmin();
    const order = await lookupOrderByName(admin, orderNumber);
    return Response.json({ success: true, ...order });
  } catch (err) {
    // Catch-all: whatever this is — thrown Error, thrown Response used as
    // control flow by a library, anything — never let it become an
    // unhandled exception that renders as an HTML error page. This is a
    // JSON-only API and every response from it should be JSON.
    console.error("[ext-api/order-lookup] Unhandled error:", err);
    const message =
      err instanceof Error ? err.message : err instanceof Response ? `HTTP ${err.status} thrown by a library call` : String(err);
    return Response.json({ success: false, error: `Unhandled error: ${message}` }, { status: 500 });
  }
}
