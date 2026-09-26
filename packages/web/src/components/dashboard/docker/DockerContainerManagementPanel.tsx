import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import type {
  DockerManagementAction,
  DockerManagementCapability,
  DockerManagementOperation,
} from "../../../lib/api";
import {
  getVpsDockerContainerLogs,
  getVpsDockerManagementCapability,
  getVpsDockerManagementOperation,
  requestVpsDockerContainerAction,
} from "../../../lib/api";

const LOG_LINE_HARD_LIMIT = 200;
const DEFAULT_LOG_LINES = 100;

type OperationState = {
  operation: DockerManagementOperation | null;
  checking: boolean;
  requestBusy: boolean;
  error: string | null;
};

/**
 * Docker container management (P4, web-only against the planned contract).
 *
 * - Capability/target display is explicit; controls stay disabled until both
 *   capability and a container target resolve.
 * - Log-lines is a separate setting from history/event pagination limits.
 * - Start/stop/restart always confirm via AlertDialog; Cancel closes the
 *   dialog and makes no API call.
 * - No optimistic state: container rows are never edited locally; only the
 *   operation result/status is shown.
 * - Logs load only on manual Load/Refresh clicks (never from SSE/polling)
 *   and render as text only (React escaping; no inner HTML).
 */
export function DockerContainerManagementPanel({
  vpsId,
  enabled,
}: {
  vpsId: string;
  enabled: boolean;
}) {
  const [capability, setCapability] =
    useState<DockerManagementCapability | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] =
    useState<DockerManagementAction | null>(null);
  const [operationState, setOperationState] = useState<OperationState>({
    operation: null,
    checking: false,
    requestBusy: false,
    error: null,
  });

  const [logLinesSetting, setLogLinesSetting] =
    useState<number>(DEFAULT_LOG_LINES);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logsTruncated, setLogsTruncated] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const logsAbortRef = useRef<AbortController | null>(null);
  const containers = capability?.targets ?? [];
  const selected = containers.find((item) => item.containerKey === targetKey) ?? null;
  const agentInstanceId = selected?.agentInstanceId;

  // ── Capability load (manual retry only; never driven by SSE) ──────
  useEffect(() => {
    if (!enabled) {
      setCapability(null);
      setCapabilityLoading(false);
      setCapabilityError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setCapabilityLoading(true);
    setCapabilityError(null);
    getVpsDockerManagementCapability(vpsId, controller.signal)
      .then((result) => {
        if (cancelled) return;
        setCapability(result);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setCapability(null);
        setCapabilityError(
          err instanceof Error
            ? err.message
            : "Container management is unavailable right now.",
        );
      })
      .finally(() => {
        if (!cancelled) setCapabilityLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vpsId, enabled, capabilityRetry]);

  // ── Target + log cleanup on scope change ───────────────────────────
  useEffect(() => {
    if (!enabled) {
      setTargetKey(null);
      setPendingAction(null);
      setOperationState({
        operation: null,
        checking: false,
        requestBusy: false,
        error: null,
      });
      setLogLines([]);
      setLogsTruncated(false);
      setLogsError(null);
      logsAbortRef.current?.abort();
      logsAbortRef.current = null;
      return;
    }
    if (targetKey && !containers.some((item) => item.containerKey === targetKey)) {
      setTargetKey(null);
      setPendingAction(null);
      setLogLines([]);
      setLogsTruncated(false);
      setLogsError(null);
      logsAbortRef.current?.abort();
      logsAbortRef.current = null;
    }
  }, [enabled, targetKey, capability]);

  useEffect(() => {
    return () => {
      logsAbortRef.current?.abort();
      logsAbortRef.current = null;
    };
  }, []);

  const effectiveMaxLines = Math.min(
    LOG_LINE_HARD_LIMIT,
    capability?.maxLogLines && capability.maxLogLines > 0
      ? capability.maxLogLines
      : LOG_LINE_HARD_LIMIT,
  );
  const boundedLogLines = Math.min(
    Math.max(Math.floor(logLinesSetting) || DEFAULT_LOG_LINES, 1),
    effectiveMaxLines,
  );
  const visibleOperation =
    operationState.operation &&
    operationState.operation.target.containerKey === targetKey
      ? operationState.operation
      : null;

  const confirmAction = async () => {
    if (!pendingAction || !selected) return;
    // Dialog Cancel closes without calling this; only explicit confirmation
    // reaches the API, and only once per click.
    setOperationState((prev) => ({
      ...prev,
      requestBusy: true,
      error: null,
    }));
    try {
      const result = await requestVpsDockerContainerAction(
        vpsId,
        { agentInstanceId, containerKey: selected.containerKey },
        pendingAction,
      );
      setOperationState({
        operation: result,
        checking: false,
        requestBusy: false,
        error: null,
      });
    } catch (err) {
      setOperationState((prev) => ({
        ...prev,
        requestBusy: false,
        error:
          err instanceof Error
            ? err.message
            : "Unable to start this container operation.",
      }));
    } finally {
      // No optimistic container update; dialog closes and status/logs are
      // checked manually below.
      setPendingAction(null);
    }
  };

  const checkOperationStatus = async () => {
    const current = operationState.operation;
    if (!current || operationState.checking) return;
    setOperationState((prev) => ({ ...prev, checking: true, error: null }));
    try {
      const result = await getVpsDockerManagementOperation(vpsId, current.id);
      setOperationState((prev) => ({
        ...prev,
        operation: result,
        checking: false,
      }));
    } catch (err) {
      // Keep the last known operation but surface unknown freshness.
      setOperationState((prev) => ({
        ...prev,
        checking: false,
        error:
          err instanceof Error
            ? `Operation status is unknown right now: ${err.message}`
            : "Operation status is unknown right now.",
      }));
    }
  };

  const loadLogs = async () => {
    if (!selected || !agentInstanceId || logsLoading) return;
    logsAbortRef.current?.abort();
    const controller = new AbortController();
    logsAbortRef.current = controller;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const result = await getVpsDockerContainerLogs(
        vpsId,
        { agentInstanceId, containerKey: selected.containerKey },
        boundedLogLines,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      // Text only: rendered via React text content below, never HTML.
      setLogLines(result.lines.slice(0, boundedLogLines));
      setLogsTruncated(result.truncated);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLogsError(
        err instanceof Error ? err.message : "Container logs are unavailable.",
      );
    } finally {
      if (!controller.signal.aborted) setLogsLoading(false);
      if (logsAbortRef.current === controller) logsAbortRef.current = null;
    }
  };

  const clearLogs = () => {
    logsAbortRef.current?.abort();
    logsAbortRef.current = null;
    setLogsLoading(false);
    setLogLines([]);
    setLogsTruncated(false);
    setLogsError(null);
  };

  if (!enabled) {
    return (
      <section
        aria-label="Docker container management"
        className="rounded-none border border-white/10 bg-black/10 p-4"
      >
        <h3 className="text-xs font-medium text-white/75">
          Container management
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-white/45">
          Management controls stay hidden until Docker management is enabled.
        </p>
      </section>
    );
  }

  if (capabilityLoading) {
    return (
      <section
        aria-label="Docker container management"
        aria-busy="true"
        className="rounded-none border border-white/10 bg-black/10 p-4"
      >
        <h3 className="text-xs font-medium text-white/75">
          Container management
        </h3>
        <p className="mt-1 text-[11px] text-white/50">
          Checking container management capability…
        </p>
      </section>
    );
  }

  if (capabilityError || !capability) {
    return (
      <section
        aria-label="Docker container management"
        className="rounded-none border border-white/10 bg-black/10 p-4"
      >
        <h3 className="text-xs font-medium text-white/75">
          Container management
        </h3>
        <p className="mt-1 text-[11px] text-white/60">
          Container management status is unknown right now.
        </p>
        {capabilityError ? (
          <p className="mt-1 text-[11px] text-white/40">{capabilityError}</p>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3 min-h-9"
          onClick={() => setCapabilityRetry((n) => n + 1)}
        >
          Retry capability check
        </Button>
      </section>
    );
  }

  if (!capability.supported) {
    return (
      <section
        aria-label="Docker container management"
        className="rounded-none border border-white/10 bg-black/10 p-4"
      >
        <h3 className="text-xs font-medium text-white/75">
          Container management
        </h3>
        <p className="mt-1 text-[11px] text-white/60">
          Container management is not supported by this agent.
        </p>
        {capability.reason ? (
          <p className="mt-1 text-[11px] text-white/40">{capability.reason}</p>
        ) : null}
      </section>
    );
  }

  const actionDisabled =
    !selected || operationState.requestBusy || operationState.checking;
  const actions: DockerManagementAction[] = ["start", "stop", "restart"];

  return (
    <section
      aria-label="Docker container management"
      className="rounded-none border border-white/10 bg-black/10 p-4"
    >
      <h3 className="text-xs font-medium text-white/75">
        Container management
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-white/40">
        Capability: {capability.actions.join(", ") || "no actions"} · logs{" "}
        {capability.logsSupported ? "supported" : "not supported"} (max{" "}
        {effectiveMaxLines} lines). Target a single container below; every
        action asks for confirmation first.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <label
            className="mb-1 block text-[11px] text-white/50"
            htmlFor={`docker-management-target-${vpsId}`}
          >
            Target container
          </label>
          <select
            id={`docker-management-target-${vpsId}`}
            value={targetKey ?? ""}
            onChange={(event) =>
              setTargetKey(event.target.value || null)
            }
            className="h-9 w-full rounded-sm border border-white/10 bg-slate-900 px-2 text-[12px] text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/60"
          >
            <option value="">Select a container…</option>
            {containers.map((container) => (
              <option key={container.containerKey} value={container.containerKey}>
                {container.name} · {container.state ?? "unknown"}
              </option>
            ))}
          </select>
          {selected ? (
            <p className="mt-1 truncate text-[11px] text-white/40">
              Target: {selected.name} · key {selected.containerKey} ·{" "}
              {selected.image} · {selected.state}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-white/40">
              Select a target container to enable start, stop, and restart.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={action === "stop" ? "destructive" : "secondary"}
              className="min-h-9 capitalize"
              disabled={
                actionDisabled || !capability.actions.includes(action)
              }
              onClick={() => setPendingAction(action)}
            >
              {action}
            </Button>
          ))}
        </div>
      </div>

      <div
        aria-live="polite"
        className="mt-3 rounded-none border border-white/10 bg-black/20 px-3 py-2"
      >
        <p className="text-[11px] font-medium text-white/70">
          Operation status:{" "}
          {operationState.error && !visibleOperation
            ? "unknown"
            : (visibleOperation?.status ?? "none")}
        </p>
        {visibleOperation ? (
          <>
            <p className="mt-1 text-[11px] text-white/50">
              {visibleOperation.action} · {visibleOperation.target.containerKey} ·
              requested {new Date(visibleOperation.createdAt).toLocaleString()}
              {visibleOperation.updatedAt
                ? ` · updated ${new Date(visibleOperation.updatedAt).toLocaleString()}`
                : ""}
            </p>
            {visibleOperation.status === "failed" &&
            visibleOperation.result?.message ? (
              <p role="alert" className="mt-1 text-[11px] text-rose-200">
                {visibleOperation.result.message}
              </p>
            ) : null}
            {visibleOperation.cancelReason ? (
              <p className="mt-1 text-[11px] text-white/40">
                Cancel reason: {visibleOperation.cancelReason}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-9"
                disabled={operationState.checking}
                onClick={() => void checkOperationStatus()}
              >
                {operationState.checking
                  ? "Checking…"
                  : "Check status manually"}
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-[11px] text-white/40">
            No operation for this target yet. Confirm an action above, then
            check status manually. Live updates never change this status
            automatically.
          </p>
        )}
        {operationState.error ? (
          <p role="alert" className="mt-1 text-[11px] text-rose-200">
            {operationState.error}
          </p>
        ) : null}
      </div>

      <div className="mt-3 border-t border-white/10 pt-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-end">
          <div>
            <label
              className="mb-1 block text-[11px] text-white/50"
              htmlFor={`docker-management-lines-${vpsId}`}
            >
              Log lines (separate setting, 1–{effectiveMaxLines})
            </label>
            <input
              id={`docker-management-lines-${vpsId}`}
              type="number"
              min={1}
              max={effectiveMaxLines}
              value={logLinesSetting}
              onChange={(event) =>
                setLogLinesSetting(Number(event.target.value))
              }
              className="h-9 w-full rounded-sm border border-white/10 bg-black/20 px-2 text-[12px] text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/60"
            />
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="min-h-9"
              disabled={
                !selected ||
                !capability.logsSupported ||
                logsLoading
              }
              onClick={() => void loadLogs()}
            >
              {logsLoading
                ? "Loading logs…"
                : logLines.length
                  ? "Refresh logs manually"
                  : "Load logs manually"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-9"
              disabled={!logLines.length && !logsError}
              onClick={clearLogs}
            >
              Clear
            </Button>
          </div>
        </div>
        {!capability.logsSupported ? (
          <p className="mt-2 text-[11px] text-white/40">
            Log retrieval is not supported by this agent.
          </p>
        ) : null}
        {logsError ? (
          <p role="alert" className="mt-2 text-[11px] text-rose-200">
            {logsError}
          </p>
        ) : null}
        {logLines.length ? (
          <>
            <p className="mt-2 text-[11px] text-white/40">
              Showing {logLines.length} bounded lines
              {logsTruncated ? " · output was truncated" : ""}. Text only.
            </p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-none border border-white/10 bg-black/40 p-3 text-[11px] leading-relaxed text-white/75">
              {logLines.join("\n")}
            </pre>
          </>
        ) : (
          <p className="mt-2 text-[11px] text-white/40">
            Logs load only when requested and never refresh automatically.
          </p>
        )}
      </div>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          // Closing the dialog is always a local cancel with no API call.
          if (!open && !operationState.requestBusy) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction ? (
                <>
                  {pendingAction === "start"
                    ? "Start"
                    : pendingAction === "stop"
                      ? "Stop"
                      : "Restart"}{" "}
                  container “{selected?.name ?? selected?.containerKey}”?
                </>
              ) : (
                "Confirm container action"
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This targets {selected?.name ?? "the selected container"}{" "}
              (key {selected?.containerKey ?? "—"}) on this server. The action is sent
              once on confirmation; container state below is not updated
              optimistically. Check operation status manually afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                !pendingAction ||
                !selected ||
                operationState.requestBusy
              }
              onClick={() => void confirmAction()}
            >
              {operationState.requestBusy
                ? "Sending…"
                : pendingAction
                  ? `Confirm ${pendingAction}`
                  : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
