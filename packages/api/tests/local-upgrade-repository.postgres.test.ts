import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { loadMigrations } from "../src/db/migrations.js";
import { createPostgresLocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.postgres.repository.js";
import type { LocalUpgradeJob } from "../src/local-upgrade/local-upgrade.models.js";

const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;

const TERMINAL_RESULT = {
  outcome: "succeeded",
  reportedBuildId: "build-new",
  heartbeatBuildId: "build-new",
  completedAt: "2026-09-27T00:00:00.000Z",
} as const;

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lug_1",
    vps_id: "vps-1",
    state: "succeeded",
    progress: 100,
    release_id: "rel-1",
    release_version: "1.0.0",
    release_build_id: "build-new",
    target_sha256: "abc",
    target_url: "https://example.invalid/agent.tar.gz",
    target_size_bytes: null,
    manifest_raw: "{}",
    baseline_build_id: null,
    baseline_heartbeat_at: null,
    actor: "test",
    idempotency_key: null,
    fencing_token: 1,
    reclaim_count: 0,
    claimed_at: null,
    lease_expires_at: null,
    deadline_at: new Date("2026-09-27T00:30:00.000Z"),
    phase_deadline_at: null,
    message: null,
    error_code: null,
    error_message: null,
    result: { ...TERMINAL_RESULT },
    revision: 1,
    created_at: new Date("2026-09-27T00:00:00.000Z"),
    updated_at: new Date("2026-09-27T00:00:00.000Z"),
    completed_at: new Date("2026-09-27T00:00:00.000Z"),
    ...overrides,
  };
}

function baseJob(): LocalUpgradeJob {
  const now = "2026-09-27T00:00:00.000Z";
  return {
    id: "lug_live_1",
    vpsId: "vps-live-1",
    state: "queued",
    progress: null,
    releaseId: "rel-1",
    releaseVersion: "1.0.0",
    releaseBuildId: "build-new",
    targetSha256: "abc",
    targetUrl: "https://example.invalid/agent.tar.gz",
    manifestRaw: "{}",
    actor: "test",
    fencingToken: 1,
    reclaimCount: 0,
    claimedAt: null,
    leaseExpiresAt: null,
    deadlineAt: "2026-09-27T00:30:00.000Z",
    error: null,
    result: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

describe("local-upgrade postgres migration (021)", () => {
  it("defines result as jsonb", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find((m) => m.id === "021_local_agent_upgrades.sql");
    expect(migration).toBeDefined();
    expect(migration!.sql).toMatch(/result\s+jsonb/i);
  });
});

describe("local-upgrade postgres CAS result (deterministic SQL fake)", () => {
  it("persists a result-only patch as stringified JSONB instead of dropping it", async () => {
    const query = vi.fn(async () => ({ rows: [baseRow()] }));
    const repo = createPostgresLocalUpgradeRepository({ query } as never);

    // Regression: COLUMNS excludes "result", so a result-only patch used to hit
    // `if (!column) continue` and return undefined without issuing SQL.
    const updated = await repo.compareAndSet("lug_1", 0, {
      result: { ...TERMINAL_RESULT },
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("result = $");
    expect(sql).toContain("revision = revision + 1");
    expect(sql).toContain("WHERE id = $1 AND revision = $2");
    expect(values).toContainEqual(JSON.stringify(TERMINAL_RESULT));
    expect(updated?.result).toEqual(TERMINAL_RESULT);
    expect(updated?.revision).toBe(1);
  });

  it("preserves null semantics when clearing the terminal outcome", async () => {
    const query = vi.fn(async () => ({ rows: [baseRow({ result: null })] }));
    const repo = createPostgresLocalUpgradeRepository({ query } as never);

    const updated = await repo.compareAndSet("lug_1", 1, { result: null });

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("result = $");
    expect(values).toContain(null);
    expect(updated?.result).toBeNull();
  });

  it("preserves the CAS revision guard on conflict", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repo = createPostgresLocalUpgradeRepository({ query } as never);

    await expect(
      repo.compareAndSet("lug_1", 999, { result: { ...TERMINAL_RESULT } }),
    ).resolves.toBeUndefined();
  });
});

describe("local-upgrade postgres terminal outcome (live PostgreSQL)", () => {
  it.skipIf(!databaseUrl)("persists and retrieves terminal outcome with CAS revision", async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schema = `vps_manager_lug_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query("CREATE TABLE vps (id text PRIMARY KEY)");
      const migrations = await loadMigrations();
      await pool.query(migrations.find((m) => m.id === "021_local_agent_upgrades.sql")!.sql);
      await pool.query("INSERT INTO vps (id) VALUES ('vps-live-1')");

      const repo = createPostgresLocalUpgradeRepository(pool);
      await repo.create(baseJob());

      const updated = await repo.compareAndSet("lug_live_1", 0, {
        state: "succeeded",
        result: { ...TERMINAL_RESULT },
        completedAt: "2026-09-27T00:00:00.000Z",
      });
      expect(updated?.revision).toBe(1);
      expect(updated?.result).toEqual(TERMINAL_RESULT);

      const reloaded = await repo.get("lug_live_1");
      expect(reloaded?.result).toEqual(TERMINAL_RESULT);
      expect(reloaded?.revision).toBe(1);

      await expect(
        repo.compareAndSet("lug_live_1", 0, { result: { ...TERMINAL_RESULT } }),
      ).resolves.toBeUndefined();
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
