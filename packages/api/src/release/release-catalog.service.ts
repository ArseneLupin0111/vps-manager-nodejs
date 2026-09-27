// Verified release catalog: fetch, verify, cache signed release manifests.
//
// Trust model: the stable channel pointer (untrusted transport) names an
// immutable manifest URL; the manifest is only accepted after its Ed25519
// signature verifies against the pinned public key and the schema passes.
// Every failure path — missing/malformed key, fetch error, TTL expiry,
// allowlist violation, size cap, bad signature, pointer/manifest releaseId
// mismatch — resolves to status "unavailable" (or "not_found" when the
// verified cache simply names a different release). Nothing here ever
// generates a key, skips verification, or serves an unverified document.

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  DEFAULT_ARTIFACT_COMPONENT,
  RELEASE_GIT_SHA_RE,
  parseSignedReleaseManifest,
  type SignedReleaseManifest,
} from "./release-manifest.model.js";
import {
  assertAllowedReleaseUrl,
  parseReleaseConfig,
  type ReleaseCatalogConfig,
} from "./release-config.js";
import {
  ReleaseManifestVerificationError,
  verifyReleaseManifestText,
} from "./release-manifest.verify.js";

export const RELEASE_CATALOG = Symbol("RELEASE_CATALOG");
export const RELEASE_CATALOG_OPTIONS = Symbol("RELEASE_CATALOG_OPTIONS");

/** One signed artifact entry as consumed by the API and job pinning. */
export type ReleaseArtifactEntry = {
  os: string;
  arch: string;
  size: number;
  sha256: string;
  url: string;
};

/**
 * A verified, channel-current release. `manifestRaw` is the signed document
 * verbatim as fetched (never re-canonicalized server-side); `manifestUrl` is
 * the stable allowlisted URL it can be re-fetched from; `publicKey` is the
 * pinned key that verified it.
 */
export type ReleaseCatalogEntry = {
  releaseId: string;
  version: string;
  buildId: string;
  publishedAt: string;
  channel: string;
  apiCompatibility: { min: number; max: number };
  artifacts: ReleaseArtifactEntry[];
  manifestRaw: string;
  manifestUrl: string;
  publicKey: string;
};

export type ReleaseCatalogQuery = {
  channel: string;
  os: string;
  arch: string;
  apiContractVersion: number;
};

export type ReleaseCatalogByIdQuery = {
  releaseId: string;
  os: string;
  arch: string;
  apiContractVersion: number;
};

export type ReleaseCatalogResult =
  | { status: "ok"; release: ReleaseCatalogEntry }
  | { status: "unavailable"; reason: string }
  | { status: "not_found" };

export interface ReleaseCatalog {
  getCompatibleRelease(query: ReleaseCatalogQuery): Promise<ReleaseCatalogResult>;
  getReleaseById(query: ReleaseCatalogByIdQuery): Promise<ReleaseCatalogResult>;
}

export type ReleaseCatalogOptions = {
  /** Environment to read configuration from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Fetch implementation (tests inject; production uses global fetch). */
  fetchImpl?: typeof fetch;
  /** Clock (tests inject). */
  now?: () => number;
  /** Allowlist override for offline test harnesses only. */
  allowedHosts?: readonly string[];
};

type VerifiedSnapshot = {
  manifestText: string;
  manifest: SignedReleaseManifest;
  manifestUrl: string;
  fetchedAt: number;
};

type ResolveOutcome =
  | { snapshot: VerifiedSnapshot; reason?: undefined }
  | { snapshot?: undefined; reason: FailureReason | "unknown" };

type FailureReason =
  | "fetch_failed"
  | "too_large"
  | "invalid_encoding"
  | "too_many_redirects"
  | "url_rejected"
  | "invalid_pointer"
  | "pointer_release_mismatch"
  | "signature_missing"
  | "signature_invalid"
  | "invalid_json"
  | "manifest_invalid";

class FetchRejected extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason, message: string) {
    super(message);
    this.name = "FetchRejected";
    this.reason = reason;
  }
}

