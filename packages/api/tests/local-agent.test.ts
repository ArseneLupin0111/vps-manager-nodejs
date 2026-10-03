import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { LocalAgentSupervisorService } from "../src/agents/local-agent-supervisor.service.js";
import {
  resetLocalMetricsTracking,
  collectSystemMetrics,
  buildLocalMetricSample,
  computeNetworkRate,
} from "../src/agents/local-system-metrics.js";
import { isFreshTimestamp } from "../src/monitoring/monitoring.service.js";

// ── Shared configs ───────────────────────────────────────────────────────

const localConfig: AppConfig = {
  mode: "local",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: true,
  dataDir: "data",
  privateDir: "private",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
  agentInstallIntervalSeconds: 1,
  allowInsecureAgentHttp: false,
  localAgentEnabled: true,
  storageDriver: "json",
  dbSsl: false,
  dbPoolMax: 10,
  dashboardSessionSecret: "local-test-session-secret-32+chars!!",
  dashboardSessionTtlSeconds: 86_400,
  dashboardCookieSecure: false,
  dashboardCookieSameSite: "lax",
  dashboardPublicOrigin: undefined,
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

const demoConfig: AppConfig = {
  ...localConfig,
  mode: "demo",
  localAgentEnabled: false,
};

const localAgentDisabledConfig: AppConfig = {
  ...localConfig,
  localAgentEnabled: false,
};

// ── Helpers ──────────────────────────────────────────────────────────────

async function createTempRepositories(tempDir: string) {
  const dataDir = join(tempDir, "data");
  return {
    vps: createVpsStore(join(dataDir, "vps.json")),
    metrics: createJsonMetricRepository(join(dataDir, "metrics.json")),
    agent: createJsonAgentRepository(join(dataDir, "agents.json")),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("LocalAgentSupervisorService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vps-manager-local-agent-"));
    resetLocalMetricsTracking();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a local host record on bootstrap (local mode)", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(
      localConfig,
      repos.vps,
      repos.metrics,
      repos.agent,
    );

    await service.onApplicationBootstrap();

    const records = await repos.vps.list();
    const localHost = records.find((r) => r.id === "vps_local_host");
    expect(localHost).toBeDefined();
    expect(localHost!.kind).toBe("local");
    expect(localHost!.managedBy).toBe("system");
    expect(localHost!.provider).toBe("local");
    expect(localHost!.tags).toContain("local-agent");
    expect(localHost!.name).toBeTruthy();

    // Cleanup
    service.stopCollection();
  });

  it("does not duplicate local host on second bootstrap", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(
      localConfig,
      repos.vps,
      repos.metrics,
      repos.agent,
    );

    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();

    const records = await repos.vps.list();
    const localHosts = records.filter((r) => r.id === "vps_local_host");
    expect(localHosts.length).toBe(1);

    service.stopCollection();
  });

  it("does not create local host in demo mode", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(
      demoConfig,
      repos.vps,
      repos.metrics,
      repos.agent,
    );

    await service.onApplicationBootstrap();

    const records = await repos.vps.list();
    const localHost = records.find((r) => r.id === "vps_local_host");
    expect(localHost).toBeUndefined();
  });

  it("does not create local host when localAgentEnabled=false", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(
      localAgentDisabledConfig,
      repos.vps,
      repos.metrics,
      repos.agent,
    );

    await service.onApplicationBootstrap();

    const records = await repos.vps.list();
    const localHost = records.find((r) => r.id === "vps_local_host");
    expect(localHost).toBeUndefined();
  });

  it("collectOnce appends metrics and updates agent state", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(
      localConfig,
      repos.vps,
      repos.metrics,
      repos.agent,
    );

    // Bootstrap to create the local host
    await service.onApplicationBootstrap();
    service.stopCollection();

    // Collect metrics
    await service.collectOnce();
    await service.collectOnce();

    // Check metrics were appended
    const latest = await repos.metrics.getLatest("vps_local_host");
    expect(latest).toBeDefined();
    expect(latest!.vpsId).toBe("vps_local_host");
    expect(latest!.cpu).toBeGreaterThanOrEqual(0);
    expect(latest!.cpu).toBeLessThanOrEqual(100);
    expect(latest!.memory).toBeGreaterThanOrEqual(0);
    expect(latest!.memory).toBeLessThanOrEqual(100);
    expect(latest!.source).toBe("local-agent");
    expect(latest!.agentVersion).toBe("0.1.0-local");

    // Check agent state
    const state = await repos.agent.getState("vps_local_host");
    expect(state).toBeDefined();
    expect(state!.status).toBe("online");
    expect(state!.version).toBe("0.1.0-local");
    expect(state!.lastSeenAt).toBeDefined();

    // Check VPS status updated
    const vps = await repos.vps.get("vps_local_host");
    expect(vps).toBeDefined();
    expect(vps!.status).toBe("healthy");
    expect(vps!.lastSeenAt).toBeDefined();

    service.stopCollection();
  });

  it("does not overwrite a real local agent heartbeat during fallback collection or shutdown", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(localConfig, repos.vps, repos.metrics, repos.agent);
    await service.onApplicationBootstrap();
    service.stopCollection();

    const buildId = "c1fcfce6813696796f99c18a9361e8d43808ff26";
    const lastSeenAt = new Date().toISOString();
    await repos.agent.upsertState({
      vpsId: "vps_local_host",
      status: "online",
      version: `0.1.0+${buildId}`,
      buildId,
      lastSeenAt,
    });

    await service.collectOnce();
    expect(await repos.agent.getState("vps_local_host")).toMatchObject({
      version: `0.1.0+${buildId}`,
      buildId,
      lastSeenAt,
      status: "online",
    });
    await service.onApplicationShutdown();
    expect(await repos.agent.getState("vps_local_host")).toMatchObject({
      version: `0.1.0+${buildId}`,
      buildId,
      lastSeenAt,
      status: "online",
    });
  });

  it("collectOnce captures window samples", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(
      localConfig,
      repos.vps,
      repos.metrics,
      repos.agent,
    );

    await service.onApplicationBootstrap();
    service.stopCollection();

    // Collect several times
    for (let i = 0; i < 5; i++) {
      await service.collectOnce();
    }

    const window = await repos.metrics.listWindow("vps_local_host");
    expect(window.length).toBe(5);

    service.stopCollection();
  });

  it("dashboard overview includes metrics from local agent", async () => {
    const repos = await createTempRepositories(tempDir);
    const service = new LocalAgentSupervisorService(
      localConfig,
      repos.vps,
      repos.metrics,
      repos.agent,
    );

    // Bootstrap and collect
    await service.onApplicationBootstrap();
    service.stopCollection();
    await service.collectOnce();

    // Verify metrics exist
    const latestMetrics = await repos.metrics.listLatest();
    expect(latestMetrics.length).toBeGreaterThanOrEqual(1);

    const localMetric = latestMetrics.find((m) => m.vpsId === "vps_local_host");
    expect(localMetric).toBeDefined();

    // Verify freshness
    expect(
      isFreshTimestamp(localMetric!.receivedAt ?? localMetric!.collectedAt),
    ).toBe(true);

    service.stopCollection();
  });
});

