import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectProblems,
  getThrottleDelay,
  formatEta,
} from "./sync.server.js";

// A product/variant pair that trips no problem checks: 6-digit SKU,
// "<digits> - <body>" title, and an image present.
function cleanProduct(overrides = {}) {
  return {
    product: {
      title: "123456 - Vintage Denim Jacket",
      featuredImage: { url: "https://cdn.example/x.jpg" },
      ...overrides.product,
    },
    variant: { sku: "123456", ...overrides.variant },
  };
}

describe("detectProblems", () => {
  it("returns no problems for a well-formed product", () => {
    const { product, variant } = cleanProduct();
    expect(detectProblems(product, variant)).toEqual([]);
  });

  it("flags no_sku when the variant SKU is missing", () => {
    const { product } = cleanProduct();
    expect(detectProblems(product, { sku: null })).toEqual(["no_sku"]);
  });

  it("flags no_sku when the SKU is not exactly six digits", () => {
    const { product } = cleanProduct();
    for (const sku of ["12345", "1234567", "12ab56", "  123456"]) {
      expect(detectProblems(product, { sku })).toEqual(["no_sku"]);
    }
  });

  it("flags no_sku when the variant itself is undefined", () => {
    const { product } = cleanProduct();
    expect(detectProblems(product, undefined)).toEqual(["no_sku"]);
  });

  it("flags no_title when the product has no title", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: null, featuredImage: { url: "x" } }, variant),
    ).toEqual(["no_title"]);
  });

  it("flags no_title when the title has neither a numeric prefix nor body", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "Vintage Lamp", featuredImage: { url: "x" } }, variant),
    ).toEqual(["no_title"]);
  });

  it("flags no_title_body when the title is a bare numeric prefix", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456-", featuredImage: { url: "x" } }, variant),
    ).toEqual(["no_title_body"]);
  });

  it("accepts an en-dash separator in the title", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems(
        { title: "123456 – Vintage Lamp", featuredImage: { url: "x" } },
        variant,
      ),
    ).toEqual([]);
  });

  it("flags no_pic when the featuredImage-shape payload has no image", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp", featuredImage: null }, variant),
    ).toEqual(["no_pic"]);
  });

  it("flags no_pic when the media-shape payload carries no image", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp", media: { edges: [] } }, variant),
    ).toEqual(["no_pic"]);
    // media present but only a non-image (video / 3d model) → still no picture
    expect(
      detectProblems(
        { title: "123456 - Lamp", media: { edges: [{ node: {} }] } },
        variant,
      ),
    ).toEqual(["no_pic"]);
  });

  it("does not flag no_pic when the media-shape payload has an image", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems(
        {
          title: "123456 - Lamp",
          media: { edges: [{ node: { image: { url: "https://cdn.example/x.jpg" } } }] },
        },
        variant,
      ),
    ).toEqual([]);
  });

  it("leaves no_pic unjudged when the payload fetched no image field at all", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp" }, variant),
    ).toEqual([]);
  });

  it("accumulates every problem, in detection order", () => {
    expect(
      detectProblems({ title: null, featuredImage: null }, { sku: null }),
    ).toEqual(["no_sku", "no_title", "no_pic"]);
  });
});

describe("getThrottleDelay", () => {
  it("returns the base delay when the response carries no cost extension", () => {
    expect(getThrottleDelay(undefined, 800)).toBe(800);
    expect(getThrottleDelay(null, 800)).toBe(800);
    expect(getThrottleDelay({}, 800)).toBe(800);
    expect(getThrottleDelay({ extensions: {} }, 800)).toBe(800);
  });

  it("returns the base delay when plenty of points remain", () => {
    const data = {
      extensions: {
        cost: {
          actualQueryCost: 50,
          throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 },
        },
      },
    };
    expect(getThrottleDelay(data, 800)).toBe(800);
  });

  it("uses built-in defaults when throttleStatus fields are absent", () => {
    // available defaults to 1000, queryCost to 50 -> 1000 >= 150 -> base delay.
    expect(getThrottleDelay({ extensions: { cost: {} } }, 800)).toBe(800);
  });

  it("returns a computed wait once available drops below 3x the query cost", () => {
    const data = {
      extensions: {
        cost: {
          actualQueryCost: 100,
          throttleStatus: { currentlyAvailable: 100, restoreRate: 50 },
        },
      },
    };
    // needed = 300 - 100 = 200; wait = ceil(200 / 50 * 1000) + 500 = 4500.
    expect(getThrottleDelay(data, 800)).toBe(4500);
  });

  it("does not throttle exactly at the 3x threshold", () => {
    const data = {
      extensions: {
        cost: {
          actualQueryCost: 100,
          throttleStatus: { currentlyAvailable: 300, restoreRate: 50 },
        },
      },
    };
    expect(getThrottleDelay(data, 800)).toBe(800);
  });

  it("rounds the wait up and adds the 500ms cushion", () => {
    const data = {
      extensions: {
        cost: {
          actualQueryCost: 100,
          throttleStatus: { currentlyAvailable: 299, restoreRate: 50 },
        },
      },
    };
    // needed = 1; wait = ceil(1 / 50 * 1000) + 500 = ceil(20) + 500 = 520.
    expect(getThrottleDelay(data, 800)).toBe(520);
  });
});

describe("formatEta", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const startedMsAgo = (ms) => new Date(Date.now() - ms).toISOString();

  it("returns null before any progress is made", () => {
    expect(formatEta(0, 100, startedMsAgo(60000))).toBeNull();
  });

  it("returns null when there is no start time", () => {
    expect(formatEta(10, 100, null)).toBeNull();
    expect(formatEta(10, 100, undefined)).toBeNull();
  });

  it("extrapolates remaining minutes from elapsed time and progress", () => {
    // 60s elapsed for 10 of 100 -> 6s/product -> 90 left -> 540s -> 9 min.
    expect(formatEta(10, 100, startedMsAgo(60000))).toBe("~9 minutes remaining");
  });

  it("uses the singular phrasing at exactly one minute", () => {
    // 60s elapsed for 50 of 100 -> 1.2s/product -> 50 left -> 60s -> 1 min.
    expect(formatEta(50, 100, startedMsAgo(60000))).toBe("~1 minute remaining");
  });

  it("reports less than a minute once nothing is left to process", () => {
    expect(formatEta(100, 100, startedMsAgo(5000))).toBe(
      "less than a minute remaining",
    );
  });

  it("accepts a Date start time as well as an ISO string", () => {
    expect(formatEta(50, 150, new Date(Date.now() - 60000))).toBe(
      "~2 minutes remaining",
    );
  });
});
