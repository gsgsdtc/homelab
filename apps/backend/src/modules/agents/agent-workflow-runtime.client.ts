import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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

@Injectable()
export class AgentWorkflowRuntimeClient {
  constructor(private readonly config: ConfigService) {}

  async reloadWorkflow(request: ReloadWorkflowRequest): Promise<ReloadWorkflowResult> {
    const runtimeUrl = this.config.get<string>("HOMELAB_WORKFLOW_RUNTIME_URL");
    if (!runtimeUrl) {
      return {
        status: "failed",
        error: "workflow runtime URL is not configured"
      };
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.get<number>("HOMELAB_WORKFLOW_RELOAD_TIMEOUT_MS", 30_000)
    );
    try {
      const response = await fetch(
        `${runtimeUrl.replace(/\/$/, "")}/runtime/agents/${encodeURIComponent(request.agentId)}/workflows/${encodeURIComponent(
          request.workflowKey
        )}/reload`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceHash: request.sourceHash,
            relativePath: request.relativePath,
            extension: request.extension
          }),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        return {
          status: "failed",
          error: `workflow runtime returned HTTP ${response.status}`
        };
      }
      const body = (await response.json()) as { status?: string; loadedAt?: string; error?: string };
      if (body.status !== "succeeded") {
        return {
          status: "failed",
          error: body.error || "workflow runtime reload failed"
        };
      }
      return {
        status: "succeeded",
        loadedAt: body.loadedAt ? new Date(body.loadedAt) : new Date()
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "workflow runtime reload failed"
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
