import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AgentWorkflowReloader,
  MASTRA_AGENT_WORKFLOW_RELOAD_HOOK,
  ReloadWorkflowRequest,
  ReloadWorkflowResult
} from "./agent-workflow-reloader";

@Injectable()
export class MastraAgentWorkflowReloader implements AgentWorkflowReloader {
  constructor(
    @Optional()
    @Inject(MASTRA_AGENT_WORKFLOW_RELOAD_HOOK)
    private readonly hook?: AgentWorkflowReloader
  ) {}

  async reloadWorkflow(request: ReloadWorkflowRequest): Promise<ReloadWorkflowResult> {
    if (!this.hook) {
      return {
        status: "failed",
        error: "in-process Mastra workflow reload hook is not registered"
      };
    }
    try {
      return await this.hook.reloadWorkflow(request);
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "in-process Mastra workflow reload failed"
      };
    }
  }
}
