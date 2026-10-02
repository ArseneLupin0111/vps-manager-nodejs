import { useState } from "react";
import type { DockerAlert } from "../../../lib/api";
import { acknowledgeVpsDockerAlert } from "../../../lib/api";
import { EmptyState } from "../shared/EmptyState";

/** Bounded Docker alerts panel (state/summary/occurrences with acknowledge). */
export function DockerAlertsPanel({
  alerts,
  loading,
  error,
  vpsId,
  onAcknowledged,
}: {
  alerts: DockerAlert[];
  retained?: number;
  loading: boolean;
  error?: string | null;
  vpsId?: string;
  onAcknowledged?: (alert: DockerAlert) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);

  const acknowledge = async (alertId: string) => {
    if (!vpsId || busy) return;
    setBusy(alertId);
    setAckError(null);
    try {
      const updated = await acknowledgeVpsDockerAlert(vpsId, alertId);
      onAcknowledged?.(updated);
    } catch (err) {
      setAckError(
        err instanceof Error ? err.message : "Unable to acknowledge this alert.",
      );
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <section aria-label="Docker alerts" aria-busy="true" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-dim">Loading Docker alerts…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label="Docker alerts" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-text">Docker alerts are unavailable right now.</p>
        <p className="mt-1 text-[11px] text-dim">{error}</p>
      </section>
    );
  }
  return (
    <section aria-label="Docker alerts" className="border border-line bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-semibold">Alerts</h3>
        <p className="text-[12px] text-dim">
          showing {alerts.length} loaded alerts
        </p>
      </div>
      {ackError ? (
        <p role="alert" className="mt-2 text-[11px] text-crit">
          {ackError}
        </p>
      ) : null}
      {alerts.length === 0 ? (
        <div className="mt-2">
          <EmptyState>No Docker alerts retained. New alerts appear here as read-only state, summary, and occurrence counts.</EmptyState>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {alerts.map((alert) => (
            <li key={alert.id} className="border border-line bg-raised px-3 py-2 text-[12px]">
              <p className="flex items-center justify-between gap-2">
                <span className="font-medium text-text">{alert.ruleKind}</span>
                <span className="flex items-center gap-2">
                  <span className={alert.state === "open" ? "text-warn" : "text-dim"}>{alert.state}</span>
                  {vpsId && alert.state === "open" ? <button type="button" disabled={busy === alert.id} className="border border-line px-2 py-0.5 text-[11px] font-medium text-text transition-colors hover:border-dim hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-40" onClick={() => { void acknowledge(alert.id); }}>{busy === alert.id ? "Acknowledging…" : "Acknowledge"}</button> : null}
                </span>
              </p>
              <p className="mt-0.5 text-dim">{alert.summary}</p>
              <p className="mt-0.5 text-[11px] text-dim">
                {alert.occurrences} occurrence{alert.occurrences === 1 ? "" : "s"} · opened {new Date(alert.openedAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
