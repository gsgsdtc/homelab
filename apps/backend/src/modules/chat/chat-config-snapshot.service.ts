import { Inject, Injectable } from "@nestjs/common";
import { AgentStatus } from "@prisma/client";
import { createHash } from "crypto";
import { ChatTestControlService } from "../chat-test-control/chat-test-control.service";
import { ChatConfigAgent, ChatConfigSourceService } from "./chat-config-source.service";
import { executionError, failureFrom } from "./chat.errors";
import { ChatConfigurationSnapshot, ChatEligibilityResponse } from "./chat.types";

type SnapshotSource = Pick<
  ChatConfigSourceService,
  "getAgent" | "resolveProvider" | "readSoul" | "readSkills" | "readWorkflow" | "readVersionVector"
>;
type SnapshotControl = Pick<ChatTestControlService, "checkpoint" | "increment" | "fault">;

@Injectable()
export class ChatConfigSnapshotService {
  constructor(
    @Inject(ChatConfigSourceService)
    private readonly source: SnapshotSource,
    @Inject(ChatTestControlService)
    private readonly testControl: SnapshotControl
  ) {}

  async getEligibility(agentId: string, testNamespace?: string): Promise<ChatEligibilityResponse> {
    const agent = await this.source.getAgent(agentId);
    if (agent.status !== AgentStatus.ready) {
      return this.ineligible(agent, "AGENT_NOT_READY", "Agent is not ready");
    }

    try {
      const provider = await this.source.resolveProvider(agent);
      const soul = await this.source.readSoul(agent);
      if (soul.status === "error" || soul.content === null) {
        return this.ineligible(agent, "SOUL_SNAPSHOT_UNAVAILABLE", "Agent Soul is unavailable");
      }
      await this.source.readSkills(agent);
      await this.source.readWorkflow(agent);
      return {
        agentId: agent.id,
        eligible: true,
        code: null,
        message: null,
        agent: { name: agent.name, status: agent.status },
        providerSummary: { id: provider.id, name: provider.name, model: provider.model ?? provider.defaultModel }
      };
    } catch (error) {
      const failure = failureFrom(error);
      const mapped = failure.code === "INTERNAL_ERROR" ? this.mapConfigurationError(error) : failure;
      return this.ineligible(agent, mapped.code, mapped.message);
    } finally {
      void testNamespace;
    }
  }

  async capture(agentId: string, testNamespace?: string): Promise<ChatConfigurationSnapshot> {
    if (this.testControl.fault(testNamespace, "config_read_error")) {
      throw executionError({
        httpStatus: 500,
        code: "CONFIG_READ_FAILED",
        message: "Agent configuration could not be read",
        retryable: true
      });
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.testControl.increment(testNamespace, "snapshotAttempts");
      const initialVector = await this.source.readVersionVector(agentId);
      await this.testControl.checkpoint(testNamespace, "afterInitialVector");
      const agent = await this.source.getAgent(agentId);
      if (agent.status !== AgentStatus.ready) {
        throw executionError({ httpStatus: 422, code: "AGENT_NOT_READY", message: "Agent is not ready", retryable: false });
      }
      const provider = await this.source.resolveProvider(agent);
      await this.testControl.checkpoint(testNamespace, "afterProviderLoad");
      const soul = await this.source.readSoul(agent);
      await this.testControl.checkpoint(testNamespace, "afterSoulLoad");
      if (soul.status === "error" || soul.content === null) {
        throw executionError({
          httpStatus: 422,
          code: "SOUL_SNAPSHOT_UNAVAILABLE",
          message: "Agent Soul is unavailable",
          retryable: false
        });
      }
      const skills = await this.source.readSkills(agent);
      await this.testControl.checkpoint(testNamespace, "afterSkillsLoad");
      const workflow = await this.source.readWorkflow(agent);
      await this.testControl.checkpoint(testNamespace, "afterWorkflowLoad");
      await this.testControl.checkpoint(testNamespace, "beforeFinalVector");
      const finalVector = await this.source.readVersionVector(agentId);
      if (initialVector !== finalVector) {
        continue;
      }
      return {
        provider: {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model ?? provider.defaultModel,
          revision: provider.revision
        },
        soul: soul.content,
        soulRevision: this.hash(soul.content),
        skills: Object.fromEntries(
          skills
            .slice()
            .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
            .map((skill: any) => [skill.name, { ...skill }])
        ),
        workflow,
        versionVector: finalVector,
        testNamespace
      };
    }

    throw executionError({
      httpStatus: 409,
      code: "CONFIG_SNAPSHOT_CONFLICT",
      message: "Agent configuration is changing; retry",
      retryable: true
    });
  }

  private ineligible(agent: ChatConfigAgent, code: string, message: string): ChatEligibilityResponse {
    return {
      agentId: agent.id,
      eligible: false,
      code,
      message,
      agent: { name: agent.name, status: agent.status },
      providerSummary: null
    };
  }

  private mapConfigurationError(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (/disabled/i.test(message)) return { code: "PROVIDER_DISABLED", message: "Agent model provider is disabled" };
    if (/default model provider/i.test(message)) {
      return { code: "DEFAULT_PROVIDER_NOT_FOUND", message: "No enabled default model provider is configured" };
    }
    if (/provider.*not found/i.test(message)) return { code: "PROVIDER_NOT_FOUND", message: "Agent model provider was not found" };
    return { code: "CONFIG_READ_FAILED", message: "Agent configuration could not be read" };
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
