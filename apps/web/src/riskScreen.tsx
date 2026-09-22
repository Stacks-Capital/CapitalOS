import { useMarketRisk, usePositions } from "@stacks-capital/react";
import {
  type ConnectedWallet,
  EmptyStateView,
  Panel,
  panelState,
  ResponsiveTable,
  StateNote,
  Unavailable,
  type ViewMode,
} from "@stacks-capital/ui";
import { useEffect, useMemo, useState } from "react";
import {
  ALERT_DELIVERY_LIMITATIONS,
  type AlertSettings,
  BTC_STRESS_COVERAGE_NOTE,
  buildGraniteRiskAssessment,
  checkAlertTrigger,
  loadAlertSettings,
  saveAlertSettings,
} from "./riskState.ts";
import { concentrationByQuantity } from "@stacks-capital/core";

const MARKET = "granite.sbtc.isolated";

export function RiskScreen({
  wallet,
  signedIn,
  mode = "simple",
}: {
  wallet: ConnectedWallet | null;
  signedIn: boolean;
  mode?: ViewMode;
}) {
  const positions = usePositions({ enabled: signedIn });
  const risk = useMarketRisk(signedIn ? MARKET : null, { staleMs: 15_000 });

  // Alert configuration state
  const [alertSettings, setAlertSettings] = useState<AlertSettings>(() => loadAlertSettings());
  const [permissionStatus, setPermissionStatus] = useState<string>("default");

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setPermissionStatus(Notification.permission);
    }
  }, []);

  const updateAlertSettings = (partial: Partial<AlertSettings>) => {
    const updated = { ...alertSettings, ...partial };
    setAlertSettings(updated);
    saveAlertSettings(updated);
  };

  const handleRequestNotificationPermission = async () => {
    if (typeof window !== "undefined" && "Notification" in window) {
      const res = await Notification.requestPermission();
      setPermissionStatus(res);
      if (res === "granted") {
        updateAlertSettings({
          enabled: true,
          limitationsAcknowledged: true,
          consentedAt: new Date().toISOString(),
        });
      }
    }
  };

  const assessment = useMemo(() => {
    return buildGraniteRiskAssessment(risk.data?.data, new Date());
  }, [risk.data?.data]);

  const activeAlert = useMemo(() => {
    return checkAlertTrigger(assessment.health, alertSettings);
  }, [assessment.health, alertSettings]);

  // Concentration analysis
  const held = positions.data?.data.items ?? [];
  const concentration = useMemo(() => {
    const slices = held.map((pos) => ({
      key: pos.marketId,
      quantity: pos.quantity ? BigInt(pos.quantity) : null,
      assetId: pos.assetId || "sbtc-token",
    }));
    return concentrationByQuantity(slices);
  }, [held]);

  const riskState = panelState(risk, risk.data?.context);

  if (!signedIn || wallet === null) {
    return (
      <Panel title="Risk Telemetry & Stress Testing">
        <EmptyStateView
          state={{
            kind: "empty",
            instruction:
              "Connect your Stacks wallet to view isolated credit risk, stress simulations, and alert monitors.",
          }}
        />
      </Panel>
    );
  }

  return (
    <div className="risk-screen-container">
      <StateNote state={riskState} onRetry={() => void risk.refresh()} />

      {/* Active Alert Banner */}
      {activeAlert.triggered && (
        <aside className="panel panel-notice panel-notice-warn alert-active-banner" role="alert">
          <div className="alert-content">
            <span className="badge badge-danger">TRIGGERED ALERT</span>
            <p className="warn font-bold">{activeAlert.message}</p>
          </div>
        </aside>
      )}

      {/* Plain vs Advanced Risk Status Overview */}
      <Panel
        title={mode === "simple" ? "Credit Health Overview" : "Granite Protocol Risk Telemetry"}
        action={
          <button type="button" onClick={() => void risk.refresh()} className="button-secondary">
            Refresh Feeds
          </button>
        }
      >
        {assessment.unavailableReason ? (
          <Unavailable reason={assessment.unavailableReason} />
        ) : mode === "simple" ? (
          <div className="risk-plain-summary">
            <div
              className={`risk-kpi-badge ${
                assessment.health?.stale ? "tone-stale" : assessment.health?.healthy ? "tone-healthy" : "tone-danger"
              }`}
            >
              <span className="risk-kpi-label">POSITION HEALTH</span>
              <span className="risk-kpi-title">
                {assessment.health?.stale
                  ? "Telemetry Stale"
                  : assessment.health?.debtUsd === 0n
                    ? "Safe (No Debt Opened)"
                    : assessment.health?.healthy
                      ? "Healthy Position"
                      : "Liquidation Danger"}
              </span>
              <p className="risk-kpi-explanation">{assessment.interpretation?.meaning}</p>
            </div>

            <div className="risk-plain-cards-grid">
              <div className="risk-card">
                <span className="risk-card-header">Health Factor</span>
                <span className="risk-card-value font-large">
                  {assessment.metrics.find((m) => m.id === "health_factor")?.displayValue}
                </span>
                <span className="muted font-small">Target: &gt; 1.50</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-header">Current LTV</span>
                <span className="risk-card-value font-large">
                  {assessment.metrics.find((m) => m.id === "current_ltv")?.displayValue}
                </span>
                <span className="muted font-small">
                  Liquidation at {assessment.metrics.find((m) => m.id === "liquidation_threshold")?.displayValue}
                </span>
              </div>
              <div className="risk-card">
                <span className="risk-card-header">Safety Buffer</span>
                <span className="risk-card-value font-large">
                  {assessment.metrics.find((m) => m.id === "safety_buffer")?.displayValue}
                </span>
                <span className="muted font-small">Margin above borrow limit</span>
              </div>
            </div>

            {/* Plain Protective Guidance */}
            <div className="risk-guidance-box">
              <strong>Recommended Protective Actions:</strong>
              <ul>
                {assessment.actions?.actions.map((act) => (
                  <li key={act.action} className={act.allowed ? "text-success" : "text-muted"}>
                    <strong>{act.action.replace("_", " ").toUpperCase()}:</strong> {act.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          /* Advanced Mode: Detailed Telemetry Grid with Metadata */
          <div className="risk-advanced-table">
            <p className="muted font-small">
              Calculation Engine: <code>{assessment.metrics[0]?.calculationVersion}</code>. All numbers disclose
              underlying feed source, observation timestamp, and explicit meaning.
            </p>

            <div className="metrics-meta-grid">
              {assessment.metrics.map((m) => (
                <div key={m.id} className={`metric-meta-card ${m.isWarning ? "metric-warn" : ""}`}>
                  <div className="metric-header-row">
                    <span className="metric-label">{m.label}</span>
                    <span className={`badge ${m.status === "fresh" ? "badge-success" : "badge-neutral"}`}>
                      {m.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="metric-value-row">
                    <span className="metric-val">{m.displayValue}</span>
                  </div>
                  <div className="metric-metadata-block">
                    <p className="metric-meaning font-small">{m.meaning}</p>
                    <div className="metric-source-footer font-micro muted">
                      <span>
                        <strong>Source:</strong> {m.source}
                      </span>
                      <span>
                        <strong>Observed:</strong> {new Date(m.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>

      {/* BTC Stress Scenarios Panel */}
      <Panel title="BTC Collateral Stress Scenarios">
        <div className="stress-coverage-banner">
          <p className="font-small muted">{BTC_STRESS_COVERAGE_NOTE}</p>
        </div>

        {assessment.scenarios === null ? (
          <Unavailable reason="Stress scenarios cannot be calculated while protocol risk parameters or prices are missing." />
        ) : (
          <div className="stress-table-wrapper">
            <div className="stress-assumptions-callout">
              <strong>Stated Assumptions:</strong> {assessment.scenarios.assumptions.note} Collateral priced via{" "}
              <code>{assessment.scenarios.assumptions.collateralFeed}</code>, debt via{" "}
              <code>{assessment.scenarios.assumptions.debtFeed}</code> against liquidation threshold{" "}
              {(Number(assessment.scenarios.assumptions.liquidationThresholdBps) / 100).toFixed(0)}%.
            </div>

            <ResponsiveTable
              rows={assessment.scenarios.rows}
              rowKey={(row) => String(row.shiftBps)}
              columns={[
                {
                  header: "BTC Price Shock",
                  cell: (r) => (
                    <span className={r.shiftBps < -2000 ? "text-danger font-bold" : "text-warning font-bold"}>
                      {r.label}
                    </span>
                  ),
                },
                {
                  header: "Projected LTV",
                  cell: (r) => (r.health ? `${(Number(r.health.currentLtvBps) / 100).toFixed(2)}%` : "Unavailable"),
                },
                {
                  header: "Health Factor",
                  cell: (r) => (r.health ? (Number(r.health.healthFactorBps) / 10000).toFixed(2) : "Unavailable"),
                },
                {
                  header: "Outcome & Solvency",
                  cell: (r) => {
                    if (!r.health) return <span className="muted">{r.unavailableReason}</span>;
                    const liquidates =
                      r.health.currentLtvBps >=
                      BigInt(assessment.scenarios?.assumptions.liquidationThresholdBps ?? 8000);
                    return liquidates ? (
                      <span className="badge badge-danger">LIQUIDATION TRIGGERED</span>
                    ) : (
                      <span className="badge badge-success">Solvent (Above Water)</span>
                    );
                  },
                },
              ]}
            />
          </div>
        )}
      </Panel>

      {/* Portfolio Concentration */}
      <Panel title="Asset & Market Concentration">
        {concentration.available ? (
          <ResponsiveTable
            rows={concentration.slices}
            rowKey={(slice) => slice.key}
            columns={[
              { header: "Position / Market", cell: (s) => s.key },
              { header: "Quantity (Base Units)", cell: (s) => s.quantity.toString() },
              { header: "Portfolio Share", cell: (s) => `${(Number(s.shareBps) / 100).toFixed(2)}%` },
            ]}
          />
        ) : (
          <Unavailable reason={concentration.reason ?? "Concentration unavailable."} />
        )}
      </Panel>

      {/* Alerts & Consent Panel */}
      <Panel title="Advisory Health Alerts & Notification Consent">
        <div className="alerts-card">
          <p className="font-small">
            Configure client-side risk alerts to notify you when your Granite health factor drops below a safety
            threshold or when oracle feeds become stale.
          </p>

          <div className="alert-controls-row">
            <label className="checkbox-label font-small">
              <input
                type="checkbox"
                checked={alertSettings.enabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  if (enabled && permissionStatus !== "granted") {
                    void handleRequestNotificationPermission();
                  } else {
                    updateAlertSettings({ enabled });
                  }
                }}
              />
              Enable Health Factor Monitoring Alerts
            </label>

            <div className="alert-threshold-input">
              <label htmlFor="hf-threshold" className="font-small muted">
                Alert Health Factor Threshold:
              </label>
              <select
                id="hf-threshold"
                value={alertSettings.minHealthFactor}
                disabled={!alertSettings.enabled}
                onChange={(e) => updateAlertSettings({ minHealthFactor: Number(e.target.value) })}
              >
                <option value={1.1}>1.10 (High Risk)</option>
                <option value={1.25}>1.25 (Recommended)</option>
                <option value={1.5}>1.50 (Conservative)</option>
                <option value={1.75}>1.75 (Early Warning)</option>
              </select>
            </div>

            <label className="checkbox-label font-small">
              <input
                type="checkbox"
                checked={alertSettings.staleOracleWarning}
                disabled={!alertSettings.enabled}
                onChange={(e) => updateAlertSettings({ staleOracleWarning: e.target.checked })}
              />
              Warn on Stale Oracles
            </label>
          </div>

          <div className="alert-consent-box">
            <label className="checkbox-label font-small">
              <input
                type="checkbox"
                checked={alertSettings.limitationsAcknowledged}
                onChange={(e) =>
                  updateAlertSettings({
                    limitationsAcknowledged: e.target.checked,
                    consentedAt: e.target.checked ? new Date().toISOString() : null,
                  })
                }
              />
              <strong>I acknowledge and accept the delivery limitations:</strong>
            </label>
            <ul className="muted font-micro">
              {ALERT_DELIVERY_LIMITATIONS.map((lim) => (
                <li key={lim}>{lim}</li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export { RiskScreen as Risk };
