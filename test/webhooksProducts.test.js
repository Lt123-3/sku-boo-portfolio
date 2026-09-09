// test/webhooksProducts.test.js
//
// Regression test for Session 6 (see EXECUTION_PLAN.md).
//
// products/create and products/update webhooks deliver a REST-shaped payload.
// They must NOT hand that payload straight to upsertSkuIndexRow (which reads a
// GraphQL product node) — instead they re-fetch the product by its GID
// (payload.admin_graphql_api_id) with the same field selection runDripSync uses,
// then upsert that. products/delete must pass the same GID — never the bare
// REST payload.id — so the stored `gid://shopify/Product/<id>` productId matches
// on lookup, and a missed match must be logged loudly, not swallowed.
//
// Lives in test/ rather than beside the routes for the flatRoutes() reason
// spelled out at the top of test/authGate.test.js.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_SHOP = "test-shop.myshopify.com";
const GID = "gid://shopify/Product/8123456789";

// vi.mock factories are hoisted above imports; anything they close over must
// come from vi.hoisted.
const { webhookMock, prismaMock } = vi.hoisted(() => ({
  webhookMock: vi.fn(),
  prismaMock: {
    skuIndex: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    problemLog: { create: vi.fn(), createMany: vi.fn() },
  },
}));

vi.mock("../app/shopify.server.js", () => ({
  authenticate: { webhook: webhookMock },
}));

// Fake Prisma so the REAL upsertSkuIndexRow / detectProblems / handleProductDeleted
// run against something inspectable — this is what proves the re-fetched shape
// produces a correct row (real SKU key, GID productId, honest problem flags).
vi.mock("../app/db.server.js", () => ({ default: prismaMock }));

const { action: createAction } = await import(
  "../app/routes/webhooks.products.create.jsx"
);
const { action: updateAction } = await import(
  "../app/routes/webhooks.products.update.jsx"
);
const { action: deleteAction } = await import(
  "../app/routes/webhooks.products.delete.jsx"
);
const { handleProductDeleted } = await import("../app/lib/sync.server.js");

// A GraphQL product node in the drip shape: valid 6-digit SKU, real image.
function graphqlProductNode(overrides = {}) {
  return {
    id: GID,
    title: "123456 - Vintage Denim Jacket",
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
    variants: { edges: [{ node: { sku: "123456" } }] },
    featuredImage: { url: "https://cdn.example/x.jpg" },
    ...overrides,
  };
}

// The REST-shaped body Shopify actually posts: id is a bare integer, variants is
// a plain array, there is no featuredImage. The GID lives in admin_graphql_api_id.
function restPayload() {
  return {
    id: 8123456789,
    admin_graphql_api_id: GID,
    title: "123456 - Vintage Denim Jacket",
    variants: [{ id: 1, sku: "123456" }],
    image: { src: "https://cdn.example/x.jpg" },
  };
}

function graphqlReturning(node) {
  return vi.fn().mockResolvedValue({
    json: async () => ({ data: { product: node } }),
  });
}

const req = () =>
  new Request("http://localhost/webhooks/products", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.skuIndex.findUnique.mockResolvedValue(null);
  prismaMock.skuIndex.findFirst.mockResolvedValue(null);
  prismaMock.skuIndex.upsert.mockResolvedValue({});
  prismaMock.skuIndex.update.mockResolvedValue({});
  prismaMock.problemLog.create.mockResolvedValue({});
  prismaMock.problemLog.createMany.mockResolvedValue({});
});

