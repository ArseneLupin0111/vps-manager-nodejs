import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Clock3,
  DownloadCloud,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  MapPin,
  MoreHorizontal,
  RotateCw,
  Server,
  ServerCog,
  ShieldCheck,
  Trash2,
} from "lucide-react";
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
  AlertDialogTrigger,
} from "../../ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
  formatDate,
  freshnessLabel,
  serverStatusLabel,
  vpsDisplayName,
  vpsHostId,
} from "../../../lib/dashboard-formatters";
import type { DashboardOverview, VpsRecord } from "../../../lib/api";
import { formatUptime } from "../shared/formatUptime";
import { formatBytes } from "./helpers";
import { DockerMetricsPanel } from "./DockerMetricsPanel";
import { AgentLifecycleStatus, agentJobFor } from "./AgentLifecycleStatus";
import { LocalAgentUpdate } from "./LocalAgentUpdate";

// ── ServerCard ───────────────────────────────────────────────────────

export function ServerCard({
  vps,
  metric,
  systemInfo,
  dockerMetrics,
  jobs,
  busy,
  password,
  onPasswordChange,
  onProvision,
  onVerify,
  onInstallAgent,
  onUninstallAgent,
  onUpgradeAgent,
  onRestartAgent,
  onRotateAgent,
  onToggleDockerMetrics,
  onDelete,
  mode,
  onEdit,
}: {
  vps: VpsRecord;
  metric?: DashboardOverview["metrics"][number];
  systemInfo?: DashboardOverview["systemInfo"][number];
  dockerMetrics?: DashboardOverview["dockerMetrics"][number];
  jobs: DashboardOverview["jobs"];
  busy: boolean;
  password: string;
  onPasswordChange: (id: string, value: string) => void;
  onProvision: (vps: VpsRecord) => void;
  onVerify: (vps: VpsRecord) => void;
  onInstallAgent: (vps: VpsRecord) => void;
  onUninstallAgent: (vps: VpsRecord) => void;
  onUpgradeAgent: (vps: VpsRecord) => void;
  onRestartAgent: (vps: VpsRecord) => void;
  onRotateAgent: (vps: VpsRecord) => void;
  onToggleDockerMetrics: (vps: VpsRecord) => void;
  onDelete: (vps: VpsRecord) => void;
  mode: "demo" | "local";
  onEdit: (vps: VpsRecord) => void;
}) {
  const isLocalHost = vps.kind === "local" || vps.managedBy === "system";
  const isReady = isLocalHost || Boolean(vps.keyProvisionedAt);
  const isDown = vps.status === "unreachable";
  const [showPassword, setShowPassword] = useState(false);
  const [addressHidden, setAddressHidden] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<VpsRecord | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<VpsRecord | null>(null);
  const [upgradeTarget, setUpgradeTarget] = useState<VpsRecord | null>(null);
  const [restartTarget, setRestartTarget] = useState<VpsRecord | null>(null);
  const [rotateAgentTarget, setRotateAgentTarget] = useState<VpsRecord | null>(null);
  const displayName = vpsDisplayName(vps);
  const hostId = vpsHostId(vps);
  const osLabel =
    systemInfo?.os?.prettyName ||
    systemInfo?.os?.name ||
    systemInfo?.os?.family ||
    "OS not reported";
  const specsLabel = systemInfo
    ? [
        systemInfo.cpu?.cores ? `${systemInfo.cpu.cores} cores` : null,
        systemInfo.memory?.totalBytes
          ? `${formatBytes(systemInfo.memory.totalBytes)} RAM`
          : null,
        systemInfo.rootDisk?.totalBytes
          ? `${formatBytes(systemInfo.rootDisk.totalBytes)} disk`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const agentJob = agentJobFor(vps, jobs);
  const systemFacts = systemInfo
    ? [
        [systemInfo.kernel?.release, systemInfo.kernel?.arch]
          .filter(Boolean)
          .join(" · ") || null,
        systemInfo.cpu?.model || null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const agentActionRunning = Boolean(
    agentJob && (agentJob.status === "queued" || agentJob.status === "running"),
  );
  const showInstall =
    !agentActionRunning &&
    vps.agentStatus !== "online" &&
    vps.agentStatus !== "offline";
  const canUpgrade = mode !== "demo" && !isLocalHost && !agentActionRunning &&
    (vps.agentStatus === "online" || vps.agentStatus === "offline" || vps.agentStatus === "failed");
  const canRestart = mode !== "demo" && !isLocalHost && isReady && !agentActionRunning &&
    (vps.agentStatus === "offline" || vps.agentStatus === "failed");
  const canRotateAgent = mode !== "demo" && isLocalHost && !agentActionRunning;

  const handlePasswordKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = password.trim();
      if (!trimmed) {
        setPasswordError("Password cannot be empty");
        return;
      }
      setPasswordError("");
      setConfirmOpen(true);
    }
  };

  return (
    <article
      aria-label={`Server ${displayName}`}
      className={`min-w-0 overflow-hidden border bg-panel transition-colors ${isDown ? "border-crit/30" : "border-line hover:border-dim/60"}`}
    >
      <div className="grid min-w-0 gap-5 p-5">
        {/* Identity: name → status → endpoint → os/location → specs */}
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h3 className="min-w-0 break-words text-lg font-semibold leading-tight tracking-[-0.02em] text-text">
              {displayName}
            </h3>
            <ServerHealthStatus status={vps.status} />
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[13px] leading-5 text-dim">
            <span
              className="tnum inline-block min-w-[12rem] font-mono"
              aria-label={addressHidden ? "Server address hidden" : `Server address ${vps.host}:${vps.port}`}
            >
              {addressHidden ? "••••••••••••:••••" : `${vps.host}:${vps.port}`}
            </span>
            <button
              type="button"
              className="inline-grid h-7 w-7 shrink-0 place-items-center border border-line text-dim transition-colors hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-signal"
              aria-label={addressHidden ? "Show server address" : "Hide server address"}
              aria-pressed={addressHidden}
              title={addressHidden ? "Show server address" : "Hide server address"}
              onClick={() => setAddressHidden((hidden) => !hidden)}
            >
              {addressHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
            </button>
          </div>
          <p className="mt-1 truncate text-[12px] text-dim" title={osLabel}>
            {osLabel}
          </p>
          <p className="mt-0.5 text-[12px] text-dim">
            {specsLabel ?? "System info not reported yet."}
          </p>
          {systemFacts ? (
            <p className="mt-0.5 truncate text-[11px] text-dim" title={systemFacts}>
              {systemFacts}
            </p>
          ) : null}
          {hostId ? (
            <p className="mt-1 break-all font-mono text-[11px] text-dim">
              Host ID: {hostId}
            </p>
          ) : null}
          <ServerLocationMeta vps={vps} />
          <ServerAnnotations vps={vps} />
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-dim">
            <Clock3 size={13} aria-hidden="true" />
            <span>Seen {formatDate(vps.lastSeenAt)}</span>
          </div>
        </div>

        {/* Meters: 4px tonal bars */}
        <div className="grid min-w-0 gap-3">
          <TelemetryMeter label="CPU" value={metric?.cpu} />
          <TelemetryMeter label="RAM" value={metric?.memory} />
          <TelemetryMeter label="Disk" value={metric?.disk} />
          <div className="flex items-baseline justify-between gap-3 text-[12px]">
            <span className="text-dim">Load</span>
            <span className="tnum text-dim">{metric ? metric.loadAverage : "n/a"}</span>
          </div>
        </div>

        {/* Docker box */}
        <div className="min-w-0 border border-line bg-ink/40">
          <DockerMetricsPanel
            vps={vps}
            dockerMetrics={dockerMetrics}
            busy={busy}
            onToggle={onToggleDockerMetrics}
          />
        </div>

        {/* Actions footer */}
        <div className="flex min-w-0 flex-col gap-3 border-t border-line pt-4 xl:flex-row xl:items-center xl:justify-between">
          <ServerRuntimeMeta
            vps={vps}
            metric={metric}
            systemInfo={systemInfo}
            jobs={jobs}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
          <Button asChild type="button" size="sm" variant="default">
            <Link
              to={`/vps/${encodeURIComponent(vps.id)}`}
              aria-label={`Manage ${displayName}`}
            >
              <Server size={16} />
              <span>Manage</span>
            </Link>
          </Button>
          {isLocalHost ? (
            <span className="inline-flex h-9 items-center gap-2 px-2 text-sm text-dim">
              <Activity size={16} aria-hidden="true" />
              Managed locally
            </span>
          ) : isReady ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onVerify(vps)}
              >
                <ShieldCheck size={16} />
                Verify access
              </Button>
              {showInstall ? <Button
                type="button"
                size="sm"
                variant="default"
                disabled={busy}
                onClick={() => onInstallAgent(vps)}
              >
                <DownloadCloud size={16} />
                {vps.agentStatus === "failed" ? "Retry install" : "Install agent"}
              </Button> : null}
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setShowPassword((value) => !value)}
              >
                <KeyRound size={16} />
                Install key
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onVerify(vps)}
              >
                <ShieldCheck size={16} />
                Verify access
              </Button>
            </>
          )}
          <ServerOverflow
            vps={vps}
            busy={busy}
            isLocalHost={isLocalHost}
            onRotate={() => setShowPassword(true)}
            canUpgrade={canUpgrade}
            canRestart={canRestart}
            canRotateAgent={canRotateAgent}
            onRequestUpgrade={() => {
              window.setTimeout(() => setUpgradeTarget(vps), 0);
            }}
            onRequestRestart={() => window.setTimeout(() => setRestartTarget(vps), 0)}
            onRequestRotateAgent={() => window.setTimeout(() => setRotateAgentTarget(vps), 0)}
            onRequestUninstall={() => {
              window.setTimeout(() => setUninstallTarget(vps), 0);
            }}
            onRequestDelete={() => {
              window.setTimeout(() => setDeleteTarget(vps), 0);
            }}
            mode={mode}
            onEdit={() => window.setTimeout(() => onEdit(vps), 0)}
          />
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-1 text-xs xl:order-first xl:grid-cols-1">
            <div className="flex items-center gap-2"><span className="text-dim">Agent</span><AgentLifecycleStatus vps={vps} jobs={jobs} compact /></div>
            <div className="flex items-center gap-2"><span className="text-dim">Access</span><span className={isReady ? "text-signal" : "text-warn"}>{isLocalHost ? "Local" : isReady ? "Key ready" : "Needs password"}</span></div>
            {isLocalHost ? <LocalAgentUpdate vps={vps} variant="card" /> : null}
          </div>
        </div>
      </div>
      {isDown ? (
        <div className="flex items-center gap-2 border-t border-crit/30 bg-crit/5 px-5 py-2 text-[12px] text-crit">
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="min-w-0">
            No heartbeat since {formatDate(vps.lastSeenAt)} ({freshnessLabel(metric?.collectedAt ?? vps.lastSeenAt)}). Check power, firewall and SSH key.
          </span>
        </div>
      ) : null}
      {/* Delete confirmation – rendered outside DropdownMenu to avoid focus-trap nesting */}
      <AlertDialog
        open={deleteTarget?.id === vps.id}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the server record for {vps.username}@
              {vps.host}:{vps.port}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onDelete(vps);
              }}
            >
              Delete server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={restartTarget?.id === vps.id} onOpenChange={(open) => { if (!open) setRestartTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Restart agent on {displayName}?</AlertDialogTitle><AlertDialogDescription>This restarts the monitoring agent only. It does not reboot the VPS.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (!busy) onRestartAgent(vps); setRestartTarget(null); }}>Restart agent</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={rotateAgentTarget?.id === vps.id} onOpenChange={(open) => { if (!open) setRotateAgentTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Rotate agent credential on {displayName}?</AlertDialogTitle><AlertDialogDescription>The agent credential is replaced without exposing the token. The agent reconnects automatically.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (!busy) onRotateAgent(vps); setRotateAgentTarget(null); }}>Rotate credential</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      {/* Uninstall confirmation – outside DropdownMenu so focus is restored cleanly */}
      <AlertDialog open={upgradeTarget?.id === vps.id} onOpenChange={(open) => { if (!open) setUpgradeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Upgrade agent on {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>Monitoring will pause briefly while the agent is upgraded. If the upgrade cannot complete, the previous version is restored automatically. Existing credentials are preserved and are not changed or stored again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { onUpgradeAgent(vps); setUpgradeTarget(null); }}>Upgrade agent</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={uninstallTarget?.id === vps.id}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall agent from {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Monitoring from this agent will stop. The server record and SSH access stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onUninstallAgent(vps);
                setUninstallTarget(null);
              }}
            >
              Uninstall agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {showPassword && !isLocalHost ? (
        <form
          onSubmit={(event) => event.preventDefault()}
          autoComplete="off"
          className="grid gap-2 border-t border-line bg-ink/40 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <Label>
            {isReady ? "One-time password for rotation" : "One-time password"}
            <Input
              type="password"
              maxLength={4096}
              autoComplete="new-password"
              placeholder="Used once to install or rotate the key"
              value={password}
              onChange={(event) => {
                onPasswordChange(vps.id, event.target.value);
                if (passwordError) setPasswordError("");
              }}
              onKeyDown={handlePasswordKeyDown}
            />
            {passwordError ? (
              <p className="mt-1 text-xs font-normal text-crit">
                {passwordError}
              </p>
            ) : null}
          </Label>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                disabled={busy || !password.trim()}
                className="self-end rounded-none"
              >
                <KeyRound size={16} />
                {isReady ? "Rotate key" : "Install key"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {isReady ? "Rotate SSH key?" : "Install SSH key?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This will connect to {displayName} and update authorized SSH
                  access using the one-time password. The password will not be
                  stored.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    onProvision(vps);
                  }}
                >
                  {isReady ? "Rotate key" : "Install key"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </form>
      ) : null}
    </article>
  );
}

