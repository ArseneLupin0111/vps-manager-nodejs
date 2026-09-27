// Canonical JSON for release tooling — byte-compatible with
// packages/api/src/release/release-manifest.canonical.ts and with the host
// updater's Go implementation. All three are pinned to the shared fixture
// vector scripts/release/fixtures/manifest.canonical.txt.

/** Canonical JSON string of any JSON-serializable value. */
export function canonicalJson(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number is not canonicalizable");
    }
    return JSON.stringify(value);
  }
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (type === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value type ${type}`);
}

/** Canonical source bytes for signing/verifying: document minus signature. */
export function canonicalizeManifest(document) {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("release manifest must be a JSON object");
  }
  const { signature, ...unsigned } = document;
  void signature;
  return canonicalJson(unsigned);
}
