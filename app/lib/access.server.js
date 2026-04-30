// app/lib/access.server.js

import { createCookieSessionStorage, redirect } from "react-router";
import db from "../db.server.js";

// --- Session Storage Setup ---
const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "skuboo_session",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 8,
    secrets: [process.env.SESSION_SECRET ?? "skuboo-dev-secret"],
  },
});

// --- Export sessionStorage and getSession so login route can use them ---
export { sessionStorage };

export async function getSession(request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

// --- Create a new user session ---
export async function createUserSession({ request, userId, redirectTo }) {
  const session = await getSession(request);
  session.set("userId", userId);

  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await sessionStorage.commitSession(session),
    },
  });
}

// --- Destroy the session (sign out) ---
export async function destroyUserSession(request) {
  const session = await getSession(request);

  return redirect("/app/login", {
    headers: {
      "Set-Cookie": await sessionStorage.destroySession(session),
    },
  });
}

// --- Get the userId from the session cookie ---
export async function getUserId(request) {
  const session = await getSession(request);
  const userId = session.get("userId");
  if (!userId || typeof userId !== "string") return null;
  return userId;
}

// --- Require Access ---
export async function requireAccess(request, shopId) {
  const userId = await getUserId(request);

    // --- DEBUG ---
  console.log("[requireAccess] cookie header:", request.headers.get("Cookie"));
  console.log("[requireAccess] userId from session:", userId);
  console.log("[requireAccess] shopId:", shopId);
  // --- END DEBUG ---

  if (!userId) {
    return redirect("/app/login");
  }

  if (!shopId || typeof shopId !== "string") {
    console.error("requireAccess: shopId missing or invalid", { shopId });
    return redirect("/app/login");
  }

  let accessKey;
  try {
    accessKey = await db.accessKey.findUnique({
      where: {
        shopId_userId: {
          shopId,
          userId,
        },
      },
    });
  } catch (err) {
    console.error("requireAccess: database error", err);
    return redirect("/app/login");
  }

  if (!accessKey || !accessKey.active) {
    console.warn("requireAccess: access denied", { userId, shopId });
    return redirect("/app/login?error=access_denied");
  }

  return {
    userId:   accessKey.userId,
    username: accessKey.username,
    role:     accessKey.role,
  };
}

// --- Check if user is an admin ---
export function requireAdmin(accessData) {
  if (accessData.role !== "admin") {
    throw new Response("Forbidden", { status: 403 });
  }
}