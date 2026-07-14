import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Agent } from "@prisma/client";
import { createHash } from "crypto";
import { AgentWorkflowRuntimeClient } from "./agent-workflow-runtime.client";
import { AgentWorkflowValidator } from "./agent-workflow-validator.service";
import { AgentWorkspaceService } from "./agent-workspace.service";
import { CreateWorkflowDto, ReloadWorkflowDto, RollbackWorkflowDto, WorkflowSourceDto } from "./dto/workflow.dto";
import { PrismaService } from "../prisma/prisma.service";

type WorkflowExtension = "ts" | "js";
type WorkflowReloadStatus = "draft" | "loading" | "succeeded" | "failed";

export interface PublicAgentWorkflow {
  workflowKey: string;
  filePath: string;
  draftHash: string | null;
  activeHash: string | null;
  reloadStatus: WorkflowReloadStatus;
  loadedAt: Date | null;
  updatedAt: Date;
  revision: string | null;
  error: { message: string } | null;
}

@Injectable()
export class AgentWorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: AgentWorkspaceService,
    private readonly validator: AgentWorkflowValidator,
    private readonly runtime: AgentWorkflowRuntimeClient
  ) {}

  async list(agentId: string): Promise<PublicAgentWorkflow[]> {
    await this.findAgent(agentId);
    const workflows = await this.prisma.agentWorkflow.findMany({
      where: { agentId },
      orderBy: { workflowKey: "asc" }
    });
    return workflows.map((workflow) => this.toPublic(workflow));
  }

  async get(agentId: string, workflowKey: string, view: "draft" | "active" = "draft") {
    const agent = await this.findAgent(agentId);
    const workflow = await this.findWorkflow(agentId, workflowKey);
    let source: string | null = null;
    if (view === "active" && workflow.activeHash) {
      const version = await this.prisma.agentWorkflowVersion.findFirst({
        where: { workflowId: workflow.id, sourceHash: workflow.activeHash },
        orderBy: { promotedAt: "desc" }
      });
      source = version?.source ?? null;
    } else if (workflow.draftHash) {
      source = await this.workspaces.readWorkflowSource(agent, workflow.workflowKey, workflow.extension as WorkflowExtension);
    }
    return {
      ...this.toPublic(workflow),
      source
    };
  }

  async validate(_agentId: string, workflowKey: string, dto: WorkflowSourceDto) {
    const extension = dto.extension ?? "ts";
    this.validator.validateSource({ workflowKey, extension, source: dto.source });
    return {
      workflowKey,
      valid: true,
      sourceHash: this.hash(dto.source)
    };
  }

  async create(agentId: string, dto: CreateWorkflowDto): Promise<PublicAgentWorkflow> {
    return this.saveDraft(agentId, dto);
  }

  async saveDraft(agentId: string, dto: CreateWorkflowDto | (WorkflowSourceDto & { workflowKey: string })): Promise<PublicAgentWorkflow> {
    const agent = await this.findAgent(agentId);
    const extension = dto.extension ?? "ts";
    await this.assertExpectedRevision(agentId, dto.workflowKey, dto.expectedRevision);
    this.validator.validateSource({ workflowKey: dto.workflowKey, extension, source: dto.source });
    const sourceHash = this.hash(dto.source);
    const writeResult = await this.workspaces.writeWorkflowSource(agent, dto.workflowKey, extension, dto.source);
    const workflow = await this.prisma.agentWorkflow.upsert({
      where: {
        agentId_workflowKey: {
          agentId,
          workflowKey: dto.workflowKey
        }
      },
      create: {
        agentId,
        workflowKey: dto.workflowKey,
        extension,
        relativePath: writeResult.relativePath,
        draftHash: sourceHash,
        revision: sourceHash,
        reloadStatus: "draft",
        reloadError: null
      },
      update: {
        extension,
        relativePath: writeResult.relativePath,
        draftHash: sourceHash,
        revision: sourceHash,
        reloadStatus: "draft",
        reloadError: null
      }
    });
    return this.toPublic(workflow);
  }

  async update(agentId: string, workflowKey: string, dto: WorkflowSourceDto): Promise<PublicAgentWorkflow> {
    return this.saveDraft(agentId, { ...dto, workflowKey });
  }

  async saveAndReload(agentId: string, workflowKey: string, dto: WorkflowSourceDto): Promise<PublicAgentWorkflow> {
    const draft = await this.saveDraft(agentId, { ...dto, workflowKey });
    return this.reload(agentId, workflowKey, { expectedDraftHash: draft.draftHash ?? undefined });
  }

  async reload(agentId: string, workflowKey: string, dto: ReloadWorkflowDto = {}): Promise<PublicAgentWorkflow> {
    const workflow = await this.findWorkflow(agentId, workflowKey);
    if (!workflow.draftHash) {
      throw new BadRequestException("workflow has no draft to reload");
    }
    if (dto.expectedDraftHash && dto.expectedDraftHash !== workflow.draftHash) {
      throw new ConflictException("workflow draft changed; refresh before reloading");
    }
    await this.prisma.agentWorkflow.update({
      where: { id: workflow.id },
      data: { reloadStatus: "loading", reloadError: null }
    });
    const result = await this.runtime.reloadWorkflow({
      agentId,
      workflowKey,
      sourceHash: workflow.draftHash,
      relativePath: workflow.relativePath,
      extension: workflow.extension as WorkflowExtension
    });
    if (result.status !== "succeeded") {
      const failed = await this.prisma.agentWorkflow.update({
        where: { id: workflow.id },
        data: {
          reloadStatus: "failed",
          reloadError: this.sanitizeError(result.error || "workflow reload failed")
        }
      });
      return this.toPublic(failed);
    }
    const agent = await this.findAgent(agentId);
    const source = await this.workspaces.readWorkflowSource(agent, workflow.workflowKey, workflow.extension as WorkflowExtension);
    const promoted = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.agentWorkflow.update({
        where: { id: workflow.id },
        data: {
          activeHash: workflow.draftHash,
          revision: workflow.draftHash,
          reloadStatus: "succeeded",
          reloadError: null,
          loadedAt: result.loadedAt ?? new Date()
        }
      });
      await tx.agentWorkflowVersion.create({
        data: {
          workflowId: workflow.id,
          sourceHash: workflow.draftHash!,
          source,
          extension: workflow.extension,
          relativePath: workflow.relativePath,
          rollbackOfVersionId: (dto as ReloadWorkflowDto & { rollbackOfVersionId?: string }).rollbackOfVersionId
        }
      });
      await this.pruneOldVersions(tx, workflow.id, workflow.draftHash!);
      return updated;
    });
    return this.toPublic(promoted);
  }

  async versions(agentId: string, workflowKey: string) {
    const workflow = await this.findWorkflow(agentId, workflowKey);
    return this.prisma.agentWorkflowVersion.findMany({
      where: { workflowId: workflow.id },
      orderBy: { promotedAt: "desc" },
      take: 10
    });
  }

  async rollback(agentId: string, workflowKey: string, dto: RollbackWorkflowDto): Promise<PublicAgentWorkflow> {
    const workflow = await this.findWorkflow(agentId, workflowKey);
    const version = await this.prisma.agentWorkflowVersion.findUnique({ where: { id: dto.versionId } });
    if (!version || version.workflowId !== workflow.id) {
      throw new NotFoundException("workflow version not found");
    }
    const draft = await this.saveDraft(agentId, {
      workflowKey,
      source: version.source,
      extension: version.extension as WorkflowExtension,
      expectedRevision: workflow.draftHash ?? undefined
    });
    return this.reload(agentId, workflowKey, {
      expectedDraftHash: draft.draftHash ?? undefined,
      rollbackOfVersionId: dto.versionId
    } as ReloadWorkflowDto & { rollbackOfVersionId: string });
  }

  private async findAgent(agentId: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new NotFoundException("agent not found");
    }
    return agent;
  }

  private async findWorkflow(agentId: string, workflowKey: string) {
    const workflow = await this.prisma.agentWorkflow.findFirst({
      where: { agentId, workflowKey }
    });
    if (!workflow) {
      throw new NotFoundException("workflow not found");
    }
    return workflow;
  }

  private async assertExpectedRevision(agentId: string, workflowKey: string, expectedRevision?: string) {
    if (!expectedRevision) {
      return;
    }
    const existing = await this.prisma.agentWorkflow.findUnique({
      where: {
        agentId_workflowKey: {
          agentId,
          workflowKey
        }
      }
    });
    if (existing?.draftHash && existing.draftHash !== expectedRevision) {
      throw new ConflictException("workflow draft changed; refresh before saving");
    }
  }

  private async pruneOldVersions(tx: any, workflowId: string, activeHash: string) {
    const versions = await tx.agentWorkflowVersion.findMany({
      where: { workflowId },
      orderBy: { promotedAt: "desc" },
      skip: 10,
      select: { id: true, sourceHash: true }
    });
    const pruneIds = versions
      .filter((version: { id: string; sourceHash?: string | null }) => version.sourceHash !== activeHash)
      .map((version: { id: string }) => version.id);
    if (pruneIds.length) {
      await tx.agentWorkflowVersion.deleteMany({
        where: { id: { in: pruneIds } }
      });
    }
  }

  private toPublic(workflow: any): PublicAgentWorkflow {
    return {
      workflowKey: workflow.workflowKey,
      filePath: workflow.relativePath,
      draftHash: workflow.draftHash,
      activeHash: workflow.activeHash,
      reloadStatus: workflow.reloadStatus,
      loadedAt: workflow.loadedAt,
      updatedAt: workflow.updatedAt,
      revision: workflow.revision,
      error: workflow.reloadError ? { message: workflow.reloadError } : null
    };
  }

  private hash(source: string): string {
    return createHash("sha256").update(source, "utf8").digest("hex");
  }

  private sanitizeError(error: string): string {
    return error
      .replace(/\/(?:private|Users|home)\/[^\s'"]+/g, "[path]")
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[secret]")
      .replace(/gh[pousr]_[A-Za-z0-9_]{8,}/g, "[secret]")
      .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, "[secret]")
      .replace(/AKIA[0-9A-Z]{16}/g, "[secret]")
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[secret]")
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[secret]")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[secret]");
  }
}
