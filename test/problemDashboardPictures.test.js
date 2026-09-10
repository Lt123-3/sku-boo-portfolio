// test/problemDashboardPictures.test.js
//
// Covers the Pictures section query on /app/problem-dashboard (intent
// "pictures_query"): the no_pic / low_pic filter, title/SKU search, sort, and
// the belt-and-suspenders exclusion filter on the returned rows.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_SHOP = "test-shop.myshopify.com";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    skuIndex:    { findMany: vi.fn(), count: vi.fn() },
    productInfo: { findMany: vi.fn() },
  },
}));

vi.mock("../app/shopify.server.js", () => ({
  authenticate: { admin: vi.fn().mockResolvedValue({ admin: {}, session: { shop: TEST_SHOP } }) },
}));
vi.mock("../app/lib/access.server.js", () => ({
  validateSkuSession: vi.fn().mockResolvedValue({ role: "admin", userId: "u1" }),
}));
vi.mock("../app/db.server.js", () => ({ default: prismaMock }));

const { action } = await import("../app/routes/app.problem-dashboard.jsx");

function picturesRequest(fields = {}) {
  const fd = new FormData();
  fd.set("intent", "pictures_query");
  fd.set("sessionId", "s1");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("http://localhost/app/problem-dashboard", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.skuIndex.findMany.mockResolvedValue([]);
  prismaMock.skuIndex.count.mockResolvedValue(0);
  prismaMock.productInfo.findMany.mockResolvedValue([]);
});

describe("pictures_query", () => {
  it("filters to active no_pic / low_pic rows and passes the total through", async () => {
    prismaMock.skuIndex.findMany.mockResolvedValue([
      { id: 1, productId: "gid://shopify/Product/1", problems: '["no_pic"]',  excludedProblems: "[]", imageCount: 0 },
      { id: 2, productId: "gid://shopify/Product/2", problems: '["low_pic"]', excludedProblems: "[]", imageCount: 2 },
      // low_pic present but excluded → must be dropped from the result
      { id: 3, productId: "gid://shopify/Product/3", problems: '["low_pic"]', excludedProblems: '["low_pic"]', imageCount: 1 },
    ]);
    prismaMock.skuIndex.count.mockResolvedValue(42);

    const res  = await action({ request: picturesRequest() });
    const body = await res.json();

    const where = prismaMock.skuIndex.findMany.mock.calls[0][0].where;
    expect(where.shopId).toBe(TEST_SHOP);
    expect(where.OR).toEqual([
      { problems: { contains: '"no_pic"' } },
      { problems: { contains: '"low_pic"' } },
    ]);
    expect(where.AND).toBeUndefined();

    expect(body.pictures.total).toBe(42);
    expect(body.pictures.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("adds a title/SKU search clause when search is provided", async () => {
    await action({ request: picturesRequest({ search: "denim" }) });

    const where = prismaMock.skuIndex.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { OR: [{ title: { contains: "denim" } }, { skuNumber: { contains: "denim" } }] },
    ]);
  });

  it("orders by fewest images by default and by recency when asked", async () => {
    await action({ request: picturesRequest() });
    expect(prismaMock.skuIndex.findMany.mock.calls[0][0].orderBy).toEqual([
      { imageCount: "asc" },
      { updatedAt: "desc" },
    ]);

    prismaMock.skuIndex.findMany.mockClear();
    await action({ request: picturesRequest({ sort: "recent" }) });
    expect(prismaMock.skuIndex.findMany.mock.calls[0][0].orderBy).toEqual([
      { updatedAt: "desc" },
    ]);
  });

  it("rejects a non-admin session", async () => {
    const { validateSkuSession } = await import("../app/lib/access.server.js");
    validateSkuSession.mockResolvedValueOnce({ role: "operator" });

    const res  = await action({ request: picturesRequest() });
    const body = await res.json();

    expect(body).toEqual({ success: false, error: "Forbidden" });
    expect(prismaMock.skuIndex.findMany).not.toHaveBeenCalled();
  });
});
