import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { dockerManagementClaimSchema, dockerManagementCreateSchema, dockerManagementResultSchema } from "./docker-management.schemas.js";
import { DockerManagementService } from "./docker-management.service.js";

@Controller("api/vps/:id/docker/management")
@UseGuards(DashboardSessionGuard, OriginGuard)
export class DockerManagementController {
  constructor(
    @Inject(DockerManagementService)
    private readonly service: DockerManagementService,
  ) {}
  @Get("capability") capability(@Param("id") id: string) { return this.service.capability(id); }
  @Post("actions") create(@Param("id") id: string, @Body() body: unknown) {
    try { const input = dockerManagementCreateSchema.parse(body); return this.service.create(id, { ...input, confirmedAt: new Date().toISOString() }); }
    catch (e) { if (e instanceof Error && e.name === "ZodError") throw new BadRequestException("Invalid management request"); throw e; }
  }
  @Get("actions/:operationId") get(@Param("id") id: string, @Param("operationId") operationId: string) { return this.service.get(id, operationId); }
  @Get("logs") logs(@Param("id") id: string, @Query("lines") lines: string, @Query("agentInstanceId") agentInstanceId: string, @Query("containerKey") containerKey: string) { return this.service.getLogs(id, { agentInstanceId, containerKey }, Number(lines) || 100); }
  @Post("actions/:operationId/claim") claim(@Param("id") id: string, @Param("operationId") operationId: string, @Body() body: unknown) { return this.service.claim(id, operationId, dockerManagementClaimSchema.parse(body).claimedBy); }
  @Post("actions/:operationId/result") result(@Param("id") id: string, @Param("operationId") operationId: string, @Body() body: unknown, @Req() req: Request) { const claimedBy = req.header("x-agent-instance") ?? ""; return this.service.result(id, operationId, claimedBy, dockerManagementResultSchema.parse(body)); }
}
