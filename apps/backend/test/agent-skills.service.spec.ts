import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AgentSkillsService } from "../src/modules/agents/agent-skills.service";

describe("AgentSkillsService", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  const agent = {
    id: "agent-123",
    name: "Ops Agent",
    workspacePath: ".homelab/agents/ops-agent--agent123",
    workspaceName: "ops-agent--agent123"
  };

  const prisma = {
    agent: {
      findUnique: jest.fn()
    },
    agentSkillChange: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn()
    },
    agentSkillInstallation: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn()
    },
    agentSkillSource: {
      findUnique: jest.fn()
    },
    agentSkillSelfUpdatePolicy: {
      findFirst: jest.fn()
    },
    $transaction: jest.fn()
  } as any;

  const workspaces = {
    listSkills: jest.fn(),
    stageSkillsConfig: jest.fn(),
    commitSkillsConfig: jest.fn(),
    rollbackSkillsConfig: jest.fn()
  } as any;

  const validator = {
    validate: jest.fn()
  };

  const reloadClient = {
    reloadSkills: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agent.findUnique.mockResolvedValue(agent);
    prisma.agentSkillChange.findFirst.mockResolvedValue(null);
    prisma.agentSkillSource.findUnique.mockResolvedValue({
      id: "source-1",
      sourceType: "registry",
      label: "Workspace Registry",
      isTrusted: true
    });
    prisma.agentSkillInstallation.findMany.mockResolvedValue([]);
    prisma.agentSkillInstallation.findUnique.mockResolvedValue(null);
    prisma.agentSkillSelfUpdatePolicy.findFirst.mockResolvedValue(null);
    prisma.agentSkillChange.create.mockImplementation(async ({ data }: any) => ({
      id: "change-1",
      targetAgentId: data.targetAgentId,
      operation: data.operation,
      skillName: data.skillName,
      sourceType: data.sourceType,
      sourceId: data.sourceId,
      requestedVersion: data.requestedVersion,
      resolvedVersion: null,
      previousVersion: null,
      previousConfigVersion: "config-old",
      activeConfigVersion: null,
      stagedConfigVersion: null,
      changeStatus: "pending",
      reloadStatus: "unknown",
      auditStatus: "audit_pending",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      createdAt: now,
      finishedAt: null
    }));
    prisma.agentSkillChange.update.mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      targetAgentId: "agent-123",
      operation: "install",
      skillName: "skill-a",
      sourceType: "registry",
      sourceId: "source-1",
      requestedVersion: "1.3.0",
      resolvedVersion: data.resolvedVersion ?? "1.3.0",
      previousVersion: null,
      previousConfigVersion: "config-old",
      activeConfigVersion: data.activeConfigVersion ?? null,
      stagedConfigVersion: data.stagedConfigVersion ?? null,
      changeStatus: data.changeStatus ?? "succeeded",
      reloadStatus: data.reloadStatus ?? "pending_restart",
      auditStatus: data.auditStatus ?? "audit_written",
      rollbackResult: data.rollbackResult ?? "not_required",
      failedStage: data.failedStage ?? null,
      errorCode: data.errorCode ?? null,
      safeErrorSummary: data.safeErrorSummary ?? null,
      createdAt: now,
      finishedAt: data.finishedAt ?? now
    }));
    prisma.agentSkillInstallation.upsert.mockResolvedValue({});
    prisma.agentSkillInstallation.update.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    validator.validate.mockResolvedValue({ resolvedVersion: "1.3.0", manifest: { name: "skill-a" } });
    workspaces.stageSkillsConfig.mockResolvedValue({
      previousConfigVersion: "config-old",
      stagedConfigVersion: "config-new",
      config: { skills: [{ name: "skill-a", version: "1.3.0" }] }
    });
    workspaces.commitSkillsConfig.mockResolvedValue({ activeConfigVersion: "config-new" });
    workspaces.rollbackSkillsConfig.mockResolvedValue({ activeConfigVersion: "config-old" });
    reloadClient.reloadSkills.mockResolvedValue({
      reloadStatus: "pending_restart",
      effectiveFor: "next_task"
    });
  });

  it("installs from a trusted source and returns pending_restart when no real reload endpoint exists", async () => {
    const service = new AgentSkillsService(prisma, workspaces, validator, reloadClient);

    const result = await service.installAdmin("agent-123", {
      skillName: "skill-a",
      sourceId: "source-1",
      sourceType: "registry",
      version: "1.3.0"
    }, "admin-1");

    expect(prisma.agentSkillChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: "admin",
        actorId: "admin-1",
        targetAgentId: "agent-123",
        operation: "install",
        auditStatus: "audit_pending",
        changeStatus: "pending"
      })
    });
    expect(workspaces.stageSkillsConfig).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ operation: "install", skillName: "skill-a" })
    );
    expect(workspaces.commitSkillsConfig).toHaveBeenCalledWith(agent, "change-1", "config-new");
    expect(result).toMatchObject({
      changeId: "change-1",
      skillName: "skill-a",
      changeStatus: "succeeded",
      reloadStatus: "pending_restart",
      auditStatus: "audit_written",
      rollbackResult: "not_required",
      activeConfigVersion: "config-new",
      effectiveFor: "next_task"
    });
  });

  it("rejects a second change while one is in progress", async () => {
    prisma.agentSkillChange.findFirst.mockResolvedValueOnce({ id: "change-busy" });
    const service = new AgentSkillsService(prisma, workspaces, validator, reloadClient);

    const result = await service.installAdmin("agent-123", {
      skillName: "skill-a",
      sourceId: "source-1",
      sourceType: "registry",
      version: "1.3.0"
    }, "admin-1");

    expect(result).toMatchObject({
      changeStatus: "failed",
      failedStage: "concurrency_lock",
      errorCode: "AGENT_SKILL_CHANGE_IN_PROGRESS",
      reloadStatus: "unknown",
      rollbackResult: "skipped"
    });
    expect(workspaces.stageSkillsConfig).not.toHaveBeenCalled();
  });

  it("rolls back to the previous config when reload fails", async () => {
    reloadClient.reloadSkills.mockRejectedValueOnce(
      new Error("reload token ghp_secret1234567890 failed at /repo/private/path")
    );
    const service = new AgentSkillsService(prisma, workspaces, validator, reloadClient);

    const result = await service.installAdmin("agent-123", {
      skillName: "skill-a",
      sourceId: "source-1",
      sourceType: "registry",
      version: "1.3.0"
    }, "admin-1");

    expect(workspaces.rollbackSkillsConfig).toHaveBeenCalledWith(agent, "change-1", "config-old");
    expect(result).toMatchObject({
      changeStatus: "rolled_back",
      reloadStatus: "failed",
      failedStage: "reload",
      rollbackResult: "succeeded",
      activeConfigVersion: "config-old",
      errorCode: "AGENT_SKILL_RELOAD_FAILED"
    });
    expect(result.safeErrorSummary).not.toContain("ghp_secret");
    expect(result.safeErrorSummary).not.toContain("/repo/private/path");
  });

  it("rejects agent self-update by default", async () => {
    const service = new AgentSkillsService(prisma, workspaces, validator, reloadClient);

    await expect(
      service.selfUpdate(
        { id: "app-key-1", name: "agent key", agentName: "Ops Agent", scopes: ["agent:skills:self-update"] },
        {
          agentId: "agent-123",
          operation: "install",
          skillName: "skill-a",
          sourceId: "source-1",
          sourceType: "registry",
          version: "1.3.0"
        }
      )
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.agentSkillChange.create).not.toHaveBeenCalled();
  });

  it("rejects untrusted sources before staging workspace files", async () => {
    prisma.agentSkillSource.findUnique.mockResolvedValueOnce(null);
    const service = new AgentSkillsService(prisma, workspaces, validator, reloadClient);

    await expect(
      service.installAdmin("agent-123", {
        skillName: "skill-a",
        sourceId: "missing-source",
        sourceType: "git",
        version: "main"
      }, "admin-1")
    ).rejects.toThrow(BadRequestException);
    expect(workspaces.stageSkillsConfig).not.toHaveBeenCalled();
  });
});
