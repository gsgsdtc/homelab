import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Agent, AgentStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWorkspaceService } from "./agent-workspace.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
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
    return this.toPublic(agent);
  }

  async create(dto: CreateAgentDto): Promise<PublicAgent> {
    this.assertNoSecretLeak(dto.modelSecretRef);
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
        soul: dto.soul ?? ""
      }
    });

    const agent = await this.initializeAgent(created, false);
    return this.toPublic(agent);
  }

  async update(id: string, dto: UpdateAgentDto): Promise<PublicAgent> {
    this.assertNoSecretLeak(dto.modelSecretRef);
    await this.findAgent(id);
    const agent = await this.prisma.agent.update({
      where: { id },
      data: {
        name: dto.name,
        modelProvider: dto.modelProvider,
        modelSecretRef: dto.modelSecretRef,
        soul: dto.soul
      }
    });

    const initialized = await this.initializeAgent(agent, true);
    return this.toPublic(initialized);
  }

  async retryInitialization(id: string): Promise<PublicAgent> {
    const agent = await this.findAgent(id);
    const retried = await this.initializeAgent(agent, true);
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

  private async findAgent(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException("agent not found");
    }
    return agent;
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

  private assertNoSecretLeak(secretRef?: string): void {
    if (!secretRef) {
      return;
    }
    if (/^(sk-|xox[baprs]-|gh[pousr]_|-----BEGIN |eyJ)/.test(secretRef)) {
      throw new BadRequestException("only secret reference names are allowed");
    }
  }

  private toPublic(agent: Agent): PublicAgent {
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      workspacePath: agent.workspacePath,
      workspaceName: agent.workspaceName,
      initError: this.toInitError(agent),
      gitStatus: this.workspaces.getGitStatus()
    };
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
