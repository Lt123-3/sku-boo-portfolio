// app/lib/orderLookup.server.js
//
// Shared order-resolution logic — one GraphQL shape, one address/weight
// resolution — used by both ext-api.order-lookup.jsx (the extension's manual
// lookup) and esp-server.js (the ESP32 relay's order list + submission
// address resolution), instead of duplicating the query in two places.
//
// Functions here throw plain Errors on failure; callers translate that into
// whatever shape fits their transport (JSON HTTP response vs. a WebSocket
// error message).

import prisma from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";

const GRAMS_PER_LB = 453.592;

export function weightToLb(weight) {
  if (!weight) return 0;
  switch (weight.unit) {
    case "POUNDS":    return weight.value;
    case "OUNCES":    return weight.value / 16;
    case "GRAMS":     return weight.value / GRAMS_PER_LB;
    case "KILOGRAMS": return (weight.value * 1000) / GRAMS_PER_LB;
    default:          return 0;
  }
}

// Loads an authenticated admin GraphQL client for the one shop this
// deployment serves. Filtered by SHOP_DOMAIN, not just findFirst() — dev and
// prod currently share one Session table, so an unfiltered lookup can
// silently grab the wrong shop's session.
//
// Returns shopId alongside admin — resolved from the matched session row
// (the same `session.shop` the admin routes use to scope Prisma rows), not
// the raw env var. SHOP_DOMAIN only picks which session to load here;
// callers that then read/write shop-scoped rows (SavedPackage, OrderSaving,
// ...) should use the returned shopId so they stay consistent with the
// admin UI's write path even if SHOP_DOMAIN's formatting ever drifts from
// the canonical value Shopify stored on the session.
export async function getShopAdmin() {
  if (!process.env.SHOP_DOMAIN) {
    throw new Error("Server misconfigured: SHOP_DOMAIN not set");
  }
  const session = await prisma.session.findFirst({
    where: { shop: process.env.SHOP_DOMAIN, isOnline: false },
  });
  if (!session) {
    throw new Error(`No session found for shop ${process.env.SHOP_DOMAIN}`);
  }
  const { admin } = await unauthenticated.admin(session.shop);
  return { admin, shopId: session.shop };
}

const ORDER_FIELDS = `
  id
  name
  shippingAddress {
    name address1 address2 city provinceCode zip countryCodeV2
  }
  customer {
    defaultAddress {
      name address1 address2 city provinceCode zip countryCodeV2
    }
  }
  lineItems(first: 50) {
    edges {
      node {
        title sku quantity
        variant {
          inventoryItem {
            measurement { weight { value unit } }
          }
        }
      }
    }
  }
`;

function normalizeOrder(order) {
  const lineItems = (order.lineItems?.edges ?? []).map((e) => e.node);
  const suggestedWeightLb = lineItems.reduce((sum, item) => {
    const weight = item.variant?.inventoryItem?.measurement?.weight;
    return sum + weightToLb(weight) * item.quantity;
  }, 0);

  // Prefer the customer's own saved address over the order's shippingAddress
  // snapshot — that snapshot can be stale or absent (e.g. local pickup
  // orders), while the customer record reflects any later corrections.
  // Falls back to shippingAddress for guest checkouts with no customer account.
  const addr = order.customer?.defaultAddress ?? order.shippingAddress;

  return {
    orderId: order.id,
    orderName: order.name,
    shippingAddress: addr
      ? {
          name: addr.name ?? "",
          street1: addr.address1 ?? "",
          street2: addr.address2 ?? "",
          city: addr.city ?? "",
          state: addr.provinceCode ?? "",
          zip: addr.zip ?? "",
          country: addr.countryCodeV2 ?? "",
        }
      : null,
    lineItems: lineItems.map((item) => ({
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
    })),
    suggestedWeightLb: Math.round(suggestedWeightLb * 100) / 100,
  };
}

// Finds one order by its exact name ("#4337" or "4337"). Throws if nothing
// matches exactly, even if Shopify's search returns loosely-related
// candidates — see the comment on searchQuery below.
export async function lookupOrderByName(admin, orderNumber) {
  const targetName = orderNumber.startsWith("#") ? orderNumber : `#${orderNumber}`;
  // name: field-qualifies the search instead of a bare full-text match — a
  // bare "#4337" can match unrelated orders on other fields too, and
  // silently return the wrong one. Combined with the exact-match check
  // below on the results, since search can still rank loosely.
  const searchQuery = `name:${targetName}`;

  const response = await admin.graphql(
    `#graphql
    query lookupOrder($query: String!) {
      orders(first: 20, query: $query) {
        edges { node { ${ORDER_FIELDS} } }
      }
    }`,
    { variables: { query: searchQuery } },
  );
  const data = await response.json();

  if (data.errors) {
    console.error("[orderLookup] GraphQL errors:", data.errors);
    throw new Error("Shopify GraphQL error");
  }

  const candidates = (data.data?.orders?.edges ?? []).map((e) => e.node);
  const order = candidates.find((o) => o.name === targetName);
  if (!order) {
    throw new Error(
      `Order ${targetName} not found (search returned ${candidates.length} candidate(s), none matched exactly)`,
    );
  }

  return normalizeOrder(order);
}

// Recent open orders, for the ESP's order list — bounded, since it's a small
// screen to scroll through, not a full order-history browser.
export async function listRecentOrders(admin, first = 25) {
  const response = await admin.graphql(
    `#graphql
    query listRecentOrders($first: Int!) {
      orders(first: $first, sortKey: CREATED_AT, reverse: true, query: "status:open") {
        edges { node { ${ORDER_FIELDS} } }
      }
    }`,
    { variables: { first } },
  );
  const data = await response.json();

  if (data.errors) {
    console.error("[orderLookup] GraphQL errors (listRecentOrders):", data.errors);
    throw new Error("Shopify GraphQL error");
  }

  const orders = (data.data?.orders?.edges ?? []).map((e) => e.node);
  return orders.map(normalizeOrder);
}
