// Ed25519 verification of signed release manifests (fail closed).
//
// Verification accepts a manifest document only when its Ed25519 signature
// over the canonical bytes (top-level `signature` field removed) verifies
// against the pinned 32-byte raw public key. There is no key generation, no
// signature-optional mode, and no permissive fallback anywhere in this path.

import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalizeManifest } from "./release-manifest.canonical.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

export type ReleaseManifestFailureReason =
  | "invalid_json"
  | "signature_missing"
  | "signature_invalid";

export class ReleaseManifestVerificationError extends Error {
  readonly reason: ReleaseManifestFailureReason;
  constructor(reason: ReleaseManifestFailureReason, message: string) {
    super(message);
    this.name = "ReleaseManifestVerificationError";
    this.reason = reason;
  }
}

function decodeBase64Exact(value: string, bytes: number, what: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== bytes) {
    throw new ReleaseManifestVerificationError(
      "signature_invalid",
      `${what} must decode to ${bytes} bytes (got ${decoded.length})`,
    );
  }
  return decoded;
}

/**
 * Parse and verify a signed manifest document.
 *
 * @param manifestText raw signed document exactly as fetched (canonicalized
 *   only in memory for verification; the input bytes are never rewritten)
 * @param publicKeyBase64 pinned Ed25519 public key, base64 of 32 raw bytes
 * @returns the parsed document (schema validation happens separately)
 * @throws ReleaseManifestVerificationError on malformed JSON, missing
 *   signature, or any signature mismatch — never a boolean soft-fail
 */
export function verifyReleaseManifestText(
  manifestText: string,
  publicKeyBase64: string,
): unknown {
  let document: unknown;
  try {
    document = JSON.parse(manifestText);
  } catch {
    throw new ReleaseManifestVerificationError(
      "invalid_json",
      "manifest is not valid JSON",
    );
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new ReleaseManifestVerificationError(
      "invalid_json",
      "manifest must be a JSON object",
    );
  }
  const signatureValue = (document as Record<string, unknown>).signature;
  if (typeof signatureValue !== "string" || signatureValue === "") {
    throw new ReleaseManifestVerificationError(
      "signature_missing",
      "manifest carries no signature field",
    );
  }

  const signature = decodeBase64Exact(signatureValue, SIGNATURE_BYTES, "signature");
  const rawKey = decodeBase64Exact(
    publicKeyBase64,
    RAW_PUBLIC_KEY_BYTES,
    "public key",
  );
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new ReleaseManifestVerificationError(
      "signature_invalid",
      "public key is not a valid Ed25519 key",
    );
  }

  const canonicalBytes = Buffer.from(canonicalizeManifest(document), "utf8");
  let valid = false;
  try {
    valid = cryptoVerify(null, canonicalBytes, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new ReleaseManifestVerificationError(
      "signature_invalid",
      "manifest signature verification failed",
    );
  }
  return document;
}
