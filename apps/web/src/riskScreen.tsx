import { useCapital, useMarketRisk, usePositions, useWorkflows } from "@stacks-capital/react";
import { concentrationBy, scenarios, wouldLiquidate } from "./exposure.ts";
import type { ConnectedWallet } from "./session.ts";
import { panelState } from "./state.ts";
import { Panel, StateNote, Unavailable } from "./ui.tsx";

const MARKET = "granite.sbtc.isolated";
const bps = (value: bigint | string | null) => (value === null ? "unknown" : `${(Number(value) / 100).toFixed(2)}%`);

export function Risk({ wallet, signedIn }: { wallet: ConnectedWallet | null; signedIn: boolean }) {
  const { scope } = useCapital();
  const positions = usePositions({ enabled: signedIn });
  const risk = useMarketRisk(signedIn ? MARKET : null, { staleMs: 15_000 });
  const workflows = useWorkflows({ enabled: signedIn, limit: 20 });

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Risk and activity">
        <p className="muted">Sign in to see your exposure and what you have done.</p>
      </Panel>
    );
  }

  const held = positions.data?.data.items ?? [];
  const byMarket = concentrationBy(held, (position) => position.marketId);
  const byProtocol = concentrationBy(held, (position) => position.marketId.split(".")[0] ?? position.marketId);
  const projection = risk.data === undefined ? null : scenarios(risk.data.data, new Date());

  return (
    <>
      <Panel
        title="Protocol risk"
        action={
          <button type="button" onClick={() => void risk.refresh()}>
            Refresh
          </button>
        }
      >
        <StateNote state={panelState(risk, risk.data?.context)} onRetry={() => void risk.refresh()} />
        {risk.data === undefined ? null : risk.data.data.params === null ? (
          <Unavailable reason="The protocol's risk parameters could not be read." />
        ) : (
          <dl>
            <dt>Borrow limit</dt>
            <dd>{bps(risk.data.data.params.ltvBorrowBps)}</dd>
            <dt>Liquidation at</dt>
            <dd>{bps(risk.data.data.params.ltvLiqBps)}</dd>
            <dt>Safety buffer</dt>
            <dd>{bps(risk.data.data.params.bufferBps)}</dd>
            <dt>Collateral price</dt>
            <dd>
              {risk.data.data.collateralOracle.price ?? "unknown"} from {risk.data.data.collateralOracle.source}
              {risk.data.data.collateralOracle.stale ? " (stale)" : ""}
            </dd>
          </dl>
        )}
        {(risk.data?.data.warnings ?? []).map((warning) => (
          <p key={warning} className="warn">
            {warning}
          </p>
        ))}
      </Panel>

      <Panel title="Concentration">
        <StateNote state={panelState(positions, positions.data?.context)} onRetry={() => void positions.refresh()} />
        {[["By market", byMarket] as const, ["By protocol", byProtocol] as const].map(([title, result]) => (
          <section key={title}>
            <h3>{title}</h3>
            {result.available ? (
              <table>
                <tbody>
                  {result.value.slices.map((slice) => (
                    <tr key={slice.key}>
                      <td>{slice.key}</td>
                      <td>{slice.quantity}</td>
                      <td>{bps(slice.shareBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Unavailable reason={result.reason} />
            )}
          </section>
        ))}
      </Panel>

      <Panel title="If the price moves">
        {projection === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p className="muted">
              {projection.assumptions.note} Collateral priced from {projection.assumptions.collateralFeed}
              {projection.assumptions.publishedAt === null ? "" : `, published ${projection.assumptions.publishedAt}`}.
              Liquidation at {bps(projection.assumptions.liquidationThresholdBps)}.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Move</th>
                  <th>Loan to value</th>
                  <th>Health factor</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {projection.rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.health.available ? bps(row.health.value.currentLtvBps) : "unavailable"}</td>
                    <td>{row.health.available ? bps(row.health.value.healthFactorBps) : "unavailable"}</td>
                    <td>
                      {row.health.available
                        ? wouldLiquidate(row, projection.assumptions.liquidationThresholdBps)
                          ? "would be liquidated"
                          : "still above water"
                        : row.health.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      <Panel
        title="Activity"
        action={
          <button type="button" onClick={() => void workflows.refresh()}>
            Refresh
          </button>
        }
      >
        <StateNote state={panelState(workflows, workflows.data?.context)} onRetry={() => void workflows.refresh()} />
        {(workflows.data?.items ?? []).length === 0 ? (
          <p className="muted">Nothing yet for {scope.address}.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Workflow</th>
                <th>State</th>
                <th>Next</th>
                <th>Steps recorded</th>
              </tr>
            </thead>
            <tbody>
              {(workflows.data?.items ?? []).map((workflow) => (
                <tr key={workflow.id}>
                  <td>{workflow.createdAt}</td>
                  <td>{workflow.id}</td>
                  <td>{workflow.state}</td>
                  <td>{workflow.nextAction}</td>
                  <td>{workflow.transitionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
