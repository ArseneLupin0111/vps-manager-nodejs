#!/usr/bin/env node
// Verify an Ed25519-signed release manifest against a pinned public key.
//
// Usage (canonical form, cited by the manual runbook):
//   node scripts/release/verify-manifest.mjs --manifest <file> \
//     --pubkey-env AGENT_RELEASE_PUBLIC_KEY
//
// Also accepted:
//   --pubkey <base64-raw-32B>     inline pinned key
//   --pubkey-file <path>          file holding the base64 key
//   --expect-release <40-hex-sha> additionally require manifest.releaseId
//
// Exit 0  -> signature, structure, and (if given) release pin all valid
// Exit 1  -> any check failed (reason on stderr; nothing is ever skipped)

import { readFileSync } from "node:fs";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { canonicalizeManifest } from "./lib/canonical.mjs";

const MAX_MANIFEST_BYTES = 1_048_576;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

function fail(message) {
  process.stderr.write(`verify-manifest: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    manifest: null,
    pubkey: null,
    pubkeyEnv: null,
    pubkeyFile: null,
    expectRelease: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--pubkey") args.pubkey = argv[++i];
    else if (arg === "--pubkey-env") args.pubkeyEnv = argv[++i];
    else if (arg === "--pubkey-file") args.pubkeyFile = argv[++i];
    else if (arg === "--expect-release") args.expectRelease = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: verify-manifest.mjs --manifest <file>\n" +
          "        (--pubkey-env <ENV> | --pubkey <b64> | --pubkey-file <path>)\n" +
          "        [--expect-release <40-hex-sha>]\n",
      );
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!args.manifest) fail("--manifest <file> is required");
  const sources = [args.pubkey, args.pubkeyEnv, args.pubkeyFile].filter(
    (value) => value !== null,
  );
  if (sources.length !== 1) {
    fail("exactly one of --pubkey, --pubkey-env, --pubkey-file is required");
  }
  return args;
}

function loadPublicKey(args) {
  if (args.pubkey !== null) return args.pubkey.trim();
  if (args.pubkeyFile !== null) return readFileSync(args.pubkeyFile, "utf8").trim();
  const value = process.env[args.pubkeyEnv];
  if (value === undefined || value.trim() === "") {
    fail(`environment ${args.pubkeyEnv} is not set or empty`);
  }
  return value.trim();
}

const args = parseArgs(process.argv.slice(2));

let manifestBytes;
try {
  manifestBytes = readFileSync(args.manifest);
} catch (error) {
  fail(`cannot read --manifest: ${error.message}`);
}
if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
  fail(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
}

let document;
try {
  document = JSON.parse(manifestBytes.toString("utf8"));
} catch {
  fail("manifest is not valid JSON");
}
if (document === null || typeof document !== "object" || Array.isArray(document)) {
  fail("manifest must be a JSON object");
}

const { signature, releaseId, version, buildId, channel, publishedAt, apiCompatibility, artifacts } =
  document;
if (typeof signature !== "string" || signature === "") {
  fail("manifest carries no signature field");
}
const signatureBytes = Buffer.from(signature, "base64");
if (signatureBytes.length !== 64) {
  fail(`signature must decode to 64 bytes (got ${signatureBytes.length})`);
}

const publicKeyB64 = loadPublicKey(args);
const rawKey = Buffer.from(publicKeyB64, "base64");
if (rawKey.length !== 32) {
  fail(`public key must decode to 32 bytes (got ${rawKey.length})`);
}
let publicKey;
try {
  publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
} catch {
  fail("public key is not a valid Ed25519 key");
}

let canonical;
try {
  canonical = Buffer.from(canonicalizeManifest(document), "utf8");
} catch (error) {
  fail(`cannot canonicalize manifest: ${error.message}`);
}
if (!cryptoVerify(null, canonical, publicKey, signatureBytes)) {
  fail("signature verification FAILED (manifest was not signed by the pinned key or was modified)");
}

// Structure checks mirror the API schema closely enough that an operator
// running only this CLI still cannot accept a document the API would reject.
if (typeof releaseId !== "string" || !GIT_SHA_RE.test(releaseId)) {
  fail("releaseId must be a 40-char lowercase hex git SHA");
}
if (typeof buildId !== "string" || !GIT_SHA_RE.test(buildId)) {
  fail("buildId must be a 40-char lowercase hex git SHA");
}
if (
  typeof version !== "string" ||
  !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)
) {
  fail("version must match [A-Za-z0-9][A-Za-z0-9._+-]{0,63}");
}
if (typeof channel !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(channel)) {
  fail("channel must match [a-z][a-z0-9-]{0,31}");
}
if (typeof publishedAt !== "string" || publishedAt === "") {
  fail("publishedAt must be a string");
}
if (
  apiCompatibility === null ||
  typeof apiCompatibility !== "object" ||
  !Number.isInteger(apiCompatibility.min) ||
  !Number.isInteger(apiCompatibility.max) ||
  apiCompatibility.max < apiCompatibility.min
) {
  fail("apiCompatibility must be {min,max} integers with max >= min");
}
if (!Array.isArray(artifacts) || artifacts.length === 0) {
  fail("artifacts must be a non-empty array");
}
for (const [index, artifact] of artifacts.entries()) {
  if (artifact === null || typeof artifact !== "object") {
    fail(`artifacts[${index}] must be an object`);
  }
  if (typeof artifact.os !== "string" || typeof artifact.arch !== "string") {
    fail(`artifacts[${index}] must carry os and arch`);
  }
  if (
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  ) {
    fail(`artifacts[${index}].sha256 must be 64 lowercase hex chars`);
  }
  if (!Number.isInteger(artifact.size) || artifact.size <= 0) {
    fail(`artifacts[${index}].size must be a positive integer`);
  }
  if (typeof artifact.url !== "string" || !artifact.url.startsWith("https://")) {
    fail(`artifacts[${index}].url must be https`);
  }
}

if (args.expectRelease !== null && args.expectRelease !== releaseId) {
  fail(`manifest releaseId ${releaseId} does not match expected ${args.expectRelease}`);
}

process.stdout.write(
  `manifest OK: release=${releaseId} version=${version} build=${buildId} channel=${channel} artifacts=${artifacts.length}\n`,
);
