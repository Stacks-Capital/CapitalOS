import type { QuotedPlan } from "@stacks-capital/client";
import { useEarnOptions, usePositions, useWorkflows } from "@stacks-capital/react";
import { compareEarn, formatRate, type Rate } from "./compare.ts";
import { reviewQuote } from "./earn.ts";
import { buildPortfolio, type Position } from "./holdings.ts";
import { Panel, StateNote, Unavailable } from "./primitives.tsx";
import { panelState, UNAVAILABLE } from "./state.ts";
import { ResponsiveTable } from "./table.tsx";

/*
 * Widgets a partner drops into their own page. Each one reads through the hooks, so it only needs a
 * CapitalProvider above it, and each keeps the same honesty rules as the Stacks Capital app:
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
          <ResponsiveTable
            rows={group.rows}
            rowKey={(row) => row.option.marketId}
            rowSelected={(row) => selectedMarketId === row.option.marketId}
            columns={[
              { header: "Rank", cell: (row) => row.rank ?? "not ranked" },
              { header: "Market", cell: (row) => row.option.marketId },
              { header: "Base", cell: (row) => formatRate(rateOf(row.option.baseRate, row.option.baseRateScale)) },
              {
                header: "Incentive",
                cell: (row) => formatRate(rateOf(row.option.incentiveRate, row.option.incentiveRateScale)),
              },
              { header: "Together", cell: (row) => formatRate(row.effectiveRate) },
              { header: "Liquidity", cell: (row) => row.option.availableLiquidity ?? "unknown" },
              {
                header: "Withdrawal",
                cell: (row) => (row.option.withdrawal === null ? "none listed" : row.option.withdrawal.state),
              },
              ...(onChoose === undefined
                ? []
                : [
                    {
                      header: "Action",
                      cell: (row: (typeof group.rows)[number]) => (
                        <button
                          type="button"
                          disabled={row.option.supply.state !== "enabled"}
                          onClick={() => onChoose(row.option.marketId)}
                        >
                          Choose
                        </button>
                      ),
                    },
                  ]),
            ]}
          />
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
        <ResponsiveTable
          rows={portfolio.rows}
          rowKey={(row) => row.key}
          columns={[
            { header: "Kind", cell: (row) => row.kind },
            { header: "Market", cell: (row) => row.marketId },
            { header: "Quantity", cell: (row) => row.quantity ?? "unknown" },
            { header: "Counted", cell: (row) => (row.countsTowardTotal ? "counted" : "not counted") },
          ]}
        />
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
        <ResponsiveTable
          rows={items}
          rowKey={(workflow) => workflow.id}
          columns={[
            { header: "Started", cell: (workflow) => workflow.createdAt },
            { header: "Workflow", cell: (workflow) => workflow.id },
            { header: "State", cell: (workflow) => workflow.state },
            { header: "Next", cell: (workflow) => workflow.nextAction },
          ]}
        />
      )}
    </Panel>
  );
}
