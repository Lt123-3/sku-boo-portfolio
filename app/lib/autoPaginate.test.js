import { describe, it, expect } from "vitest";
import { shouldAutoLoad, backoffDelayMs, nextFailureCount } from "./autoPaginate.js";

const base = {
  hasNextPage: true,
  nodeCount: 10,
  cap: 2000,
  fetcherIdle: true,
  sessionReady: true,
};

describe("shouldAutoLoad", () => {
  it("is true when every condition is met", () => {
    expect(shouldAutoLoad(base)).toBe(true);
  });

  it("is false once there is no next page", () => {
    expect(shouldAutoLoad({ ...base, hasNextPage: false })).toBe(false);
  });

  it("is false at or past the node cap", () => {
    expect(shouldAutoLoad({ ...base, nodeCount: 2000 })).toBe(false);
    expect(shouldAutoLoad({ ...base, nodeCount: 2500 })).toBe(false);
  });

  it("is false while a request is in flight", () => {
    expect(shouldAutoLoad({ ...base, fetcherIdle: false })).toBe(false);
  });

  it("is false before the session is ready — the gap that let the old loop start", () => {
    expect(shouldAutoLoad({ ...base, sessionReady: false })).toBe(false);
  });

  it("coerces loosely-typed flags", () => {
    expect(shouldAutoLoad({ ...base, hasNextPage: 1, fetcherIdle: 1, sessionReady: "abc" })).toBe(true);
    expect(shouldAutoLoad({ ...base, sessionReady: "" })).toBe(false);
    expect(shouldAutoLoad({ ...base, hasNextPage: null })).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("fires immediately with no failures", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-3)).toBe(0);
  });

  it("doubles from the base delay per consecutive failure", () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(5)).toBe(16000);
  });

  it("clamps to the cap for sustained failure", () => {
    expect(backoffDelayMs(6)).toBe(30000);
    expect(backoffDelayMs(10)).toBe(30000);
    expect(backoffDelayMs(100)).toBe(30000);
  });

  it("honours custom base and cap", () => {
    expect(backoffDelayMs(1, { baseMs: 500, capMs: 5000 })).toBe(500);
    expect(backoffDelayMs(4, { baseMs: 500, capMs: 5000 })).toBe(4000);
    expect(backoffDelayMs(5, { baseMs: 500, capMs: 5000 })).toBe(5000);
  });
});

describe("nextFailureCount", () => {
  it("increments on a failed settle", () => {
    expect(nextFailureCount(0, true)).toBe(1);
    expect(nextFailureCount(4, true)).toBe(5);
  });

  it("resets on a successful settle", () => {
    expect(nextFailureCount(7, false)).toBe(0);
    expect(nextFailureCount(0, false)).toBe(0);
  });
});
