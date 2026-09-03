/* eslint-env node */
// app/routes/ext-api.pending-submission.jsx
//
// Returns the most recent ESP submission still waiting for a computed rate
// (written by esp-server.js when the shipping-desk device submits an
// order+package+weight), so the extension can auto-fill package/weight/
// address instead of the operator typing an order number by hand.

import prisma from "../db.server.js";
import { checkExtensionToken } from "../lib/extAuth.server.js";

export async function loader({ request }) {
  const authError = checkExtensionToken(request);
  if (authError) return authError;

  if (!process.env.SHOP_DOMAIN) {
    return Response.json(
      { success: false, error: "Server misconfigured: SHOP_DOMAIN not set" },
      { status: 500 },
    );
  }

  try {
    const pending = await prisma.pendingSubmission.findFirst({
      where: { shopId: process.env.SHOP_DOMAIN, rate: null },
      orderBy: { createdAt: "desc" },
    });

    if (!pending) {
      return Response.json({ success: true, pending: null });
    }

    return Response.json({
      success: true,
      pending: {
        id: pending.id,
        orderId: pending.orderId,
        orderName: pending.orderName,
        packageName: pending.packageName,
        weightLb: pending.weightLb,
        shippingAddress: JSON.parse(pending.address),
        lineItems: JSON.parse(pending.lineItems),
      },
    });
  } catch (err) {
    console.error("[ext-api/pending-submission] Unhandled error:", err);
    return Response.json(
      { success: false, error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
