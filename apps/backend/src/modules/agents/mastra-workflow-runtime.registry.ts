import { Injectable } from "@nestjs/common";
import { pathToFileURL } from "url";
import { ReloadWorkflowResult } from "./agent-workflow-reloader";

export interface MastraWorkflowRuntimeReloadRequest {
  agentId: string;
  workflowKey: string;
  sourceHash: string;
  relativePath: string;
  sourcePath: string;
  extension: "ts" | "js";
}

export interface MastraWorkflowRuntimeRegistry {
  reloadWorkflow(request: MastraWorkflowRuntimeReloadRequest): Promise<ReloadWorkflowResult>;
}

export const MASTRA_WORKFLOW_RUNTIME_REGISTRY = Symbol("MASTRA_WORKFLOW_RUNTIME_REGISTRY");

@Injectable()
export class DynamicImportMastraWorkflowRuntimeRegistry implements MastraWorkflowRuntimeRegistry {
  private readonly workflows = new Map<string, unknown>();

  async reloadWorkflow(request: MastraWorkflowRuntimeReloadRequest): Promise<ReloadWorkflowResult> {
    try {
      const workflowModule = await import(`${pathToFileURL(request.sourcePath).href}?hash=${request.sourceHash}`);
      if (!workflowModule.default) {
        return {
          status: "failed",
          error: "Mastra workflow module must default export a workflow"
        };
      }
      this.workflows.set(this.key(request.agentId, request.workflowKey), workflowModule.default);
      return {
        status: "succeeded",
        loadedAt: new Date()
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "Mastra workflow runtime reload failed"
      };
    }
  }

  getWorkflow(agentId: string, workflowKey: string): unknown {
    return this.workflows.get(this.key(agentId, workflowKey));
  }

  private key(agentId: string, workflowKey: string): string {
    return `${agentId}:${workflowKey}`;
  }
}
