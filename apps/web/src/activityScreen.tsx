import { useCapital, useWorkflow, useWorkflows } from "@stacks-capital/react";
import { EmptyStateView, Panel, panelState, StateNote, type ConnectedWallet } from "@stacks-capital/ui";
import { useMemo, useState } from "react";
import { enrichWorkflows, groupWorkflows, type EnrichedWorkflow, type WorkflowGroupKind } from "./activityState.ts";
import type { StacksNetwork } from "@stacks-capital/core";

export function ActivityScreen({
  signedIn,
  wallet,
  network = "mainnet",
}: {
  signedIn: boolean;
  wallet?: ConnectedWallet | null;
  network?: StacksNetwork;
}) {
  const { scope } = useCapital();
  const workflows = useWorkflows({ enabled: signedIn, limit: 50 });

  const [filterGroup, setFilterGroup] = useState<WorkflowGroupKind | "all">("all");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [lookupInput, setLookupInput] = useState("");

  const detailedWorkflow = useWorkflow(selectedWorkflowId);

  const enrichedList: EnrichedWorkflow[] = useMemo(() => {
    const rawItems = workflows.data?.items ?? [];
    return enrichWorkflows(rawItems, network);
  }, [workflows.data?.items, network]);

  const grouped = useMemo(() => groupWorkflows(enrichedList), [enrichedList]);

  const displayedWorkflows = useMemo(() => {
    if (filterGroup === "all") return enrichedList;
    return grouped[filterGroup];
  }, [filterGroup, enrichedList, grouped]);

  const state = panelState(workflows, workflows.data?.context);

  if (!signedIn || !wallet) {
    return (
      <Panel title="Activity & Durable Workflows">
        <EmptyStateView
          state={{
            kind: "empty",
            instruction:
              "Connect your Stacks wallet to view your durable workflows, lifecycle state, and recovery actions.",
          }}
        />
      </Panel>
    );
  }

  return (
    <div className="activity-screen-container">
      {/* Workflow Direct ID Lookup Bar */}
      <Panel title="Direct Workflow Lookup">
        <form
          className="workflow-lookup-form"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = lookupInput.trim();
            if (trimmed) {
              setSelectedWorkflowId(trimmed);
            }
          }}
        >
          <input
            type="text"
            className="input-field"
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            placeholder="Enter workflow id (wf_...)"
            aria-label="Workflow ID"
          />
          <button type="submit" className="button-secondary">
            Look up
          </button>
        </form>

        {selectedWorkflowId && (
          <div className="workflow-detail-drawer">
            <div className="detail-header-row">
              <h3>Workflow Inspection: {selectedWorkflowId}</h3>
              <button type="button" className="button-text font-small" onClick={() => setSelectedWorkflowId(null)}>
                Close
              </button>
            </div>
            <StateNote
              state={panelState(detailedWorkflow, detailedWorkflow.data?.context)}
              onRetry={() => void detailedWorkflow.refresh()}
            />
            {detailedWorkflow.data && (
              <div className="workflow-detail-body">
                <p>
                  <strong>State:</strong>{" "}
                  <span className="badge badge-neutral">{detailedWorkflow.data.data.state}</span>{" "}
                  <strong>Next Action:</strong> <code>{detailedWorkflow.data.data.nextAction}</code>
                </p>
                <h4>Transition Timeline:</h4>
                <ol className="workflow-timeline">
                  {detailedWorkflow.data.data.transitions.map((move) => (
                    <li key={move.sequence} className="timeline-item font-small">
                      <div className="timeline-transition">
                        <code>{move.from}</code> &rarr; <strong>{move.to}</strong>
                      </div>
                      <div className="timeline-meta muted font-micro">
                        Reason: {move.reason} &bull; Actor: {move.actor}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* Main Durable Workflows Panel */}
      <Panel
        title="Durable Workflows History"
        action={
          <button type="button" onClick={() => void workflows.refresh()} className="button-secondary">
            Refresh
          </button>
        }
      >
        <StateNote state={state} onRetry={() => void workflows.refresh()} />

        {/* Filter Pills */}
        <div className="workflow-filter-bar">
          <button
            type="button"
            className={`filter-tab-btn ${filterGroup === "all" ? "filter-tab-active" : ""}`}
            onClick={() => setFilterGroup("all")}
          >
            All Workflows ({enrichedList.length})
          </button>
          <button
            type="button"
            className={`filter-tab-btn ${filterGroup === "active" ? "filter-tab-active" : ""}`}
            onClick={() => setFilterGroup("active")}
          >
            In Progress ({grouped.active.length})
          </button>
          <button
            type="button"
            className={`filter-tab-btn ${filterGroup === "recovery_needed" ? "filter-tab-active" : ""}`}
            onClick={() => setFilterGroup("recovery_needed")}
          >
            Needs Recovery ({grouped.recovery_needed.length})
          </button>
          <button
            type="button"
            className={`filter-tab-btn ${filterGroup === "completed" ? "filter-tab-active" : ""}`}
            onClick={() => setFilterGroup("completed")}
          >
            Completed & Reconciled ({grouped.completed.length})
          </button>
        </div>

        {displayedWorkflows.length === 0 ? (
          <EmptyStateView
            state={{
              kind: "empty",
              instruction:
                filterGroup === "recovery_needed"
                  ? "No workflows currently require recovery. All active operations are running normally."
                  : `No recorded workflows found for ${scope.address}.`,
            }}
          />
        ) : (
          <div className="workflow-cards-list">
            {displayedWorkflows.map((wf) => (
              <div key={wf.id} className={`workflow-card tone-${wf.statusTone}`}>
                <div className="workflow-card-main">
                  <div className="wf-title-row">
                    <span className="wf-action-name font-bold">{wf.actionLabel}</span>
                    <span className={`badge badge-${wf.statusTone}`}>{wf.statusLabel}</span>
                  </div>

                  <div className="wf-meta-row font-small muted">
                    <span>
                      <strong>ID:</strong> <code>{wf.id}</code>
                    </span>
                    <span>
                      <strong>Updated:</strong> {wf.formattedDate}
                    </span>
                    <span>
                      <strong>Steps:</strong> {wf.transitionCount}
                    </span>
                  </div>

                  {/* Recovery Actions Bar */}
                  {wf.recoveryActions.length > 0 && (
                    <div className="wf-recovery-actions-bar">
                      {wf.recoveryActions.map((rec) => (
                        <div key={rec.type} className="recovery-action-item">
                          {rec.targetHref ? (
                            <a
                              href={rec.targetHref}
                              target="_blank"
                              rel="noreferrer"
                              className="button-link font-small"
                            >
                              {rec.label} &rarr;
                            </a>
                          ) : (
                            <button
                              type="button"
                              className={`recovery-action-btn ${
                                rec.type === "reclaim" ? "button-danger" : "button-secondary"
                              }`}
                              title={rec.description}
                              onClick={() => setSelectedWorkflowId(wf.id)}
                            >
                              {rec.label}
                            </button>
                          )}
                          <span className="recovery-description font-micro muted">{rec.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="wf-card-side">
                  <button
                    type="button"
                    className="button-secondary font-small"
                    onClick={() => setSelectedWorkflowId(wf.id)}
                  >
                    Inspect History &rarr;
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

export { ActivityScreen as Activity };
