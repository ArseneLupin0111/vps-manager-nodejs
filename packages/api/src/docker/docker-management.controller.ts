import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { APP_CONFIG } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import { DockerLogsPolicyError, DockerLogsService } from "./docker-logs.service.js";
import { dockerLogsStreamQuerySchema } from "./docker-logs.schemas.js";
import { dockerManagementClaimSchema, dockerManagementCreateSchema, dockerManagementResultSchema } from "./docker-management.schemas.js";
import { DockerManagementService } from "./docker-management.service.js";

@Controller("api/vps/:id/docker/management")
@UseGuards(DashboardSessionGuard, OriginGuard)
export class DockerManagementController {
  constructor(
    @Inject(DockerManagementService)
    private readonly service: DockerManagementService,
    @Inject(DockerLogsService)
    private readonly logBroker: DockerLogsService,
    @Inject(APP_CONFIG)
    private readonly config: AppConfig,
  ) {}
  @Get("capability") capability(@Param("id") id: string) { return this.service.capability(id); }
  @Post("actions") create(@Param("id") id: string, @Body() body: unknown) {
    try { const input = dockerManagementCreateSchema.parse(body); return this.service.create(id, { ...input, confirmedAt: new Date().toISOString() }); }
    catch (e) { if (e instanceof Error && e.name === "ZodError") throw new BadRequestException("Invalid management request"); throw e; }
  }
  @Get("actions/:operationId") get(@Param("id") id: string, @Param("operationId") operationId: string) { return this.service.get(id, operationId); }

  /**
   * Opens the realtime log SSE stream for one container. Both `agentInstanceId`
   * and `containerKey` are required, and the target must exist in the current
   * inventory snapshot. Policy failures are answered as plain JSON before any
   * SSE header, so the viewer sees a normal error the browser can report.
   */
  @Get("logs/stream")
  async streamLogs(
    @Param("id") id: string,
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    let query;
    try {
      query = dockerLogsStreamQuerySchema.parse(req.query);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        throw new BadRequestException("Invalid log stream request");
      }
      throw error;
    }
    try {
      await this.logBroker.open(
        res,
        { vpsId: id, ...query },
        {
          dashboardSessionId: req.dashboardSessionId,
          localMode: this.config.mode === "local",
        },
      );
    } catch (error) {
      if (error instanceof DockerLogsPolicyError) {
        if (!res.headersSent) {
          res.status(error.status).json({ error: { code: error.code } });
        }
        return;
      }
      throw error;
    }
  }

  @Post("actions/:operationId/claim") claim(@Param("id") id: string, @Param("operationId") operationId: string, @Body() body: unknown) { return this.service.claim(id, operationId, dockerManagementClaimSchema.parse(body).claimedBy); }
  @Post("actions/:operationId/result") result(@Param("id") id: string, @Param("operationId") operationId: string, @Body() body: unknown, @Req() req: Request) { const claimedBy = req.header("x-agent-instance") ?? ""; return this.service.result(id, operationId, claimedBy, dockerManagementResultSchema.parse(body)); }
}
