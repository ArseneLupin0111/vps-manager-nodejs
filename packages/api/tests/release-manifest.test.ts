import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalizeManifest } from "../src/release/release-manifest.canonical.js";
import { parseSignedReleaseManifest } from "../src/release/release-manifest.model.js";
import {
  ReleaseManifestVerificationError,
  verifyReleaseManifestText,
} from "../src/release/release-manifest.verify.js";
import { parseReleaseConfig } from "../src/release/release-config.js";
import { ReleaseCatalogService } from "../src/release/release-catalog.service.js";

const fixturesDir = fileURLToPath(
  new URL("../../../scripts/release/fixtures/", import.meta.url),
);
const canonicalFixture = readFileSync(`${fixturesDir}manifest.canonical.txt`, "utf8");
const validManifestText = readFileSync(`${fixturesDir}manifest.valid.json`, "utf8");
const multicomponentManifestText = readFileSync(
  `${fixturesDir}manifest.multicomponent.json`,
  "utf8",
);
const tamperedManifestText = readFileSync(`${fixturesDir}manifest.tampered.json`, "utf8");
const fixturePublicKey = readFileSync(`${fixturesDir}manifest.pubkey.b64`, "utf8");
const validManifest = JSON.parse(validManifestText) as Record<string, unknown>;
const RELEASE_SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

const baseEnv = {
  AGENT_RELEASE_PUBLIC_KEY: fixturePublicKey,
  AGENT_RELEASE_MANIFEST_URL: "https://github.com/example-org/vps-manager-nodejs/releases/latest/download/pointer.json",
};

function pointerJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    releaseId: RELEASE_SHA,
    manifestUrl: `https://github.com/example-org/vps-manager-nodejs/releases/download/agent-${RELEASE_SHA}/manifest.json`,
    ...overrides,
  });
}

type Route = (url: string) => Response | Promise<Response>;

function makeService(options: {
  route: Route;
  env?: Record<string, string | undefined>;
  nowRef?: { value: number };
}) {
  const calls: string[] = [];
  const service = new ReleaseCatalogService({
    env: options.env ?? baseEnv,
    now: () => options.nowRef?.value ?? 1_000_000,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return options.route(url);
    }) as typeof fetch,
  });
  return { service, calls };
}

const okQuery = {
  channel: "stable",
  os: "linux",
  arch: "amd64",
  apiContractVersion: 2,
};

