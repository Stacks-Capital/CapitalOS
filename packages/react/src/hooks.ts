import {
  cacheKey,
  type Entry,
  type Market,
  type MarketCapability,
  type Page,
  RESOURCES,
  type Result,
  type Workflow,
} from "@stacks-capital/client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useCapital } from "./context.ts";

const IDLE: Entry<never> = { status: "idle", data: undefined, error: undefined, updatedAt: undefined };

export type QueryOptions = { staleMs?: number; enabled?: boolean };
export type QueryResult<T> = Entry<T> & {
  isLoading: boolean;
  /** Reads again even if the entry is still fresh. */
  refresh: () => Promise<void>;
};

/**
 * Subscribes to one cache entry and keeps it loaded. A null key means there is nothing to read yet,
 * for example a workflow id the caller does not have.
 */
export function useCapitalQuery<T>(
  key: string | null,
  loader: (signal?: AbortSignal) => Promise<T>,
  options: QueryOptions = {},
): QueryResult<T> {
  const { cache } = useCapital();
  const latest = useRef(loader);
  latest.current = loader;

  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => {} : cache.subscribe(key, listener)),
    [cache, key],
  );
  const snapshot = useCallback(() => (key === null ? (IDLE as Entry<T>) : cache.get<T>(key)), [cache, key]);
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot);

  const { staleMs, enabled = true } = options;
  const run = useCallback(
    async (force: boolean) => {
      if (key === null || !enabled) return;
      try {
        await cache.load<T>(key, (signal) => latest.current(signal), {
          force,
          ...(staleMs === undefined ? {} : { staleMs }),
        });
      } catch {
        // The failure is already on the entry, and every subscriber sees it there.
      }
    },
    [cache, key, enabled, staleMs],
  );

  useEffect(() => {
    void run(false);
  }, [run]);

  const refresh = useCallback(() => run(true), [run]);
  return { ...entry, isLoading: entry.status === "loading", refresh };
}

export type PageQuery = QueryOptions & { limit?: number; cursor?: string };

export function useMarkets(options: PageQuery = {}): QueryResult<Page<Market>> {
  const { client, scope } = useCapital();
  const { limit, cursor, ...query } = options;
  const key = cacheKey(scope, RESOURCES.markets, { limit, cursor });
  return useCapitalQuery<Page<Market>>(key, (signal) => client.markets({ limit, cursor, signal }), query);
}

export function useCapabilities(options: PageQuery = {}): QueryResult<Page<MarketCapability>> {
  const { client, scope } = useCapital();
  const { limit, cursor, ...query } = options;
  const key = cacheKey(scope, RESOURCES.capabilities, { limit, cursor });
  return useCapitalQuery<Page<MarketCapability>>(
    key,
    (signal) => client.capabilities({ limit, cursor, signal }),
    query,
  );
}

export function useWorkflow(id: string | null, options: QueryOptions = {}): QueryResult<Result<Workflow>> {
  const { client, scope } = useCapital();
  const key = id === null ? null : cacheKey(scope, RESOURCES.workflow, { id });
  return useCapitalQuery<Result<Workflow>>(key, (signal) => client.workflow(id ?? "", { signal }), options);
}
