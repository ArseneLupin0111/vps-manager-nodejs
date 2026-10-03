import { describe, expect, it } from "vitest";
import { projectHistory } from "../src/metrics/metric-history.js";
import type { MetricSample } from "../src/metrics/metrics.models.js";

const sample = (second: number, patch: Partial<MetricSample> = {}): MetricSample => ({
  vpsId: "host-a", cpu: second, memory: 40 + second, disk: 10,
  loadAverage: 1, networkRx: 100 * second, networkTx: 50 * second,
  uptime: 100 + second, collectedAt: `2026-10-03T12:00:${String(second).padStart(2, "0")}.000Z`,
  source: "agent", networkUnit: "bytes/s", networkAvailable: true, ...patch,
});

describe("host metric history", () => {
  it("keeps acquisition order and aligned CPU/RAM/RX/TX while capping late arrivals", () => {
    const rows = [sample(3), sample(1, { receivedAt: "2026-10-03T12:01:00.000Z" }), sample(2)];
    const history = projectHistory(rows, 2)!;
    expect(history.timestamps).toEqual([sample(2).collectedAt, sample(3).collectedAt]);
    expect(history.cpu).toEqual([2, 3]);
    expect(history.memory).toEqual([42, 43]);
    expect(history.networkRx).toEqual([200, 300]);
    expect(history.networkTx).toEqual([100, 150]);
    expect(rows.map(row => row.cpu)).toEqual([3, 1, 2]);
  });

  it("preserves first/reset gaps and real zero throughput without relabeling cumulative legacy data", () => {
    const history = projectHistory([
      sample(1, { networkAvailable: false }),
      sample(2, { networkRx: 0, networkTx: 0 }),
      sample(3, { source: "local-agent", networkUnit: undefined, networkRx: 900000 }),
      sample(4, { networkAvailable: false }),
      sample(5),
    ])!;
    expect(history.networkRx).toEqual([null, 0, null, null, 500]);
    expect(history.networkTx).toEqual([null, 0, null, null, 250]);
    expect(history.memory).toEqual([41, 42, 43, 44, 45]);
    expect(history.networkUnit).toBe("bytes/s");
  });
});
