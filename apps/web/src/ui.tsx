import type { ReactNode } from "react";
import type { PanelState } from "./state.ts";

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Unavailable({ reason }: { reason: string }) {
  return (
    <p className="unavailable" role="status">
      Not available yet. {reason}
    </p>
  );
}

/** Shows loading, an error the caller can act on, or a staleness note above the data itself. */
export function StateNote({ state, onRetry }: { state: PanelState; onRetry?: () => void }) {
  if (state.kind === "loading") return <p className="muted">Loading…</p>;
  if (state.kind === "unavailable") return <Unavailable reason={state.reason} />;
  if (state.kind === "error") {
    return (
      <p className="error" role="alert">
        {state.message}
        {state.canRetry && onRetry ? (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        {state.requestId ? <small> Request {state.requestId}</small> : null}
      </p>
    );
  }
  if (!state.stale && state.warnings.length === 0) return null;
  return (
    <p className="warn" role="status">
      {state.stale ? "Showing older data. " : null}
      {state.warnings.join(" ")}
    </p>
  );
}

export function Amount({ quantity, unknown }: { quantity: string | null; unknown: string }) {
  // A missing amount is never drawn as 0, because 0 is a real balance.
  return quantity === null ? <span className="muted">{unknown}</span> : <span>{quantity}</span>;
}
