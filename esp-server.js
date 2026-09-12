/* eslint-env node */
// esp-server.js
//
// Standalone, LAN-only WebSocket relay for the shipping-desk ESP32 device.
// A separate process from the main React Router server — not attached to
// react-router-serve's HTTP server — so it doesn't depend on that
// framework's internals for something as different as a raw WebSocket
// upgrade handler. Started alongside the main server by start-skuboo.sh /
// start-skuboo-dev.sh.
//
// The rate computation happens right here, synchronously within the submit
// handler — no extension involved. (An earlier version of this file wrote a
// PendingSubmission row and waited for the Chrome extension to compute a
// rate and report it back via HTTP; that hand-off isn't needed once sku-boo
// calls Shippo directly.) The extension can still be used standalone for
// manual order lookups — see ext-api.order-lookup.jsx — it's just no longer
// part of this loop.
//
// Message shapes (JSON, one object per WebSocket frame):
//   ESP -> relay:
//     { "type": "auth", "token": "..." }
//     { "type": "submit", "orderId": "...", "orderName": "#4337",
//       "packageName": "17 Cube (Default)", "weightLb": 1.75 }
//     { "type": "refresh" }
//   relay -> ESP:
//     { "type": "auth_ok" }
//     { "type": "orders", "orders": [{ "id", "name", "item" }] }
//     { "type": "packages", "packages": [{ "name", "length", "width", "height" }] }
//     { "type": "rate_result", "orderId", "orderName", "ogPrice", "twoLbPrice" }
//     { "type": "error", "message" }

import "dotenv/config";
import http from "node:http";
import { WebSocketServer } from "ws";
import prisma from "./app/db.server.js";
import { getShopAdmin, listRecentOrders, lookupOrderByName } from "./app/lib/orderLookup.server.js";
import { getUspsRates, getShipFromAddress } from "./app/lib/shippo.server.js";

const PORT = process.env.ESP_WS_PORT ? Number(process.env.ESP_WS_PORT) : 8081;
// Comparison weight always checked alongside whatever was actually weighed —
// same constant, same reasoning, as the extension's popup used to apply.
const ALWAYS_CHECK_LB = 2.1;
const ESTIMATED_HEIGHT_IN = 1; // fallback for packages with no recorded height

if (!process.env.ESP_API_TOKEN) {
  console.error("[esp-server] ESP_API_TOKEN is not set — refusing to start.");
  process.exit(1);
}
if (!process.env.SHOP_DOMAIN) {
  console.error("[esp-server] SHOP_DOMAIN is not set — refusing to start.");
  process.exit(1);
}
if (!process.env.SHIPPO_API_KEY) {
  console.error("[esp-server] SHIPPO_API_KEY is not set — refusing to start.");
  process.exit(1);
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

async function sendOrdersAndPackages(ws) {
  let admin, shopId;
  try {
    ({ admin, shopId } = await getShopAdmin());
    const orders = await listRecentOrders(admin, 25);
    send(ws, {
      type: "orders",
      orders: orders.map((o) => ({
        id: o.orderId,
        name: o.orderName,
        item: o.lineItems.map((li) => `${li.quantity}x ${li.title}`).join(", ") || "(no line items)",
      })),
    });
  } catch (err) {
    console.error("[esp-server] Failed to load orders:", err);
    send(ws, { type: "error", message: "Failed to load orders" });
  }

  try {
    // Falls back to SHOP_DOMAIN only if the getShopAdmin() call above failed
    // before resolving shopId — keeps the packages push working even when
    // Shopify auth is down, same as this endpoint's behavior before shopId
    // was resolved via the session row.
    const packages = await prisma.savedPackage.findMany({
      where: { shopId: shopId ?? process.env.SHOP_DOMAIN },
      orderBy: { name: "asc" },
    });
    send(ws, {
      type: "packages",
      packages: packages.map((p) => ({ name: p.name, length: p.length, width: p.width, height: p.height })),
    });
  } catch (err) {
    console.error("[esp-server] Failed to load packages:", err);
    send(ws, { type: "error", message: "Failed to load packages" });
  }
}

async function handleSubmit(ws, msg) {
  const { orderId, orderName, packageName, weightLb } = msg;
  if (!orderId || !orderName || !packageName || typeof weightLb !== "number") {
    send(ws, { type: "error", message: "submit requires orderId, orderName, packageName, weightLb" });
    return;
  }

  try {
    const { admin, shopId } = await getShopAdmin();
    // Re-resolved fresh rather than reusing the summary from the orders push
    // — that push only sent id/name/item for a small screen, not the full
    // address rating needs.
    const order = await lookupOrderByName(admin, orderName);
    if (!order.shippingAddress) {
      send(ws, { type: "error", message: "Order has no shipping address on file" });
      return;
    }

    const pkg = await prisma.savedPackage.findFirst({
      where: { shopId, name: packageName },
    });
    if (!pkg) {
      send(ws, { type: "error", message: `Unknown package: ${packageName}` });
      return;
    }

    const dims = { length: pkg.length, width: pkg.width, height: pkg.height ?? ESTIMATED_HEIGHT_IN };
    const from = getShipFromAddress();
    const to = {
      city: order.shippingAddress.city,
      state: order.shippingAddress.state,
      zip: order.shippingAddress.zip,
    };

    const weights = [weightLb];
    if (Math.abs(weightLb - ALWAYS_CHECK_LB) > 0.001) weights.push(ALWAYS_CHECK_LB);

    const results = await Promise.all(
      weights.map((w) => getUspsRates(process.env.SHIPPO_API_KEY, from, to, { ...dims, weightLb: w })),
    );

    const ogPrice = results[0]?.[0]?.amount ?? null;
    const twoLbPrice = weights.length > 1 ? (results[1]?.[0]?.amount ?? null) : ogPrice;

    if (ogPrice == null) {
      send(ws, { type: "error", message: "No USPS rates returned for the actual weight" });
      return;
    }

    await prisma.orderSaving.create({
      data: {
        shopId,
        shopifyOrderId: orderId,
        orderName,
        originalWeightLb: weightLb,
        ogPrice,
        twoLbPrice: twoLbPrice ?? ogPrice,
      },
    });

    send(ws, {
      type: "rate_result",
      orderId,
      orderName,
      ogPrice,
      twoLbPrice: twoLbPrice ?? ogPrice,
    });
  } catch (err) {
    console.error("[esp-server] Failed to compute rate:", err);
    send(ws, {
      type: "error",
      message: `Failed to compute rate: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

wss.on("connection", (ws) => {
  let authed = false;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (!authed) {
      if (msg.type === "auth" && msg.token === process.env.ESP_API_TOKEN) {
        authed = true;
        send(ws, { type: "auth_ok" });
        await sendOrdersAndPackages(ws);
      } else {
        send(ws, { type: "error", message: "Unauthorized" });
        ws.close();
      }
      return;
    }

    if (msg.type === "submit") {
      await handleSubmit(ws, msg);
    } else if (msg.type === "refresh") {
      await sendOrdersAndPackages(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[esp-server] Listening on ws://0.0.0.0:${PORT} (shop: ${process.env.SHOP_DOMAIN})`);
});
