// Release manifest schema.
//
// Envelope (signed Ed25519 over the canonical bytes with `signature`
// removed):
//   {releaseId, version, buildId, channel, publishedAt,
//    apiCompatibility:{min,max}, artifacts:[{os,arch,size,sha256,url,...}],
//    signature}
//
// Identity fields are immutable: releaseId/buildId are the full 40-hex git
// SHA of the release commit. All strings are restricted to printable ASCII
// so canonical byte serialization cannot diverge between implementations.

import { z } from "zod";
import { RELEASE_ALLOWED_HOSTS } from "./release-config.js";

export const RELEASE_GIT_SHA_RE = /^[0-9a-f]{40}$/;
/** Same shape the API upgrader accepts for `-version` output. */
export const RELEASE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
const OS_RE = /^[a-z][a-z0-9]*$/;
const ARCH_RE = /^[a-z0-9][a-z0-9_]*$/;
const COMPONENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PUBLISHED_AT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const BASE64_64_RE = /^[A-Za-z0-9+/]{86}==$/;

export const releaseArtifactSchema = z.object({
  /** Distinguishes agent binary from future components; defaults to agent. */
  component: z.string().regex(COMPONENT_RE).optional(),
  os: z.string().regex(OS_RE),
  arch: z.string().regex(ARCH_RE),
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256_RE),
  url: z.string().regex(PRINTABLE_ASCII_RE),
});
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;

export const releaseManifestSchema = z
  .object({
    releaseId: z.string().regex(RELEASE_GIT_SHA_RE),
    version: z.string().regex(RELEASE_VERSION_RE),
    buildId: z.string().regex(RELEASE_GIT_SHA_RE),
    channel: z.string().regex(CHANNEL_RE),
    publishedAt: z.string().regex(PUBLISHED_AT_RE),
    apiCompatibility: z
      .object({
        min: z.number().int().min(0),
        max: z.number().int().min(0),
      })
      .refine((value) => value.max >= value.min, {
        message: "apiCompatibility.max must be >= min",
      }),
    artifacts: z.array(releaseArtifactSchema).min(1),
    signature: z.string().regex(BASE64_64_RE),
  })
  // Unknown top-level fields mean an unknown manifest schema generation:
  // reject rather than guess (fail closed).
  .strict();
export type SignedReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Component matched when an artifact omits `component` entirely. */
export const DEFAULT_ARTIFACT_COMPONENT = "agent";

/**
 * Structural validation of a parsed manifest document (signature already
 * verified). Throws zod's error on any violation. Artifact URLs must also be
 * on the fixed release allowlist before the manifest is accepted.
 */
export function parseSignedReleaseManifest(document: unknown): SignedReleaseManifest {
  const manifest = releaseManifestSchema.parse(document);
  for (const artifact of manifest.artifacts) {
    try {
      // Validate without importing network logic: policy lives in config.
      const url = new URL(artifact.url);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        (url.port !== "" && url.port !== "443") ||
        !RELEASE_ALLOWED_HOSTS.includes(url.hostname)
      ) {
        throw new Error("host not allowlisted");
      }
    } catch {
      throw new Error(
        `artifact url violates release URL policy: ${artifact.url.split("?")[0]}`,
      );
    }
  }
  return manifest;
}
