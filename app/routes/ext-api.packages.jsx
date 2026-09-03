/* eslint-env node */
// app/routes/ext-api.packages.jsx
//
// Saved Packages list for the Chrome extension. sku-boo is the shared
// source of truth for this list (also read by the ESP relay), so the
// extension no longer keeps its own hardcoded copy — see app.packages.jsx
// for where these rows actually get edited.

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
    const packages = await prisma.savedPackage.findMany({
      where: { shopId: process.env.SHOP_DOMAIN },
      orderBy: { name: "asc" },
    });

    return Response.json({
      success: true,
      packages: packages.map((p) => ({
        name: p.name,
        length: p.length,
        width: p.width,
        height: p.height,
      })),
    });
  } catch (err) {
    console.error("[ext-api/packages] Unhandled error:", err);
    return Response.json(
      { success: false, error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
