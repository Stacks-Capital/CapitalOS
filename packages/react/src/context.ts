import { type Cache, type CapitalClient, createCache, sameScope, type Scope } from "@stacks-capital/client";
import { createContext, createElement, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";

export type CapitalValue = { client: CapitalClient; cache: Cache; scope: Scope };

const CapitalContext = createContext<CapitalValue | null>(null);

export type CapitalProviderProps = {
  client: CapitalClient;
  /** The connected wallet address, or null when nobody is signed in. */
  address?: string | null;
  /** Optional tenant identifier override (defaults to client.clientId). */
  tenantId?: string | null;
  /** Share one cache across providers, or leave it out to get a fresh one. */
  cache?: Cache;
  children?: ReactNode;
};

export function CapitalProvider(props: CapitalProviderProps) {
  const fallback = useMemo(() => createCache(), []);
  const cache = props.cache ?? fallback;
  const network = props.client.network;
  const address = props.address ?? null;
  const tenantId = props.tenantId !== undefined ? props.tenantId : (props.client.clientId ?? null);

  const scope = useMemo<Scope>(() => ({ network, address, tenantId }), [network, address, tenantId]);
  const previous = useRef<Scope | null>(null);

  // Switching wallet or network drops everything the old one cached, quotes included (page 01, WF-01).
  useEffect(() => {
    if (previous.current !== null && !sameScope(previous.current, scope)) cache.keepScope(scope);
    previous.current = scope;
  }, [cache, scope]);

  const value = useMemo<CapitalValue>(() => ({ client: props.client, cache, scope }), [props.client, cache, scope]);
  return createElement(CapitalContext.Provider, { value }, props.children);
}

export function useCapital(): CapitalValue {
  const value = useContext(CapitalContext);
  if (value === null) throw new Error("Capital OS hooks must be used inside a CapitalProvider");
  return value;
}
