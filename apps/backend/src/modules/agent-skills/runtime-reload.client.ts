import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AgentSkillReloadStatus } from "@prisma/client";

export interface RuntimeReloadRequest {
  agentId: string;
  workspacePath: string;
  activeConfigVersion: string;
}

export interface RuntimeReloadResult {
  reloadStatus: AgentSkillReloadStatus;
  errorCode?: string;
  safeErrorSummary?: string;
}

@Injectable()
export class RuntimeReloadClient {
  constructor(private readonly config: ConfigService) {}

  async reloadSkills(_request: RuntimeReloadRequest): Promise<RuntimeReloadResult> {
    if (this.config.get<string>("HOMELAB_RUNTIME_OFFLINE") === "true") {
      return { reloadStatus: AgentSkillReloadStatus.runtime_offline };
    }
    if (this.config.get<string>("HOMELAB_RUNTIME_RELOAD_FAIL") === "true") {
      return {
        reloadStatus: AgentSkillReloadStatus.failed,
        errorCode: "SKILL_RELOAD_FAILED",
        safeErrorSummary: "runtime reload failed"
      };
    }
    return { reloadStatus: AgentSkillReloadStatus.pending_restart };
  }
}
