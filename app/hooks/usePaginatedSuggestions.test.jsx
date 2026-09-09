// @vitest-environment jsdom
/* eslint-disable react/prop-types -- test-only probe component */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { usePaginatedSuggestions } from "./usePaginatedSuggestions.js";

// The hook needs router context for useFetcher, plus an `action` we control.
// renderHook + createRoutesStub don't compose (the stub renders its own tree),
// so a tiny probe component calls the hook and stashes its return value.
let latest;
function Probe({ field = "vendor", initialPage, sessionId }) {
  latest = usePaginatedSuggestions(field, initialPage, sessionId);
  return null;
}

let actionImpl;
const actionSpy = vi.fn((args) => actionImpl(args));

function mountProbe(props) {
  const Stub = createRoutesStub([
    { path: "/", Component: () => <Probe {...props} />, action: actionSpy },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

const json = (data) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

// What the route action returns on catch / auth failure (app.prepb.jsx:251 &
// :391) — a body with no `suggestMore`. The hook must treat this as a failure.
const failResponse = () => json({ suggestMoreError: "Unauthorized" });

const pageWithNext = () => ({ nodes: [], hasNextPage: true, endCursor: "c0" });

// Advance fake timers and let the router/fetcher promises settle.
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  actionSpy.mockClear();
  actionImpl = failResponse;
  latest = undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePaginatedSuggestions", () => {
  it("does not auto-load until a session id is present", async () => {
    mountProbe({ initialPage: pageWithNext(), sessionId: "" });
    await tick(60_000);
    expect(actionSpy).not.toHaveBeenCalled();
  });

  it("stops the tight loop: a persistently failing action retries on a backoff, not per tick", async () => {
    mountProbe({ initialPage: pageWithNext(), sessionId: "s1" });

    await tick(); // first attempt fires synchronously (backoff 0)
    expect(actionSpy).toHaveBeenCalledTimes(1);

    await tick(500); // still inside the first ~1s backoff window
    expect(actionSpy).toHaveBeenCalledTimes(1);

    await tick(700); // ~1.2s elapsed -> first backoff done
    expect(actionSpy).toHaveBeenCalledTimes(2);

    await tick(60_000); // a full minute more
    // Old code: bounded only by network RTT (hundreds/sec). New: attempts at
    // roughly 0s, 1s, 3s, 7s, 15s, 31s -> a handful.
    expect(actionSpy.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("treats a hard 401 response body as a failure too", async () => {
    actionImpl = () => new Response("Unauthorized", { status: 401 });
    mountProbe({ initialPage: pageWithNext(), sessionId: "s1" });

    await tick();
    expect(actionSpy).toHaveBeenCalledTimes(1);

    await tick(1500);
    expect(actionSpy).toHaveBeenCalledTimes(2); // backed off, then retried once

    await tick(60_000);
    expect(actionSpy.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("merges a successful page and then stops walking", async () => {
    actionImpl = () =>
      json({
        suggestMore: { field: "vendor", nodes: ["Acme", "Globex"], hasNextPage: false, endCursor: null },
      });

    mountProbe({ initialPage: pageWithNext(), sessionId: "s1" });
    await tick();

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(latest.nodes).toEqual(["Acme", "Globex"]);
    expect(latest.hasNextPage).toBe(false);

    await tick(60_000);
    expect(actionSpy).toHaveBeenCalledTimes(1); // no further walking
  });

  it("recovers without a reload: a success after failures folds in and stops the walk", async () => {
    let calls = 0;
    actionImpl = () => {
      calls += 1;
      return calls <= 2
        ? failResponse()
        : json({ suggestMore: { field: "vendor", nodes: ["Acme"], hasNextPage: false, endCursor: null } });
    };

    mountProbe({ initialPage: pageWithNext(), sessionId: "s1" });

    // Pump fake time in chunks, letting each settle -> reschedule -> fire cycle
    // complete, until the successful page lands.
    for (let i = 0; i < 30 && latest.nodes.length === 0; i++) {
      await tick(5000);
    }

    expect(latest.nodes).toEqual(["Acme"]);
    expect(latest.hasNextPage).toBe(false);
    const total = actionSpy.mock.calls.length;
    expect(total).toBeGreaterThanOrEqual(3); // 2 failures + at least one success

    await tick(60_000);
    expect(actionSpy.mock.calls.length).toBe(total); // walk stopped after the successful last page
  });

  it("manual loadMore() clears the backoff and retries immediately", async () => {
    mountProbe({ initialPage: pageWithNext(), sessionId: "s1" });

    await tick(); // attempt 1 -> fail, retry scheduled ~1s out
    expect(actionSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest.loadMore();
    });
    await tick(); // loadMore submits straight away, no timer wait
    expect(actionSpy).toHaveBeenCalledTimes(2);
  });
});
