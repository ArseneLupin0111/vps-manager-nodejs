// Read-only release catalog — public surface for API consumers.
//
// Registration (owned by the API slice, packages/api/src/app.module.ts):
//   providers: [
//     ReleaseCatalogService,
//     { provide: RELEASE_CATALOG, useExisting: ReleaseCatalogService },
//   ]
// The service constructs eagerly; a present-but-malformed
// AGENT_RELEASE_PUBLIC_KEY / AGENT_RELEASE_MANIFEST_URL throws during
// provider construction so production startup fails loudly instead of
// serving an unverifiable release. With no configuration every lookup
// reports {status:"unavailable", reason:"not_configured"}.

export {
  RELEASE_CATALOG,
  RELEASE_CATALOG_OPTIONS,
  ReleaseCatalogService,
  type ReleaseArtifactEntry,
  type ReleaseCatalog,
  type ReleaseCatalogByIdQuery,
  type ReleaseCatalogEntry,
  type ReleaseCatalogOptions,
  type ReleaseCatalogQuery,
  type ReleaseCatalogResult,
} from "./release-catalog.service.js";
export {
  RELEASE_ALLOWED_HOSTS,
  parseReleaseConfig,
  type ParsedReleaseConfig,
  type ReleaseCatalogConfig,
} from "./release-config.js";
export { canonicalJson, canonicalizeManifest } from "./release-manifest.canonical.js";
export {
  DEFAULT_ARTIFACT_COMPONENT,
  RELEASE_GIT_SHA_RE,
  RELEASE_VERSION_RE,
  parseSignedReleaseManifest,
  releaseArtifactSchema,
  releaseManifestSchema,
  type ReleaseArtifact,
  type SignedReleaseManifest,
} from "./release-manifest.model.js";
export {
  ReleaseManifestVerificationError,
  verifyReleaseManifestText,
  type ReleaseManifestFailureReason,
} from "./release-manifest.verify.js";
