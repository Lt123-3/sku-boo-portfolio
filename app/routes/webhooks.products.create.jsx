// app/routes/webhooks.products.create.jsx

import { authenticate } from "../shopify.server.js";
import { syncSkuIndexRowFromWebhook } from "../lib/sync.server.js";

export const action = async ({ request }) => {
  const { shop, admin, payload } = await authenticate.webhook(request);

  console.log("[webhook] products/create from shop:", shop);

  try {
    await syncSkuIndexRowFromWebhook(admin, payload.admin_graphql_api_id, shop);
    console.log("[webhook] Synced new product:", payload.admin_graphql_api_id);
  } catch (err) {
    console.error("[webhook] Failed to sync on create:", err);
  }

  return new Response(null, { status: 200 });
};

export default function WebhookProductCreate() {
  return null;
}
