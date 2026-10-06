/**
 * Thin entry point for local dev (runs via `tsx scripts/admin/set-dashboard-password.ts`).
 *
 * In production, use the compiled version:
 *   node dist/scripts/set-dashboard-password.js --stdin < password.txt
 *   node dist/scripts/set-dashboard-password.js --stdin --skip-if-same < password.txt
 *
 * The implementation lives in packages/api/src/scripts/set-dashboard-password.ts
 * which compiles to dist/scripts/set-dashboard-password.js during `npm run build`.
 */

import { setDashboardPasswordFromCli } from "../../packages/api/src/scripts/set-dashboard-password.js";

setDashboardPasswordFromCli();
