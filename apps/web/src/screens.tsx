import { useCapabilities, useMarkets, useWorkflow } from "@stacks-capital/react";
import { useState } from "react";
import { buildPortfolio } from "./holdings.ts";
import { panelState, UNAVAILABLE } from "./state.ts";
import { Amount, Panel, StateNote, Unavailable } from "./ui.tsx";

export function Portfolio({ address }: { address: string | null }) {
  const markets = useMarkets({ limit: 100 });
  const state = panelState(markets, markets.data?.context);

  // Balances and positions have no endpoint yet, so the portfolio is built from what exists: nothing.
  // The rule is here and tested, waiting for the data (see holdings.ts).
  const portfolio = buildPortfolio({ balances: [], positions: [], markets: markets.data?.items ?? [] });

  return (
    <>
      <Panel title="Holdings">
        {address === null ? (
          <p className="muted">Connect a wallet to see what it holds.</p>
        ) : (
          <>
            <Unavailable reason={UNAVAILABLE.balances} />
            <Unavailable reason={UNAVAILABLE.positions} />
            {portfolio.rows.length > 0 ? (
              <table>
                <tbody>
                  {portfolio.rows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.kind}</td>
                      <td>{row.assetId}</td>
                      <td>
                        <Amount quantity={row.quantity} unknown="unknown" />
                      </td>
                      <td>{row.countsTowardTotal ? "" : "not counted"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Action</th>
            <th>State</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {(capabilities.data?.items ?? []).map((capability) => (
            <tr key={`${capability.marketId}/${capability.action}`}>
              <td>{capability.marketId}</td>
              <td>{capability.action}</td>
              <td>{capability.state}</td>
              <td className="muted">{capability.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
