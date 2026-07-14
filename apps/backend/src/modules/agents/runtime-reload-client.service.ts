import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Agent } from "@prisma/client";
import { AgentSkillReloadStatusValue } from "./agent-skill-types";

export interface RuntimeReloadResult {
  reloadStatus: AgentSkillReloadStatusValue;
  effectiveFor: "next_task";
}

@Injectable()
export class RuntimeReloadClient {
  constructor(private readonly config: ConfigService) {}

  async reloadSkills(agent: Pick<Agent, "id" | "workspacePath">, activeConfigVersion: string): Promise<RuntimeReloadResult> {
    if (!this.isTestReloadInjectionEnabled()) {
      return { reloadStatus: "pending_restart", effectiveFor: "next_task" };
    }

    const injected = this.config.get<string>("HOMELAB_SKILL_RELOAD_MODE");
    if (injected === "runtime_offline") {
      return { reloadStatus: "runtime_offline", effectiveFor: "next_task" };
    }
    if (injected === "failed") {
      throw new Error(`skill reload failed for agent ${agent.id} config ${activeConfigVersion}`);
    }
    return { reloadStatus: "pending_restart", effectiveFor: "next_task" };
  }

  private isTestReloadInjectionEnabled(): boolean {
    return (
      this.config.get<string>("NODE_ENV") === "test" &&
      this.config.get<string>("HOMELAB_ENABLE_SKILL_RELOAD_TEST_MODE") === "true"
    );
  }
}
