import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectProblems,
  countProductImages,
  getThrottleDelay,
  formatEta,
} from "./sync.server.js";

// media(query: "media_type:IMAGE") edges — n image nodes.
function imageMedia(n) {
  return {
    edges: Array.from({ length: n }, (_, i) => ({
      node: { image: { url: `https://cdn.example/${i}.jpg` } },
    })),
  };
}

// A product/variant pair that trips no problem checks: 6-digit SKU,
// "<digits> - <body>" title, and 3+ images.
function cleanProduct(overrides = {}) {
  return {
    product: {
      title: "123456 - Vintage Denim Jacket",
      media: imageMedia(3),
      ...overrides.product,
    },
    variant: { sku: "123456", ...overrides.variant },
  };
}

describe("countProductImages", () => {
  it("counts image edges from a media-shape payload", () => {
    expect(countProductImages({ media: imageMedia(0) })).toBe(0);
    expect(countProductImages({ media: imageMedia(2) })).toBe(2);
    expect(countProductImages({ media: imageMedia(9) })).toBe(9);
  });

  it("ignores media edges with no image url (video / 3d / still processing)", () => {
    expect(
      countProductImages({ media: { edges: [{ node: {} }, { node: { image: {} } }] } }),
    ).toBe(0);
  });

  it("falls back to legacy featuredImage as 0 or 1", () => {
    expect(countProductImages({ featuredImage: null })).toBe(0);
    expect(countProductImages({ featuredImage: { url: "x" } })).toBe(1);
  });

  it("returns null when no image field was fetched", () => {
    expect(countProductImages({ title: "x" })).toBeNull();
  });
});

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
      detectProblems({ title: null, media: imageMedia(3) }, variant),
    ).toEqual(["no_title"]);
  });

  it("flags no_title when the title has neither a numeric prefix nor body", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "Vintage Lamp", media: imageMedia(3) }, variant),
    ).toEqual(["no_title"]);
  });

  it("flags no_title_body when the title is a bare numeric prefix", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456-", media: imageMedia(3) }, variant),
    ).toEqual(["no_title_body"]);
  });

  it("accepts an en-dash separator in the title", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems(
        { title: "123456 – Vintage Lamp", media: imageMedia(3) },
        variant,
      ),
    ).toEqual([]);
  });

  it("flags no_pic when a media-shape payload carries zero images", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp", media: imageMedia(0) }, variant),
    ).toEqual(["no_pic"]);
    // media present but only a non-image (video / 3d model) → still no picture
    expect(
      detectProblems(
        { title: "123456 - Lamp", media: { edges: [{ node: {} }] } },
        variant,
      ),
    ).toEqual(["no_pic"]);
  });

  it("flags low_pic for 1–2 images", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp", media: imageMedia(1) }, variant),
    ).toEqual(["low_pic"]);
    expect(
      detectProblems({ title: "123456 - Lamp", media: imageMedia(2) }, variant),
    ).toEqual(["low_pic"]);
  });

  it("flags nothing for 3+ images", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp", media: imageMedia(3) }, variant),
    ).toEqual([]);
    expect(
      detectProblems({ title: "123456 - Lamp", media: imageMedia(10) }, variant),
    ).toEqual([]);
  });

  it("still buckets from a legacy featuredImage payload", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp", featuredImage: null }, variant),
    ).toEqual(["no_pic"]);
    expect(
      detectProblems({ title: "123456 - Lamp", featuredImage: { url: "x" } }, variant),
    ).toEqual(["low_pic"]);
  });

  it("leaves picture problems unjudged when no image field was fetched", () => {
    const { variant } = cleanProduct();
    expect(
      detectProblems({ title: "123456 - Lamp" }, variant),
    ).toEqual([]);
  });

  it("accumulates every problem, in detection order", () => {
    expect(
      detectProblems({ title: null, media: imageMedia(0) }, { sku: null }),
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
