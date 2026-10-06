#!/usr/bin/env node

import { readFileSync } from "node:fs";

function parseEnv(file) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        let value = line.slice(index + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [line.slice(0, index).trim(), value];
      }),
  );
}

const env = parseEnv(".env.vps");
const payload = {
  name: "Local VPS",
  host: env.LOCAL_VPS_IP,
  port: Number(env.LOCAL_VPS_PORT || 22),
  username: env.LOCAL_VPS_USER,
  provider: "local",
  tags: ["manual", "agent-candidate"],
  status: "unknown",
  notes: "Imported from .env.vps for agent testing. Password was not stored.",
};

if (!payload.host || !payload.username || !Number.isInteger(payload.port)) {
  throw new Error(
    "Invalid .env.vps: expected LOCAL_VPS_IP, LOCAL_VPS_PORT, LOCAL_VPS_USER",
  );
}

const baseUrl = process.env.VPS_MANAGER_URL || "http://localhost:3000";
const listResponse = await fetch(`${baseUrl}/api/vps`);
const listPayload = await listResponse.json();

if (!listResponse.ok) {
  throw new Error(`Failed to list VPS records: ${listResponse.status}`);
}

const existing = (listPayload.data || []).find(
  (vps) =>
    vps.host === payload.host &&
    Number(vps.port) === payload.port &&
    vps.username === payload.username,
);

if (existing) {
  console.log(
    JSON.stringify(
      {
        action: "exists",
        id: existing.id,
        name: existing.name,
        host: existing.host,
        port: existing.port,
        username: existing.username,
        keyProvisioned: Boolean(existing.keyProvisionedAt),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const createResponse = await fetch(`${baseUrl}/api/vps`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const createPayload = await createResponse.json().catch(() => ({}));

if (!createResponse.ok) {
  console.error(
    JSON.stringify(
      {
        status: createResponse.status,
        error: createPayload.error || createPayload,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const vps = createPayload.data;
console.log(
  JSON.stringify(
    {
      action: "created",
      id: vps.id,
      name: vps.name,
      host: vps.host,
      port: vps.port,
      username: vps.username,
      passwordStored: false,
    },
    null,
    2,
  ),
);
