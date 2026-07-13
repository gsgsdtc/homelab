import { BadRequestException, ConflictException } from "@nestjs/common";
import { AgentWorkflowsService } from "../src/modules/agents/agent-workflows.service";
import { AgentWorkflowSnapshotService } from "../src/modules/agents/agent-workflow-snapshot.service";
import { AgentWorkflowValidator } from "../src/modules/agents/agent-workflow-validator.service";
import { AgentWorkflowRuntimeClient } from "../src/modules/agents/agent-workflow-runtime.client";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("AgentWorkflowsService", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  const prisma = {
    agent: {
      findUnique: jest.fn()
    },
    agentWorkflow: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn()
    },
    agentWorkflowVersion: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn()
    },
    $transaction: jest.fn()
  } as unknown as PrismaService & any;

  const workspaces = {
    workflowSourceRelativePath: jest.fn(),
    writeWorkflowSource: jest.fn(),
    readWorkflowSource: jest.fn()
  } as unknown as AgentWorkspaceService & any;

  const validator = {
    validateSource: jest.fn()
  } as unknown as AgentWorkflowValidator & any;

  const runtime = {
    reloadWorkflow: jest.fn()
  } as unknown as AgentWorkflowRuntimeClient & any;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    prisma.agent.findUnique.mockResolvedValue(agent());
    prisma.agentWorkflow.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
    prisma.agentWorkflowVersion.findMany.mockResolvedValue([]);
    workspaces.workflowSourceRelativePath.mockReturnValue(
      ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts"
    );
    workspaces.writeWorkflowSource.mockResolvedValue({
      path: "/repo/.homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
      relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts"
    });
    validator.validateSource.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("saves a validated draft without changing the active hash", async () => {
    prisma.agentWorkflow.findUnique.mockResolvedValue(workflow({ draftHash: "old-draft", activeHash: "active-v1" }));
    prisma.agentWorkflow.upsert.mockImplementation(async ({ update }: any) =>
      workflow({
        draftHash: update.draftHash,
        activeHash: "active-v1",
        reloadStatus: "draft",
        revision: update.revision
      })
    );
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.saveDraft("agent-1", {
      workflowKey: "support-triage",
      source: validSource("support-triage"),
      expectedRevision: "old-draft"
    });

    expect(validator.validateSource).toHaveBeenCalledWith({
      workflowKey: "support-triage",
      extension: "ts",
      source: validSource("support-triage")
    });
    expect(workspaces.writeWorkflowSource).toHaveBeenCalledWith(agent(), "support-triage", "ts", validSource("support-triage"));
    expect(result.activeHash).toBe("active-v1");
    expect(result.draftHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.reloadStatus).toBe("draft");
  });

  it("rejects stale draft updates with a conflict", async () => {
    prisma.agentWorkflow.findUnique.mockResolvedValue(workflow({ draftHash: "current-draft" }));
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    await expect(
      service.saveDraft("agent-1", {
        workflowKey: "support-triage",
        source: validSource("support-triage"),
        expectedRevision: "stale-draft"
      })
    ).rejects.toThrow(ConflictException);

    expect(workspaces.writeWorkflowSource).not.toHaveBeenCalled();
  });

  it("promotes draft to active and records a version when reload succeeds", async () => {
    const item = workflow({ draftHash: hashOf(validSource("support-triage")), activeHash: "active-v1" });
    prisma.agentWorkflow.findFirst.mockResolvedValue(item);
    runtime.reloadWorkflow.mockResolvedValue({ status: "succeeded", loadedAt: now });
    prisma.agentWorkflow.update.mockResolvedValue({
      ...item,
      activeHash: item.draftHash,
      reloadStatus: "succeeded",
      reloadError: null,
      loadedAt: now
    });
    prisma.agentWorkflowVersion.create.mockResolvedValue({
      id: "version-2",
      workflowId: item.id,
      sourceHash: item.draftHash,
      source: validSource("support-triage")
    });
    workspaces.readWorkflowSource.mockResolvedValue(validSource("support-triage"));
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.reload("agent-1", "support-triage", { expectedDraftHash: item.draftHash });

    expect(runtime.reloadWorkflow).toHaveBeenCalledWith({
      agentId: "agent-1",
      workflowKey: "support-triage",
      sourceHash: item.draftHash,
      relativePath: item.relativePath,
      extension: "ts"
    });
    expect(prisma.agentWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: item.id,
        sourceHash: item.draftHash,
        source: validSource("support-triage")
      })
    });
    expect(result.activeHash).toBe(item.draftHash);
    expect(result.reloadStatus).toBe("succeeded");
  });

  it("keeps the previous active hash and draft when reload fails", async () => {
    const item = workflow({ draftHash: "draft-v2", activeHash: "active-v1" });
    prisma.agentWorkflow.findFirst.mockResolvedValue(item);
    runtime.reloadWorkflow.mockResolvedValue({ status: "failed", error: "compile failed at /private/path token sk-secret1234567890" });
    prisma.agentWorkflow.update.mockResolvedValue({
      ...item,
      reloadStatus: "failed",
      reloadError: "compile failed at [path] token [secret]"
    });
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.reload("agent-1", "support-triage", { expectedDraftHash: "draft-v2" });

    expect(prisma.agentWorkflowVersion.create).not.toHaveBeenCalled();
    expect(result.activeHash).toBe("active-v1");
    expect(result.draftHash).toBe("draft-v2");
    expect(result.reloadStatus).toBe("failed");
    expect(result.error?.message).not.toContain("sk-secret");
  });

  it("rolls back by writing the historical version as draft and reloading it", async () => {
    const current = workflow({ draftHash: "draft-v2", activeHash: "active-v2" });
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(current).mockResolvedValueOnce({
      ...current,
      draftHash: hashOf(validSource("support-triage", "v1"))
    });
    prisma.agentWorkflowVersion.findUnique.mockResolvedValue({
      id: "version-1",
      workflowId: current.id,
      sourceHash: "active-v1",
      source: validSource("support-triage", "v1"),
      extension: "ts"
    });
    prisma.agentWorkflow.upsert.mockResolvedValue({
      ...current,
      draftHash: hashOf(validSource("support-triage", "v1")),
      reloadStatus: "draft"
    });
    runtime.reloadWorkflow.mockResolvedValue({ status: "succeeded", loadedAt: now });
    prisma.agentWorkflow.update.mockResolvedValue({
      ...current,
      draftHash: hashOf(validSource("support-triage", "v1")),
      activeHash: hashOf(validSource("support-triage", "v1")),
      reloadStatus: "succeeded"
    });
    prisma.agentWorkflowVersion.create.mockResolvedValue({ id: "version-3" });
    workspaces.readWorkflowSource.mockResolvedValue(validSource("support-triage", "v1"));
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.rollback("agent-1", "support-triage", { versionId: "version-1" });

    expect(workspaces.writeWorkflowSource).toHaveBeenCalledWith(agent(), "support-triage", "ts", validSource("support-triage", "v1"));
    expect(prisma.agentWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rollbackOfVersionId: "version-1"
      })
    });
    expect(result.activeHash).toBe(hashOf(validSource("support-triage", "v1")));
  });

  it("returns claim-time snapshot data from the active workflow version", async () => {
    prisma.agentWorkflow.findFirst.mockResolvedValue(workflow({ activeHash: "active-v1", workflowKey: "default" }));
    prisma.agentWorkflowVersion.findFirst.mockResolvedValue({
      id: "version-1",
      workflowId: "workflow-1",
      sourceHash: "active-v1"
    });
    const snapshots = new AgentWorkflowSnapshotService(prisma);

    const result = await snapshots.getClaimSnapshot("agent-1", "default");

    expect(result).toEqual({
      agentWorkflowId: "workflow-1",
      workflowKey: "default",
      workflowHash: "active-v1",
      workflowVersionId: "version-1"
    });
  });
});

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    name: "Ops Agent",
    slug: "ops-agent",
    workspaceName: "ops-agent--agent123",
    workspacePath: ".homelab/agents/ops-agent--agent123",
    ...overrides
  };
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "workflow-1",
    agentId: "agent-1",
    workflowKey: "support-triage",
    extension: "ts",
    relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
    draftHash: "draft-v1",
    activeHash: null,
    revision: "draft-v1",
    reloadStatus: "draft",
    reloadError: null,
    loadedAt: null,
    updatedAt: new Date("2026-07-13T12:00:00Z"),
    ...overrides
  };
}

function validSource(workflowKey: string, marker = "v2") {
  return [
    'import { createWorkflow } from "@mastra/core/workflows";',
    `const workflow = createWorkflow({ id: "${workflowKey}" });`,
    `workflow.commit(); // ${marker}`,
    "export default workflow;",
    ""
  ].join("\n");
}

function hashOf(source: string) {
  return require("crypto").createHash("sha256").update(source, "utf8").digest("hex");
}
