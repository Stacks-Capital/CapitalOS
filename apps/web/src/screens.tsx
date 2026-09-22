import { useCapabilities, useEarnPerformance, useMarkets, usePortfolio, useWorkflow } from "@stacks-capital/react";
import { useState } from "react";
import {
  Amount,
  EmptyStateView,
  LoadingStateView,
  Panel,
  panelState,
  PartialStateView,
  ResponsiveTable,
  StateNote,
  UNAVAILABLE,
  Unavailable,
} from "@stacks-capital/ui";

export function Portfolio({
  address,
  signedIn,
  onNavigate,
}: {
  address: string | null;
  signedIn: boolean;
  onNavigate?: (tab: string, opts?: { marketId?: string; action?: string }) => void;
}) {
  const markets = useMarkets({ limit: 100 });
  const portfolio = usePortfolio({ enabled: signedIn });
  const earnPerformance = useEarnPerformance({ enabled: signedIn });

  if (address === null) {
    return (
      <Panel title="Portfolio & Holdings">
        <EmptyStateView state={{ kind: "empty", instruction: "Connect a wallet to see what it holds." }} />
      </Panel>
    );
  }

  if (!signedIn) {
    return (
      <Panel title="Portfolio & Holdings">
        <Unavailable reason={UNAVAILABLE.balances} />
        <EmptyStateView
          state={{
            kind: "empty",
            instruction: "Sign in to see your positions and portfolio accounting.",
          }}
        />
      </Panel>
    );
  }

  const marketsState = panelState(markets, markets.data?.context);
  const portfolioState = panelState(portfolio, portfolio.data?.context);
  const performanceState = panelState(earnPerformance, earnPerformance.data?.context);

  if (portfolioState.kind === "loading") {
    return (
      <Panel title="Portfolio & Holdings">
        <LoadingStateView
          state={{
            kind: "loading",
            what: "your portfolio accounting and yield",
            canRetry: true,
            onRetry: () => {
              void portfolio.refresh();
              void earnPerformance.refresh();
            },
          }}
        />
      </Panel>
    );
  }

  const data = portfolio.data?.data;
  const coverage = data?.coverage;
  const perfItems = earnPerformance.data?.data.items ?? [];
  const entries = data?.entries ?? [];

  return (
    <>
      <StateNote
        state={portfolioState}
        onRetry={() => {
          void portfolio.refresh();
          void earnPerformance.refresh();
        }}
      />

      {/* KPI Cards: Assets, Debt, Net Worth, Coverage */}
      {data && (
        <section className="portfolio-kpi-grid" aria-label="Portfolio Summary">
          <div className="kpi-card">
            <span className="kpi-title">Gross Assets</span>
            <span className="kpi-value">
              {data.grossAssetsUsd ? `$${Number(data.grossAssetsUsd).toLocaleString()}` : "N/A"}
            </span>
            <span className="kpi-subtext">
              {data.byCategory["wallet"]?.count ?? 0} wallet +{" "}
              {(data.byCategory["supplied"]?.count ?? 0) + (data.byCategory["collateral"]?.count ?? 0)} protocol
            </span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Debt Liabilities</span>
            <span className="kpi-value debt">
              {data.grossDebtUsd ? `$${Number(data.grossDebtUsd).toLocaleString()}` : "$0.00"}
            </span>
            <span className="kpi-subtext">
              {data.byCategory["debt"]?.count ?? 0} debt{" "}
              {data.byCategory["debt"]?.count === 1 ? "position" : "positions"}
            </span>
          </div>
          <div className="kpi-card highlight">
            <span className="kpi-title">Net Subtotal</span>
            <span className="kpi-value">
              {data.netWorthUsd ? `$${Number(data.netWorthUsd).toLocaleString()}` : "N/A"}
            </span>
            <span className="kpi-subtext">Verified Assets − Debt</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Valuation Coverage</span>
            <span className="kpi-value">
              {coverage?.coverageBps !== null && coverage?.coverageBps !== undefined
                ? `${(coverage.coverageBps / 100).toFixed(1)}%`
                : "100%"}
            </span>
            <span className="kpi-subtext">
              {coverage?.isComplete ? "Fully valued" : `${coverage?.unvaluedAssets.length ?? 0} unvalued`}
            </span>
          </div>
        </section>
      )}

      {/* Partial State Disclosure if unvalued positions exist */}
      {coverage && !coverage.isComplete && (
        <aside className="panel-notice panel-notice-warn" aria-label="Coverage Warning">
          <PartialStateView
            state={{
              kind: "partial",
              verifiedSubtotal: data?.netWorthUsd ? `$${Number(data.netWorthUsd).toLocaleString()} USD` : "N/A",
              excludedPositions: coverage.unvaluedAssets.map((item) => ({
                name: item.assetId,
                reason: item.reason || "Oracle price feed unverified or missing",
              })),
              notice: "Net subtotal reflects only assets with verified price feeds.",
            }}
          />
        </aside>
      )}

      {/* Capital Deployment by Category */}
      {data && Object.keys(data.byCategory).length > 0 && (
        <Panel title="Capital Deployment by Category">
          <div className="category-pill-grid">
            {Object.entries(data.byCategory).map(([catKey, catVal]) => (
              <div key={catKey} className="category-pill-card">
                <span className="category-pill-name">{catKey.toUpperCase()}</span>
                <span className="category-pill-usd">
                  {catVal.totalUsd ? `$${Number(catVal.totalUsd).toLocaleString()}` : "Unvalued"}
                </span>
                <span className="category-pill-count">
                  {catVal.count} {catVal.count === 1 ? "position" : "positions"}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Earned Yield & Performance Attribution (I27) */}
      {perfItems.length > 0 && (
        <Panel title="Earned Yield & Performance Attribution">
          <StateNote state={performanceState} onRetry={() => void earnPerformance.refresh()} />
          <div className="performance-grid">
            {perfItems.map((item) => (
              <div key={item.marketId} className="performance-card">
                <div className="performance-header">
                  <strong>{item.marketId}</strong>
                  <span className="badge badge-info">{item.assetId}</span>
                </div>
                <div className="performance-body">
                  <p>
                    <strong>Realized Earnings:</strong> {item.realizedEarnings.amount} {item.realizedEarnings.assetId}
                    {item.realizedEarnings.usdValue && (
                      <span className="muted"> (${Number(item.realizedEarnings.usdValue).toLocaleString()})</span>
                    )}
                    <span className="muted"> (closed gains + claimed rewards)</span>
                  </p>
                  <p>
                    <strong>Accrued Yield Estimate:</strong> {item.accruedEstimate.amount}{" "}
                    {item.accruedEstimate.assetId}
                    {item.accruedEstimate.usdValue && (
                      <span className="muted"> (${Number(item.accruedEstimate.usdValue).toLocaleString()})</span>
                    )}
                    <span className="muted"> (share appreciation + accruals)</span>
                  </p>
                  <p>
                    <strong>30-Day Forward Projection:</strong>{" "}
                    {item.forward30dProjection.isProjectionAvailable ? (
                      <span className="success-text">
                        {item.forward30dProjection.projected30dAmount} {item.assetId}
                        {item.forward30dProjection.rateUsedBps && (
                          <span className="muted">
                            {" "}
                            (at {(Number(item.forward30dProjection.rateUsedBps) / 100).toFixed(2)}% APY)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="muted">
                        Unavailable: {item.forward30dProjection.unavailableReason ?? "Rate unverified"}
                      </span>
                    )}
                  </p>
                  {item.attribution.hasUnattributedInflow && (
                    <aside className="panel-notice panel-notice-warn">
                      <p className="warn">
                        <strong>Notice:</strong> Balance increase of {item.attribution.unattributedInflow} has no
                        cash-flow attribution; classified as unattributed inflow and excluded from earned yield.
                      </p>
                    </aside>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Holdings & Positions Table with Non-Double Counting Receipt Disclosure */}
      <Panel
        title="Holdings & Protocol Positions"
        action={
          onNavigate && (
            <button type="button" onClick={() => onNavigate("Positions")}>
              Manage Positions
            </button>
          )
        }
      >
        {entries.length === 0 ? (
          <p className="muted">No protocol positions or wallet holdings recorded.</p>
        ) : (
          <ResponsiveTable
            rows={entries}
            rowKey={(e) => `${e.category}-${e.assetId}-${e.marketId ?? ""}-${e.id}`}
            columns={[
              { header: "Category", cell: (e) => <span className="badge">{e.category}</span> },
              {
                header: "Asset / Market",
                cell: (e) => (
                  <div>
                    <strong>{e.assetId}</strong>
                    {e.marketId && <span className="muted"> ({e.marketId})</span>}
                  </div>
                ),
              },
              {
                header: "Quantity",
                cell: (e) => <Amount quantity={e.quantity} unknown="unknown" />,
              },
              {
                header: "Status",
                cell: (e) => (
                  <span className={`badge ${e.stale ? "badge-warning" : "badge-success"}`}>
                    {e.stale ? "Stale reading" : "Verified"}
                  </span>
                ),
              },
              {
                header: "Net Worth Accounting",
                cell: (e) =>
                  e.countsTowardTotal ? (
                    <span className="badge badge-success">Counted</span>
                  ) : (
                    <div>
                      <span className="badge badge-neutral">Receipt claim</span>
                      <div className="muted font-small">
                        {e.isReceipt ? "Excluded to prevent double-counting" : "Excluded from net total"}
                      </div>
                    </div>
                  ),
              },
            ]}
          />
        )}
      </Panel>

      {/* Available markets table */}
      <Panel
        title="Available markets"
        action={
          <button type="button" onClick={() => void markets.refresh()}>
            Refresh
          </button>
        }
      >
        <StateNote state={marketsState} onRetry={() => void markets.refresh()} />
        <ul>
          {(markets.data?.items ?? []).map((market) => (
            <li key={market.id}>
              <strong>{market.id}</strong>{" "}
              <span className="muted">
                {market.capabilities.filter((capability) => capability.state === "enabled").length} of{" "}
                {market.capabilities.length} actions enabled
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

export function Markets() {
  const capabilities = useCapabilities({ limit: 100 });
  const state = panelState(capabilities, capabilities.data?.context);
  return (
    <Panel title="Capabilities">
      <StateNote state={state} onRetry={() => void capabilities.refresh()} />
      <ResponsiveTable
        rows={capabilities.data?.items ?? []}
        rowKey={(capability) => `${capability.marketId}/${capability.action}`}
        columns={[
          { header: "Market", cell: (capability) => capability.marketId },
          { header: "Action", cell: (capability) => capability.action },
          { header: "State", cell: (capability) => capability.state },
          { header: "Why", cell: (capability) => <span className="muted">{capability.reason}</span> },
        ]}
      />
    </Panel>
  );
}

export function Activity({ signedIn }: { signedIn: boolean }) {
  const [input, setInput] = useState("");
  const [id, setId] = useState<string | null>(null);
  const workflow = useWorkflow(id);
  const state = panelState(workflow, workflow.data?.context);

  return (
    <Panel title="Workflow">
      {signedIn ? null : <p className="muted">Sign in to read your own workflows.</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setId(input.trim() === "" ? null : input.trim());
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="wf_…"
          aria-label="Workflow id"
        />
        <button type="submit">Look up</button>
      </form>
      {id === null ? null : <StateNote state={state} onRetry={() => void workflow.refresh()} />}
      {workflow.data === undefined ? null : (
        <>
          <p>
            <strong>{workflow.data.data.state}</strong> next: {workflow.data.data.nextAction}
          </p>
          <ol>
            {workflow.data.data.transitions.map((move) => (
              <li key={move.sequence}>
                {move.from} to {move.to}: {move.reason} <span className="muted">({move.actor})</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}