describe("release manifest canonical bytes", () => {
  it("matches the committed fixture bytes exactly", () => {
    expect(canonicalizeManifest(validManifest)).toBe(canonicalFixture);
  });

  it("sorts keys recursively and excludes the signature field", () => {
    expect(canonicalJson({ b: 1, a: { z: [3, { y: 1, x: 2 }], "0k": true } })).toBe(
      '{"a":{"0k":true,"z":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(canonicalizeManifest({ z: 1, signature: "abc", a: 2 })).toBe('{"a":2,"z":1}');
  });
});

describe("verifyReleaseManifestText", () => {
  it("verifies the signed fixture against the pinned key", () => {
    const document = verifyReleaseManifestText(validManifestText, fixturePublicKey);
    expect((document as Record<string, unknown>).releaseId).toBe(RELEASE_SHA);
  });

  it("rejects a tampered artifact hash", () => {
    expect(() => verifyReleaseManifestText(tamperedManifestText, fixturePublicKey))
      .toThrowError(ReleaseManifestVerificationError);
    try {
      verifyReleaseManifestText(tamperedManifestText, fixturePublicKey);
    } catch (error) {
      expect((error as ReleaseManifestVerificationError).reason).toBe("signature_invalid");
    }
  });

  it("rejects a different public key", () => {
    const wrongKey = Buffer.alloc(32, 7).toString("base64");
    expect(() => verifyReleaseManifestText(validManifestText, wrongKey)).toThrowError(
      /signature verification failed/,
    );
  });

  it("rejects a document with no signature field", () => {
    const { signature: _signature, ...unsigned } = validManifest;
    void _signature;
    try {
      verifyReleaseManifestText(JSON.stringify(unsigned), fixturePublicKey);
      expect.unreachable("unsigned document must not verify");
    } catch (error) {
      expect((error as ReleaseManifestVerificationError).reason).toBe("signature_missing");
    }
  });

  it("rejects non-JSON and non-object documents", () => {
    for (const text of ["not json", "[]", '"str"', "123"]) {
      try {
        verifyReleaseManifestText(text, fixturePublicKey);
        expect.unreachable(`must reject ${text}`);
      } catch (error) {
        expect((error as ReleaseManifestVerificationError).reason).toBe("invalid_json");
      }
    }
  });

  it("rejects a public key of the wrong length", () => {
    expect(() =>
      verifyReleaseManifestText(validManifestText, Buffer.alloc(31, 1).toString("base64")),
    ).toThrowError(/32 bytes/);
  });
});

describe("release manifest schema", () => {
  it("accepts the signed fixture document", () => {
    const manifest = parseSignedReleaseManifest(validManifest);
    expect(manifest.releaseId).toBe(RELEASE_SHA);
    expect(manifest.apiCompatibility).toEqual({ min: 2, max: 2 });
    // arm64 fixture artifact carries no component field (defaults to agent).
    expect(manifest.artifacts[1].component).toBeUndefined();
  });

  it("accepts the agent+updater release layout (bootstrap components)", () => {
    const multicomponent = JSON.parse(multicomponentManifestText) as Record<
      string,
      unknown
    >;
    const manifest = parseSignedReleaseManifest(multicomponent);
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.artifacts[0].component).toBe("agent");
    expect(manifest.artifacts[1].component).toBe("updater");
    for (const artifact of manifest.artifacts) {
      expect(artifact.os).toBe("linux");
      expect(artifact.arch).toBe("amd64");
    }
  });

  it("rejects an invalid component name", () => {
    expect(() =>
      parseSignedReleaseManifest({
        ...validManifest,
        artifacts: [
          {
            component: "UPDATER",
            os: "linux",
            arch: "amd64",
            size: 1,
            sha256: "0".repeat(64),
            url: `https://github.com/example-org/vps-manager-nodejs/releases/download/agent-${RELEASE_SHA}/vps-updater-linux-amd64`,
          },
        ],
      }),
    ).toThrowError();
  });

  it("rejects unknown top-level fields (strict schema)", () => {
    expect(() =>
      parseSignedReleaseManifest({ ...validManifest, futureField: true }),
    ).toThrowError();
  });

  it("rejects non-allowlisted artifact URLs", () => {
    const doc = {
      ...validManifest,
      artifacts: [
        {
          os: "linux",
          arch: "amd64",
          size: 1,
          sha256: "0".repeat(64),
          url: "https://evil.example.com/agent",
        },
      ],
    };
    expect(() => parseSignedReleaseManifest(doc)).toThrowError(/URL policy/);
  });

  it("rejects http URLs and inverted compatibility ranges", () => {
    expect(() =>
      parseSignedReleaseManifest({
        ...validManifest,
        artifacts: [
          {
            os: "linux",
            arch: "amd64",
            size: 1,
            sha256: "0".repeat(64),
            url: "http://github.com/a",
          },
        ],
      }),
    ).toThrowError(/URL policy/);
    expect(() =>
      parseSignedReleaseManifest({
        ...validManifest,
        apiCompatibility: { min: 3, max: 2 },
      }),
    ).toThrowError();
  });
});

