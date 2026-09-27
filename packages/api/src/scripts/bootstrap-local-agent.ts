/**
 * CLI script to bootstrap the local agent for a host.
 *
 * Compiled to dist/scripts/bootstrap-local-agent.js during `npm run build`.
 * For production runtime:
 *   node dist/scripts/bootstrap-local-agent.js --backend-url http://127.0.0.1:3000
 *
 * Usage:
 *   node dist/scripts/bootstrap-local-agent.js [options]
 *
 * Options:
 *   --backend-url <url>           Required. Backend URL the agent should push metrics to.
 *   --vps-id <id>                 Local VPS record ID (default: vps_local_host).
 *   --interval-seconds <n>        Agent metric push interval (default: 15).
 *   --request-timeout-seconds <n> Agent HTTP request timeout (default: 10).
 *   --rotate                      Rotate credential if one already exists (default: keep existing).
 *   --config-only                 Output only the agent config JSON (no envelope).
 *
 * Backend URL policy: HTTPS always; HTTP only for loopback addresses
 * (127.0.0.1, ::1, localhost) — there is no override.
 *
 * The script:
 *   1. Loads app config (reads .env via loadAppConfig).
 *   2. Creates repositories matching the active storage driver.
 *   3. Ensures the local host VPS record exists.
 *   4. Creates (or rotates) an active agent credential.
 *   5. Outputs JSON with vpsId, credentialId, and agent config.
 *   6. Never writes the token to stderr, logs, or audit.
 *   7. Closes DB pool in finally.
 */

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../config/app-config.js";
import { createRepositories } from "../persistence/repositories/create-repositories.js";
import { hostname, userInfo } from "node:os";

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
  out(`Usage: node dist/scripts/bootstrap-local-agent.js --backend-url <url> [options]

Options:
  --backend-url <url>             Required. Backend URL for agent to push metrics.
  --vps-id <id>                   Local VPS record ID (default: vps_local_host).
  --interval-seconds <n>          Agent metric push interval (default: 15).
  --request-timeout-seconds <n>   Agent HTTP request timeout (default: 10).
  --rotate                        Rotate credential if one already exists.
  --config-only                   Output only the agent config JSON.
  --help                          Show this help.
`);
  process.exit(exitCode);
}

/**
 * Validate a backend URL for agent use.
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
  // Normalize hostname: Node.js URL.hostname may return "[::1]" (with brackets) on some versions
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

function parseIntegerOption(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

// ── Main ─────────────────────────────────────────────────────────────────

export type BootstrapOutput = {
  vpsId: string;
  credentialId: string;
  config: {
    backendUrl: string;
    vpsId: string;
    token: string;
    intervalSeconds: number;
    requestTimeoutSeconds: number;
  };
};

export async function bootstrapLocalAgent(): Promise<BootstrapOutput> {
  // ── Parse args ───────────────────────────────────────────────────────
  if (hasFlag("--help")) usage();

  const backendUrlRaw = argValue("--backend-url");
  if (!backendUrlRaw) {
    console.error("Error: --backend-url is required.");
    usage(1);
  }

  const vpsId = argValue("--vps-id") ?? DEFAULT_LOCAL_HOST_ID;
  let intervalSeconds: number;
  let requestTimeoutSeconds: number;
  try {
    intervalSeconds = parseIntegerOption("--interval-seconds", 15, 1, 3600);
    requestTimeoutSeconds = parseIntegerOption(
      "--request-timeout-seconds",
      10,
      1,
      300,
    );
  } catch (error: unknown) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const rotate = hasFlag("--rotate");
  const configOnly = hasFlag("--config-only");

  // Validate backend URL
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
    console.error("Error: bootstrap-local-agent requires APP_MODE=local.");
    process.exit(1);
  }
  const repos = createRepositories(config);
  const { vps: vpsRepository, agent: agentRepository, pool } = repos;

  let result: BootstrapOutput;

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

    // ── Find existing credential / create new ────────────────────────────
    const existingCredentials =
      await agentRepository.listCredentialsByVps(vpsId);
    const activeCredentials = existingCredentials.filter(
      (credential) => credential.status === "active",
    );

    let credentialId: string;
    let token: string;

    if (activeCredentials.length > 0 && !rotate) {
      throw new Error(
        `An active credential already exists for ${vpsId}, and the raw token cannot be recovered. ` +
          `Reuse the existing agent config or pass --rotate to issue a new token.`,
      );
    } else {
      // Create fresh credential
      const secret = randomBytes(32).toString("hex");
      const secretHash = hashSecret(secret);
      const credential = await agentRepository.createCredential({
        vpsId,
        secretHash,
        status: "active",
      });
      credentialId = credential.id;
      token = `${TOKEN_PREFIX}${credential.id}_${secret}`;
    }

    // ── Build output ─────────────────────────────────────────────────────
    const agentConfig = {
      backendUrl:
        backendUrl.origin + (backendUrl.pathname.replace(/\/+$/, "") || ""),
      vpsId,
      token,
      intervalSeconds,
      requestTimeoutSeconds,
    };

    const output: BootstrapOutput = {
      vpsId,
      credentialId,
      config: agentConfig,
    };

    if (configOnly) {
      // Output only the agent config JSON (for direct pipe to config file)
      console.log(JSON.stringify(agentConfig));
    } else {
      console.log(JSON.stringify(output));
    }

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
  bootstrapLocalAgent().catch((error: unknown) => {
    console.error(
      "Failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