const MAX_REDIRECT_HOPS = 5;
const FAILURE_BACKOFF_MS = 10_000;

@Injectable()
export class ReleaseCatalogService implements ReleaseCatalog {
  private readonly logger = new Logger(ReleaseCatalogService.name);
  private readonly config: ReleaseCatalogConfig | null;
  private readonly disabledReason: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private snapshot: VerifiedSnapshot | null = null;
  private inFlight: Promise<ResolveOutcome> | null = null;
  private lastFailureReason: FailureReason | "unknown" | null = null;
  private backoffUntil = 0;

  constructor(
    @Optional()
    @Inject(RELEASE_CATALOG_OPTIONS)
    options: ReleaseCatalogOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    const parsed = parseReleaseConfig(
      options.env ?? process.env,
      options.allowedHosts,
    );
    if (parsed.enabled) {
      this.config = parsed.config;
      this.disabledReason = null;
    } else {
      this.config = null;
      this.disabledReason = parsed.reason;
    }
  }

  async getCompatibleRelease(
    query: ReleaseCatalogQuery,
  ): Promise<ReleaseCatalogResult> {
    const config = this.config;
    if (!config) {
      return { status: "unavailable", reason: this.disabledReason ?? "not_configured" };
    }
    const resolved = await this.resolve(config);
    if (!resolved.snapshot) return { status: "unavailable", reason: resolved.reason };
    if (resolved.snapshot.manifest.channel !== query.channel) {
      return { status: "unavailable", reason: "channel_mismatch" };
    }
    return { status: "ok", release: this.toEntry(resolved.snapshot, query, config) };
  }

  async getReleaseById(
    query: ReleaseCatalogByIdQuery,
  ): Promise<ReleaseCatalogResult> {
    const config = this.config;
    if (!config) {
      return { status: "unavailable", reason: this.disabledReason ?? "not_configured" };
    }
    const resolved = await this.resolve(config);
    if (!resolved.snapshot) return { status: "unavailable", reason: resolved.reason };
    if (resolved.snapshot.manifest.releaseId !== query.releaseId) {
      return { status: "not_found" };
    }
    return { status: "ok", release: this.toEntry(resolved.snapshot, query, config) };
  }

  private toEntry(
    snapshot: VerifiedSnapshot,
    query: { os: string; arch: string },
    config: ReleaseCatalogConfig,
  ): ReleaseCatalogEntry {
    const { manifest } = snapshot;
    return {
      releaseId: manifest.releaseId,
      version: manifest.version,
      buildId: manifest.buildId,
      publishedAt: manifest.publishedAt,
      channel: manifest.channel,
      apiCompatibility: { ...manifest.apiCompatibility },
      artifacts: manifest.artifacts
        .filter(
          (artifact) =>
            (artifact.component ?? DEFAULT_ARTIFACT_COMPONENT) ===
              DEFAULT_ARTIFACT_COMPONENT &&
            artifact.os === query.os &&
            artifact.arch === query.arch,
        )
        .map(({ os, arch, size, sha256, url }) => ({ os, arch, size, sha256, url })),
      manifestRaw: snapshot.manifestText,
      manifestUrl: snapshot.manifestUrl,
      publicKey: config.publicKey,
    };
  }