describe("release configuration fail-closed rules", () => {
  it("reports not_configured when both variables are absent", () => {
    expect(parseReleaseConfig({})).toEqual({ enabled: false, reason: "not_configured" });
  });

  it("throws on a malformed public key", () => {
    expect(() =>
      parseReleaseConfig({
        AGENT_RELEASE_PUBLIC_KEY: "not-base64!!",
        AGENT_RELEASE_MANIFEST_URL: baseEnv.AGENT_RELEASE_MANIFEST_URL,
      }),
    ).toThrowError(/32 raw Ed25519 bytes/);
    expect(() =>
      parseReleaseConfig({
        AGENT_RELEASE_PUBLIC_KEY: Buffer.alloc(16, 1).toString("base64"),
        AGENT_RELEASE_MANIFEST_URL: baseEnv.AGENT_RELEASE_MANIFEST_URL,
      }),
    ).toThrowError(/32 bytes/);
  });

  it("throws on partial configuration instead of silently disabling", () => {
    expect(() =>
      parseReleaseConfig({ AGENT_RELEASE_PUBLIC_KEY: fixturePublicKey }),
    ).toThrowError(/partially configured/);
  });

  it("rejects non-https, non-allowlisted, and bad TTL configuration", () => {
    const key = { AGENT_RELEASE_PUBLIC_KEY: fixturePublicKey };
    expect(() =>
      parseReleaseConfig({ ...key, AGENT_RELEASE_MANIFEST_URL: "http://github.com/p" }),
    ).toThrowError(/https/);
    expect(() =>
      parseReleaseConfig({ ...key, AGENT_RELEASE_MANIFEST_URL: "https://evil.example/p" }),
    ).toThrowError(/allowlisted/);
    expect(() =>
      parseReleaseConfig({
        ...key,
        AGENT_RELEASE_MANIFEST_URL: baseEnv.AGENT_RELEASE_MANIFEST_URL,
        AGENT_RELEASE_TTL_SECONDS: "0",
      }),
    ).toThrowError(/integer/);
  });

  it("parses a valid configuration with defaults", () => {
    const parsed = parseReleaseConfig({ ...baseEnv });
    expect(parsed.enabled).toBe(true);
    if (!parsed.enabled) return;
    expect(parsed.config.ttlSeconds).toBe(300);
    expect(parsed.config.pointerUrl).toBe(baseEnv.AGENT_RELEASE_MANIFEST_URL);
    expect(parsed.config.publicKey).toBe(fixturePublicKey);
  });
});

