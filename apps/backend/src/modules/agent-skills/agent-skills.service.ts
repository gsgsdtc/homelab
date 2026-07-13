import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AgentSkillAuditStatus,
  AgentSkillChangeResult,
  AgentSkillChangeStatus,
  AgentSkillOperation,
  AgentSkillReloadStatus,
  AgentSkillRollbackResult,
  AgentSkillSourceType
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ChangeAgentSkillDto } from "./dto/change-agent-skill.dto";
import { AgentSkillWorkspaceStore, SkillConfigEntry } from "./agent-skill-workspace.store";
import { RuntimeReloadClient } from "./runtime-reload.client";
import { SkillPackageValidator } from "./skill-package-validator.service";

type AgentRecord = { id: string; workspacePath: string };

@Injectable()
export class AgentSkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspace: AgentSkillWorkspaceStore,
    private readonly reloadClient: RuntimeReloadClient,
    private readonly validator: SkillPackageValidator
  ) {}

  async list(agentId: string) {
    const agent = await this.findAgent(agentId);
    const skills = await this.db().agentSkill.findMany({ where: { agentId }, orderBy: { skillName: "asc" } });
    const latestChange = await this.db().agentSkillChange.findFirst({
      where: { agentId },
      orderBy: { createdAt: "desc" }
    });
    return {
      agentId: agent.id,
      activeConfigVersion: latestChange?.activeConfigVersion ?? null,
      stagedConfigVersion: latestChange?.stagedConfigVersion ?? null,
      previousConfigVersion: latestChange?.previousConfigVersion ?? null,
      skills,
      latestChange: latestChange ? this.toPublicChange(latestChange) : null
    };
  }

  install(agentId: string, dto: ChangeAgentSkillDto) {
    return this.change(agentId, AgentSkillOperation.install, dto.skillName, dto);
  }

  update(agentId: string, skillName: string, dto: ChangeAgentSkillDto) {
    return this.change(agentId, AgentSkillOperation.update, skillName, dto);
  }

  remove(agentId: string, skillName: string, dto: ChangeAgentSkillDto = {}) {
    return this.change(agentId, AgentSkillOperation.remove, skillName, dto);
  }

  async selfUpdate(agentId: string, dto: ChangeAgentSkillDto) {
    const skillName = this.requiredTrim(dto.skillName, "skillName is required");
    const sourceType = dto.sourceType ?? AgentSkillSourceType.registry;
    const policy = await this.db().agentSkillSelfUpdatePolicy.findFirst({
      where: {
        agentId,
        skillName,
        operation: AgentSkillOperation.self_update,
        sourceType
      }
    });
    if (!policy) {
      throw new BadRequestException({
        message: "agent self-update is not authorized",
        failedStage: "permission",
        errorCode: "AGENT_SELF_UPDATE_NOT_AUTHORIZED"
      });
    }
    return this.change(agentId, AgentSkillOperation.self_update, skillName, dto);
  }

  async getChange(agentId: string, changeId: string) {
    const change = await this.db().agentSkillChange.findUnique({ where: { id: changeId } });
    if (!change || change.agentId !== agentId) {
      throw new NotFoundException("skill change not found");
    }
    return this.toPublicChange(change);
  }

  private async change(
    agentId: string,
    operation: AgentSkillOperation,
    skillNameInput: string | undefined,
    dto: ChangeAgentSkillDto
  ) {
    const agent = await this.findAgent(agentId);
    const activeChange = await this.db().agentSkillChange.findFirst({
      where: { agentId, changeStatus: { in: this.activeStatuses() } },
      orderBy: { createdAt: "desc" }
    });
    if (activeChange) {
      throw new ConflictException({
        message: "agent skill change already in progress",
        failedStage: "concurrency_lock",
        errorCode: "AGENT_SKILL_CHANGE_IN_PROGRESS"
      });
    }

    const skillName = this.requiredTrim(skillNameInput ?? dto.skillName, "skillName is required");
    const sourceType = dto.sourceType ?? AgentSkillSourceType.registry;
    const requestedVersion = this.requiredTrim(dto.requestedVersion, "requestedVersion is required");
    const sourceId = dto.sourceId?.trim() || null;
    await this.assertControlledSource(sourceType, sourceId);

    const validation = await this.validator.validate({ skillName, sourceType, sourceId, requestedVersion });
    const previous = await this.findExistingSkill(agentId, skillName);
    const change = await this.db().agentSkillChange.create({
      data: {
        agentId,
        operation,
        skillName,
        sourceType,
        sourceId,
        requestedVersion,
        resolvedVersion: validation.resolvedVersion,
        commitSha: validation.commitSha,
        previousVersion: previous?.version ?? null,
        changeStatus: AgentSkillChangeStatus.validating,
        reloadStatus: AgentSkillReloadStatus.unknown,
        auditStatus: AgentSkillAuditStatus.audit_written,
        rollbackResult: AgentSkillRollbackResult.not_required
      }
    });

    try {
      const nextConfig = this.buildNextConfig(
        await this.db().agentSkill.findMany({ where: { agentId } }),
        {
          skillName,
          sourceType,
          sourceId,
          requestedVersion,
          resolvedVersion: validation.resolvedVersion,
          commitSha: validation.commitSha,
          enabled: operation !== AgentSkillOperation.remove,
          systemRequired: previous?.systemRequired ?? false
        },
      );
      const workspaceResult = await this.workspace.applySkillsConfig(agent, nextConfig, change.id);
      await this.persistSkill(agentId, skillName, operation, sourceType, sourceId, validation, workspaceResult.activeConfigVersion, change.id);
      const reloadResult = await this.reloadClient.reloadSkills({
        agentId,
        workspacePath: agent.workspacePath,
        activeConfigVersion: workspaceResult.activeConfigVersion
      });
      if (reloadResult.reloadStatus === AgentSkillReloadStatus.failed) {
        await this.workspace.restoreSkillsConfig(agent, workspaceResult.previousConfigVersion);
        return this.finishChange(change.id, {
          result: AgentSkillChangeResult.rolled_back,
          changeStatus: AgentSkillChangeStatus.rolled_back,
          reloadStatus: AgentSkillReloadStatus.failed,
          rollbackResult: AgentSkillRollbackResult.succeeded,
          failedStage: "reload",
          errorCode: reloadResult.errorCode ?? "SKILL_RELOAD_FAILED",
          safeErrorSummary: this.sanitizeError(reloadResult.safeErrorSummary ?? "runtime reload failed"),
          ...workspaceResult
        });
      }
      return this.finishChange(change.id, {
        result:
          reloadResult.reloadStatus === AgentSkillReloadStatus.runtime_offline
            ? AgentSkillChangeResult.runtime_offline
            : reloadResult.reloadStatus === AgentSkillReloadStatus.pending_restart
              ? AgentSkillChangeResult.pending_restart
              : AgentSkillChangeResult.succeeded,
        changeStatus: AgentSkillChangeStatus.succeeded,
        reloadStatus: reloadResult.reloadStatus,
        rollbackResult: AgentSkillRollbackResult.not_required,
        failedStage: null,
        errorCode: null,
        safeErrorSummary: null,
        ...workspaceResult
      });
    } catch (error) {
      return this.finishChange(change.id, {
        result: AgentSkillChangeResult.failed,
        changeStatus: AgentSkillChangeStatus.failed,
        reloadStatus: AgentSkillReloadStatus.unknown,
        rollbackResult: AgentSkillRollbackResult.skipped,
        failedStage: "staging_write",
        errorCode: "AGENT_SKILL_CHANGE_FAILED",
        safeErrorSummary: this.sanitizeError(error instanceof Error ? error.message : "skill change failed")
      });
    }
  }

  private async persistSkill(
    agentId: string,
    skillName: string,
    operation: AgentSkillOperation,
    sourceType: AgentSkillSourceType,
    sourceId: string | null,
    validation: { resolvedVersion: string; commitSha: string | null },
    activeConfigVersion: string,
    changeId: string
  ) {
    if (operation === AgentSkillOperation.remove) {
      await this.db().agentSkill.deleteMany({ where: { agentId, skillName, systemRequired: false } });
      return;
    }
    await this.db().agentSkill.upsert({
      where: { agentId_skillName: { agentId, skillName } },
      update: {
        sourceType,
        sourceId,
        version: validation.resolvedVersion,
        commitSha: validation.commitSha,
        enabled: true,
        selfUpdateAllowed: operation === AgentSkillOperation.self_update ? true : undefined,
        activeConfigVersion,
        lastChangeId: changeId
      },
      create: {
        agentId,
        skillName,
        sourceType,
        sourceId,
        version: validation.resolvedVersion,
        commitSha: validation.commitSha,
        enabled: true,
        activeConfigVersion,
        lastChangeId: changeId
      }
    });
  }

  private buildNextConfig(existingSkills: Record<string, any>[], changedSkill: SkillConfigEntry): SkillConfigEntry[] {
    const withoutChanged = existingSkills
      .filter((skill) => skill.skillName !== changedSkill.skillName)
      .map((skill) => ({
        skillName: skill.skillName,
        sourceType: skill.sourceType,
        sourceId: skill.sourceId,
        requestedVersion: skill.version,
        resolvedVersion: skill.version,
        commitSha: skill.commitSha,
        enabled: skill.enabled,
        systemRequired: skill.systemRequired
      }));
    return changedSkill.enabled ? [...withoutChanged, changedSkill] : withoutChanged;
  }

  private async finishChange(changeId: string, data: Record<string, unknown>) {
    const change = await this.db().agentSkillChange.update({
      where: { id: changeId },
      data: {
        ...data,
        auditStatus: AgentSkillAuditStatus.audit_written,
        finishedAt: new Date()
      }
    });
    return this.toPublicChange(change);
  }

  private async findAgent(agentId: string): Promise<AgentRecord> {
    const agent = await this.db().agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new NotFoundException("agent not found");
    }
    return { id: agent.id, workspacePath: agent.workspacePath };
  }

  private async findExistingSkill(agentId: string, skillName: string) {
    const skills = await this.db().agentSkill.findMany({ where: { agentId, skillName } });
    return skills[0] ?? null;
  }

  private async assertControlledSource(sourceType: AgentSkillSourceType, sourceId: string | null): Promise<void> {
    if (sourceType === AgentSkillSourceType.trusted_git) {
      if (!sourceId) {
        throw new BadRequestException("trusted Git sourceId is required");
      }
      const source = await this.db().trustedSkillSource.findUnique({ where: { id: sourceId } });
      if (!source || !source.isActive || source.sourceType !== AgentSkillSourceType.trusted_git) {
        throw new BadRequestException("skill source is not trusted");
      }
    }
    if (sourceType === AgentSkillSourceType.system) {
      throw new BadRequestException("system skill source cannot be changed through this endpoint");
    }
  }

  private activeStatuses(): AgentSkillChangeStatus[] {
    return [
      AgentSkillChangeStatus.pending,
      AgentSkillChangeStatus.validating,
      AgentSkillChangeStatus.applying,
      AgentSkillChangeStatus.reloading
    ];
  }

  private requiredTrim(value: string | undefined, message: string): string {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) {
      throw new BadRequestException(message);
    }
    return trimmed;
  }

  private sanitizeError(value: string): string {
    return value
      .replace(/([?&](?:token|api_key|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/gi, "https://[redacted]@")
      .replace(/\/(?:Users|home|var|tmp)\/[^\s]+/g, "[redacted-path]")
      .replace(/(?:sk|ghp|xox[baprs])[-_A-Za-z0-9]{8,}/g, "[redacted-secret]");
  }

  private toPublicChange(change: Record<string, any>) {
    return {
      id: change.id,
      agentId: change.agentId,
      operation: change.operation,
      skillName: change.skillName,
      sourceType: change.sourceType,
      sourceId: change.sourceId,
      requestedVersion: change.requestedVersion,
      resolvedVersion: change.resolvedVersion,
      commitSha: change.commitSha,
      previousVersion: change.previousVersion,
      previousConfigVersion: change.previousConfigVersion,
      activeConfigVersion: change.activeConfigVersion,
      stagedConfigVersion: change.stagedConfigVersion,
      result: change.result,
      changeStatus: change.changeStatus,
      reloadStatus: change.reloadStatus,
      auditStatus: change.auditStatus,
      rollbackResult: change.rollbackResult,
      failedStage: change.failedStage,
      errorCode: change.errorCode,
      safeErrorSummary: change.safeErrorSummary,
      createdAt: change.createdAt,
      finishedAt: change.finishedAt
    };
  }

  private db(): any {
    return this.prisma as any;
  }
}
