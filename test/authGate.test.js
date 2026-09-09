// test/authGate.test.js
//
// Integration test for the Session 3 authorization gate (see EXECUTION_PLAN.md).
//
// app/routes/app._index.jsx and app/routes/app.prepb.jsx each export an
// `action` that must reject a signed-in *viewer* on any mutating request with
// 403, while letting an *operator* through. This drives those exported action
// functions directly with a constructed Request and a constructed viewer /
// operator session, so if the gate is ever removed or weakened (e.g. the
// isMutationAllowed check is deleted) this suite goes red.
//
// Lives in test/ rather than beside the routes on purpose: flatRoutes() turns
// any app/routes/*.test.js into a real (broken) route + a typegen stub that
// Vitest then tries to run.
//
// What is faked, and why:
//   app/shopify.server      authenticate.admin() normally verifies a real
//                           Shopify OAuth session. We only need it to hand back
//                           a shop domain plus an admin.graphql() stub.
//   validateSkuSession      stubbed so a viewer / operator session can be
//                           constructed without a SkuSession database row. The
//                           REAL isMutationAllowed and the REAL route wiring
//                           around it are what this test exercises.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_SHOP = "test-shop.myshopify.com";

// vi.mock factories are hoisted above imports, so anything they close over must
// come from vi.hoisted.
const { authenticateAdminMock, graphqlMock, validateSkuSessionMock } = vi.hoisted(
  () => ({
    authenticateAdminMock: vi.fn(),
    graphqlMock: vi.fn(),
    validateSkuSessionMock: vi.fn(),
  }),
);

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdminMock },
}));

// Partial mock: keep every real export (isMutationAllowed especially), swap
// only validateSkuSession for a stub we control per-test.
vi.mock("../app/lib/access.server.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, validateSkuSession: validateSkuSessionMock };
});

const { action: indexAction } = await import("../app/routes/app._index.jsx");
const { action: prepbAction } = await import("../app/routes/app.prepb.jsx");

const VIEWER = {
  userId: "u-viewer",
  username: "Vic Viewer",
  role: "viewer",
  shopId: TEST_SHOP,
};
const OPERATOR = {
  userId: "u-operator",
  username: "Oona Operator",
  role: "operator",
  shopId: TEST_SHOP,
};

function postRequest(fields) {
  return new Request("http://localhost/app", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

function runAction(actionFn, fields) {
  return actionFn({ request: postRequest(fields), params: {}, context: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdminMock.mockResolvedValue({
    admin: { graphql: graphqlMock },
    session: { shop: TEST_SHOP },
  });
});

describe("app._index.jsx action — viewer/operator gate", () => {
  it("rejects a viewer POST with 403", async () => {
    validateSkuSessionMock.mockResolvedValue(VIEWER);

    const res = await runAction(indexAction, {
      intent: "delete",
      productId: "gid://shopify/Product/1",
      skuLogId: "1",
      sessionId: "sid",
    });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
  });

  it("lets an operator POST through the gate", async () => {
    validateSkuSessionMock.mockResolvedValue(OPERATOR);

    // Deliberately omit productId/skuLogId: the delete handler's own field
    // validation then returns a plain object. Reaching that point at all
    // proves the gate let the operator past — no 403.
    const res = await runAction(indexAction, {
      intent: "delete",
      sessionId: "sid",
    });

    expect(res).not.toBeInstanceOf(Response);
    expect(res).toMatchObject({
      error: expect.stringMatching(/missing product id/i),
    });
  });

  it("returns needsAuth, not 403, when there is no valid session", async () => {
    validateSkuSessionMock.mockResolvedValue(null);

    const res = await runAction(indexAction, { intent: "delete", sessionId: "" });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).not.toBe(403);
    expect(await res.json()).toEqual({ needsAuth: true });
  });
});

describe("app.prepb.jsx action — viewer/operator gate", () => {
  it("rejects a viewer on every mutating intent with 403", async () => {
    validateSkuSessionMock.mockResolvedValue(VIEWER);

    for (const intent of [
      "save",
      "generate-title",
      "generate-description",
      "stage-image",
      "create-collection",
      "rename-collection",
      "delete-collection",
      "add-products",
      "remove-from-collection",
      "find-or-create-singles",
      "create-named-collection",
    ]) {
      const res = await runAction(prepbAction, { intent, sessionId: "sid" });
      expect(res, `intent=${intent}`).toBeInstanceOf(Response);
      expect(res.status, `intent=${intent}`).toBe(403);
    }
  });

  it("still lets a viewer run read-only intents", async () => {
    validateSkuSessionMock.mockResolvedValue(VIEWER);
    graphqlMock.mockResolvedValue({
      json: async () => ({ data: { collections: { edges: [] } } }),
    });

    const res = await runAction(prepbAction, {
      intent: "search",
      query: "hats",
      sessionId: "sid",
    });

    expect(res).not.toBeInstanceOf(Response);
    expect(res).toEqual({ searchResults: [] });
  });

  it("lets an operator through the gate on a mutating intent", async () => {
    validateSkuSessionMock.mockResolvedValue(OPERATOR);
    const collection = {
      id: "gid://shopify/Collection/1",
      title: "Test",
      productsCount: { count: 0 },
    };
    graphqlMock.mockResolvedValue({
      json: async () => ({
        data: { collectionCreate: { collection, userErrors: [] } },
      }),
    });

    const res = await runAction(prepbAction, {
      intent: "create-collection",
      title: "Test",
      sessionId: "sid",
    });

    expect(res).not.toBeInstanceOf(Response);
    expect(res).toEqual({ createdCollection: collection });
    expect(graphqlMock).toHaveBeenCalledOnce();
  });

  it("rejects with 401, not 403, when there is no valid session", async () => {
    validateSkuSessionMock.mockResolvedValue(null);

    const res = await runAction(prepbAction, { intent: "save", sessionId: "" });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });
});
