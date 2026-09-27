import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { LocalUpgradeService } from "./local-upgrade.service.js";
import {
  idempotencyKeySchema,
  localAgentUpgradeCreateSchema,
  localUpgradeListQuerySchema,
} from "./local-upgrade.schemas.js";

/**
 * Admin surface for local agent upgrades.
 * Confirmation is a UX dialog + session cookie + Origin check — no CSRF or
 * confirmationToken field exists in this codebase.
 */
@Controller("api/vps")
@UseGuards(DashboardSessionGuard, OriginGuard)
export class LocalUpgradeController {
  constructor(
    @Inject(LocalUpgradeService)
    private readonly service: LocalUpgradeService,
  ) {}

  @Get(":id/agent-update")
  async agentUpdate(@Param("id") id: string) {
    return { data: await this.service.getAgentUpdate(id) };
  }

  @Post(":id/local-agent-upgrades")
  async create(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Req() req: Request,
  ) {
    const input = localAgentUpgradeCreateSchema.parse(body);
    const idempotencyKey = idempotencyKeyHeader
      ? idempotencyKeySchema.parse(idempotencyKeyHeader)
      : undefined;
    const { job } = await this.service.createJob(id, input, {
      idempotencyKey,
      actor: req.dashboardSessionId ?? "dashboard",
    });
    return { data: job };
  }

  @Get(":id/local-agent-upgrades")
  async list(@Param("id") id: string, @Query() query: Record<string, unknown>) {
    const { limit, offset } = localUpgradeListQuerySchema.parse(query);
    const jobs = await this.service.listJobs(id, { limit, offset });
    return { data: jobs, meta: { limit, offset, count: jobs.length } };
  }

  @Get(":id/local-agent-upgrades/:jobId")
  async get(@Param("id") id: string, @Param("jobId") jobId: string) {
    return { data: await this.service.getJob(id, jobId) };
  }
}
