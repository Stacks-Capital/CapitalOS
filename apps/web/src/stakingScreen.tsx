import type { ConnectedWallet } from "@stacks-capital/ui";
import { EmptyStateView, Panel, UnsupportedStateView } from "@stacks-capital/ui";
import {
  getStakingRoutes,
  groupByCategory,
  isStakingSignable,
  type StakingCategory,
  type StakingRouteView,
} from "./stakingState.ts";
import type { StacksNetwork } from "@stacks-capital/core";

export type StakingScreenProps = {
  wallet: ConnectedWallet | null;
  signedIn: boolean;
};

type StakingAction = "stake" | "unstake" | "claim";

const CATEGORY_ORDER: StakingCategory[] = ["native_bitcoin", "stx_stacking", "protocol_receipt"];

const CATEGORY_DESCRIPTIONS: Record<StakingCategory, string> = {
  native_bitcoin:
    "Lock L1 Bitcoin via Stacks Proof of Transfer (PoX). This is NOT sBTC DeFi supply — it involves direct Bitcoin consensus lockup.",
  stx_stacking:
    "Delegate STX tokens via liquid stacking protocols like StackingDAO. Receive liquid receipt tokens (e.g. stSTX) redeemable after cooldown.",
  protocol_receipt:
    "Deposit stablecoins or assets into protocol vaults. Receive yield-bearing receipt tokens (e.g. sUSDh). Distinct from staking positions.",
};

function CategorySection({ category, routes }: { category: StakingCategory; routes: StakingRouteView[] }) {
  return (
    <Panel title={routes[0]?.categoryLabel ?? category}>
      <div className="staking-category-section">
        <p className="staking-category-description">{CATEGORY_DESCRIPTIONS[category]}</p>

        {routes.map((route) => (
          <div key={route.id} className="staking-route-card">
            <div className="staking-route-header">
              <span className="staking-route-name">{route.name}</span>
              <span className={`badge ${route.executable ? "badge-success" : "badge-warning"} ${route.categoryBadge}`}>
                {route.capabilityState.toUpperCase()}
              </span>
            </div>

            {/* Asset details */}
            <div className="staking-route-details">
              <div className="staking-detail">
                <span className="staking-detail-label">Input Asset</span>
                <span className="staking-detail-value">{route.assetIn}</span>
              </div>
              {route.receiptAsset && (
                <div className="staking-detail">
                  <span className="staking-detail-label">Receipt Token</span>
                  <span className="staking-detail-value">{route.receiptAsset}</span>
                </div>
              )}
            </div>

            {/* Lockup / Custody / Unbonding disclosure */}
            <div className="staking-disclosure-box">
              <div className="staking-disclosure-row">
                <span className="staking-disclosure-label">Custody Model</span>
                <span className="staking-disclosure-value">{route.custodyDescription}</span>
              </div>
              {route.lockupPeriodBlocks !== null && (
                <div className="staking-disclosure-row">
                  <span className="staking-disclosure-label">Lockup Period</span>
                  <span className="staking-disclosure-value">{route.lockupPeriodBlocks.toLocaleString()} blocks</span>
                </div>
              )}
              {route.unbondingDays !== null && (
                <div className="staking-disclosure-row">
                  <span className="staking-disclosure-label">Unbonding</span>
                  <span className="staking-disclosure-value">{route.unbondingDays} days cooldown</span>
                </div>
              )}
            </div>

            {/* Exchange rate (protocol receipts) */}
            {route.exchangeRate && (
              <div className="staking-exchange-rate">
                <span className="staking-detail-label">Exchange Rate</span>
                <span className="staking-detail-value">
                  {route.exchangeRate.rate}
                  {route.exchangeRate.stale && <span className="badge badge-neutral staking-stale-badge">STALE</span>}
                </span>
                <span className="staking-provenance-source">Source: {route.exchangeRate.source}</span>
              </div>
            )}

            {/* Rewards provenance */}
            <div className="staking-rewards-provenance">
              <span className="staking-detail-label">Yield Provenance</span>
              <span
                className={`badge ${route.rewardsProvenance.confidence === "verified" ? "badge-success" : "badge-neutral"}`}
              >
                {route.rewardsProvenance.confidence.toUpperCase().replace("_", " ")}
              </span>
              <p className="staking-provenance-note">{route.rewardsProvenance.note}</p>
            </div>

            {/* Distinctions */}
            {route.distinctions.length > 0 && (
              <div className="staking-distinctions">
                <strong>Key Distinctions:</strong>
                <ul>
                  {route.distinctions.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Action buttons — disabled when not executable */}
            <div className="staking-actions">
              {(["stake", "unstake", "claim"] as StakingAction[]).map((action) => {
                const { canSign, reason } = isStakingSignable(route);
                return (
                  <button
                    key={action}
                    type="button"
                    className="staking-action-button"
                    disabled={!canSign}
                    title={canSign ? `${action} via ${route.protocol}` : reason}
                    aria-label={`${action} ${route.name}${canSign ? "" : " (unavailable)"}`}
                  >
                    {action.charAt(0).toUpperCase() + action.slice(1)}
                  </button>
                );
              })}
            </div>

            {/* Warning banner when not executable */}
            {!route.executable && (
              <div className="staking-unavailable-banner" role="alert">
                <UnsupportedStateView
                  state={{
                    kind: "unsupported",
                    assetOrProtocol: route.name,
                    reason: route.capabilityReason,
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function StakingScreen({ wallet, signedIn }: StakingScreenProps) {
  const network: StacksNetwork = (wallet?.network as StacksNetwork) || "mainnet";

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Bitcoin Staking">
        <EmptyStateView
          state={{
            kind: "empty",
            instruction: "Connect a wallet and sign in to view staking options.",
          }}
        />
      </Panel>
    );
  }

  const routes = getStakingRoutes(network);
  const grouped = groupByCategory(routes);

  return (
    <>
      {CATEGORY_ORDER.map((category) => {
        const categoryRoutes = grouped.get(category);
        if (!categoryRoutes || categoryRoutes.length === 0) return null;
        return <CategorySection key={category} category={category} routes={categoryRoutes} />;
      })}
    </>
  );
}
