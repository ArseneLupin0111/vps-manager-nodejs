#!/usr/bin/env tsx

import { createHash, randomBytes } from "node:crypto";
import { loadAppConfig } from "../../packages/api/src/config/app-config.js";
import { createRepositories } from "../../packages/api/src/persistence/repositories/create-repositories.js";

function usage(exitCode = 0): never {
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage: npx tsx scripts/agent/create-agent-token.ts --vps-id <vps_id>

Creates a one-time-display agent token for an existing VPS record.
The raw token is printed once; only its hash is stored server-side.

Options:
  --vps-id <id>   Existing VPS id to bind the token to
  --help          Show this help and exit
`);
  process.exit(exitCode);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

async function main() {
  if (process.argv.includes("--help")) usage();
  const vpsId = argValue("--vps-id");
  if (!vpsId) usage(1);

  const config = loadAppConfig();
  const repos = createRepositories(config);
  const { vps: vpsRepository, agent: agentRepository, pool } = repos;

  try {
    const vps = await vpsRepository.get(vpsId);
    if (!vps) {
      throw new Error(`VPS not found: ${vpsId}`);
    }

    const secret = randomBytes(32).toString("hex");
    const credential = await agentRepository.createCredential({
      vpsId: vps.id,
      secretHash: createHash("sha256").update(secret).digest("hex"),
      status: "active",
    });
    const token = `vma_${credential.id}_${secret}`;

    console.log(
      JSON.stringify(
        {
          vpsId: vps.id,
          credentialId: credential.id,
          token,
          configExample: {
            backendUrl: config.agentPublicBaseUrl || "http://localhost:3000",
            vpsId: vps.id,
            token,
            intervalSeconds: config.agentInstallIntervalSeconds,
            requestTimeoutSeconds: 5,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Failed to create agent token",
  );
  process.exit(1);
});
