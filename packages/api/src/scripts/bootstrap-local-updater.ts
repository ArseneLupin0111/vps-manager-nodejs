/**
 * CLI script to bootstrap the local-updater credential for a host.
 *
 * The local-updater credential is distinct from the metrics/agent credential:
 * it is scoped `local-updater` so it can only pull upgrade jobs, never push
 * metrics or claim agent commands.
 *
 * Compiled to dist/scripts/bootstrap-local-updater.js during `npm run build`.
 * For production runtime:
 *   node dist/scripts/bootstrap-local-updater.js --backend-url http://127.0.0.1:3000
 *
 * Usage:
 *   node dist/scripts/bootstrap-local-updater.js [options]
 *
 * Options:
 *   --backend-url <url>   Required. Backend URL the updater polls.
 *   --vps-id <id>         Local VPS record ID (default: vps_local_host).
 *   --rotate              Rotate credential if one already exists.
 *   --help                Show this help.
 *
 * The script:
 *   1. Loads app config (reads .env via loadAppConfig).
 *   2. Creates repositories matching the active storage driver.
 *   3. Ensures the local host VPS record exists (and is actually local).
 *   4. Creates (or rotates) an active credential with scope `local-updater`.
 *   5. Outputs JSON with vpsId, credentialId, and token — once.
 *   6. Never writes the token to stderr, logs, or audit.
 *   7. Closes DB pool in finally.
 */

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, userInfo } from "node:os";
import { loadAppConfig } from "../config/app-config.js";
import { createRepositories } from "../persistence/repositories/create-repositories.js";

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_LOCAL_HOST_ID = "vps_local_host";
const TOKEN_PREFIX = "vma_";

// ── Helpers ──────────────────────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const val = process.argv[idx + 1];
  return val && !val.startsWith("--") ? val : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(exitCode = 0): never {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage: node dist/scripts/bootstrap-local-updater.js --backend-url <url> [options]

Options:
  --backend-url <url>             Required. Backend URL the updater polls.
  --vps-id <id>                   Local VPS record ID (default: vps_local_host).
  --rotate                        Rotate credential if one already exists.
  --help                          Show this help.
`);
  process.exit(exitCode);
}

/**
 * Validate a backend URL for updater use.
 * - HTTPS is always allowed.
 * - HTTP is allowed for loopback addresses (127.0.0.1, ::1, localhost) only.
 *   There is no override: a non-loopback backend must be HTTPS.
 */
export function validateBackendUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid backend URL: ${urlString}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Backend URL must use http or https protocol: ${urlString}`,
    );
  }

  if (url.protocol === "https:") {
    return url; // HTTPS always ok
  }

  // http: — loopback only, no override.
  const rawHostname = url.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (!isLoopback) {
    throw new Error(
      `Insecure backend URL (http) for non-loopback host "${rawHostname}". ` +
        `Use https, or http with a loopback host (127.0.0.1, ::1, localhost).`,
    );
  }

  return url;
}

/**
 * Hash a secret using SHA-256.
 */
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ── Main ─────────────────────────────────────────────────────────────────

export type BootstrapUpdaterOutput = {
  vpsId: string;
  credentialId: string;
  token: string;
};

export async function bootstrapLocalUpdater(): Promise<BootstrapUpdaterOutput> {
  // ── Parse args ───────────────────────────────────────────────────────
  if (hasFlag("--help")) usage();

  const backendUrlRaw = argValue("--backend-url");
  if (!backendUrlRaw) {
    console.error("Error: --backend-url is required.");
    usage(1);
  }

  const vpsId = argValue("--vps-id") ?? DEFAULT_LOCAL_HOST_ID;
  const rotate = hasFlag("--rotate");

  let backendUrl: URL;
  try {
    backendUrl = validateBackendUrl(backendUrlRaw);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Bootstrap repositories ───────────────────────────────────────────
  const config = loadAppConfig();
  if (config.mode !== "local") {
    console.error("Error: bootstrap-local-updater requires APP_MODE=local.");
    process.exit(1);
  }
  const repos = createRepositories(config);
  const { vps: vpsRepository, agent: agentRepository, pool } = repos;

  let result: BootstrapUpdaterOutput;

  try {
    // ── Ensure local host record ────────────────────────────────────────
    const localHostname = (() => {
      try {
        return hostname();
      } catch {
        return "Local host";
      }
    })();
    const localUsername = (() => {
      try {
        return userInfo().username;
      } catch {
        return "root";
      }
    })();

    await vpsRepository.ensureLocalHost({
      id: vpsId,
      name: localHostname,
      host: backendUrl.hostname,
      port: 22,
      username: localUsername,
      provider: "local",
      tags: ["local", "local-agent", "system"],
      status: "unknown",
      kind: "local",
      managedBy: "system",
      notes: `Local agent auto-managed. Host: ${localHostname}, User: ${localUsername}`,
    });

    // The updater credential may only ever bind to a local host record —
    // refuse if the record at this id is remote (e.g. a recycled id).
    const vps = await vpsRepository.get(vpsId);
    if (!vps || (vps.kind !== "local" && vps.managedBy !== "system")) {
      console.error(
        `Error: VPS record "${vpsId}" is not a local host; refusing to issue an updater credential.`,
      );
      process.exit(1);
    }

    // ── Find existing updater credential / create new ───────────────────
    const existingCredentials =
      await agentRepository.listCredentialsByVps(vpsId);
    const activeUpdaterCredentials = existingCredentials.filter(
      (credential) =>
        credential.status === "active" &&
        (credential.scope ?? "agent") === "local-updater",
    );

    let credentialId: string;
    let token: string;

    if (activeUpdaterCredentials.length > 0 && !rotate) {
      throw new Error(
        `An active local-updater credential already exists for ${vpsId}, and the raw token cannot be recovered. ` +
          `Pass --rotate to issue a new token.`,
      );
    } else {
      // Create fresh credential — scope local-updater, never agent metrics.
      const secret = randomBytes(32).toString("hex");
      const secretHash = hashSecret(secret);
      const credential = await agentRepository.createCredential({
        vpsId,
        secretHash,
        status: "active",
        scope: "local-updater",
      });
      credentialId = credential.id;
      token = `${TOKEN_PREFIX}${credential.id}_${secret}`;
    }

    const output: BootstrapUpdaterOutput = { vpsId, credentialId, token };

    // Output the raw token exactly once, to stdout, as JSON.
    console.log(JSON.stringify(output));
    result = output;
  } finally {
    if (pool) await pool.end();
  }

  return result;
}

// Allow both direct execution and import
const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isDirectRun) {
  bootstrapLocalUpdater().catch((error: unknown) => {
    console.error(
      "Failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
