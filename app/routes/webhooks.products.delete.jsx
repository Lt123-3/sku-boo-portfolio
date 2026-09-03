// app/routes/webhooks.products.delete.jsx

import { authenticate } from "../shopify.server.js";
import { handleProductDeleted } from "../lib/sync.server.js";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log("[webhook] products/delete from shop:", shop);

  try {
    await handleProductDeleted(payload.id, shop);
    console.log("[webhook] Marked deleted:", payload.id);
  } catch (err) {
    console.error("[webhook] Failed to handle delete:", err);
  }

  return new Response(null, { status: 200 });
};

export default function WebhookProductDelete() {
  return null;
}