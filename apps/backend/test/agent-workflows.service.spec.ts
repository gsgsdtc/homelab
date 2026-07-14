import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
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
      update: jest.fn(),
      updateMany: jest.fn()
    },
    agentWorkflowVersion: {
      create: jest.fn(),
      deleteMany: jest.fn(),
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
    prisma.agentWorkflow.updateMany.mockResolvedValue({ count: 1 });
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
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(item).mockResolvedValueOnce({
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
    expect(prisma.agentWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: item.id, draftHash: item.draftHash, relativePath: item.relativePath },
      data: expect.objectContaining({
        activeHash: item.draftHash,
        reloadStatus: "succeeded"
      })
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

  it("promotes draft through the in-process Mastra reload adapter without a remote runtime URL", async () => {
    const item = workflow({ draftHash: hashOf(validSource("support-triage")), activeHash: "active-v1" });
    const hook = {
      reloadWorkflow: jest.fn().mockResolvedValue({ status: "succeeded", loadedAt: now })
    };
    const inProcessRuntime = new AgentWorkflowRuntimeClient(config(undefined), hook);
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(item).mockResolvedValueOnce({
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
    const service = new AgentWorkflowsService(prisma, workspaces, validator, inProcessRuntime);

    const result = await service.reload("agent-1", "support-triage", { expectedDraftHash: item.draftHash });

    expect(hook.reloadWorkflow).toHaveBeenCalledWith({
      agentId: "agent-1",
      workflowKey: "support-triage",
      sourceHash: item.draftHash,
      relativePath: item.relativePath,
      extension: "ts"
    });
    expect(prisma.agentWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: item.id, draftHash: item.draftHash, relativePath: item.relativePath },
      data: expect.objectContaining({
        activeHash: item.draftHash,
        reloadStatus: "succeeded"
      })
    });
    expect(result.activeHash).toBe(item.draftHash);
    expect(result.reloadStatus).toBe("succeeded");
  });

  it("does not promote when the draft changes while runtime reload is in flight", async () => {
    const item = workflow({ draftHash: hashOf(validSource("support-triage", "v2")), activeHash: "active-v1" });
    prisma.agentWorkflow.findFirst.mockResolvedValue(item);
    runtime.reloadWorkflow.mockResolvedValue({ status: "succeeded", loadedAt: now });
    workspaces.readWorkflowSource.mockResolvedValue(validSource("support-triage", "v2"));
    prisma.agentWorkflow.updateMany.mockResolvedValue({ count: 0 });
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    await expect(service.reload("agent-1", "support-triage", { expectedDraftHash: item.draftHash })).rejects.toThrow(
      ConflictException
    );

    expect(prisma.agentWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: item.id, draftHash: item.draftHash, relativePath: item.relativePath },
      data: expect.objectContaining({ activeHash: item.draftHash })
    });
    expect(prisma.agentWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it("keeps the previous active hash and draft when reload fails", async () => {
    const source = validSource("support-triage", "v2");
    const draftHash = hashOf(source);
    const item = workflow({ draftHash, activeHash: "active-v1" });
    prisma.agentWorkflow.findFirst.mockResolvedValue(item);
    workspaces.readWorkflowSource.mockResolvedValue(source);
    runtime.reloadWorkflow.mockResolvedValue({ status: "failed", error: "compile failed at /private/path token sk-secret1234567890" });
    prisma.agentWorkflow.update.mockResolvedValue({
      ...item,
      reloadStatus: "failed",
      reloadError: "compile failed at [path] token [secret]"
    });
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.reload("agent-1", "support-triage", { expectedDraftHash: draftHash });

    expect(prisma.agentWorkflowVersion.create).not.toHaveBeenCalled();
    expect(result.activeHash).toBe("active-v1");
    expect(result.draftHash).toBe(draftHash);
    expect(result.reloadStatus).toBe("failed");
    expect(result.error?.message).not.toContain("sk-secret");
  });

  it("retries the same failed draft and promotes it after runtime recovers", async () => {
    const source = validSource("support-triage", "v2");
    const draftHash = hashOf(source);
    const item = workflow({ draftHash, activeHash: "active-v1", reloadStatus: "failed" });
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(item).mockResolvedValueOnce({
      ...item,
      activeHash: draftHash,
      reloadStatus: "succeeded",
      reloadError: null,
      loadedAt: now
    });
    runtime.reloadWorkflow.mockResolvedValue({ status: "succeeded", loadedAt: now });
    workspaces.readWorkflowSource.mockResolvedValue(source);
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.reload("agent-1", "support-triage", { expectedDraftHash: draftHash });

    expect(runtime.reloadWorkflow).toHaveBeenCalledWith(expect.objectContaining({ sourceHash: draftHash }));
    expect(prisma.agentWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sourceHash: draftHash })
    });
    expect(result.activeHash).toBe(draftHash);
    expect(result.reloadStatus).toBe("succeeded");
  });

  it("redacts sensitive reload errors across token and path types", async () => {
    const source = validSource("support-triage", "v2");
    const draftHash = hashOf(source);
    const item = workflow({ draftHash, activeHash: "active-v1" });
    prisma.agentWorkflow.findFirst.mockResolvedValue(item);
    workspaces.readWorkflowSource.mockResolvedValue(source);
    const rawError = [
      "/Users/alice/project/workflow.ts",
      "/home/app/.env",
      "sk-secret1234567890",
      "ghp_secret1234567890",
      "xoxb-secret1234567890",
      "AKIA1234567890ABCDEF",
      "eyJsecretpayload.eyJsecretpayload",
      "-----BEGIN PRIVATE KEY-----"
    ].join(" ");
    runtime.reloadWorkflow.mockResolvedValue({ status: "failed", error: rawError });
    prisma.agentWorkflow.update.mockImplementation(async ({ data }: any) => ({
      ...item,
      ...data
    }));
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.reload("agent-1", "support-triage", { expectedDraftHash: draftHash });

    expect(result.error?.message).not.toContain("/Users/alice");
    expect(result.error?.message).not.toContain("/home/app");
    expect(result.error?.message).not.toContain("sk-secret");
    expect(result.error?.message).not.toContain("ghp_");
    expect(result.error?.message).not.toContain("xoxb-");
    expect(result.error?.message).not.toContain("AKIA");
    expect(result.error?.message).not.toContain("eyJsecret");
    expect(result.error?.message).not.toContain("PRIVATE KEY");
  });

  it("rolls back by writing the historical version as draft and reloading it", async () => {
    const current = workflow({ draftHash: "draft-v2", activeHash: "active-v2" });
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(current).mockResolvedValueOnce({
      ...current,
      draftHash: hashOf(validSource("support-triage", "v1"))
    }).mockResolvedValueOnce({
      ...current,
      draftHash: hashOf(validSource("support-triage", "v1")),
      activeHash: hashOf(validSource("support-triage", "v1")),
      reloadStatus: "succeeded"
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

  it("does not change active when rollback version is missing", async () => {
    prisma.agentWorkflow.findFirst.mockResolvedValue(workflow({ activeHash: "active-v2" }));
    prisma.agentWorkflowVersion.findUnique.mockResolvedValue(null);
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    await expect(service.rollback("agent-1", "support-triage", { versionId: "missing" })).rejects.toThrow(
      NotFoundException
    );

    expect(workspaces.writeWorkflowSource).not.toHaveBeenCalled();
    expect(runtime.reloadWorkflow).not.toHaveBeenCalled();
    expect(prisma.agentWorkflow.update).not.toHaveBeenCalled();
  });

  it("keeps active unchanged and preserves rollback draft when rollback reload fails", async () => {
    const current = workflow({ draftHash: "draft-v2", activeHash: "active-v2" });
    const rollbackSource = validSource("support-triage", "v1");
    const rollbackHash = hashOf(rollbackSource);
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(current).mockResolvedValueOnce({
      ...current,
      draftHash: rollbackHash
    });
    prisma.agentWorkflowVersion.findUnique.mockResolvedValue({
      id: "version-1",
      workflowId: current.id,
      sourceHash: "active-v1",
      source: rollbackSource,
      extension: "ts"
    });
    prisma.agentWorkflow.upsert.mockResolvedValue({ ...current, draftHash: rollbackHash, reloadStatus: "draft" });
    runtime.reloadWorkflow.mockResolvedValue({ status: "failed", error: "rollback compile failed" });
    prisma.agentWorkflow.update.mockImplementation(async ({ data }: any) => ({ ...current, ...data, draftHash: rollbackHash }));
    workspaces.readWorkflowSource.mockResolvedValue(rollbackSource);
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    const result = await service.rollback("agent-1", "support-triage", { versionId: "version-1" });

    expect(result.activeHash).toBe("active-v2");
    expect(result.draftHash).toBe(rollbackHash);
    expect(result.reloadStatus).toBe("failed");
    expect(prisma.agentWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it("prunes versions beyond the ten newest without deleting the just-promoted active version", async () => {
    const source = validSource("support-triage", "v11");
    const draftHash = hashOf(source);
    const item = workflow({ draftHash, activeHash: "active-v10" });
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(item).mockResolvedValueOnce({
      ...item,
      activeHash: draftHash,
      reloadStatus: "succeeded",
      loadedAt: now
    });
    runtime.reloadWorkflow.mockResolvedValue({ status: "succeeded", loadedAt: now });
    prisma.agentWorkflowVersion.findMany.mockResolvedValue([{ id: "version-old" }, { id: "version-active", sourceHash: draftHash }]);
    workspaces.readWorkflowSource.mockResolvedValue(source);
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    await service.reload("agent-1", "support-triage", { expectedDraftHash: draftHash });

    expect(prisma.agentWorkflowVersion.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["version-old"] } }
    });
  });

  it("does not update DB or reload when workflow source write fails", async () => {
    workspaces.writeWorkflowSource.mockRejectedValueOnce(new Error("disk full before rename"));
    const service = new AgentWorkflowsService(prisma, workspaces, validator, runtime);

    await expect(
      service.saveAndReload("agent-1", "support-triage", {
        source: validSource("support-triage")
      })
    ).rejects.toThrow("disk full before rename");

    expect(prisma.agentWorkflow.upsert).not.toHaveBeenCalled();
    expect(runtime.reloadWorkflow).not.toHaveBeenCalled();
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

function config(runtimeUrl?: string) {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === "HOMELAB_WORKFLOW_RUNTIME_URL") {
        return runtimeUrl;
      }
      if (key === "HOMELAB_WORKFLOW_RELOAD_TIMEOUT_MS") {
        return 30_000;
      }
      return defaultValue;
    })
  } as any;
}
