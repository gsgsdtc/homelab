import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Agent, AgentStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AgentSoulFileStatus, AgentSoulRead, AgentWorkspaceService } from "./agent-workspace.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
import { SaveAgentSoulDto } from "./dto/save-agent-soul.dto";
import { UpdateAgentDto } from "./dto/update-agent.dto";

export interface AgentInitError {
  code: "WORKSPACE_INITIALIZATION_FAILED";
  message: string;
}

export interface PublicAgent {
  id: string;
  name: string;
  status: AgentStatus;
  workspacePath: string;
  workspaceName: string;
  initError: AgentInitError | null;
  gitStatus: "available" | "unavailable";
  soul?: string | null;
  soulFileStatus?: AgentSoulFileStatus;
  soulFileError?: string;
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: AgentWorkspaceService
  ) {}

  async list(): Promise<PublicAgent[]> {
    const agents = await this.prisma.agent.findMany({
      orderBy: { createdAt: "desc" }
    });
    return agents.map((agent) => this.toPublic(agent));
  }

  async get(id: string): Promise<PublicAgent> {
    const agent = await this.findAgent(id);
    return this.toPublic(agent, await this.workspaces.readSoul(agent));
  }

  async create(dto: CreateAgentDto): Promise<PublicAgent> {
    const soul = this.normalizeSoul(dto.soul, { allowDefault: true, agentName: dto.name });
    this.assertNoSecretLeak(dto);
    const slug = this.buildSlug(dto.slug ?? dto.name);
    const id = randomUUID();
    const descriptor = this.workspaces.buildDescriptor(slug, id);
    const created = await this.prisma.agent.create({
      data: {
        id,
        name: dto.name,
        slug,
        status: AgentStatus.initializing,
        workspaceName: descriptor.workspaceName,
        workspacePath: descriptor.relativeWorkspacePath,
        modelProvider: dto.modelProvider,
        modelSecretRef: dto.modelSecretRef,
        soul
      }
    });

    const agent = await this.initializeAgent(created, false);
    return this.toPublic(agent);
  }

  async update(id: string, dto: UpdateAgentDto): Promise<PublicAgent> {
    const soul = this.normalizeSoul(dto.soul, { allowDefault: false });
    this.assertNoSecretLeak(dto);
    const previousAgent = await this.findAgent(id);
    const agent = await this.prisma.agent.update({
      where: { id },
      data: {
        name: dto.name,
        modelProvider: dto.modelProvider,
        modelSecretRef: dto.modelSecretRef,
        soul
      }
    });

    const initialized = await this.syncAgentWorkspace(agent, previousAgent);
    return this.toPublic(initialized);
  }

  async saveSoul(id: string, dto: SaveAgentSoulDto): Promise<PublicAgent> {
    const soul = this.normalizeSoul(dto.soul, { allowDefault: false });
    if (soul === undefined) {
      throw new BadRequestException("soul content must not be blank");
    }
    this.assertNoSecretLeak({ soul });
    const agent = await this.findAgent(id);
    await this.workspaces.writeSoul(agent, soul);
    await this.prisma.agent.update({
      where: { id },
      data: { soul }
    });
    return this.get(id);
  }

  async loadSoulForRun(id: string): Promise<string> {
    const agent = await this.findAgent(id);
    return this.workspaces.readSoulForRun(agent);
  }

  async retryInitialization(id: string): Promise<PublicAgent> {
    const agent = await this.findAgent(id);
    const retried = this.hasWorkspaceUserEditConflict(agent)
      ? await this.syncAgentWorkspace(agent, agent)
      : await this.initializeAgent(agent, true);
    return this.toPublic(retried);
  }

  private async initializeAgent(agent: Agent, allowExistingWorkspace: boolean): Promise<Agent> {
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: AgentStatus.initializing,
        initializationError: null
      }
    });

    try {
      await this.workspaces.initializeWorkspace(agent, { allowExistingWorkspace });
      return await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.ready,
          initializationError: null,
          initializedAt: new Date()
        }
      });
    } catch (error) {
      return this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.init_failed,
          initializationError: this.formatError(error)
        }
      });
    }
  }

  private async syncAgentWorkspace(agent: Agent, previousAgent: Agent): Promise<Agent> {
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: AgentStatus.initializing,
        initializationError: null
      }
    });

    try {
      await this.workspaces.syncWorkspace(agent, previousAgent);
      return await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.ready,
          initializationError: null,
          initializedAt: new Date()
        }
      });
    } catch (error) {
      return this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.init_failed,
          initializationError: this.formatError(error)
        }
      });
    }
  }

  private async findAgent(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException("agent not found");
    }
    return agent;
  }

  private hasWorkspaceUserEditConflict(agent: Agent): boolean {
    return (
      agent.status === AgentStatus.init_failed &&
      (agent.initializationError ?? "").startsWith("workspace file has user edits:")
    );
  }

  private buildSlug(input: string): string {
    const slug = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) {
      throw new BadRequestException("agent slug must contain letters or numbers");
    }
    return slug;
  }

  private assertNoSecretLeak(dto: CreateAgentDto | UpdateAgentDto | SaveAgentSoulDto): void {
    const fields: Array<[string, string | undefined]> = [
      ["name", "name" in dto ? dto.name : undefined],
      ["slug", "slug" in dto ? dto.slug : undefined],
      ["modelProvider", "modelProvider" in dto ? dto.modelProvider : undefined],
      ["modelSecretRef", "modelSecretRef" in dto ? dto.modelSecretRef : undefined],
      ["soul", dto.soul]
    ];

    for (const [field, value] of fields) {
      if (value && this.looksLikeSecret(value)) {
        throw new BadRequestException(`${field} must not contain real secret values`);
      }
    }
  }

  private looksLikeSecret(value: string): boolean {
    return [
      /sk-[A-Za-z0-9_-]{8,}/,
      /xox[baprs]-[A-Za-z0-9-]{8,}/,
      /gh[pousr]_[A-Za-z0-9_]{8,}/,
      /AKIA[0-9A-Z]{16}/,
      /AIza[0-9A-Za-z_-]{20,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
    ].some((pattern) => pattern.test(value));
  }

  private toPublic(agent: Agent, soul?: AgentSoulRead): PublicAgent {
    const output: PublicAgent = {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      workspacePath: agent.workspacePath,
      workspaceName: agent.workspaceName,
      initError: this.toInitError(agent),
      gitStatus: this.workspaces.getGitStatus()
    };
    if (soul) {
      output.soul = soul.content;
      output.soulFileStatus = soul.status;
      if (soul.message) {
        output.soulFileError = soul.message;
      }
    }
    return output;
  }

  private normalizeSoul(
    soul: string | undefined,
    options: { allowDefault: boolean; agentName?: string }
  ): string | undefined {
    if (soul === undefined) {
      return options.allowDefault ? `# ${options.agentName}\n` : undefined;
    }
    if (soul.trim().length === 0) {
      throw new BadRequestException("soul content must not be blank");
    }
    return soul;
  }

  private toInitError(agent: Agent): AgentInitError | null {
    if (agent.status !== AgentStatus.init_failed) {
      return null;
    }
    return {
      code: "WORKSPACE_INITIALIZATION_FAILED",
      message: agent.initializationError || "workspace initialization failed"
    };
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : "workspace initialization failed";
  }
}
