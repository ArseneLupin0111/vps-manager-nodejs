#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseEnv(file) {
  if (!existsSync(file)) throw new Error(`${file} not found`);
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        const key = line.slice(0, index).trim();
        let value = line.slice(index + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );
}

const appEnv = existsSync(".env") ? parseEnv(".env") : {};
const vpsEnv = parseEnv(".env.vps");

const host = vpsEnv.LOCAL_VPS_IP;
const port = Number(vpsEnv.LOCAL_VPS_PORT || 22);
const username = vpsEnv.LOCAL_VPS_USER;

if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(
    "Invalid .env.vps: expected LOCAL_VPS_IP, LOCAL_VPS_PORT, LOCAL_VPS_USER",
  );
}

const dataDir = appEnv.DATA_DIR || "data";
mkdirSync(dataDir, { recursive: true });
const file = join(dataDir, "vps.json");
const data = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : { vps: [] };
data.vps = Array.isArray(data.vps) ? data.vps : [];

const now = new Date().toISOString();
let record = data.vps.find(
  (vps) =>
    vps.host === host && Number(vps.port) === port && vps.username === username,
);
let created = false;

if (record) {
  record.name = record.name || "Local VPS";
  record.provider = record.provider || "local";
  record.tags = Array.from(
    new Set([...(record.tags || []), "manual", "agent-candidate"]),
  );
  record.status = record.status || "unknown";
  record.updatedAt = now;
} else {
  created = true;
  record = {
    id: `vps_${randomBytes(9).toString("base64url")}`,
    name: "Local VPS",
    host,
    port,
    username,
    provider: "local",
    tags: ["manual", "agent-candidate"],
    status: "unknown",
    notes: "Imported from .env.vps for agent testing. Password was not stored.",
    createdAt: now,
    updatedAt: now,
  };
  data.vps.push(record);
}

writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      created,
      passwordStored: false,
    },
    null,
    2,
  ),
);
