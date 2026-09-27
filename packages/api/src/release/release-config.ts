// Release catalog configuration — self-contained, fail-closed.
//
// The release catalog verifies signed agent release manifests against a
// pinned Ed25519 public key. Configuration rules:
//   - both AGENT_RELEASE_PUBLIC_KEY and AGENT_RELEASE_MANIFEST_URL absent
//     => catalog disabled; every lookup reports unavailable (never a
//     generated key, never an unsigned/lenient fallback);
//   - either present but malformed (or only one present) => throw, so a
//     misconfigured production deployment fails loudly at startup.
//
// The download allowlist is a fixed code constant (not an environment
// variable) so no runtime configuration can widen where signed content is
// fetched from. Tests override it only through explicit constructor options.

/** Hostnames allowed for pointer, manifest, and artifact fetches. */
export const RELEASE_ALLOWED_HOSTS: readonly string[] = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export type ReleaseCatalogConfig = {
  /** Pinned Ed25519 public key, base64 of exactly 32 raw bytes. */
  publicKey: string;
  /**
   * Stable channel pointer document URL (env AGENT_RELEASE_MANIFEST_URL,
   * https, allowlisted host). Points at `{releaseId, manifestUrl}`; the
   * pointer's own manifestUrl names the immutable signed document.
   */
  pointerUrl: string;
  /** Verified-manifest cache TTL in seconds. */
  ttlSeconds: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Hard cap for pointer and manifest response bodies. */
  maxBytes: number;
  /** Fixed download allowlist (constructor-overridable for tests only). */
  allowedHosts: readonly string[];
};

export type ParsedReleaseConfig =
  | { enabled: true; config: ReleaseCatalogConfig }
  | { enabled: false; reason: "not_configured" };

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1_048_576;

export function assertAllowedReleaseUrl(
  rawUrl: string,
  allowedHosts: readonly string[] = RELEASE_ALLOWED_HOSTS,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`release URL is not a valid URL: ${redactUrl(rawUrl)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`release URL must use https: ${redactUrl(rawUrl)}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`release URL must not carry userinfo: ${redactUrl(rawUrl)}`);
  }
  if (url.port !== "" && url.port !== "443") {
    throw new Error(`release URL must not carry a non-443 port: ${redactUrl(rawUrl)}`);
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`release URL host is not allowlisted: ${url.hostname}`);
  }
  return url;
}

function redactUrl(raw: string): string {
  // Never echo query strings (redirects may carry signatures in them).
  const cut = raw.indexOf("?");
  return cut === -1 ? raw : `${raw.slice(0, cut)}?<redacted>`;
}

function parsePublicKey(value: string): string {
  if (!BASE64_RE.test(value)) {
    throw new Error(
      "AGENT_RELEASE_PUBLIC_KEY must be base64 of exactly 32 raw Ed25519 bytes",
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new Error(
      "AGENT_RELEASE_PUBLIC_KEY must be base64 of exactly 32 raw Ed25519 bytes",
    );
  }
  if (decoded.length !== 32) {
    throw new Error(
      `AGENT_RELEASE_PUBLIC_KEY must decode to 32 bytes (got ${decoded.length})`,
    );
  }
  return value;
}

function parseTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 86_400) {
    throw new Error(
      "AGENT_RELEASE_TTL_SECONDS must be an integer between 1 and 86400",
    );
  }
  return value;
}

export function parseReleaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  allowedHosts: readonly string[] = RELEASE_ALLOWED_HOSTS,
): ParsedReleaseConfig {
  const publicKeyRaw = env.AGENT_RELEASE_PUBLIC_KEY?.trim();
  const manifestUrlRaw = env.AGENT_RELEASE_MANIFEST_URL?.trim();

  const publicKeySet = publicKeyRaw !== undefined && publicKeyRaw !== "";
  const manifestUrlSet = manifestUrlRaw !== undefined && manifestUrlRaw !== "";

  if (!publicKeySet && !manifestUrlSet) {
    return { enabled: false, reason: "not_configured" };
  }
  if (!publicKeySet || !manifestUrlSet) {
    throw new Error(
      "release catalog is partially configured: AGENT_RELEASE_PUBLIC_KEY and " +
        "AGENT_RELEASE_MANIFEST_URL must both be set (fail closed)",
    );
  }

  const publicKey = parsePublicKey(publicKeyRaw);
  const pointerUrl = assertAllowedReleaseUrl(manifestUrlRaw, allowedHosts).toString();
  const ttlSeconds = parseTtlSeconds(env.AGENT_RELEASE_TTL_SECONDS);

  return {
    enabled: true,
    config: {
      publicKey,
      pointerUrl,
      ttlSeconds,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes: DEFAULT_MAX_BYTES,
      allowedHosts,
    },
  };
}