function ServerHealthStatus({ status }: { status?: VpsRecord["status"] }) {
  const isDown = status === "unreachable";
  const label = serverStatusLabel(status);
  const tone =
    status === "healthy"
      ? "border-signal/40 bg-signal/10 text-signal"
      : status === "warning"
        ? "border-warn/40 bg-warn/10 text-warn"
        : isDown
          ? "border-crit/40 bg-crit/10 text-crit"
          : "border-line bg-raised text-dim";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-0.5 text-[11px] font-medium ${tone}`}
      aria-label={`Host status: ${label}`}
      title={`Host status: ${label}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === "healthy" ? "pulse" : ""}`} aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

// ── ServerRuntimeMeta ────────────────────────────────────────────────

function ServerRuntimeMeta({
  vps,
  metric,
  systemInfo,
  jobs,
}: {
  vps: VpsRecord;
  metric?: DashboardOverview["metrics"][number];
  systemInfo?: DashboardOverview["systemInfo"][number];
  jobs: DashboardOverview["jobs"];
}) {
  const runningJobs = jobs.filter((job) => job.status === "running").length;
  const parts = [
    systemInfo?.agentVersion ? `Agent ${systemInfo.agentVersion}` : null,
    metric ? `Uptime ${formatUptime(metric.uptime)}` : null,
    metric ? `Last check ${freshnessLabel(metric.collectedAt)}` : null,
    `${runningJobs} running job${runningJobs === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <div className="min-w-0 text-xs font-normal leading-5 text-dim">
      <p className="whitespace-normal" title={parts.join(" / ")}>
        {parts.join(" · ")}
      </p>
      <p
        className="mt-0.5 break-all font-mono text-[10px] leading-4 text-dim"
        title={`Server ID: ${vps.id} · SSH user: ${vps.username}`}
      >
        ID {vps.id} · SSH {vps.username}
      </p>
    </div>
  );
}

