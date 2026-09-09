// Cursor-paginated, store-wide suggestion list for the Prep B editor
// (vendor / product-type / tag). Shared at the page level rather than per row:
// these values aren't per-product, so every ProductRow sees the same loaded
// pages.
//
// Extracted from app/routes/app.prepb.jsx so it can be unit-tested without the
// route module's import graph (Prisma, shopify.server, TipTap, ...).
//
// It walks every page in the background so typing can search the whole store,
// not just what's been loaded. The walk now:
//   - never starts until there's a real SKU session to authenticate with
//     (previously it fired `suggest-more` with an empty sessionId on mount and
//     span on the resulting 401), and
//   - backs off exponentially on failure instead of re-firing instantly, so a
//     dead session / rejected Shopify token can't flood the server.

import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { shouldAutoLoad, backoffDelayMs, nextFailureCount } from "../lib/autoPaginate.js";

// Past this many loaded values the background walk stops and "Load more"
// becomes a manual fallback (huge stores).
export const SUGGEST_AUTOLOAD_CAP = 2000;

export function usePaginatedSuggestions(field, initialPage, sessionId) {
  const fetcher = useFetcher();
  const submitFetcher = fetcher.submit; // stable across renders in react-router v7

  const [state, setState] = useState({
    nodes: initialPage.nodes,
    hasNextPage: initialPage.hasNextPage,
    endCursor: initialPage.endCursor,
    failures: 0,
  });

  // A submit-generation counter, not a `fetcher.state` edge, drives settle
  // detection: React can coalesce idle -> submitting -> idle into no observable
  // change when a request resolves fast, which would strand the walk. `genRef`
  // bumps on every submit; the settle effect folds in exactly one result per
  // generation once the fetcher is idle again.
  const genRef          = useRef(0);
  const processedGenRef = useRef(0);
  const retryTimerRef   = useRef(null);

  const sessionReady = Boolean(sessionId);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current != null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const submitPage = useCallback(
    (after) => {
      genRef.current += 1;
      submitFetcher(
        { intent: "suggest-more", field, after: after ?? "", sessionId: sessionId ?? "" },
        { method: "POST" },
      );
    },
    [submitFetcher, field, sessionId],
  );

  const pending = genRef.current !== processedGenRef.current;

  // Fold each settled request into `state` — a success merges the page, a
  // failure just bumps `failures`. Either way it writes state, so the auto-walk
  // effect re-runs on the *next* commit with fresh data (never mid-settle with
  // a stale `hasNextPage`).
  useEffect(() => {
    if (fetcher.state !== "idle") return; // still in flight
    if (genRef.current === processedGenRef.current) return; // nothing new settled
    processedGenRef.current = genRef.current;

    const result = fetcher.data?.suggestMore;
    const ok = Boolean(result) && result.field === field;
    setState((prev) => {
      if (ok) {
        return {
          nodes: [...new Set([...prev.nodes, ...result.nodes])],
          hasNextPage: result.hasNextPage,
          endCursor: result.endCursor,
          failures: 0,
        };
      }
      return { ...prev, failures: nextFailureCount(prev.failures, true) };
    });
  }, [fetcher.state, fetcher.data, field]);

  // Background auto-walk. Deps are `state` / `sessionReady` / `pending` — it
  // re-runs after a settle has been folded in, so it always sees current data.
  // First attempt fires synchronously; after failures the next one waits
  // backoffDelayMs().
  useEffect(() => {
    if (pending) return;

    const canLoad = shouldAutoLoad({
      hasNextPage: state.hasNextPage,
      nodeCount: state.nodes.length,
      cap: SUGGEST_AUTOLOAD_CAP,
      fetcherIdle: true, // `pending` false above implies nothing in flight
      sessionReady,
    });
    if (!canLoad) {
      clearRetry();
      return;
    }
    if (retryTimerRef.current != null) return;

    const delay = backoffDelayMs(state.failures);
    if (delay === 0) {
      submitPage(state.endCursor);
      return;
    }
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      submitPage(state.endCursor);
    }, delay);
    return clearRetry;
  }, [
    pending,
    state.hasNextPage,
    state.nodes.length,
    state.endCursor,
    state.failures,
    sessionReady,
    submitPage,
    clearRetry,
  ]);

  // Drop any pending retry when the component unmounts.
  useEffect(() => clearRetry, [clearRetry]);

  // Manual "Load more" — an explicit user retry: clear the backoff, go now.
  function loadMore() {
    if (!state.hasNextPage || fetcher.state !== "idle") return;
    clearRetry();
    setState((prev) => ({ ...prev, failures: 0 }));
    submitPage(state.endCursor);
  }

  return {
    nodes: state.nodes,
    hasNextPage: state.hasNextPage,
    loading: fetcher.state !== "idle",
    loadMore,
  };
}
