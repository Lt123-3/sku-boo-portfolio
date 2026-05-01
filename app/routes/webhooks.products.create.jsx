// app/routes/webhooks.products.create.jsx

import { authenticate } from "../shopify.server.js";
import { upsertSkuIndexRow } from "../lib/sync.server.js";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log("[webhook] products/create from shop:", shop);

  try {
    await upsertSkuIndexRow(payload, shop);
    console.log("[webhook] Upserted new product:", payload.id);
  } catch (err) {
    console.error("[webhook] Failed to upsert on create:", err);
  }

  return new Response(null, { status: 200 });
};

export default function WebhookProductCreate() {
  return null;
}