// Pure decision helpers for background "walk every page" fetch loops.
//
// Shared by the client hooks that auto-paginate against a route action
// (usePaginatedSuggestions on Prep B, the sync-status poller on Admin).
// Kept dependency-free so it runs under the plain `environment: "node"`
// Vitest config alongside the other lib unit tests.
//
// The bug these guard against: an auto-firing effect that only stops on a
// success-shaped payload will re-fire instantly on every failure (401/403/
// error), flooding the server. Callers track a consecutive-failure count and
// space retries out with backoffDelayMs().

// Should another background request fire right now?
// `sessionReady` is the missing precondition in the original hook — never
// auto-walk before the caller actually has a session to authenticate with.
export function shouldAutoLoad({ hasNextPage, nodeCount, cap, fetcherIdle, sessionReady }) {
  return Boolean(hasNextPage) && nodeCount < cap && Boolean(fetcherIdle) && Boolean(sessionReady);
}

// Delay before the next auto attempt, given how many consecutive failures
// have happened. 0 failures -> 0ms (fire immediately, unchanged happy path).
// Then 1s, 2s, 4s, 8s, 16s, ... clamped to capMs.
export function backoffDelayMs(failureCount, { baseMs = 1000, capMs = 30000 } = {}) {
  if (failureCount <= 0) return 0;
  return Math.min(baseMs * 2 ** (failureCount - 1), capMs);
}

// Fold a settled request into the running failure count: bump on failure,
// reset to 0 on success.
export function nextFailureCount(prev, settledWithoutUsableData) {
  return settledWithoutUsableData ? prev + 1 : 0;
}
