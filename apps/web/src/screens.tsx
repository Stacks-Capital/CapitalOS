import { useCapabilities, useMarkets, usePositions, useWorkflow } from "@stacks-capital/react";
import { useState } from "react";
import {
  Amount,
  buildPortfolio,
  EmptyStateView,
  excludedFrom,
  LoadingStateView,
  type HoldingPosition as Position,
  Panel,
  panelState,
  PartialStateView,
  ResponsiveTable,
  StateNote,
  UNAVAILABLE,
  Unavailable,
} from "@stacks-capital/ui";

export function Portfolio({ address, signedIn }: { address: string | null; signedIn: boolean }) {
  const markets = useMarkets({ limit: 100 });
  // Positions belong to a signed in address. Asking before sign in is refused, and says so loudly.
  const positions = usePositions({ enabled: signedIn });
  const state = panelState(markets, markets.data?.context);
  const positionsState = panelState(positions, positions.data?.context);

  // Positions come from the worker's projections (I11). Wallet balances still have no endpoint.
  const held: Position[] = (positions.data?.data.items ?? [])
    .filter((position) => position.kind === "supplied" || position.kind === "debt" || position.kind === "collateral")
    .map((position) => ({
      marketId: position.marketId,
      kind: position.kind as Position["kind"],
      assetId: position.assetId,
      quantity: position.quantity,
      stale: position.stale,
      warnings: position.warnings,
    }));
  const portfolio = buildPortfolio({ balances: [], positions: held, markets: markets.data?.items ?? [] });
  const excluded = excludedFrom(portfolio);
  const totalsLine = portfolio.totals.map((total) => `${total.quantity ?? "unknown"} ${total.assetId}`).join(", ");

  return (
    <>
      <Panel title="Holdings">
        {address === null ? (
          <EmptyStateView state={{ kind: "empty", instruction: "Connect a wallet to see what it holds." }} />
        ) : (
          <>
            <Unavailable reason={UNAVAILABLE.balances} />
            {!signedIn ? (
              <EmptyStateView state={{ kind: "empty", instruction: "Sign in to see your positions." }} />
            ) : positionsState.kind === "loading" ? (
              <LoadingStateView
                state={{
                  kind: "loading",
                  what: "your positions",
                  canRetry: true,
                  onRetry: () => void positions.refresh(),
                }}
              />
            ) : (
              <StateNote state={positionsState} onRetry={() => void positions.refresh()} />
            )}
            {/* A subtotal that quietly drops rows reads as a complete balance, so the drops are named. */}
            {signedIn && portfolio.totals.length > 0 && excluded.length > 0 ? (
              <PartialStateView
                state={{ kind: "partial", verifiedSubtotal: totalsLine, excludedPositions: excluded }}
              />
            ) : portfolio.totals.length > 0 ? (
              <p>Total {totalsLine}</p>
            ) : null}
            {portfolio.rows.length > 0 ? (
              <ResponsiveTable
                rows={portfolio.rows}
                rowKey={(row) => row.key}
                columns={[
                  { header: "Kind", cell: (row) => row.kind },
                  { header: "Asset", cell: (row) => row.assetId },
                  { header: "Quantity", cell: (row) => <Amount quantity={row.quantity} unknown="unknown" /> },
                  { header: "Counted", cell: (row) => (row.countsTowardTotal ? "counted" : "not counted") },
                ]}
              />
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        title="Available markets"
        action={
          <button type="button" onClick={() => void markets.refresh()}>
            Refresh
          </button>
        }
      >
        <StateNote state={state} onRetry={() => void markets.refresh()} />
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
