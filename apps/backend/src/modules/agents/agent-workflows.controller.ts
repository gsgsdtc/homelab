import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AgentWorkflowsService } from "./agent-workflows.service";
import { CreateWorkflowDto, ReloadWorkflowDto, RollbackWorkflowDto, WorkflowSourceDto } from "./dto/workflow.dto";

@Controller("agents/:agentId/workflows")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AgentWorkflowsController {
  constructor(private readonly workflows: AgentWorkflowsService) {}

  @Get()
  list(@Param("agentId") agentId: string) {
    return this.workflows.list(agentId);
  }

  @Post()
  create(@Param("agentId") agentId: string, @Body() dto: CreateWorkflowDto) {
    return this.workflows.create(agentId, dto);
  }

  @Get(":workflowKey")
  get(@Param("agentId") agentId: string, @Param("workflowKey") workflowKey: string, @Query("view") view: "active" | "draft" = "draft") {
    return this.workflows.get(agentId, workflowKey, view);
  }

  @Put(":workflowKey")
  saveDraft(@Param("agentId") agentId: string, @Param("workflowKey") workflowKey: string, @Body() dto: WorkflowSourceDto) {
    return this.workflows.update(agentId, workflowKey, dto);
  }

  @Post(":workflowKey/validate")
  validate(@Param("agentId") agentId: string, @Param("workflowKey") workflowKey: string, @Body() dto: WorkflowSourceDto) {
    return this.workflows.validate(agentId, workflowKey, dto);
  }

  @Post(":workflowKey/reload")
  reload(@Param("agentId") agentId: string, @Param("workflowKey") workflowKey: string, @Body() dto: ReloadWorkflowDto) {
    return this.workflows.reload(agentId, workflowKey, dto);
  }

  @Post(":workflowKey/save-and-reload")
  saveAndReload(@Param("agentId") agentId: string, @Param("workflowKey") workflowKey: string, @Body() dto: WorkflowSourceDto) {
    return this.workflows.saveAndReload(agentId, workflowKey, dto);
  }

  @Get(":workflowKey/versions")
  versions(@Param("agentId") agentId: string, @Param("workflowKey") workflowKey: string) {
    return this.workflows.versions(agentId, workflowKey);
  }

  @Post(":workflowKey/rollback")
  rollback(@Param("agentId") agentId: string, @Param("workflowKey") workflowKey: string, @Body() dto: RollbackWorkflowDto) {
    return this.workflows.rollback(agentId, workflowKey, dto);
  }
}

@Controller("agents/:agentId/workflow-capabilities")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AgentWorkflowCapabilitiesController {
  constructor(private readonly workflows: AgentWorkflowsService) {}

  @Get()
  get(@Param("agentId") _agentId: string) {
    return this.workflows.capabilities();
  }
}
