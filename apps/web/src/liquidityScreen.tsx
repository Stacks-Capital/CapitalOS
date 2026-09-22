import type { ConnectedWallet } from "@stacks-capital/ui";
import { EmptyStateView, Panel, ResponsiveTable, StateNote, UnsupportedStateView } from "@stacks-capital/ui";
import {
  ALLOWED_POOL_PRINCIPALS,
  buildPoolView,
  type calculateImpermanentLoss,
  ilScenarios,
} from "./liquidityState.ts";
import type { StacksNetwork } from "@stacks-capital/core";

export type LiquidityScreenProps = {
  wallet: ConnectedWallet | null;
  signedIn: boolean;
};

export function LiquidityScreen({ wallet, signedIn }: LiquidityScreenProps) {
  const network: StacksNetwork = (wallet?.network as StacksNetwork) || "mainnet";

  // Build the pool view — currently always unavailable (B6)
  const poolPrincipal = ALLOWED_POOL_PRINCIPALS.length > 0 ? ALLOWED_POOL_PRINCIPALS[0] : null;
  const pool = buildPoolView(poolPrincipal ?? null, network);
  const ilResults = ilScenarios();

  // Sign-in gate
  if (!signedIn || wallet === null) {
    return (
      <Panel title="Liquidity Provision">
        <EmptyStateView
          state={{
            kind: "empty",
            instruction: "Connect a wallet and sign in to manage your liquidity positions.",
          }}
        />
      </Panel>
    );
  }

  // Capability gate — currently all LP actions are unavailable (B6)
  if (!pool.executable) {
    return (
      <>
        {/* Pool Information Card */}
        <Panel title="Pool Overview">
          <div className="lp-pool-overview">
            <div className="lp-pool-pair">
              <span className="lp-pair-label">
                {pool.pair.x.symbol} / {pool.pair.y.symbol}
              </span>
              <span className="badge badge-neutral lp-protocol-badge">{pool.protocol.toUpperCase()} DLMM</span>
            </div>
            <div className="lp-pool-stats">
              <div className="lp-stat">
                <span className="lp-stat-label">Fee Tier</span>
                <span className="lp-stat-value">{(pool.feeTierBps / 100).toFixed(2)}%</span>
              </div>
              <div className="lp-stat">
                <span className="lp-stat-label">Active Price</span>
                <span className="lp-stat-value">{pool.activePriceDisplay ?? "—"}</span>
              </div>
              <div className="lp-stat">
                <span className="lp-stat-label">TVL</span>
                <span className="lp-stat-value">{pool.tvlUsd ?? "—"}</span>
              </div>
              <div className="lp-stat">
                <span className="lp-stat-label">Status</span>
                <span className="badge badge-warning">{pool.capabilityState.toUpperCase()}</span>
              </div>
            </div>
          </div>
        </Panel>

        {/* Range / Bin Disclosure */}
        <Panel title="Range & Bin Configuration">
          <div className="lp-range-disclosure">
            <div className="lp-range-bar">
              <div className="lp-range-label">Lower Bound</div>
              <div className="lp-range-indicator">
                <div className="lp-range-track">
                  <div className="lp-range-empty" />
                </div>
              </div>
              <div className="lp-range-label">Upper Bound</div>
            </div>
            <div className="lp-range-values">
              <span>{pool.rangeLower ?? "Not set"}</span>
              <span className="lp-active-bin-label">
                Bin: {pool.activeBinId ?? "—"} · Step: {pool.binStepBps ?? "—"} bps
              </span>
              <span>{pool.rangeUpper ?? "Not set"}</span>
            </div>
            <StateNote state={{ kind: "unavailable", reason: pool.capabilityReason }} onRetry={() => {}} />
          </div>
        </Panel>

        {/* IL Exposure Calculator */}
        <Panel title="Impermanent Loss Exposure">
          <div className="lp-il-calculator">
            <p className="lp-il-disclosure">{ilResults[0]?.formulaDisclosure}</p>
            <div className="lp-il-scenarios">
              <ResponsiveTable
                columns={[
                  {
                    header: "Price Δ",
                    cell: (r: { pctKey: string; estimate: ReturnType<typeof calculateImpermanentLoss> }) => (
                      <span>
                        {r.estimate.priceChangePercent > 0 ? "+" : ""}
                        {r.estimate.priceChangePercent}%
                      </span>
                    ),
                  },
                  {
                    header: "IL",
                    cell: (r: { pctKey: string; estimate: ReturnType<typeof calculateImpermanentLoss> }) => (
                      <span className={r.estimate.ilPercent < -5 ? "text-danger" : "text-warning"}>
                        {r.estimate.ilPercent.toFixed(2)}%
                      </span>
                    ),
                  },
                ]}
                rows={ilResults.map((estimate) => ({ pctKey: String(estimate.priceChangePercent), estimate }))}
                rowKey={(r) => r.pctKey}
              />
            </div>
            <div className="lp-il-limitations">
              <strong>Limitations:</strong>
              <ul>
                {(ilResults[0]?.limitations ?? []).map((lim) => (
                  <li key={lim}>{lim}</li>
                ))}
              </ul>
            </div>
          </div>
        </Panel>

        {/* Exit Liquidity */}
        <Panel title="Exit Liquidity & Depth">
          <div className="lp-exit-info">
            <div className="lp-stat">
              <span className="lp-stat-label">Reserve {pool.pair.x.symbol}</span>
              <span className="lp-stat-value">{pool.exitLiquidity.reserveX}</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-label">Reserve {pool.pair.y.symbol}</span>
              <span className="lp-stat-value">{pool.exitLiquidity.reserveY}</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-label">Lock Type</span>
              <span className="lp-stat-value">{pool.exitLiquidity.lockType}</span>
            </div>
            <p className="lp-exit-depth">{pool.exitLiquidity.depthDescription}</p>
          </div>
        </Panel>

        {/* Unavailable actions */}
        <Panel title="Actions">
          <UnsupportedStateView
            state={{
              kind: "unsupported",
              assetOrProtocol: "Bitflow Liquidity Pools",
              reason: pool.capabilityReason,
            }}
          />
        </Panel>
      </>
    );
  }

  // Future: when pools are allowlisted, render add/remove/claim tabs with full workflow
  return (
    <Panel title="Liquidity Provision">
      <EmptyStateView
        state={{
          kind: "empty",
          instruction: "No allowlisted pools are available for liquidity provision.",
        }}
      />
    </Panel>
  );
}