// ── Compact metadata helpers ─────────────────────────────────────────

function ServerLocationMeta({ vps }: { vps: VpsRecord }) {
  const location = [vps.city, vps.country].filter(Boolean).join(", ") || "Location not detected";
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-dim">
      <span className="inline-flex min-w-0 items-center gap-1">
        <ServerCog size={12} aria-hidden="true" />
        <span className="truncate">{vps.provider || "Provider not set"}</span>
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <MapPin size={12} aria-hidden="true" />
        <span className="truncate" title={location}>{location}</span>
      </span>
    </div>
  );
}

function ServerAnnotations({ vps }: { vps: VpsRecord }) {
  return (
    <>
      {vps.tags?.length ? (
        <p
          className="mt-1.5 truncate text-[11px] text-dim"
          title={`Tags: ${vps.tags.join(", ")}`}
        >
          Tags · {vps.tags.join(", ")}
        </p>
      ) : null}
      {vps.notes ? (
        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-dim">
          {vps.notes}
        </p>
      ) : null}
    </>
  );
}

function TelemetryMeter({ label, value }: { label: string; value?: number }) {
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const normalizedValue = hasValue ? Math.min(100, Math.max(0, value)) : 0;
  const meterTone = !hasValue
    ? "text-dim"
    : value >= 85
      ? "text-crit"
      : value >= 70
        ? "text-warn"
        : "text-signal";
  const meterColor = !hasValue
    ? "bg-line"
    : value >= 85
      ? "bg-crit"
      : value >= 70
        ? "bg-warn"
        : "bg-signal";

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-dim">{label}</span>
        <span className={`tnum ${meterTone}`}>{hasValue ? `${value.toFixed(1)}%` : "n/a"}</span>
      </div>
      {hasValue ? (
        <div
          role="progressbar"
          aria-label={`${label} utilization`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={normalizedValue}
          className="mt-1.5 h-1 w-full overflow-hidden bg-line"
        >
          <div
            className={`h-full ${meterColor} transition-all duration-500`}
            style={{ width: `${normalizedValue}%` }}
          />
        </div>
      ) : (
        <div className="mt-1.5 h-1 w-full bg-line" aria-hidden="true" />
      )}
    </div>
  );
}