  private async resolve(config: ReleaseCatalogConfig): Promise<ResolveOutcome> {
    const now = this.now();
    if (
      this.snapshot &&
      now - this.snapshot.fetchedAt < config.ttlSeconds * 1000
    ) {
      return { snapshot: this.snapshot };
    }
    if (this.inFlight) return this.inFlight;
    if (now < this.backoffUntil && this.lastFailureReason) {
      return { reason: this.lastFailureReason };
    }
    this.inFlight = this.refresh(config).then<ResolveOutcome>((outcome) => {
      if (outcome.snapshot) {
        this.snapshot = outcome.snapshot;
        this.lastFailureReason = null;
        this.backoffUntil = 0;
        return outcome;
      }
      this.lastFailureReason = outcome.reason;
      this.backoffUntil = this.now() + FAILURE_BACKOFF_MS;
      this.logger.warn(`release catalog unavailable: ${outcome.reason}`);
      return outcome;
    });
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(config: ReleaseCatalogConfig): Promise<ResolveOutcome> {
    try {
      const pointerText = await this.fetchText(config, config.pointerUrl);
      const pointer = this.parsePointer(pointerText, config);
      const manifestText = await this.fetchText(config, pointer.manifestUrl);

      let document: unknown;
      try {
        document = verifyReleaseManifestText(manifestText, config.publicKey);
      } catch (error) {
        if (error instanceof ReleaseManifestVerificationError) {
          throw new FetchRejected(error.reason, error.message);
        }
        throw error;
      }
      let manifest: SignedReleaseManifest;
      try {
        manifest = parseSignedReleaseManifest(document);
      } catch {
        throw new FetchRejected("manifest_invalid", "manifest schema rejected");
      }
      if (manifest.releaseId !== pointer.releaseId) {
        throw new FetchRejected(
          "pointer_release_mismatch",
          "pointer names a different release than the manifest carries",
        );
      }
      return {
        snapshot: {
          manifestText,
          manifest,
          manifestUrl: pointer.manifestUrl,
          fetchedAt: this.now(),
        },
      };
    } catch (error) {
      if (error instanceof FetchRejected) return { reason: error.reason };
      return { reason: "fetch_failed" };
    }
  }

  private parsePointer(
    text: string,
    config: ReleaseCatalogConfig,
  ): { releaseId: string; manifestUrl: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FetchRejected("invalid_pointer", "pointer is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new FetchRejected("invalid_pointer", "pointer must be a JSON object");
    }
    const { releaseId, manifestUrl } = parsed as Record<string, unknown>;
    if (typeof releaseId !== "string" || !RELEASE_GIT_SHA_RE.test(releaseId)) {
      throw new FetchRejected("invalid_pointer", "pointer releaseId is not a git SHA");
    }
    if (typeof manifestUrl !== "string") {
      throw new FetchRejected("invalid_pointer", "pointer manifestUrl is missing");
    }
    try {
      assertAllowedReleaseUrl(manifestUrl, config.allowedHosts);
    } catch (error) {
      throw new FetchRejected(
        "url_rejected",
        error instanceof Error ? error.message : "pointer manifestUrl rejected",
      );
    }
    return { releaseId, manifestUrl };
  }

  /** Fetch one allowlisted URL with manual, per-hop-validated redirects. */
  private async fetchText(
    config: ReleaseCatalogConfig,
    rawUrl: string,
  ): Promise<string> {
    let url = rawUrl;
    try {
      assertAllowedReleaseUrl(url, config.allowedHosts);
    } catch (error) {
      throw new FetchRejected(
        "url_rejected",
        error instanceof Error ? error.message : "url rejected",
      );
    }

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(config.timeoutMs),
          headers: { accept: "application/json" },
        });
      } catch {
        throw new FetchRejected("fetch_failed", "release fetch failed");
      }

      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get("location");
        if (!location) {
          throw new FetchRejected("fetch_failed", "redirect without location");
        }
        let next: URL;
        try {
          next = new URL(location, url);
          assertAllowedReleaseUrl(next.toString(), config.allowedHosts);
        } catch (error) {
          throw new FetchRejected(
            "url_rejected",
            error instanceof Error ? error.message : "redirect rejected",
          );
        }
        url = next.toString();
        continue;
      }
      if (!response.ok) {
        throw new FetchRejected("fetch_failed", `release fetch HTTP ${response.status}`);
      }
      const bytes = await this.readBodyCapped(response, config.maxBytes);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new FetchRejected("invalid_encoding", "response is not UTF-8");
      }
    }
    throw new FetchRejected("too_many_redirects", "too many redirects");
  }

  private async readBodyCapped(
    response: Response,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > maxBytes) {
      throw new FetchRejected("too_large", "release response exceeds size cap");
    }
    if (!response.body) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new FetchRejected("too_large", "release response exceeds size cap");
        }
        chunks.push(value);
      }
    }
    if (chunks.length === 1) return chunks[0];
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
}
