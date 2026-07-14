import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Agent } from "@prisma/client";
import { AppKeyIdentity } from "../app-keys/app-keys.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWorkspaceService } from "./agent-workspace.service";
import {
  AgentSkillChangeResult,
  AgentSkillFailedStageValue,
  AgentSkillMutation,
  SkillConfigEntry
} from "./agent-skill-types";
import {
  AgentSkillInstallDto,
  AgentSkillOperationValue,
  AgentSkillRemoveDto,
  AgentSkillSelfUpdateDto,
  AgentSkillSourceTypeValue,
  AgentSkillUpdateDto
} from "./dto/agent-skill-change.dto";
import { RuntimeReloadClient } from "./runtime-reload-client.service";
import { SkillPackageValidator } from "./skill-package-validator.service";

type SkillChangeRecord = Record<string, any>;
type SkillInstallRecord = Record<string, any>;
type InstallationSnapshot = {
  agentId: string;
  skillName: string;
  sourceType: AgentSkillSourceTypeValue;
  sourceId: string;
  version: string;
  configVersion: string;
  enabled: boolean;
  systemRequired: boolean;
  selfUpdateAllowed: boolean;
} | null;
type SkillChangeFailure = Error & { skillChange?: SkillChangeRecord };

@Injectable()
export class AgentSkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: AgentWorkspaceService,
    private readonly validator: SkillPackageValidator,
    private readonly reloadClient: RuntimeReloadClient
  ) {}

  async list(agentId: string) {
    await this.findAgent(agentId);
    const installations = await (this.prisma as any).agentSkillInstallation.findMany({
      where: { agentId },
      orderBy: { skillName: "asc" }
    });
    const latestChange = await (this.prisma as any).agentSkillChange.findFirst({
      where: { targetAgentId: agentId },
      orderBy: { createdAt: "desc" }
    });

    return {
      agentId,
      activeConfigVersion: latestChange?.activeConfigVersion ?? null,
      previousConfigVersion: latestChange?.previousConfigVersion ?? null,
      stagedConfigVersion: latestChange?.stagedConfigVersion ?? null,
      changeStatus: latestChange?.changeStatus ?? "succeeded",
      reloadStatus: latestChange?.reloadStatus ?? "unknown",
      auditStatus: latestChange?.auditStatus ?? "audit_written",
      rollbackResult: latestChange?.rollbackResult ?? "not_required",
      failedStage: latestChange?.failedStage ?? null,
      errorCode: latestChange?.errorCode ?? null,
      safeErrorSummary: latestChange?.safeErrorSummary ?? null,
      skills: installations.map((skill: SkillInstallRecord) => this.toPublicSkill(skill))
    };
  }

  async getChange(agentId: string, changeId: string): Promise<AgentSkillChangeResult> {
    const change = await (this.prisma as any).agentSkillChange.findUnique({ where: { id: changeId } });
    if (!change || change.targetAgentId !== agentId) {
      throw new NotFoundException("skill change not found");
    }
    return this.toChangeResult(change);
  }

  async installAdmin(agentId: string, dto: AgentSkillInstallDto, adminId: string): Promise<AgentSkillChangeResult> {
    return this.performChange(agentId, "install", dto.skillName, dto.sourceType, dto.sourceId, dto.version, {
      actorType: "admin",
      actorId: adminId
    });
  }

  async updateAdmin(agentId: string, dto: AgentSkillUpdateDto, adminId: string): Promise<AgentSkillChangeResult> {
    return this.performChange(agentId, "update", dto.skillName, dto.sourceType, dto.sourceId, dto.version, {
      actorType: "admin",
      actorId: adminId
    });
  }

  async removeAdmin(agentId: string, dto: AgentSkillRemoveDto, adminId: string): Promise<AgentSkillChangeResult> {
    const existing = await (this.prisma as any).agentSkillInstallation.findUnique({
      where: { agentId_skillName: { agentId, skillName: dto.skillName } }
    });
    if (!existing) {
      throw new NotFoundException("skill is not installed");
    }
    if (existing.systemRequired) {
      throw new BadRequestException("system required skill cannot be removed");
    }
    return this.performChange(agentId, "remove", dto.skillName, existing.sourceType, existing.sourceId, undefined, {
      actorType: "admin",
      actorId: adminId
    });
  }

  async selfUpdate(identity: AppKeyIdentity, dto: AgentSkillSelfUpdateDto): Promise<AgentSkillChangeResult> {
    if (!identity.scopes.includes("agent:skills:self-update")) {
      throw new ForbiddenException("agent self-update scope is required");
    }
    const agent = await this.findAgent(dto.agentId);
    if (identity.agentName && identity.agentName !== agent.name) {
      throw new ForbiddenException("app key is not bound to this agent");
    }
    const policy = await (this.prisma as any).agentSkillSelfUpdatePolicy.findFirst({
      where: {
        agentId: dto.agentId,
        operation: dto.operation,
        skillName: dto.skillName,
        sourceId: dto.sourceId,
        sourceType: dto.sourceType,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      }
    });
    if (!policy) {
      throw new ForbiddenException("agent self-update is not authorized");
    }
    const sourceId = dto.sourceId ?? policy.sourceId;
    const sourceType = dto.sourceType ?? policy.sourceType;
    if (sourceId !== policy.sourceId || sourceType !== policy.sourceType) {
      throw new ForbiddenException("requested skill source is outside the self-update policy");
    }
    this.assertVersionAllowed(dto.version, policy.versionConstraint, policy.allowLatest);
    return this.performChange(dto.agentId, dto.operation, dto.skillName, sourceType, sourceId, dto.version, {
      actorType: "agent",
      actorId: identity.id
    });
  }

  private async performChange(
    agentId: string,
    operation: AgentSkillOperationValue,
    skillName: string,
    sourceType: AgentSkillSourceTypeValue,
    sourceId: string,
    requestedVersion: string | undefined,
    actor: { actorType: "admin" | "agent"; actorId: string }
  ): Promise<AgentSkillChangeResult> {
    const agent = await this.findAgent(agentId);
    const source = await (this.prisma as any).agentSkillSource.findUnique({ where: { id: sourceId } });
    if (!source || !source.isTrusted || source.sourceType !== sourceType) {
      throw new BadRequestException("skill source is not trusted or does not exist");
    }

    const currentInstallations = await (this.prisma as any).agentSkillInstallation.findMany({ where: { agentId } });
    const previous = currentInstallations.find((item: SkillInstallRecord) => item.skillName === skillName);
    const previousSnapshot = this.toInstallationSnapshot(previous);
    if (operation === "update" && !previous) {
      throw new NotFoundException("skill is not installed");
    }
    if ((operation === "update" || operation === "remove") && previous?.systemRequired) {
      throw new BadRequestException("system required skill cannot be modified");
    }

    const change = await this.createPendingChange({
      actorType: actor.actorType,
      actorId: actor.actorId,
      targetAgentId: agentId,
      operation,
      skillName,
      sourceType,
      sourceId,
      requestedVersion: requestedVersion ?? null,
      previousVersion: previous?.version ?? null,
      previousConfigVersion: previous?.configVersion ?? null,
      changeStatus: "pending",
      reloadStatus: "unknown",
      auditStatus: "audit_pending",
      rollbackResult: "not_required"
    });
    if (!change) {
      return this.concurrencyResult(skillName, operation);
    }

    try {
      const mutation = await this.validateAndStage(agent, change, operation, skillName, sourceType, sourceId, requestedVersion, currentInstallations);
      const committed = await this.commitChange(
        agent,
        change.id,
        mutation.previousConfigVersion,
        mutation.stagedConfigVersion,
        operation,
        skillName,
        sourceType,
        sourceId,
        mutation.resolvedVersion
      );
      return await this.reloadAndFinalize(agent, change, committed.activeConfigVersion, mutation.stagedConfigVersion, previousSnapshot);
    } catch (error) {
      return this.failBeforeReload(change, error);
    }
  }

  private async validateAndStage(
    agent: Agent,
    change: SkillChangeRecord,
    operation: AgentSkillOperationValue,
    skillName: string,
    sourceType: AgentSkillSourceTypeValue,
    sourceId: string,
    requestedVersion: string | undefined,
    currentInstallations: SkillInstallRecord[]
  ) {
    await this.updateChange(change.id, { changeStatus: "validating" });
    let resolvedVersion = requestedVersion;
    if (operation !== "remove") {
      try {
        const validation = await this.validator.validate({
          operation,
          skillName,
          sourceType,
          sourceId,
          version: requestedVersion,
          changeId: change.id,
          currentSkills: this.toConfigEntries(currentInstallations)
        });
        resolvedVersion = validation.resolvedVersion;
      } catch (error) {
        await this.updateChange(change.id, this.failureData("manifest_validation", "AGENT_SKILL_MANIFEST_INVALID", error));
        throw error;
      }
    }

    await this.updateChange(change.id, { changeStatus: "applying", resolvedVersion: resolvedVersion ?? null });
    try {
      const mutation: AgentSkillMutation = {
        operation,
        skillName,
        sourceType,
        sourceId,
        version: requestedVersion,
        resolvedVersion,
        changeId: change.id,
        currentSkills: this.toConfigEntries(currentInstallations)
      };
      const staged = await this.workspaces.stageSkillsConfig(agent, mutation);
      await this.updateChange(change.id, {
        previousConfigVersion: staged.previousConfigVersion,
        stagedConfigVersion: staged.stagedConfigVersion
      });
      return { ...staged, resolvedVersion };
    } catch (error) {
      await this.updateChange(change.id, this.failureData("staging_write", "AGENT_SKILL_STAGING_FAILED", error));
      throw error;
    }
  }

  private async commitChange(
    agent: Agent,
    changeId: string,
    previousConfigVersion: string | null,
    stagedConfigVersion: string,
    operation: AgentSkillOperationValue,
    skillName: string,
    sourceType: AgentSkillSourceTypeValue,
    sourceId: string,
    resolvedVersion?: string
  ): Promise<{ activeConfigVersion: string }> {
    try {
      const committed = await this.workspaces.commitSkillsConfig(agent, changeId, stagedConfigVersion);
      await (this.prisma as any).$transaction(async (tx: any) => {
        if (operation === "remove") {
          await tx.agentSkillInstallation.update({
            where: { agentId_skillName: { agentId: agent.id, skillName } },
            data: { enabled: false, lastChangeId: changeId, configVersion: committed.activeConfigVersion }
          });
        } else {
          await tx.agentSkillInstallation.upsert({
            where: { agentId_skillName: { agentId: agent.id, skillName } },
            create: {
              agentId: agent.id,
              skillName,
              sourceType,
              sourceId,
              version: resolvedVersion,
              configVersion: committed.activeConfigVersion,
              enabled: true,
              lastChangeId: changeId
            },
            update: {
              sourceType,
              sourceId,
              version: resolvedVersion,
              configVersion: committed.activeConfigVersion,
              enabled: true,
              lastChangeId: changeId
            }
          });
        }
        await tx.agentSkillChange.update({
          where: { id: changeId },
          data: { activeConfigVersion: committed.activeConfigVersion, changeStatus: "reloading" }
        });
      });
      return committed;
    } catch (error) {
      await this.workspaces.rollbackSkillsConfig(agent, changeId, previousConfigVersion);
      const failedChange = await this.updateChange(
        changeId,
        this.failureData("atomic_switch", "AGENT_SKILL_ATOMIC_SWITCH_FAILED", error)
      );
      throw this.withFailedChange(error, failedChange);
    }
  }

  private async reloadAndFinalize(
    agent: Agent,
    change: SkillChangeRecord,
    activeConfigVersion: string,
    stagedConfigVersion: string,
    previousInstallation: InstallationSnapshot
  ): Promise<AgentSkillChangeResult> {
    try {
      const reload = await this.reloadClient.reloadSkills(agent, activeConfigVersion);
      if (reload.reloadStatus === "failed") {
        throw new Error("runtime reload failed");
      }
      const final = await this.updateChange(change.id, {
        activeConfigVersion,
        stagedConfigVersion,
        changeStatus: "succeeded",
        reloadStatus: reload.reloadStatus,
        auditStatus: "audit_written",
        rollbackResult: "not_required",
        effectiveFor: reload.effectiveFor,
        failedStage: null,
        errorCode: null,
        safeErrorSummary: null,
        finishedAt: new Date()
      });
      return this.toChangeResult(final);
    } catch (error) {
      return this.rollbackAfterReloadFailure(agent, change, previousInstallation, error);
    }
  }

  private async rollbackAfterReloadFailure(
    agent: Agent,
    change: SkillChangeRecord,
    previousInstallation: InstallationSnapshot,
    error: unknown
  ): Promise<AgentSkillChangeResult> {
    try {
      const latest = (await (this.prisma as any).agentSkillChange.findUnique?.({ where: { id: change.id } })) ?? change;
      const rolledBack = await this.workspaces.rollbackSkillsConfig(agent, change.id, latest.previousConfigVersion ?? null);
      await this.restoreInstallation(agent.id, change.skillName, previousInstallation);
      const final = await this.updateChange(change.id, {
        activeConfigVersion: rolledBack.activeConfigVersion,
        changeStatus: "rolled_back",
        reloadStatus: "failed",
        auditStatus: "audit_written",
        rollbackResult: "succeeded",
        failedStage: "reload",
        errorCode: "AGENT_SKILL_RELOAD_FAILED",
        safeErrorSummary: this.safeErrorSummary(error),
        finishedAt: new Date()
      });
      return this.toChangeResult(final);
    } catch (rollbackError) {
      const final = await this.updateChange(change.id, {
        changeStatus: "rollback_failed",
        reloadStatus: "failed",
        auditStatus: "audit_written",
        rollbackResult: "failed",
        failedStage: "rollback",
        errorCode: "AGENT_SKILL_ROLLBACK_FAILED",
        safeErrorSummary: this.safeErrorSummary(rollbackError),
        finishedAt: new Date()
      });
      return this.toChangeResult(final);
    }
  }

  private async createPendingChange(data: Record<string, unknown>): Promise<SkillChangeRecord | null> {
    try {
      return await (this.prisma as any).agentSkillChange.create({ data });
    } catch (error) {
      if (this.isUniqueConflict(error)) {
        return null;
      }
      throw error;
    }
  }

  private async failBeforeReload(change: SkillChangeRecord, error: unknown): Promise<AgentSkillChangeResult> {
    const failedChange = this.getFailedChange(error);
    if (failedChange) {
      return this.toChangeResult(failedChange);
    }
    const latest = await (this.prisma as any).agentSkillChange.findUnique?.({ where: { id: change.id } });
    return this.toChangeResult(latest ?? { ...change, ...this.failureData("staging_write", "AGENT_SKILL_CHANGE_FAILED", error) });
  }

  private async findAgent(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException("agent not found");
    }
    return agent;
  }

  private toConfigEntries(installations: SkillInstallRecord[]): SkillConfigEntry[] {
    return installations
      .filter((skill) => skill.enabled !== false)
      .map((skill) => ({
        name: skill.skillName,
        version: skill.version,
        sourceType: skill.sourceType,
        sourceId: skill.sourceId,
        enabled: skill.enabled,
        systemRequired: skill.systemRequired,
        selfUpdateAllowed: skill.selfUpdateAllowed
      }));
  }

  private toInstallationSnapshot(installation: SkillInstallRecord | undefined): InstallationSnapshot {
    if (!installation) {
      return null;
    }
    return {
      agentId: installation.agentId,
      skillName: installation.skillName,
      sourceType: installation.sourceType,
      sourceId: installation.sourceId,
      version: installation.version,
      configVersion: installation.configVersion,
      enabled: installation.enabled,
      systemRequired: installation.systemRequired,
      selfUpdateAllowed: installation.selfUpdateAllowed
    };
  }

  private async restoreInstallation(
    agentId: string,
    skillName: string,
    previousInstallation: InstallationSnapshot
  ): Promise<void> {
    const where = { agentId_skillName: { agentId, skillName } };
    if (!previousInstallation) {
      await (this.prisma as any).agentSkillInstallation.delete({ where });
      return;
    }
    await (this.prisma as any).agentSkillInstallation.update({
      where,
      data: {
        sourceType: previousInstallation.sourceType,
        sourceId: previousInstallation.sourceId,
        version: previousInstallation.version,
        configVersion: previousInstallation.configVersion,
        enabled: previousInstallation.enabled,
        systemRequired: previousInstallation.systemRequired,
        selfUpdateAllowed: previousInstallation.selfUpdateAllowed
      }
    });
  }

  private toPublicSkill(skill: SkillInstallRecord) {
    return {
      name: skill.skillName,
      version: skill.version,
      sourceType: skill.sourceType,
      sourceId: skill.sourceId,
      enabled: skill.enabled,
      systemRequired: skill.systemRequired,
      selfUpdateAllowed: skill.selfUpdateAllowed,
      activeConfigVersion: skill.configVersion
    };
  }

  private concurrencyResult(skillName: string, operation: AgentSkillOperationValue): AgentSkillChangeResult {
    return {
      changeId: "concurrency_lock",
      skillName,
      operation,
      changeStatus: "failed",
      reloadStatus: "unknown",
      auditStatus: "audit_written",
      rollbackResult: "skipped",
      failedStage: "concurrency_lock",
      errorCode: "AGENT_SKILL_CHANGE_IN_PROGRESS",
      safeErrorSummary: "Another skills change is already in progress for this agent.",
      previousConfigVersion: null,
      activeConfigVersion: null,
      stagedConfigVersion: null,
      effectiveFor: "next_task"
    };
  }

  private failureData(failedStage: AgentSkillFailedStageValue, errorCode: string, error: unknown) {
    return {
      changeStatus: "failed",
      reloadStatus: "unknown",
      auditStatus: "audit_written",
      rollbackResult: "skipped",
      failedStage,
      errorCode,
      safeErrorSummary: this.safeErrorSummary(error),
      finishedAt: new Date()
    };
  }

  private async updateChange(changeId: string, data: Record<string, unknown>): Promise<SkillChangeRecord> {
    return (this.prisma as any).agentSkillChange.update({ where: { id: changeId }, data });
  }

  private isUniqueConflict(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002");
  }

  private withFailedChange(error: unknown, skillChange: SkillChangeRecord): SkillChangeFailure {
    const failure: SkillChangeFailure = error instanceof Error ? error : new Error(String(error));
    failure.skillChange = skillChange;
    return failure;
  }

  private getFailedChange(error: unknown): SkillChangeRecord | null {
    if (error && typeof error === "object" && "skillChange" in error) {
      return (error as SkillChangeFailure).skillChange ?? null;
    }
    return null;
  }

  private toChangeResult(change: SkillChangeRecord): AgentSkillChangeResult {
    return {
      changeId: change.id,
      skillName: change.skillName,
      operation: change.operation,
      changeStatus: change.changeStatus,
      reloadStatus: change.reloadStatus,
      auditStatus: change.auditStatus,
      rollbackResult: change.rollbackResult,
      failedStage: change.failedStage ?? null,
      errorCode: change.errorCode ?? null,
      safeErrorSummary: change.safeErrorSummary ?? null,
      previousConfigVersion: change.previousConfigVersion ?? null,
      activeConfigVersion: change.activeConfigVersion ?? null,
      stagedConfigVersion: change.stagedConfigVersion ?? null,
      effectiveFor: "next_task"
    };
  }

  private assertVersionAllowed(version: string | undefined, constraint: string, allowLatest: boolean): void {
    if (!version) {
      throw new ForbiddenException("requested skill version is required by the self-update policy");
    }
    if (version === "latest" && allowLatest) {
      return;
    }
    if (constraint !== "*" && version !== constraint) {
      throw new ForbiddenException("requested skill version is outside the self-update policy");
    }
  }

  private safeErrorSummary(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw
      .replace(/(sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]+/g, "[redacted-secret]")
      .replace(/[A-Za-z]:\\[^\s]+/g, "[redacted-path]")
      .replace(/\/[A-Za-z0-9._/-]+/g, "[redacted-path]")
      .replace(/https?:\/\/[^\s@/]+:[^\s@/]+@[^\s]+/g, "[redacted-url]");
  }
}
