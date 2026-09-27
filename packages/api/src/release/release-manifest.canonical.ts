// Canonical JSON for signed release manifests.
//
// Canonical form: UTF-8 JSON with recursively sorted object keys (JS default
// string order = UTF-16 code-unit order, identical to UTF-8 byte order for
// the ASCII-only keys and values this schema admits) and no insignificant
// whitespace. The Ed25519 signature covers exactly these bytes with the
// top-level `signature` field removed.
//
// This implementation is cross-checked byte-for-byte against
// scripts/release/fixtures/manifest.canonical.txt, which the host updater's
// independent Go implementation must also reproduce.

/** Canonical JSON string of any JSON-serializable value. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJson: non-finite number is not canonicalizable");
    }
    return JSON.stringify(value);
  }
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (type === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value type ${type}`);
}

/**
 * Canonical bytes source for a signed manifest document: the document with
 * its top-level `signature` field removed. Throws when the document is not a
 * plain JSON object (signatures only exist on objects).
 */
export function canonicalizeManifest(document: unknown): string {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("release manifest must be a JSON object");
  }
  const { signature: _signature, ...unsigned } = document as Record<string, unknown>;
  void _signature;
  return canonicalJson(unsigned);
}
