#!/usr/bin/env tsx

/**
 * Thin entry point for local dev (runs via `npx tsx scripts/agent/bootstrap-local-agent.ts`).
 *
 * In production, use the compiled version:
 *   node dist/scripts/bootstrap-local-agent.js --backend-url http://127.0.0.1:3000
 *   node dist/scripts/bootstrap-local-agent.js --backend-url https://example.com --config-only > agent-config.json
 *
 * The implementation lives in packages/api/src/scripts/bootstrap-local-agent.ts
 * which compiles to dist/scripts/bootstrap-local-agent.js during `npm run build`.
 */

import { bootstrapLocalAgent } from "../../packages/api/src/scripts/bootstrap-local-agent.js";

bootstrapLocalAgent();
