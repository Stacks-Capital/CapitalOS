import type { StacksNetwork } from "@stacks-capital/core";
import type { WalletId } from "@stacks-capital/wallets";

export const NAV_TABS = [
  "Overview",
  "Deposit BTC",
  "Earn",
  "Borrow",
  "Swap",
  "Liquidity",
  "Staking",
  "Positions",
  "Risk",
  "Activity",
] as const;

export type NavTab = (typeof NAV_TABS)[number] | "Portfolio";

export const STORAGE_TAB_KEY = "stacks-capital:active_tab";
export const STORAGE_SESSION_PREFIX = "stacks-capital:session:";

export function getInitialTab(urlSearch?: string, storage?: { getItem: (k: string) => string | null }): NavTab {
  try {
    const search = urlSearch ?? (typeof window !== "undefined" ? window.location.search : "");
    const param = new URLSearchParams(search).get("tab");
    if (param && (NAV_TABS.includes(param as any) || param === "Portfolio")) return param as NavTab;
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    const stored = store?.getItem(STORAGE_TAB_KEY);
    if (stored && (NAV_TABS.includes(stored as any) || stored === "Portfolio")) return stored as NavTab;
  } catch {
    // Storage unavailable in private browsing
  }
  return "Overview";
}

export function getInitialSession(
  network: StacksNetwork,
  storage?: { getItem: (k: string) => string | null },
): { address: string; token: string; walletId: WalletId } | null {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    const raw = store?.getItem(`${STORAGE_SESSION_PREFIX}${network}`);
    if (raw) return JSON.parse(raw);
  } catch {
    // Ignore storage read failures
  }
  return null;
}