describe("ReleaseCatalogService", () => {
  it("serves a verified release with raw manifest, stable URL, and pinned key", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const release = result.release;
    expect(release.releaseId).toBe(RELEASE_SHA);
    expect(release.buildId).toBe(RELEASE_SHA);
    expect(release.version).toBe("1.2.3");
    expect(release.manifestRaw).toBe(validManifestText);
    expect(release.manifestUrl).toBe(
      `https://github.com/example-org/vps-manager-nodejs/releases/download/agent-${RELEASE_SHA}/manifest.json`,
    );
    expect(release.publicKey).toBe(fixturePublicKey);
    expect(release.apiCompatibility).toEqual({ min: 2, max: 2 });
    expect(release.artifacts).toHaveLength(1);
    expect(release.artifacts[0].arch).toBe("amd64");
    expect(release.artifacts[0].sha256).toHaveLength(64);
  });

  it("returns ok with empty artifacts for an unsupported architecture", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    const result = await service.getCompatibleRelease({
      ...okQuery,
      arch: "riscv64",
    });
    expect(result).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
    if (result.status !== "ok") return;
    expect(result.release.artifacts).toEqual([]);
  });

  it("includes the component-less arm64 artifact under the agent component", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    const result = await service.getCompatibleRelease({ ...okQuery, arch: "arm64" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.release.artifacts).toHaveLength(1);
    expect(result.release.artifacts[0].size).toBe(8_301_224);
  });

  it("never surfaces the updater component through the agent catalog", async () => {
    const multicomponentManifest = JSON.parse(
      multicomponentManifestText,
    ) as Record<string, unknown>;
    expect(
      verifyReleaseManifestText(multicomponentManifestText, fixturePublicKey),
    ).toBeDefined();
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(multicomponentManifestText, { status: 200 }),
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Only the agent artifact is consumable; the updater entry (same
    // os/arch) is pinned in manifestRaw for HostOwner's installer, not here.
    expect(result.release.artifacts).toHaveLength(1);
    expect(result.release.artifacts[0].url).toContain("vps-agent-linux-amd64");
    expect(result.release.manifestRaw).toBe(multicomponentManifestText);
    expect(
      (multicomponentManifest.artifacts as Array<Record<string, unknown>>).filter(
        (artifact) => artifact.component === "updater",
      ),
    ).toHaveLength(1);
  });

  it("reports channel_mismatch when the verified manifest is on another channel", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    const result = await service.getCompatibleRelease({ ...okQuery, channel: "beta" });
    expect(result).toEqual({ status: "unavailable", reason: "channel_mismatch" });
  });

  it("resolves getReleaseById with not_found for a different verified release", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    const hit = await service.getReleaseById({ ...okQuery, releaseId: RELEASE_SHA });
    expect(hit.status).toBe("ok");
    const miss = await service.getReleaseById({
      ...okQuery,
      releaseId: "1".repeat(40),
    });
    expect(miss).toEqual({ status: "not_found" });
  });

  it("fails closed on a tampered manifest", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(tamperedManifestText, { status: 200 }),
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result).toEqual({ status: "unavailable", reason: "signature_invalid" });
  });

  it("fails closed when the pointer names another release", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson({ releaseId: "1".repeat(40) }), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result).toEqual({
      status: "unavailable",
      reason: "pointer_release_mismatch",
    });
  });

  it("rejects a pointer whose manifest URL leaves the allowlist", async () => {
    const { service } = makeService({
      route: () =>
        new Response(
          pointerJson({ manifestUrl: "https://evil.example.com/manifest.json" }),
          { status: 200 },
        ),
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result).toEqual({ status: "unavailable", reason: "url_rejected" });
  });

  it("rejects a redirect that leaves the allowlist", async () => {
    const { service } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(null, {
              status: 302,
              headers: { location: "https://evil.example.com/manifest.json" },
            }),
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result).toEqual({ status: "unavailable", reason: "url_rejected" });
  });

  it("follows allowlisted redirects", async () => {
    const { service } = makeService({
      route: (url) => {
        if (url.includes("pointer.json")) return new Response(pointerJson(), { status: 200 });
        if (url.includes("/download/")) {
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://objects.githubusercontent.com/github-production-release-asset/manifest.json",
            },
          });
        }
        return new Response(validManifestText, { status: 200 });
      },
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result.status).toBe("ok");
  });

  it("gives up after five redirects", async () => {
    let hops = 0;
    const { service } = makeService({
      route: () => {
        hops += 1;
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://github.com/example-org/loop/${hops}.json`,
          },
        });
      },
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result).toEqual({ status: "unavailable", reason: "too_many_redirects" });
  });

  it("enforces the response size cap", async () => {
    const { service } = makeService({
      route: () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    });
    const result = await service.getCompatibleRelease(okQuery);
    expect(result).toEqual({ status: "unavailable", reason: "too_large" });
  });

  it("reports not_configured when no key is present", async () => {
    const service = new ReleaseCatalogService({ env: {} });
    expect(await service.getCompatibleRelease(okQuery)).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
    expect(await service.getReleaseById({ ...okQuery, releaseId: RELEASE_SHA })).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
  });

  it("throws at construction when the key is malformed", () => {
    expect(
      () =>
        new ReleaseCatalogService({
          env: {
            AGENT_RELEASE_PUBLIC_KEY: "aaa",
            AGENT_RELEASE_MANIFEST_URL: baseEnv.AGENT_RELEASE_MANIFEST_URL,
          },
        }),
    ).toThrowError(/must decode to 32 bytes/);
  });

  it("caches until TTL then refetches", async () => {
    const nowRef = { value: 1_000_000 };
    const { service, calls } = makeService({
      nowRef,
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    await service.getCompatibleRelease(okQuery);
    expect(calls).toHaveLength(2);
    nowRef.value += 299_000;
    await service.getCompatibleRelease(okQuery);
    expect(calls).toHaveLength(2);
    nowRef.value += 2_000;
    await service.getCompatibleRelease(okQuery);
    expect(calls).toHaveLength(4);
  });

  it("backs off after a fetch failure instead of hammering", async () => {
    const nowRef = { value: 1_000_000 };
    const { service, calls } = makeService({
      nowRef,
      route: () => {
        throw new Error("network down");
      },
    });
    const first = await service.getCompatibleRelease(okQuery);
    expect(first).toEqual({ status: "unavailable", reason: "fetch_failed" });
    expect(calls).toHaveLength(1);
    const second = await service.getCompatibleRelease(okQuery);
    expect(second).toEqual({ status: "unavailable", reason: "fetch_failed" });
    expect(calls).toHaveLength(1);
    nowRef.value += 11_000;
    await service.getCompatibleRelease(okQuery);
    expect(calls).toHaveLength(2);
  });

  it("shares a single in-flight refresh across concurrent calls", async () => {
    const { service, calls } = makeService({
      route: (url) =>
        url.includes("pointer.json")
          ? new Response(pointerJson(), { status: 200 })
          : new Response(validManifestText, { status: 200 }),
    });
    const [a, b, c] = await Promise.all([
      service.getCompatibleRelease(okQuery),
      service.getCompatibleRelease(okQuery),
      service.getReleaseById({ ...okQuery, releaseId: RELEASE_SHA }),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(c.status).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});
