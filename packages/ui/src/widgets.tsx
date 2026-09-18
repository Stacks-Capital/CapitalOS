import type { QuotedPlan } from "@stacks-capital/client";
import { useEarnOptions, usePositions, useWorkflows } from "@stacks-capital/react";
import { compareEarn, formatRate, type Rate } from "./compare.ts";
import { reviewQuote } from "./earn.ts";
import { buildPortfolio, type Position } from "./holdings.ts";
import { Panel, StateNote, Unavailable } from "./primitives.tsx";
import { panelState, UNAVAILABLE } from "./state.ts";

/*
 * Widgets a partner drops into their own page. Each one reads through the hooks, so it only needs a
 * CapitalProvider above it, and each keeps the same honesty rules as the Capital OS app:
 * unknown is shown as unknown, and nothing incomparable is ranked.
 */

const rateOf = (value: string | null, scale: number | null): Rate | null =>
  value === null || scale === null ? null : { value, scale };

export function EarnComparison({
  onChoose,
  selectedMarketId = null,
  now = () => new Date(),
}: {
  onChoose?: (marketId: string) => void;
  selectedMarketId?: string | null;
  now?: () => Date;
}) {
  const options = useEarnOptions();
  const comparison = compareEarn(options.data?.data.items ?? [], now());

  return (
    <Panel title="Where to earn">
      <StateNote state={panelState(options, options.data?.context)} onRetry={() => void options.refresh()} />
      <p className="muted">{comparison.note}</p>
      {comparison.groups.map((group) => (
        <section key={group.suppliedAssetId ?? "unknown"}>
          <h3>Supplying {group.suppliedAssetId ?? "an asset this page cannot name"}</h3>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Market</th>
                <th>Base</th>
                <th>Incentive</th>
                <th>Together</th>
                <th>Liquidity</th>
                <th>Withdrawal</th>
                {onChoose === undefined ? null : <th />}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.option.marketId} aria-selected={selectedMarketId === row.option.marketId}>
                  <td>{row.rank ?? "not ranked"}</td>
                  <td>{row.option.marketId}</td>
                  <td>{formatRate(rateOf(row.option.baseRate, row.option.baseRateScale))}</td>
                  <td>{formatRate(rateOf(row.option.incentiveRate, row.option.incentiveRateScale))}</td>
                  <td>{formatRate(row.effectiveRate)}</td>
                  <td>{row.option.availableLiquidity ?? "unknown"}</td>
                  <td>{row.option.withdrawal === null ? "none listed" : row.option.withdrawal.state}</td>
                  {onChoose === undefined ? null : (
                    <td>
                      <button
                        type="button"
                        disabled={row.option.supply.state !== "enabled"}
                        onClick={() => onChoose(row.option.marketId)}
                      >
                        Choose
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {group.rows
            .filter((row) => row.notes.length > 0)
            .map((row) => (
              <p key={row.option.marketId} className="muted">
                {row.option.marketId}: {row.notes.join(" ")}
              </p>
            ))}
        </section>
      ))}
    </Panel>
  );
}

export function QuoteSummary({ quoted, now = new Date() }: { quoted: QuotedPlan; now?: Date }) {
  const view = reviewQuote(quoted.quote, now);
  return (
    <div className="quote">
      <p>
        You send {view.input}, expecting {view.expected}.
      </p>
      <ul>
        {view.fees.map((fee) => (
          <li key={fee.kind}>
            {fee.kind} fee: {fee.amount}
          </li>
        ))}
      </ul>
      {view.minimumOutput === null ? null : <p>At least {view.minimumOutput}.</p>}
      {view.warnings.length > 0 ? <p className="warn">{view.warnings.join(" ")}</p> : null}
      <p className={view.expired ? "error" : "muted"}>
        {view.expired ? "This quote has expired. Ask for a new one." : `Valid for ${view.expiresInSeconds}s.`}
      </p>
      <p className="muted">{quoted.plan.reviewSummary}</p>
    </div>
  );
}

export function PositionsSummary({ signedIn }: { signedIn: boolean }) {
  const positions = usePositions({ enabled: signedIn });
  if (!signedIn) return <Unavailable reason="Sign in to see your positions." />;

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
  // Wallet balances have no endpoint yet, so only protocol positions are totalled.
  const portfolio = buildPortfolio({ balances: [], positions: held, markets: [] });

  return (
    <Panel title="Your positions">
      <StateNote state={panelState(positions, positions.data?.context)} onRetry={() => void positions.refresh()} />
      <Unavailable reason={UNAVAILABLE.balances} />
      {portfolio.rows.length === 0 ? (
        <p className="muted">No positions yet.</p>
      ) : (
        <table>
          <tbody>
            {portfolio.rows.map((row) => (
              <tr key={row.key}>
                <td>{row.kind}</td>
                <td>{row.marketId}</td>
                <td>{row.quantity ?? "unknown"}</td>
                <td>{row.countsTowardTotal ? "" : "not counted"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function WorkflowHistory({ signedIn }: { signedIn: boolean }) {
  const workflows = useWorkflows({ enabled: signedIn, limit: 20 });
  if (!signedIn) return <Unavailable reason="Sign in to see what you have done." />;
  const items = workflows.data?.items ?? [];

  return (
    <Panel title="Activity">
      <StateNote state={panelState(workflows, workflows.data?.context)} onRetry={() => void workflows.refresh()} />
      {items.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <table>
          <tbody>
            {items.map((workflow) => (
              <tr key={workflow.id}>
                <td>{workflow.createdAt}</td>
                <td>{workflow.id}</td>
                <td>{workflow.state}</td>
                <td>{workflow.nextAction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