// ── ServerOverflow ───────────────────────────────────────────────────

function ServerOverflow({
  vps,
  busy,
  isLocalHost,
  onRotate,
  canUpgrade,
  canRestart,
  canRotateAgent,
  onRequestUpgrade,
  onRequestRestart,
  onRequestRotateAgent,
  onRequestUninstall,
  onRequestDelete,
  mode,
  onEdit,
}: {
  vps: VpsRecord;
  busy: boolean;
  isLocalHost: boolean;
  onRotate: () => void;
  canUpgrade: boolean;
  canRestart: boolean;
  canRotateAgent: boolean;
  onRequestUpgrade: () => void;
  onRequestRestart: () => void;
  onRequestRotateAgent: () => void;
  onRequestUninstall: () => void;
  onRequestDelete: () => void;
  mode: "demo" | "local";
  onEdit: () => void;
}) {
  const displayName = vpsDisplayName(vps);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`More actions for ${displayName}`}
        >
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 rounded-none">
        {isLocalHost ? null : (
          <DropdownMenuItem disabled={busy || !canUpgrade} onClick={onRequestUpgrade}>
            <RotateCw size={15} />
            Upgrade agent
          </DropdownMenuItem>
        )}
        {canRestart ? <DropdownMenuItem disabled={busy} onClick={onRequestRestart}><RotateCw size={15} />Restart agent</DropdownMenuItem> : null}
        {isLocalHost ? <DropdownMenuItem disabled={busy || !canRotateAgent} onClick={onRequestRotateAgent}><KeyRound size={15} />Rotate agent credential</DropdownMenuItem> : null}
        <DropdownMenuItem onClick={onRotate} disabled={busy || isLocalHost}>
          <KeyRound size={15} />
          Reinstall SSH key
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy || isLocalHost || mode === "demo"}
          onClick={onEdit}
          title={mode === "demo" ? "Editing is unavailable in demo mode." : isLocalHost ? "Local servers are managed by the system." : undefined}
          aria-label={`Edit server${mode === "demo" ? ": unavailable in demo mode" : isLocalHost ? ": local servers are system managed" : ""}`}
        >
          <Edit3 size={15} />
          Edit server
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={busy || isLocalHost}
          onClick={onRequestDelete}
        >
          <Trash2 size={15} />
          Remove server
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
