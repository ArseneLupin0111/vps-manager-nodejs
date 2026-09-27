#!/usr/bin/env node
// Sign a release manifest with Ed25519 over its canonical JSON bytes.
//
// Usage:
//   node scripts/release/sign-manifest.mjs --in unsigned.json --out manifest.json
//
// The signing key comes from (in order): --key-file <path> or the
// AGENT_RELEASE_SIGNING_KEY environment variable (PKCS#8 PEM). This tool
// NEVER generates a key: a missing key is a hard failure so no release can
// accidentally be signed with ephemeral or fake material.
//
// --print-pubkey emits the matching raw public key (base64 of 32 bytes),
// which is exactly the value deployed as AGENT_RELEASE_PUBLIC_KEY.

import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { canonicalJson, canonicalizeManifest } from "./lib/canonical.mjs";

function fail(message) {
  process.stderr.write(`sign-manifest: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { in: null, out: null, keyFile: null, printPubkey: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--in") args.in = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--key-file") args.keyFile = argv[++i];
    else if (arg === "--print-pubkey") args.printPubkey = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: sign-manifest.mjs --in <unsigned.json> [--out <signed.json>]\n" +
          "                        [--key-file <pkcs8.pem>]\n" +
          "                        (key otherwise read from AGENT_RELEASE_SIGNING_KEY)\n" +
          "                        [--print-pubkey]\n",
      );
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!args.in) fail("--in <unsigned.json> is required");
  return args;
}

const args = parseArgs(process.argv.slice(2));

const keyMaterial = args.keyFile
  ? readFileSync(args.keyFile, "utf8")
  : process.env.AGENT_RELEASE_SIGNING_KEY;
if (!keyMaterial || keyMaterial.trim() === "") {
  fail(
    "no signing key: pass --key-file or set AGENT_RELEASE_SIGNING_KEY " +
      "(PKCS#8 PEM); key generation is intentionally not supported",
  );
}

let privateKey;
try {
  privateKey = createPrivateKey({ key: keyMaterial, format: "pem", type: "pkcs8" });
} catch (error) {
  fail(`signing key is not a valid PKCS#8 PEM: ${error.message}`);
}
if (privateKey.asymmetricKeyType !== "ed25519") {
  fail(`signing key must be Ed25519 (got ${privateKey.asymmetricKeyType})`);
}

let document;
try {
  document = JSON.parse(readFileSync(args.in, "utf8"));
} catch (error) {
  fail(`cannot parse --in document: ${error.message}`);
}
if (document === null || typeof document !== "object" || Array.isArray(document)) {
  fail("--in document must be a JSON object");
}

let signature;
try {
  const unsigned = canonicalizeManifest(document);
  signature = sign(null, Buffer.from(unsigned, "utf8"), privateKey).toString("base64");
} catch (error) {
  fail(`cannot canonicalize/sign manifest: ${error.message}`);
}

const { signature: _existing, ...unsigned } = document;
void _existing;
// Serialized through the canonical serializer: recursively sorted keys, no
// insignificant whitespace, signature included — byte-stable output.
const signedText = canonicalJson({ ...unsigned, signature });

if (args.out) {
  writeFileSync(args.out, signedText, "utf8");
  process.stderr.write(`sign-manifest: wrote ${args.out}\n`);
} else {
  process.stdout.write(`${signedText}\n`);
}
if (args.printPubkey) {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  process.stdout.write(`${spki.subarray(spki.length - 32).toString("base64")}\n`);
}