describe("collectSystemMetrics", () => {
  beforeEach(() => {
    resetLocalMetricsTracking();
  });

  it("returns valid metrics structure", () => {
    const metrics = collectSystemMetrics();
    expect(metrics).toHaveProperty("cpu");
    expect(metrics).toHaveProperty("memory");
    expect(metrics).toHaveProperty("disk");
    expect(metrics).toHaveProperty("loadAverage");
    expect(metrics).toHaveProperty("networkRx");
    expect(metrics).toHaveProperty("networkTx");
    expect(metrics).toHaveProperty("networkUnit");
    expect(metrics).toHaveProperty("networkAvailable");
    expect(metrics).toHaveProperty("uptime");

    expect(metrics.cpu).toBeGreaterThanOrEqual(0);
    expect(metrics.cpu).toBeLessThanOrEqual(100);
    expect(metrics.memory).toBeGreaterThanOrEqual(0);
    expect(metrics.memory).toBeLessThanOrEqual(100);
    expect(metrics.loadAverage).toBeGreaterThanOrEqual(0);
    expect(metrics.uptime).toBeGreaterThanOrEqual(0);

    // Network throughput contract: explicit unit on every sample,
    // non-negative rates, availability flag present.
    expect(metrics.networkUnit).toBe("bytes/s");
    expect(typeof metrics.networkAvailable).toBe("boolean");
    expect(metrics.networkRx).toBeGreaterThanOrEqual(0);
    expect(metrics.networkTx).toBeGreaterThanOrEqual(0);
    // First sample after reset has no baseline: gap, not a zero reading.
    expect(metrics.networkAvailable).toBe(false);
    expect(metrics.networkRx).toBe(0);
    expect(metrics.networkTx).toBe(0);
  });

  it("buildLocalMetricSample creates correct sample", () => {
    const metrics = collectSystemMetrics();
    const sample = buildLocalMetricSample("vps_local_host", metrics);

    expect(sample.vpsId).toBe("vps_local_host");
    expect(sample.cpu).toBe(metrics.cpu);
    expect(sample.memory).toBe(metrics.memory);
    expect(sample.source).toBe("local-agent");
    expect(sample.agentVersion).toBe("0.1.0-local");
    expect(sample.collectedAt).toBeTruthy();
    expect(sample.receivedAt).toBeTruthy();

    // Throughput contract flows through to the wire sample.
    expect(sample.networkUnit).toBe("bytes/s");
    expect(sample.networkAvailable).toBe(metrics.networkAvailable);
    expect(sample.networkRx).toBe(metrics.networkRx);
    expect(sample.networkTx).toBe(metrics.networkTx);
  });
});

