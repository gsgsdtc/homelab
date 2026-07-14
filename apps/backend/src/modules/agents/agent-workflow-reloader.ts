export interface ReloadWorkflowRequest {
  agentId: string;
  workflowKey: string;
  sourceHash: string;
  relativePath: string;
  extension: "ts" | "js";
}

export interface ReloadWorkflowResult {
  status: "succeeded" | "failed";
  loadedAt?: Date;
  error?: string;
}

export interface AgentWorkflowReloader {
  reloadWorkflow(request: ReloadWorkflowRequest): Promise<ReloadWorkflowResult>;
}

export const MASTRA_AGENT_WORKFLOW_RELOAD_HOOK = Symbol("MASTRA_AGENT_WORKFLOW_RELOAD_HOOK");
