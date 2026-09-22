import type { ConnectedWallet } from "@stacks-capital/ui";
import { useCapabilities, usePortfolio, usePositions } from "@stacks-capital/react";
import {
  Amount,
  EmptyStateView,
  LoadingStateView,
  Panel,
  panelState,
  ResponsiveTable,
  StateNote,
} from "@stacks-capital/ui";

export type PositionsScreenProps = {
  wallet: ConnectedWallet | null;
  signedIn: boolean;
  onNavigate?: (tab: string, opts?: { marketId?: string; action?: string }) => void;
};

export function PositionsScreen({ wallet, signedIn, onNavigate }: PositionsScreenProps) {
  const positions = usePositions({ enabled: signedIn });
  const portfolio = usePortfolio({ enabled: signedIn });
  const capabilities = useCapabilities({ limit: 100 });

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Verified positions">
        <EmptyStateView
          state={{
            kind: "empty",
            instruction: "Connect a wallet and sign in to view and manage your positions.",
          }}
        />
      </Panel>
    );
  }

  const positionsState = panelState(positions, positions.data?.context);
  const portfolioState = panelState(portfolio, portfolio.data?.context);

  if (positionsState.kind === "loading" || portfolioState.kind === "loading") {
    return (
      <Panel title="Verified positions">
        <LoadingStateView
          state={{
            kind: "loading",
            what: "your verified positions and accounting",
            canRetry: true,
            onRetry: () => {
              void positions.refresh();
              void portfolio.refresh();
            },
          }}
        />
      </Panel>
    );
  }

  const items = positions.data?.data.items ?? [];
  const portfolioData = portfolio.data?.data;
  const coverage = portfolioData?.coverage;

  const suppliedPositions = items.filter((p) => p.kind === "supplied");
  const collateralPositions = items.filter((p) => p.kind === "collateral");
  const debtPositions = items.filter((p) => p.kind === "debt");
  const receiptEntries = (portfolioData?.entries ?? []).filter((e) => e.isReceipt || !e.countsTowardTotal);

  const caps = capabilities.data?.items ?? [];
  const isActionAllowed = (marketId: string, action: string) => {
    const match = caps.find((c) => c.marketId === marketId && c.action === action);
    return match ? match.state === "enabled" : true;
  };

  return (
    <>
      <StateNote
        state={positionsState}
        onRetry={() => {
          void positions.refresh();
          void portfolio.refresh();
        }}
      />

      {/* KPI & Valuation Coverage Header */}
      {portfolioData && (
        <section className="portfolio-kpi-grid" aria-label="Portfolio Summary">
          <div className="kpi-card">
            <span className="kpi-title">Gross Assets</span>
            <span className="kpi-value">
              {portfolioData.grossAssetsUsd ? `$${Number(portfolioData.grossAssetsUsd).toLocaleString()}` : "N/A"}
            </span>
            <span className="kpi-subtext">
              {portfolioData.byCategory["wallet"]?.count ?? 0} wallet +{" "}
              {(portfolioData.byCategory["supplied"]?.count ?? 0) +
                (portfolioData.byCategory["collateral"]?.count ?? 0)}{" "}
              protocol
            </span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Debt Liabilities</span>
            <span className="kpi-value debt">
              {portfolioData.grossDebtUsd ? `$${Number(portfolioData.grossDebtUsd).toLocaleString()}` : "$0.00"}
            </span>
            <span className="kpi-subtext">
              {debtPositions.length} active {debtPositions.length === 1 ? "liability" : "liabilities"}
            </span>
          </div>
          <div className="kpi-card highlight">
            <span className="kpi-title">Net Subtotal</span>
            <span className="kpi-value">
              {portfolioData.netWorthUsd ? `$${Number(portfolioData.netWorthUsd).toLocaleString()}` : "N/A"}
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

      {/* Credit & Collateral Health Summary */}
      {(collateralPositions.length > 0 || debtPositions.length > 0) && (
        <Panel title="Credit Health & Safety Buffers">
          <div className="health-card-grid">
            <div className="health-card">
              <span className="health-card-label">Collateral Backing</span>
              <span className="health-card-value">
                {portfolioData?.byCategory["collateral"]?.totalUsd
                  ? `$${Number(portfolioData.byCategory["collateral"].totalUsd).toLocaleString()}`
                  : `${collateralPositions.length} position(s)`}
              </span>
              <span className="health-card-subtext">
                {collateralPositions.map((p) => `${p.quantity ?? "0"} ${p.assetId}`).join(", ") || "No collateral"}
              </span>
            </div>
            <div className="health-card">
              <span className="health-card-label">Outstanding Liabilities</span>
              <span className="health-card-value danger-text">
                {portfolioData?.grossDebtUsd ? `$${Number(portfolioData.grossDebtUsd).toLocaleString()}` : "$0.00"}
              </span>
              <span className="health-card-subtext">
                {debtPositions.map((p) => `${p.quantity ?? "0"} ${p.assetId}`).join(", ") || "No debt liabilities"}
              </span>
            </div>
            <div className="health-card">
              <span className="health-card-label">Aggregate Health</span>
              <span className="health-card-value">
                {debtPositions.length === 0 ? (
                  <span className="success-text">Unleveraged</span>
                ) : (
                  <span className="badge badge-success">Active Collateralized</span>
                )}
              </span>
              <span className="health-card-subtext">
                {debtPositions.some((p) => p.stale) || collateralPositions.some((p) => p.stale)
                  ? "Caution: Some position readings are stale"
                  : "All position feeds verified"}
              </span>
            </div>
          </div>
        </Panel>
      )}

      {/* Supplied Positions */}
      <Panel
        title={`Supplied Vault Positions (${suppliedPositions.length})`}
        action={
          <button type="button" onClick={() => onNavigate?.("Earn")}>
            Explore Earn Markets
          </button>
        }
      >
        {suppliedPositions.length === 0 ? (
          <p className="muted">No active earn vault supplies.</p>
        ) : (
          <ResponsiveTable
            rows={suppliedPositions}
            rowKey={(p) => `${p.marketId}-${p.assetId}`}
            columns={[
              { header: "Market", cell: (p) => <strong>{p.marketId}</strong> },
              { header: "Supplied Asset", cell: (p) => p.assetId },
              {
                header: "Quantity",
                cell: (p) => <Amount quantity={p.quantity} unknown="unknown" />,
              },
              {
                header: "Status",
                cell: (p) => (
                  <span className={`badge ${p.stale ? "badge-warning" : "badge-success"}`}>
                    {p.stale ? "Stale reading" : "Verified"}
                  </span>
                ),
              },
              {
                header: "Actions",
                cell: (p) => (
                  <div className="button-group">
                    <button
                      type="button"
                      disabled={!isActionAllowed(p.marketId, "deposit")}
                      onClick={() => onNavigate?.("Earn", { marketId: p.marketId, action: "deposit" })}
                    >
                      Deposit More
                    </button>
                    <button
                      type="button"
                      disabled={!isActionAllowed(p.marketId, "withdraw")}
                      onClick={() => onNavigate?.("Earn", { marketId: p.marketId, action: "withdraw" })}
                    >
                      Withdraw
                    </button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Panel>

      {/* Collateral Positions */}
      <Panel
        title={`Collateral Positions (${collateralPositions.length})`}
        action={
          <button type="button" onClick={() => onNavigate?.("Borrow", { action: "collateral_add" })}>
            Add Collateral
          </button>
        }
      >
        {collateralPositions.length === 0 ? (
          <p className="muted">No active collateral deposited.</p>
        ) : (
          <ResponsiveTable
            rows={collateralPositions}
            rowKey={(p) => `${p.marketId}-${p.assetId}`}
            columns={[
              { header: "Market", cell: (p) => <strong>{p.marketId}</strong> },
              { header: "Collateral Asset", cell: (p) => p.assetId },
              {
                header: "Quantity",
                cell: (p) => <Amount quantity={p.quantity} unknown="unknown" />,
              },
              {
                header: "Status",
                cell: (p) => (
                  <span className={`badge ${p.stale ? "badge-warning" : "badge-success"}`}>
                    {p.stale ? "Stale reading" : "Verified"}
                  </span>
                ),
              },
              {
                header: "Actions",
                cell: (p) => (
                  <div className="button-group">
                    <button
                      type="button"
                      disabled={!isActionAllowed(p.marketId, "collateral_add")}
                      onClick={() => onNavigate?.("Borrow", { action: "collateral_add" })}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      disabled={!isActionAllowed(p.marketId, "collateral_remove")}
                      onClick={() => onNavigate?.("Borrow", { action: "collateral_remove" })}
                    >
                      Remove
                    </button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Panel>

      {/* Debt Liabilities */}
      <Panel
        title={`Debt Liabilities (${debtPositions.length})`}
        action={
          <button type="button" onClick={() => onNavigate?.("Borrow", { action: "borrow" })}>
            Borrow
          </button>
        }
      >
        {debtPositions.length === 0 ? (
          <p className="muted">No outstanding debt liabilities.</p>
        ) : (
          <ResponsiveTable
            rows={debtPositions}
            rowKey={(p) => `${p.marketId}-${p.assetId}`}
            columns={[
              { header: "Market", cell: (p) => <strong>{p.marketId}</strong> },
              { header: "Borrowed Asset", cell: (p) => p.assetId },
              {
                header: "Outstanding Balance",
                cell: (p) => <span className="danger-text">{p.quantity ?? "unknown"}</span>,
              },
              {
                header: "Status",
                cell: (p) => (
                  <span className={`badge ${p.stale ? "badge-warning" : "badge-success"}`}>
                    {p.stale ? "Stale reading" : "Verified"}
                  </span>
                ),
              },
              {
                header: "Actions",
                cell: (p) => (
                  <div className="button-group">
                    <button
                      type="button"
                      disabled={!isActionAllowed(p.marketId, "repay")}
                      onClick={() => onNavigate?.("Borrow", { action: "repay" })}
                    >
                      Repay
                    </button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Panel>

      {/* Receipt Tokens Non-Double Counting Disclosure */}
      {receiptEntries.length > 0 && (
        <Panel title="Receipt Token Disclosures (Non-Double Counted)">
          <aside className="panel-notice panel-notice-info">
            <p>
              <strong>Receipt tokens are underlying claims:</strong> The tokens listed below represent cryptographic
              claims on your supplied protocol vaults (such as <code>zft</code> for Zest vaults). They are tracked for
              cryptographic completeness, but their value is already represented in your supplied balances. To prevent
              double-counting, they are excluded from your net subtotal.
            </p>
          </aside>
          <ResponsiveTable
            rows={receiptEntries}
            rowKey={(e) => `${e.assetId}-${e.category}-${e.id}`}
            columns={[
              { header: "Receipt Asset", cell: (e) => <code>{e.assetId}</code> },
              {
                header: "Market / Protocol",
                cell: (e) => <span>{e.marketId ?? e.protocolKey ?? "Protocol Vault"}</span>,
              },
              { header: "Held Claim", cell: (e) => e.quantity ?? "0" },
              {
                header: "Accounting Treatment",
                cell: (e) => (
                  <div>
                    <span className="badge badge-neutral">Receipt claim</span>
                    <div className="muted font-small">
                      {e.isReceipt ? "Excluded to prevent double counting" : "Non-asset claim"}
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </Panel>
      )}
    </>
  );
}
