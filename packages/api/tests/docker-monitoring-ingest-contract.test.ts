import { describe, expect, it } from "vitest";
import {
  DOCKER_INGEST_DIGEST_VERSION,
  DOCKER_INGEST_LEGACY_DIGEST_VERSION,
  canonicalDockerJson,
  compareDockerSourceSequence,
  compareDockerWatermarks,
  dockerIngestRequestDigest,
} from "../src/docker/docker-monitoring.schemas.js";
import {
  DockerIngestConflict,
  type DockerIngestResult,
  type DockerIngestUnit,
} from "../src/docker/docker-monitoring.models.js";

const hostSample = {
  id: "sample-1",
  vpsId: "vps-1",
  agentInstanceId: "agent-1",
  snapshotId: "snap-1",
  collectedAt: "2026-01-01T00:00:00.000Z",
  receivedAt: "2026-01-01T00:00:01.000Z",
  effectiveAt: "2026-01-01T00:00:00.000Z",
  metrics: { cpu: 1 },
};

const requiredUnit: DockerIngestUnit = {
  vpsId: "vps-1",
  agentInstanceId: "agent-1",
  snapshotId: "snap-1",
  requestDigest: "digest",
  requestDigestVersion: 1,
  receivedAt: hostSample.receivedAt,
  sourceSequence: "90071992547409931234567890",
  hostSample,
};

const eventfulResult: DockerIngestResult = {
  vpsId: "vps-1",
  ingestStatus: "committed",
  snapshotId: "snap-1",
  agentInstanceId: "agent-1",
  receivedAt: hostSample.receivedAt,
  revision: 1,
  committedWatermark: {
    vpsId: "vps-1",
    agentInstanceId: "agent-1",
    timeNano: "10",
    boundaryDigests: [],
    updatedAt: hostSample.receivedAt,
  },
};
const eventlessResult: DockerIngestResult = {
  ...eventfulResult,
  committedWatermark: undefined,
};

// I3 foundation contract evidence: deterministic wire primitives and complete compile fixtures.
describe("Docker monitoring ingest I3 foundation contract", () => {
  it("canonicalizes sorted object keys while preserving array order and digest stability", () => {
    const a = { z: 1, nested: { b: 2, a: ["second", "first"] } };
    const b = { nested: { a: ["second", "first"], b: 2 }, z: 1 };
    expect(canonicalDockerJson(a)).toBe(
      '{"nested":{"a":["second","first"],"b":2},"z":1}',
    );
    expect(dockerIngestRequestDigest(a)).toBe(dockerIngestRequestDigest(b));
    expect(dockerIngestRequestDigest(a)).not.toBe(
      dockerIngestRequestDigest({
        ...a,
        nested: { ...a.nested, a: ["first", "second"] },
      }),
    );
  });

  it("compares arbitrary positive decimal source sequences using BigInt", () => {
    expect(
      compareDockerSourceSequence(
        "90071992547409931234567890",
        "9007199254740993123456789",
      ),
    ).toBe(1);
    expect(compareDockerSourceSequence("10", "10")).toBe(0);
    expect(compareDockerSourceSequence("9", "10")).toBe(-1);
  });

  it("orders watermarks exactly by time then canonical boundary digest order", () => {
    const w = (timeNano: string, boundaryDigests: string[]) => ({
      timeNano,
      boundaryDigests,
    });
    expect(
      compareDockerWatermarks(
        w("100000000000000000000", ["b"]),
        w("99", ["z"]),
      ),
    ).toBe(1);
    expect(compareDockerWatermarks(w("10", ["a"]), w("10", ["b"]))).toBe(-1);
    expect(compareDockerWatermarks(w("10", ["a"]), w("10", ["a"]))).toBe(0);
  });

  it("keeps committed watermark optional for eventless results and available for eventful results", () => {
    expect(eventlessResult.committedWatermark).toBeUndefined();
    expect(eventfulResult.committedWatermark?.timeNano).toBe("10");
  });

  it("exposes typed Docker ingest conflicts", () => {
    const error = new DockerIngestConflict("watermark_conflict");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DockerIngestConflict");
    expect(error.code).toBe("watermark_conflict");
  });

  it("versions request digests with a stable v1 and a distinct v2 default", () => {
    const value = { b: 1, a: [1, 2] };
    expect(DOCKER_INGEST_DIGEST_VERSION).toBe(2);
    expect(DOCKER_INGEST_LEGACY_DIGEST_VERSION).toBe(1);
    expect(dockerIngestRequestDigest(value)).toBe(
      dockerIngestRequestDigest(value, DOCKER_INGEST_DIGEST_VERSION),
    );
    expect(dockerIngestRequestDigest(value, 1)).toBe(
      dockerIngestRequestDigest(value, 1),
    );
    expect(dockerIngestRequestDigest(value, 1)).not.toBe(
      dockerIngestRequestDigest(value),
    );
  });

  it("accepts required and full ingest unit fixtures at compile/runtime", () => {
    const full: DockerIngestUnit = {
      ...requiredUnit,
      batchId: "batch-1",
      containerSamples: [{ ...hostSample, containerKey: "container-1" }],
      events: [
        {
          ...({
            ...hostSample,
            action: "start",
            eventOccurredAt: hostSample.collectedAt,
            eventDigest: "event",
            contextVersion: 1,
          } as any),
          sourceSequence: "90071992547409931234567890",
        },
      ],
      eventProtocol: {
        fromWatermark: {
          vpsId: "vps-1",
          agentInstanceId: "agent-1",
          timeNano: "0",
          boundaryDigests: [],
          updatedAt: hostSample.receivedAt,
        },
        proposedWatermark: {
          vpsId: "vps-1",
          agentInstanceId: "agent-1",
          timeNano: "10",
          boundaryDigests: [],
          updatedAt: hostSample.receivedAt,
        },
        eventWindow: { from: "0", to: "10" },
      },
    };
    expect(full.events).toHaveLength(1);
    expect(requiredUnit.sourceSequence).toMatch(/^[1-9][0-9]*$/);
  });
});
