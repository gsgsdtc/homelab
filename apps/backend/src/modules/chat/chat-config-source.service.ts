import { Inject, Injectable } from "@nestjs/common";
import { Agent } from "@prisma/client";
import { createHash } from "crypto";
import { AgentWorkspaceService } from "../agents/agent-workspace.service";
import {
  MASTRA_WORKFLOW_RUNTIME_REGISTRY,
  MastraWorkflowRuntimeRegistry
} from "../agents/mastra-workflow-runtime.registry";
import { ModelProvidersService, ResolvedModelProvider } from "../model-providers/model-providers.service";
import { PrismaService } from "../prisma/prisma.service";
import { ChatApiException, executionError } from "./chat.errors";

export type ChatConfigAgent = Agent;

@Injectable()
export class ChatConfigSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ModelProvidersService,
    private readonly workspaces: AgentWorkspaceService,
    @Inject(MASTRA_WORKFLOW_RUNTIME_REGISTRY)
    private readonly workflowRegistry: Pick<MastraWorkflowRuntimeRegistry, "getWorkflow" | "loadWorkflowVersion">
  ) {}

  async getAgent(agentId: string): Promise<ChatConfigAgent> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new ChatApiException(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    return agent;
  }

  async resolveProvider(agent: ChatConfigAgent) {
    let provider: ResolvedModelProvider;
    try {
      provider = await this.providers.resolveProviderForAgent(agent.modelProviderId ?? undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/disabled/i.test(message)) {
        throw executionError({
          httpStatus: 422,
          code: "PROVIDER_DISABLED",
          message: "Agent model provider is disabled",
          retryable: false
        });
      }
      if (/default model provider/i.test(message)) {
        throw executionError({
          httpStatus: 422,
          code: "DEFAULT_PROVIDER_NOT_FOUND",
          message: "No enabled default model provider is configured",
          retryable: false
        });
      }
      if (/provider.*not found/i.test(message)) {
        throw executionError({
          httpStatus: 422,
          code: "PROVIDER_NOT_FOUND",
          message: "Agent model provider was not found",
          retryable: false
        });
      }
      throw error;
    }
    return {
      ...provider,
      model: provider.defaultModel,
      revision: this.hash({
        id: provider.id,
        baseUrl: provider.baseUrl,
        model: provider.defaultModel,
        credential: this.hash(provider.apiKey)
      })
    };
  }

  readSoul(agent: ChatConfigAgent) {
    return this.workspaces.readSoul(agent);
  }

  async readSkills(agent: ChatConfigAgent) {
    const installations = await this.prisma.agentSkillInstallation.findMany({
      where: { agentId: agent.id, enabled: true },
      orderBy: { skillName: "asc" }
    });
    const bundles = new Map<string, Awaited<ReturnType<AgentWorkspaceService["readSkillsConfigVersion"]>>>();
    try {
      for (const configVersion of new Set(installations.map((skill) => skill.configVersion))) {
        bundles.set(configVersion, await this.workspaces.readSkillsConfigVersion(agent, configVersion));
      }
      return installations.map((skill) => {
        const bundle = bundles
          .get(skill.configVersion)
          ?.find(
            (entry) =>
              entry.name === skill.skillName &&
              entry.version === skill.version &&
              entry.sourceType === skill.sourceType &&
              entry.sourceId === skill.sourceId &&
              entry.enabled
          );
        if (!bundle) throw new Error("active skill entry is missing from immutable bundle");
        return {
          name: skill.skillName,
          version: skill.version,
          configVersion: skill.configVersion,
          sourceType: skill.sourceType,
          sourceId: skill.sourceId,
          bundle: Object.freeze({ ...bundle })
        };
      });
    } catch (error) {
      void error;
      throw executionError({
        httpStatus: 422,
        code: "SKILLS_SNAPSHOT_UNAVAILABLE",
        message: "Agent Skills are unavailable",
        retryable: false
      });
    }
  }

  async readWorkflow(agent: ChatConfigAgent) {
    const workflow = await this.prisma.agentWorkflow.findUnique({
      where: { agentId_workflowKey: { agentId: agent.id, workflowKey: "default" } }
    });
    if (!workflow?.activeHash || workflow.reloadStatus !== "succeeded") {
      throw executionError({
        httpStatus: 422,
        code: "WORKFLOW_NOT_ACTIVE",
        message: "Agent default chat workflow is not active",
        retryable: false
      });
    }
    const version = await this.prisma.agentWorkflowVersion.findFirst({
      where: { workflowId: workflow.id, sourceHash: workflow.activeHash },
      orderBy: { promotedAt: "desc" }
    });
    if (!version) {
      throw executionError({
        httpStatus: 422,
        code: "WORKFLOW_NOT_ACTIVE",
        message: "Agent default chat workflow is not active",
        retryable: false
      });
    }
    let executable = this.workflowRegistry.getWorkflow(agent.id, "default", workflow.activeHash);
    try {
      executable ??= await this.workflowRegistry.loadWorkflowVersion({
        agentId: agent.id,
        workflowKey: "default",
        sourceHash: workflow.activeHash,
        source: version.source,
        extension: version.extension === "js" ? "js" : "ts"
      });
    } catch (error) {
      void error;
      throw executionError({
        httpStatus: 422,
        code: "WORKFLOW_NOT_ACTIVE",
        message: "Agent default chat Workflow is not active",
        retryable: false
      });
    }
    if (!this.isMastraExecutable(executable)) {
      throw executionError({
        httpStatus: 422,
        code: "WORKFLOW_NOT_ACTIVE",
        message: "Agent default chat Workflow is not active",
        retryable: false
      });
    }
    return { workflowKey: "default" as const, activeHash: workflow.activeHash, source: version.source, executable };
  }

  async readVersionVector(agentId: string): Promise<string> {
    const agent = await this.getAgent(agentId);
    const [provider, soul, skills, workflow] = await Promise.all([
      this.resolveProvider(agent),
      this.readSoul(agent),
      this.readSkills(agent),
      this.readWorkflow(agent)
    ]);
    if (soul.status === "error" || soul.content === null) {
      throw executionError({
        httpStatus: 422,
        code: "SOUL_SNAPSHOT_UNAVAILABLE",
        message: "Agent Soul is unavailable",
        retryable: false
      });
    }
    return this.hash({
      provider: provider.revision,
      soul: this.hash(soul.content),
      skills: skills.map((skill) => [skill.name, skill.configVersion]),
      workflow: workflow.activeHash
    });
  }

  private hash(value: unknown): string {
    const input = typeof value === "string" ? value : JSON.stringify(value);
    return createHash("sha256").update(input, "utf8").digest("hex");
  }

  private isMastraExecutable(value: unknown): value is { createRun(options?: { runId?: string }): Promise<unknown> } {
    return Boolean(
      value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).committed === true &&
        typeof (value as Record<string, unknown>).createRun === "function"
    );
  }
}

export type ResolvedChatProvider = ResolvedModelProvider & { model: string; revision: string };
