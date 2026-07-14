import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AgentWorkflowRuntimeClient } from "./agent-workflow-runtime.client";
import { AgentWorkflowSnapshotService } from "./agent-workflow-snapshot.service";
import { AgentWorkflowValidator } from "./agent-workflow-validator.service";
import { AgentWorkspaceService } from "./agent-workspace.service";
import { AgentWorkflowsController } from "./agent-workflows.controller";
import { AgentWorkflowsService } from "./agent-workflows.service";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { MASTRA_AGENT_WORKFLOW_RELOAD_HOOK } from "./agent-workflow-reloader";
import { LocalMastraWorkflowReloadHook } from "./local-mastra-workflow-reload.hook";
import { MastraAgentWorkflowReloader } from "./mastra-agent-workflow-reloader";

@Module({
  imports: [PrismaModule],
  controllers: [AgentsController, AgentWorkflowsController],
  providers: [
    AgentsService,
    AgentWorkspaceService,
    AgentWorkflowsService,
    AgentWorkflowValidator,
    LocalMastraWorkflowReloadHook,
    {
      provide: MASTRA_AGENT_WORKFLOW_RELOAD_HOOK,
      useExisting: LocalMastraWorkflowReloadHook
    },
    MastraAgentWorkflowReloader,
    AgentWorkflowRuntimeClient,
    AgentWorkflowSnapshotService
  ],
  exports: [AgentsService, AgentWorkflowsService, AgentWorkflowSnapshotService]
})
export class AgentsModule {}
