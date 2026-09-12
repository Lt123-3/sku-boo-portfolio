// app/lib/orderLookup.server.test.js
//
// Regression test for Session 8 (see EXECUTION_PLAN.md): getShopAdmin() must
// return shopId resolved from the matched Session row (session.shop) — the
// same value app.packages.jsx's write path uses — not process.env.SHOP_DOMAIN
// re-read directly. esp-server.js's SavedPackage/OrderSaving reads and writes
// depend on that contract to stay consistent with the admin route.
//
// What is faked, and why:
//   app/db.server.js      swapped for a controllable prisma.session.findFirst
//                          stub, so we can return a session shape independent
//                          of whatever SHOP_DOMAIN is set to in the test.
//   app/shopify.server.js unauthenticated.admin() normally builds a real
//                          Shopify admin GraphQL client from a session; we
//                          only need it to hand back a recognizable stub.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, unauthenticatedAdminMock } = vi.hoisted(() => ({
  prismaMock: { session: { findFirst: vi.fn() } },
  unauthenticatedAdminMock: vi.fn(),
}));

vi.mock("../db.server.js", () => ({ default: prismaMock }));
vi.mock("../shopify.server.js", () => ({
  unauthenticated: { admin: unauthenticatedAdminMock },
}));

const { getShopAdmin } = await import("./orderLookup.server.js");

describe("getShopAdmin", () => {
  let savedShopDomain;

  beforeEach(() => {
    vi.clearAllMocks();
    savedShopDomain = process.env.SHOP_DOMAIN;
  });

  afterEach(() => {
    if (savedShopDomain === undefined) delete process.env.SHOP_DOMAIN;
    else process.env.SHOP_DOMAIN = savedShopDomain;
  });

  it("resolves shopId from the matched session row, not the raw env var", async () => {
    // SHOP_DOMAIN only picks which session to load; if it ever drifts from
    // the canonical value Shopify stored on the session (the scenario this
    // fix guards against), the returned shopId must still follow the session
    // row — which is what app.packages.jsx's write path scopes by.
    process.env.SHOP_DOMAIN = "env-var-value.myshopify.com";
    prismaMock.session.findFirst.mockResolvedValue({ shop: "db-canonical-value.myshopify.com" });
    const fakeAdmin = { graphql: vi.fn() };
    unauthenticatedAdminMock.mockResolvedValue({ admin: fakeAdmin });

    const result = await getShopAdmin();

    expect(result.shopId).toBe("db-canonical-value.myshopify.com");
    expect(result.admin).toBe(fakeAdmin);
    expect(prismaMock.session.findFirst).toHaveBeenCalledWith({
      where: { shop: "env-var-value.myshopify.com", isOnline: false },
    });
    expect(unauthenticatedAdminMock).toHaveBeenCalledWith("db-canonical-value.myshopify.com");
  });

  it("throws when SHOP_DOMAIN is not set", async () => {
    delete process.env.SHOP_DOMAIN;

    await expect(getShopAdmin()).rejects.toThrow("Server misconfigured: SHOP_DOMAIN not set");
    expect(prismaMock.session.findFirst).not.toHaveBeenCalled();
  });

  it("throws when no offline session matches SHOP_DOMAIN", async () => {
    process.env.SHOP_DOMAIN = "no-session-for-this-shop.myshopify.com";
    prismaMock.session.findFirst.mockResolvedValue(null);

    await expect(getShopAdmin()).rejects.toThrow(
      "No session found for shop no-session-for-this-shop.myshopify.com",
    );
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
  });
});