describe("computeNetworkRate", () => {
  beforeEach(() => {
    resetLocalMetricsTracking();
  });

  it("marks the first sample unavailable and baselines", () => {
    const first = computeNetworkRate({ rx: 3000, tx: 1100 }, 1_000);
    expect(first).toEqual({ rx: 0, tx: 0, available: false });

    // 3000 rx / 1100 tx bytes over 1s => rates equal deltas.
    const second = computeNetworkRate({ rx: 6000, tx: 2200 }, 2_000);
    expect(second.available).toBe(true);
    expect(second.rx).toBe(3000);
    expect(second.tx).toBe(1100);
  });

  it("suppresses both directions on counter reset and recovers", () => {
    computeNetworkRate({ rx: 10_000, tx: 5_000 }, 1_000);

    // Either direction going backwards invalidates the whole interval —
    // no partial rate may leak through the other direction.
    const reset = computeNetworkRate({ rx: 2_000, tx: 6_000 }, 2_000);
    expect(reset).toEqual({ rx: 0, tx: 0, available: false });

    // Counters advance past the reset baseline: clean recovery.
    const recovered = computeNetworkRate({ rx: 3_000, tx: 6_500 }, 3_000);
    expect(recovered.available).toBe(true);
    expect(recovered.rx).toBe(1000);
    expect(recovered.tx).toBe(500);
  });

  it("marks non-advancing clocks unavailable and keeps the baseline", () => {
    computeNetworkRate({ rx: 3_000, tx: 1_100 }, 1_000);

    const stalled = computeNetworkRate({ rx: 6_000, tx: 2_200 }, 1_000);
    expect(stalled).toEqual({ rx: 0, tx: 0, available: false });

    // Next sample with a live clock covers the full window.
    const after = computeNetworkRate({ rx: 6_000, tx: 2_200 }, 3_000);
    expect(after.available).toBe(true);
    expect(after.rx).toBe(1500);
    expect(after.tx).toBe(550);
  });

  it("marks unreadable counters unavailable without losing the baseline", () => {
    computeNetworkRate({ rx: 3_000, tx: 1_100 }, 1_000);

    const unreadable = computeNetworkRate(null, 2_000);
    expect(unreadable).toEqual({ rx: 0, tx: 0, available: false });

    const after = computeNetworkRate({ rx: 6_000, tx: 2_200 }, 3_000);
    expect(after.available).toBe(true);
    expect(after.rx).toBe(1500);
    expect(after.tx).toBe(550);
  });
});
