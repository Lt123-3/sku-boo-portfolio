// test/initSyncPass2.test.js
//
// Regression test for Session 7 (see EXECUTION_PLAN.md).
//
// runInitSyncPass2 used to call only upsertProductInfoRow per product, so field
// changes discovered during a full-catalog re-sync never reached SkuHistory —
// only runCronCycle ran detectAndWriteChanges. Pass 2 must now run
// detectAndWriteChanges *before* upsertProductInfoRow (so the diff sees the
// pre-cycle ProductInfo row), exactly as the cron cycle sequences it.
//
// Lives in test/ rather than beside app/lib for the same flatRoutes() reason
// spelled out at the top of test/authGate.test.js — keeping the mock-heavy
// suites together.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_SHOP = "test-shop.myshopify.com";
const GID = "gid://shopify/Product/8123456789";

// vi.mock factories are hoisted above imports; anything they close over must
// come from vi.hoisted.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    skuIndex: { count: vi.fn() },
    syncState: { findUnique: vi.fn(), upsert: vi.fn() },
    productInfo: { findUnique: vi.fn(), upsert: vi.fn() },
    skuHistory: { create: vi.fn() },
  },
}));

// Fake Prisma so the REAL runInitSyncPass2 / detectAndWriteChanges /
// upsertProductInfoRow run against something inspectable.
vi.mock("../app/db.server.js", () => ({ default: prismaMock }));

const { runInitSyncPass2 } = await import("../app/lib/sync.server.js");

// A cron / Pass 2-shaped product node. `first(...)` overrides let each test
// vary just the field it cares about.
function productNode(overrides = {}) {
  return {
    id: GID,
    title: "123456 - Vintage Denim Jacket",
    vendor: "Acme",
    updatedAt: "2026-09-09T00:00:00Z",
    media: { edges: [{ node: { image: { url: "https://cdn.example/x.jpg" } } }] },
    collections: { edges: [{ node: { title: "Denim" } }, { node: { title: "Vintage" } }] },
    metafield: { value: "1000" },
    variants: {
      edges: [
        {
          node: {
            price: "42.00",
            sku: "123456",
            inventoryItem: {
              measurement: { weight: { value: 2, unit: "KILOGRAMS" } },
              inventoryLevels: {
                edges: [
                  {
                    node: {
                      location: { id: "gid://shopify/Location/1", name: "Main" },
                      quantities: [{ quantity: 5 }],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

// The ProductInfo row detectAndWriteChanges reads back — matches productNode()
// field-for-field unless overridden, so by default nothing looks changed.
function productInfoRow(overrides = {}) {
  return {
    productId: GID,
    title: "123456 - Vintage Denim Jacket",
    vendor: "Acme",
    price: "42.00",
    weight: "2 KILOGRAMS",
    condition: "1000",
    inventory: JSON.stringify({
      "gid://shopify/Location/1": { name: "Main", quantity: 5 },
    }),
    collections: JSON.stringify(["Denim", "Vintage"]),
    imageUrl: "https://cdn.example/x.jpg",
    ...overrides,
  };
}

// One page, no next page.
function graphqlOnePage(node) {
  return vi.fn().mockResolvedValue({
    json: async () => ({
      data: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{ node }],
        },
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.skuIndex.count.mockResolvedValue(1);
  prismaMock.syncState.findUnique.mockResolvedValue(null); // not cancelled, no startTime
  prismaMock.syncState.upsert.mockResolvedValue({});
  prismaMock.productInfo.upsert.mockResolvedValue({});
  prismaMock.skuHistory.create.mockResolvedValue({});
});

describe("runInitSyncPass2 — feeds SkuHistory via detectAndWriteChanges", () => {
  it("writes a SkuHistory row for a field that actually changed", async () => {
    prismaMock.productInfo.findUnique.mockResolvedValue(
      productInfoRow({ title: "123456 - OLD TITLE" }),
    );
    const graphql = graphqlOnePage(productNode());

    await runInitSyncPass2({ graphql }, TEST_SHOP, null, "fast");

    expect(prismaMock.skuHistory.create).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.skuHistory.create.mock.calls[0][0];
    expect(data).toMatchObject({
      shopId: TEST_SHOP,
      productId: GID,
      skuNumber: "123456",
      field: "title",
      oldValue: "123456 - OLD TITLE",
      newValue: "123456 - Vintage Denim Jacket",
      changedBy: "system",
    });
  });

  it("diffs against the pre-cycle row: detectAndWriteChanges runs before upsertProductInfoRow", async () => {
    prismaMock.productInfo.findUnique.mockResolvedValue(
      productInfoRow({ price: "10.00" }),
    );
    const graphql = graphqlOnePage(productNode());

    await runInitSyncPass2({ graphql }, TEST_SHOP, null, "fast");

    expect(prismaMock.productInfo.findUnique).toHaveBeenCalledWith({
      where: { productId: GID },
    });
    const readOrder = prismaMock.productInfo.findUnique.mock.invocationCallOrder[0];
    const writeOrder = prismaMock.productInfo.upsert.mock.invocationCallOrder[0];
    expect(readOrder).toBeLessThan(writeOrder);
    expect(prismaMock.skuHistory.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.skuHistory.create.mock.calls[0][0].data.field).toBe("price");
  });

  it("writes nothing when every tracked field matches the stored row", async () => {
    prismaMock.productInfo.findUnique.mockResolvedValue(productInfoRow());
    const graphql = graphqlOnePage(productNode());

    await runInitSyncPass2({ graphql }, TEST_SHOP, null, "fast");

    expect(prismaMock.skuHistory.create).not.toHaveBeenCalled();
    expect(prismaMock.productInfo.upsert).toHaveBeenCalledTimes(1);
  });

  it("writes no history on a first-ever Pass 2 (no ProductInfo row yet)", async () => {
    prismaMock.productInfo.findUnique.mockResolvedValue(null);
    const graphql = graphqlOnePage(productNode());

    await runInitSyncPass2({ graphql }, TEST_SHOP, null, "fast");

    expect(prismaMock.skuHistory.create).not.toHaveBeenCalled();
    expect(prismaMock.productInfo.upsert).toHaveBeenCalledTimes(1);
  });
});
