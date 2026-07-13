import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  AgentSkillOperation,
  AgentSkillSourceType,
  AgentSkillChangeStatus,
  AgentSkillReloadStatus
} from "@prisma/client";
import { AgentSkillsService } from "../src/modules/agent-skills/agent-skills.service";
import { AgentSkillWorkspaceStore } from "../src/modules/agent-skills/agent-skill-workspace.store";
import { RuntimeReloadClient } from "../src/modules/agent-skills/runtime-reload.client";
import { SkillPackageValidator } from "../src/modules/agent-skills/skill-package-validator.service";

describe("AgentSkillsService", () => {
  const now = new Date("2026-07-13T10:00:00Z");
  const prisma: any = {
    agent: { findUnique: jest.fn() },
    agentSkill: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    agentSkillChange: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    agentSkillSelfUpdatePolicy: { findFirst: jest.fn() },
    trustedSkillSource: { findUnique: jest.fn() }
  };
  const workspace = {
    applySkillsConfig: jest.fn(),
    restoreSkillsConfig: jest.fn()
  } as unknown as AgentSkillWorkspaceStore & { applySkillsConfig: jest.Mock; restoreSkillsConfig: jest.Mock };
  const reload = {
    reloadSkills: jest.fn()
  } as unknown as RuntimeReloadClient & { reloadSkills: jest.Mock };
  const validator = {
    validate: jest.fn()
  } as unknown as SkillPackageValidator & { validate: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agent.findUnique.mockResolvedValue(agentFrom());
    prisma.agentSkill.findMany.mockResolvedValue([]);
    prisma.agentSkillChange.findFirst.mockResolvedValue(null);
    prisma.agentSkillSelfUpdatePolicy.findFirst.mockResolvedValue(null);
    prisma.agentSkillChange.create.mockImplementation(async ({ data }: { data: any }) => changeFrom(data));
    prisma.agentSkillChange.update.mockImplementation(async ({ data }: { data: any }) => changeFrom(data));
    prisma.trustedSkillSource.findUnique.mockResolvedValue(null);
    workspace.applySkillsConfig.mockResolvedValue({
      previousConfigVersion: "cfg-previous",
      activeConfigVersion: "cfg-next",
      stagedConfigVersion: "stg-change-1"
    });
    workspace.restoreSkillsConfig.mockResolvedValue(undefined);
    validator.validate.mockResolvedValue({ resolvedVersion: "1.2.0", commitSha: null });
    reload.reloadSkills.mockResolvedValue({ reloadStatus: AgentSkillReloadStatus.pending_restart });
  });

  it("installs a registry skill through staging and returns pending_restart when runtime reload is unavailable", async () => {
    const service = new AgentSkillsService(prisma, workspace, reload, validator);

    const result = await service.install("agent-1", {
      skillName: "skill-a",
      sourceType: AgentSkillSourceType.registry,
      requestedVersion: "1.2.0"
    });

    expect(workspace.applySkillsConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      [expect.objectContaining({ skillName: "skill-a", requestedVersion: "1.2.0" })],
      expect.any(String)
    );
    expect(prisma.agentSkill.upsert).toHaveBeenCalledWith({
      where: { agentId_skillName: { agentId: "agent-1", skillName: "skill-a" } },
      update: expect.objectContaining({ version: "1.2.0", enabled: true }),
      create: expect.objectContaining({ agentId: "agent-1", skillName: "skill-a", version: "1.2.0" })
    });
    expect(result).toMatchObject({
      operation: AgentSkillOperation.install,
      changeStatus: AgentSkillChangeStatus.succeeded,
      reloadStatus: AgentSkillReloadStatus.pending_restart,
      activeConfigVersion: "cfg-next",
      failedStage: null
    });
  });

  it("rejects arbitrary Git URLs before workspace writes", async () => {
    const service = new AgentSkillsService(prisma, workspace, reload, validator);

    await expect(
      service.install("agent-1", {
        skillName: "skill-a",
        sourceType: AgentSkillSourceType.trusted_git,
        sourceId: "missing-source",
        requestedVersion: "main"
      })
    ).rejects.toThrow(BadRequestException);

    expect(workspace.applySkillsConfig).not.toHaveBeenCalled();
    expect(prisma.agentSkill.upsert).not.toHaveBeenCalled();
  });

  it("rolls back to the previous config version when reload fails", async () => {
    reload.reloadSkills.mockResolvedValueOnce({
      reloadStatus: AgentSkillReloadStatus.failed,
      errorCode: "SKILL_RELOAD_FAILED",
      safeErrorSummary: "reload failed"
    });
    const service = new AgentSkillsService(prisma, workspace, reload, validator);

    const result = await service.update("agent-1", "skill-a", {
      sourceType: AgentSkillSourceType.registry,
      requestedVersion: "1.3.0"
    });

    expect(workspace.restoreSkillsConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-1" }), "cfg-previous");
    expect(result).toMatchObject({
      changeStatus: AgentSkillChangeStatus.rolled_back,
      reloadStatus: AgentSkillReloadStatus.failed,
      failedStage: "reload",
      errorCode: "SKILL_RELOAD_FAILED",
      rollbackResult: "succeeded"
    });
  });

  it("rejects a second change while an agent change is active", async () => {
    prisma.agentSkillChange.findFirst.mockResolvedValueOnce(changeFrom({ id: "change-active" }));
    const service = new AgentSkillsService(prisma, workspace, reload, validator);

    await expect(
      service.remove("agent-1", "skill-a", {
        sourceType: AgentSkillSourceType.registry,
        requestedVersion: "1.2.0"
      })
    ).rejects.toThrow(ConflictException);

    expect(workspace.applySkillsConfig).not.toHaveBeenCalled();
  });

  it("rejects agent self-update by default before workspace writes", async () => {
    const service = new AgentSkillsService(prisma, workspace, reload, validator);

    await expect(
      service.selfUpdate("agent-1", {
        skillName: "skill-a",
        sourceType: AgentSkillSourceType.registry,
        requestedVersion: "1.2.0"
      })
    ).rejects.toThrow(BadRequestException);

    expect(workspace.applySkillsConfig).not.toHaveBeenCalled();
    expect(prisma.agentSkill.upsert).not.toHaveBeenCalled();
  });

  function agentFrom(overrides: Partial<any> = {}) {
    return {
      id: "agent-1",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: "ops-agent--agent123",
      workspacePath: ".homelab/agents/ops-agent--agent123",
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }

  function changeFrom(overrides: Partial<any> = {}) {
    return {
      id: "change-1",
      agentId: "agent-1",
      operation: AgentSkillOperation.install,
      skillName: "skill-a",
      sourceType: AgentSkillSourceType.registry,
      sourceId: null,
      requestedVersion: "1.2.0",
      resolvedVersion: null,
      commitSha: null,
      previousVersion: null,
      previousConfigVersion: null,
      activeConfigVersion: null,
      stagedConfigVersion: null,
      result: "pending",
      changeStatus: AgentSkillChangeStatus.pending,
      reloadStatus: AgentSkillReloadStatus.unknown,
      auditStatus: "audit_written",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      createdAt: now,
      finishedAt: null,
      ...overrides
    };
  }
});
