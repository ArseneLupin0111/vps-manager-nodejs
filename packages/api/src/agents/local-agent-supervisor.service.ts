import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import * as os from "node:os";
import type { AppConfig } from "../config/app-config.js";
import {
  APP_CONFIG,
  VPS_REPOSITORY,
  METRIC_REPOSITORY,
  AGENT_REPOSITORY,
} from "../tokens.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { MetricRepository } from "../persistence/repositories/metric.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { VpsRecord } from "../vps/vps.models.js";
import {
  collectSystemMetrics,
  buildLocalMetricSample,
  resetCpuTracking,
} from "./local-system-metrics.js";

/**
 * Default local host ID used for the local agent record.
 * Override with LOCAL_HOST_ID env var if needed.
 */
const DEFAULT_LOCAL_HOST_ID = "vps_local_host";

/**
 * Minimum interval between metric collections (5 seconds).
 * Prevents too-frequent collections when agentInstallIntervalSeconds is very low.
 */
const MIN_COLLECT_INTERVAL_MS = 5_000;

@Injectable()
export class LocalAgentSupervisorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private localHostId: string;
  private started = false;
  private stopping = false;
  private collectionInFlight: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(METRIC_REPOSITORY)
    private readonly metricRepository: MetricRepository,
    @Inject(AGENT_REPOSITORY) private readonly agentRepository: AgentRepository,
  ) {
    this.localHostId = process.env.LOCAL_HOST_ID ?? DEFAULT_LOCAL_HOST_ID;
  }

  /**
   * Bootstrap lifecycle: ensure local host record exists and start collection.
   * Only runs in local mode when localAgentEnabled is true.
   * Never runs in demo mode.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.mode !== "local") return;
    if (this.config.localAgentEnabled !== true) return;
    this.stopping = false;
    await this.ensureLocalHost();
    this.startCollection();
    this.started = true;
  }

  /**
   * Shutdown lifecycle: clear interval and mark agent offline.
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.stopCollection();
    await this.collectionInFlight;
    if (this.started) {
      await this.markAgentOffline();
    }
  }

  /**
   * Ensure the local host record exists in the VPS repository.
   * Safe to call multiple times — it upserts by stable ID.
   */
  private async ensureLocalHost(): Promise<VpsRecord> {
    const hostname = os.hostname() || "Local host";
    const username = os.userInfo().username || "root";

    // Try to get external IPv4
    let host = hostname;
    try {
      const interfaces = os.networkInterfaces();
      for (const iface of Object.values(interfaces)) {
        if (!iface) continue;
        for (const addr of iface) {
          if (addr.family === "IPv4" && !addr.internal) {
            host = addr.address;
            break;
          }
        }
        if (host !== hostname) break;
      }
    } catch {
      // Fallback to hostname
    }

    return this.vpsRepository.ensureLocalHost({
      id: this.localHostId,
      name: hostname,
      host,
      port: 22,
      username,
      provider: "local",
      tags: ["local", "local-agent", "system"],
      status: "unknown",
      kind: "local",
      managedBy: "system",
      notes: `Local agent auto-managed. Host: ${hostname}, User: ${username}`,
    });
  }

  /**
   * Start periodic metric collection.
   */
  private startCollection(): void {
    if (this.intervalTimer || this.startupTimer) return;

    const intervalSeconds = Math.max(
      this.config.agentInstallIntervalSeconds,
      MIN_COLLECT_INTERVAL_MS / 1000,
    );
    const intervalMs = intervalSeconds * 1000;

    // Initial collection after a short delay (let the app fully initialize)
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.collectOnce();
    }, 1_000);

    this.intervalTimer = setInterval(() => {
      this.collectOnce();
    }, intervalMs);
  }

  /**
   * Stop the collection interval.
   */
  stopCollection(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Collect metrics once and push them to repositories.
   * Exposed as public for testing.
   */
  async collectOnce(): Promise<void> {
    if (this.stopping) return;
    if (this.collectionInFlight) return this.collectionInFlight;
    this.collectionInFlight = this.collectOnceInternal().finally(() => {
      this.collectionInFlight = null;
    });
    return this.collectionInFlight;
  }

  private async collectOnceInternal(): Promise<void> {
    try {
      const metrics = collectSystemMetrics();
      const sample = buildLocalMetricSample(this.localHostId, metrics);

      // Append metric sample
      await this.metricRepository.append(sample, this.config.metricWindowLimit);

      // The in-process collector is a fallback for hosts without a real agent.
      // Never replace the signed agent's heartbeat/build identity with synthetic state.
      const now = new Date().toISOString();
      const currentState = await this.agentRepository.getState(this.localHostId);
      if (!currentState || currentState.version === "0.1.0-local") {
        await this.agentRepository.upsertState({
          vpsId: this.localHostId,
          status: "online",
          version: "0.1.0-local",
          lastSeenAt: now,
        });
      }

      // Update VPS record lastSeenAt/status
      await this.vpsRepository.markSeen(this.localHostId, "healthy", now);
    } catch (error: unknown) {
      // Log but don't crash the service
      console.error(
        "[LocalAgentSupervisor] collectOnce error:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Mark the local agent as offline on shutdown.
   */
  private async markAgentOffline(): Promise<void> {
    try {
      const currentState = await this.agentRepository.getState(this.localHostId);
      if (!currentState || currentState.version === "0.1.0-local") {
        const now = new Date().toISOString();
        await this.agentRepository.upsertState({
          vpsId: this.localHostId,
          status: "offline",
          version: "0.1.0-local",
          lastSeenAt: now,
        });
      }
    } catch {
      // Best effort on shutdown
    }
  }
}
