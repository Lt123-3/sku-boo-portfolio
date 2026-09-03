/* eslint-env node */
// app/routes/ext-api.report-rate.jsx
//
// The extension reports back the rate it computed for an order — logged as
// an OrderSaving row (savings tracking over time). If pendingSubmissionId is
// present, this order came from an ESP submission, so its PendingSubmission
// row gets the rate filled in — esp-server.js polls for that and pushes the
// result back down to the device.

import prisma from "../db.server.js";
import { checkExtensionToken } from "../lib/extAuth.server.js";

export async function action({ request }) {
  if (request.method !== "POST") {
    return Response.json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const authError = checkExtensionToken(request);
  if (authError) return authError;

  if (!process.env.SHOP_DOMAIN) {
    return Response.json(
      { success: false, error: "Server misconfigured: SHOP_DOMAIN not set" },
      { status: 500 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { orderId, orderName, weightLb, ogPrice, twoLbPrice, pendingSubmissionId } = body ?? {};
  if (
    !orderId ||
    !orderName ||
    typeof weightLb !== "number" ||
    typeof ogPrice !== "number" ||
    typeof twoLbPrice !== "number"
  ) {
    return Response.json(
      { success: false, error: "orderId, orderName, weightLb, ogPrice, and twoLbPrice are required" },
      { status: 400 },
    );
  }

  let savingId;
  try {
    const saving = await prisma.orderSaving.create({
      data: {
        shopId: process.env.SHOP_DOMAIN,
        shopifyOrderId: orderId,
        orderName,
        originalWeightLb: weightLb,
        ogPrice,
        twoLbPrice,
      },
    });
    savingId = saving.id;
  } catch (err) {
    console.error("[ext-api/report-rate] Failed to record saving:", err);
    return Response.json(
      { success: false, error: `Failed to record saving: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // Best-effort — the saving is already recorded above regardless of
  // whether this succeeds, so a failure here shouldn't fail the request.
  if (pendingSubmissionId) {
    try {
      await prisma.pendingSubmission.update({
        where: { id: pendingSubmissionId },
        data: { rate: ogPrice, ratedAt: new Date() },
      });
    } catch (err) {
      console.error("[ext-api/report-rate] Saving recorded, but failed to update PendingSubmission:", err);
    }
  }

  return Response.json({ success: true, savingId });
}
