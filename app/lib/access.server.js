// app/lib/access.server.js

import prisma from "../db.server.js";
import crypto from "crypto";
// --- Constants ---
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

// --- Generate a secure random session ID ---
function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

// --- Create a new SKU Boo session in SQLite ---
// Called after a user successfully enters their access key
export async function createSkuSession({ userId, shopId }) {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  // --- Look up username and role from AccessKey table ---
  let accessKey;
  try {
    accessKey = await prisma.accessKey.findUnique({
      where: {
        shopId_userId: { shopId, userId },
      },
    });
  } catch (err) {
    console.error("[createSkuSession] DB error looking up AccessKey:", err);
    return null;
  }

  if (!accessKey || !accessKey.active) {
    console.warn("[createSkuSession] Access key not found or revoked:", { userId, shopId });
    return null;
  }

  // --- Write session row to SQLite ---
  try {
    await prisma.skuSession.create({
      data: {
        sessionId,
        userId,
        shopId,
        username: accessKey.username,
        role:     accessKey.role,
        expiresAt,
      },
    });
  } catch (err) {
    console.error("[createSkuSession] DB error creating session:", err);
    return null;
  }

  return { sessionId, username: accessKey.username, role: accessKey.role };
}

// --- Validate an existing session ---
// Returns session data if valid, null if expired or not found
export async function validateSkuSession({ sessionId, shopId }) {
  if (!sessionId || !shopId) return null;

  let session;
  try {
    session = await prisma.skuSession.findUnique({
      where: { sessionId },
    });
  } catch (err) {
    console.error("[validateSkuSession] DB error:", err);
    return null;
  }

  // --- Not found ---
  if (!session) return null;

  // --- Wrong shop ---
  if (session.shopId !== shopId) {
    console.warn("[validateSkuSession] shopId mismatch", { sessionShopId: session.shopId, shopId });
    return null;
  }

  // --- Expired ---
  if (new Date() > new Date(session.expiresAt)) {
    console.log("[validateSkuSession] session expired, deleting:", sessionId);
    try {
      await prisma.skuSession.delete({ where: { sessionId } });
    } catch (err) {
      console.error("[validateSkuSession] Failed to delete expired session:", err);
    }
    return null;
  }

  return {
    userId:   session.userId,
    username: session.username,
    role:     session.role,
    shopId:   session.shopId,
  };
}

// --- Validate access key code against AccessKey table ---
// Used when user submits their PIN
export async function validateAccessKey({ userId, shopId }) {
  if (!userId || !shopId) return null;

  let accessKey;
  try {
    accessKey = await prisma.accessKey.findUnique({
      where: {
        shopId_userId: { shopId, userId },
      },
    });
  } catch (err) {
    console.error("[validateAccessKey] DB error:", err);
    return null;
  }

  if (!accessKey || !accessKey.active) return null;

  return {
    userId:   accessKey.userId,
    username: accessKey.username,
    role:     accessKey.role,
  };
}

// --- Delete a session (sign out) ---
export async function deleteSkuSession(sessionId) {
  if (!sessionId) return;
  try {
    await prisma.skuSession.delete({ where: { sessionId } });
  } catch (err) {
    console.error("[deleteSkuSession] DB error:", err);
  }
}

// --- Clean up expired sessions ---
// Call this occasionally to keep the table tidy
export async function cleanExpiredSessions() {
  try {
    const result = await prisma.skuSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    console.log("[cleanExpiredSessions] Deleted expired sessions:", result.count);
  } catch (err) {
    console.error("[cleanExpiredSessions] DB error:", err);
  }
}