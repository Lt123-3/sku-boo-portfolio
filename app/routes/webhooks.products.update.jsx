// app/routes/webhooks.products.update.jsx

import { authenticate } from "../shopify.server.js";
import { upsertSkuIndexRow } from "../lib/sync.server.js";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log("[webhook] products/update from shop:", shop);

  try {
    await upsertSkuIndexRow(payload, shop);
    console.log("[webhook] Upserted updated product:", payload.id);
  } catch (err) {
    console.error("[webhook] Failed to upsert on update:", err);
  }

  return new Response(null, { status: 200 });
};

export default function WebhookProductUpdate() {
  return null;
}