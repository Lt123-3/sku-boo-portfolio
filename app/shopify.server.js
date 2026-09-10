import 'dotenv/config';
import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server.js";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  // Shop-specific webhook registration. registerWebhooks() (called in afterAuth,
  // below) reconciles this map against the shop via the Admin GraphQL API using
  // the session token — no `shopify app deploy` / linked app required. Keep this
  // the single source of truth: there are deliberately no [[webhooks.subscriptions]]
  // in shopify.app.toml (declaring both would double-register).
  webhooks: {
    PRODUCTS_CREATE:   { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/products/create" },
    PRODUCTS_UPDATE:   { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/products/update" },
    PRODUCTS_DELETE:   { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/products/delete" },
    APP_UNINSTALLED:   { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/app/uninstalled" },
    APP_SCOPES_UPDATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/app/scopes_update" },
  },
  hooks: {
    // Called after install and after an offline-token refresh. afterAuth receives
    // { session, admin } — not a Request — so use session directly. Swallow errors
    // so a transient registration failure can't turn the auth flow into a 500.
    afterAuth: async ({ session }) => {
      try {
        await shopify.registerWebhooks({ session });
        console.log("[afterAuth] webhooks registered:", session.shop);
      } catch (err) {
        console.error("[afterAuth] registerWebhooks failed:", session?.shop, err);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