describe.each([
  ["create", () => createAction],
  ["update", () => updateAction],
])("products/%s — re-fetch by GID before upsert", (name, getAction) => {
  it("queries product(id:) with the drip field selection, keyed by admin_graphql_api_id", async () => {
    const graphql = graphqlReturning(graphqlProductNode());
    webhookMock.mockResolvedValue({
      topic: `PRODUCTS_${name.toUpperCase()}`,
      shop: TEST_SHOP,
      admin: { graphql },
      payload: restPayload(),
    });

    const res = await getAction()({ request: req() });

    expect(graphql).toHaveBeenCalledOnce();
    const [queryArg, optsArg] = graphql.mock.calls[0];
    expect(queryArg).toContain("product(id: $id)");
    expect(queryArg).toContain("variants(first: 1)");
    expect(queryArg).toContain("featuredImage { url }");
    expect(optsArg).toEqual({ variables: { id: GID } });
    expect(res.status).toBe(200);
  });

  it("upserts a correct SkuIndex row: real SKU key, GID productId, no false flags", async () => {
    const graphql = graphqlReturning(graphqlProductNode());
    webhookMock.mockResolvedValue({
      shop: TEST_SHOP,
      admin: { graphql },
      payload: restPayload(),
    });

    await getAction()({ request: req() });

    expect(prismaMock.skuIndex.upsert).toHaveBeenCalledOnce();
    const arg = prismaMock.skuIndex.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ skuNumber: "123456" });
    expect(arg.create.productId).toBe(GID);
    expect(arg.update.productId).toBe(GID);
    expect(arg.create.status).toBe("active");
    expect(JSON.parse(arg.create.problems)).toEqual([]);
  });

  it("never routes the raw REST payload into the upsert path", async () => {
    const graphql = graphqlReturning(graphqlProductNode());
    webhookMock.mockResolvedValue({
      shop: TEST_SHOP,
      admin: { graphql },
      payload: restPayload(),
    });

    await getAction()({ request: req() });

    // The raw payload (variants: [], no featuredImage, integer id) would have
    // produced a `gid-...` placeholder row keyed off the bare integer.
    const arg = prismaMock.skuIndex.upsert.mock.calls[0][0];
    expect(String(arg.where.skuNumber)).not.toMatch(/^gid-/);
    expect(arg.create.productId).not.toBe(8123456789);
  });

  it("no admin client (uninstalled / CLI-triggered) — skips the upsert, still 200", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    webhookMock.mockResolvedValue({
      shop: TEST_SHOP,
      admin: undefined,
      payload: restPayload(),
    });

    const res = await getAction()({ request: req() });

    expect(prismaMock.skuIndex.upsert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(res.status).toBe(200);
    warn.mockRestore();
  });

  it("GraphQL errors on re-fetch — skips the upsert, still 200", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const graphql = vi.fn().mockResolvedValue({
      json: async () => ({ errors: [{ message: "boom" }] }),
    });
    webhookMock.mockResolvedValue({
      shop: TEST_SHOP,
      admin: { graphql },
      payload: restPayload(),
    });

    const res = await getAction()({ request: req() });

    expect(prismaMock.skuIndex.upsert).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(res.status).toBe(200);
    error.mockRestore();
  });

  it("product gone by the time we re-fetch — skips the upsert, still 200", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const graphql = graphqlReturning(null);
    webhookMock.mockResolvedValue({
      shop: TEST_SHOP,
      admin: { graphql },
      payload: restPayload(),
    });

    const res = await getAction()({ request: req() });

    expect(prismaMock.skuIndex.upsert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(res.status).toBe(200);
    warn.mockRestore();
  });
});

describe("products/delete — passes the GID, logs a miss", () => {
  it("looks up by admin_graphql_api_id (not payload.id) and frees the SKU", async () => {
    webhookMock.mockResolvedValue({
      shop: TEST_SHOP,
      payload: { id: 8123456789, admin_graphql_api_id: GID },
    });
    prismaMock.skuIndex.findFirst.mockResolvedValueOnce({
      id: 7,
      skuNumber: "123456",
    });

    const res = await deleteAction({ request: req() });

    expect(prismaMock.skuIndex.findFirst).toHaveBeenCalledWith({
      where: { productId: GID, shopId: TEST_SHOP },
    });
    expect(prismaMock.skuIndex.update).toHaveBeenCalledOnce();
    expect(prismaMock.skuIndex.update.mock.calls[0][0].data).toMatchObject({
      taken: false,
      productId: null,
      status: "deleted",
    });
    expect(res.status).toBe(200);
  });

  it("handleProductDeleted logs productId + shopId when nothing matches", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prismaMock.skuIndex.findFirst.mockResolvedValue(null);

    await handleProductDeleted(GID, TEST_SHOP);

    expect(warn).toHaveBeenCalledOnce();
    const logged = warn.mock.calls[0].join(" ");
    expect(logged).toContain(GID);
    expect(logged).toContain(TEST_SHOP);
    expect(prismaMock.skuIndex.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
