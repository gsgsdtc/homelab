import { AgentWorkflowsController } from "../src/modules/agents/agent-workflows.controller";
import { AgentWorkflowsService } from "../src/modules/agents/agent-workflows.service";

describe("AgentWorkflowsController", () => {
  const service = {
    list: jest.fn(),
    get: jest.fn(),
    validate: jest.fn(),
    create: jest.fn(),
    saveDraft: jest.fn(),
    saveAndReload: jest.fn(),
    reload: jest.fn(),
    versions: jest.fn(),
    rollback: jest.fn()
  } as unknown as jest.Mocked<AgentWorkflowsService>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("routes save-and-reload to the workflow service with agent and workflow keys", async () => {
    service.saveAndReload.mockResolvedValue(response({ workflowKey: "support-triage", reloadStatus: "succeeded" }));
    const controller = new AgentWorkflowsController(service);

    const result = await controller.saveAndReload("agent-1", "support-triage", {
      source: "export default workflow;",
      extension: "ts",
      expectedRevision: "draft-v1"
    });

    expect(service.saveAndReload).toHaveBeenCalledWith("agent-1", "support-triage", {
      source: "export default workflow;",
      extension: "ts",
      expectedRevision: "draft-v1"
    });
    expect(result).toMatchObject({ workflowKey: "support-triage", reloadStatus: "succeeded" });
  });

  it("routes rollback to the workflow service", async () => {
    service.rollback.mockResolvedValue(response({ workflowKey: "support-triage", activeHash: "active-v1" }));
    const controller = new AgentWorkflowsController(service);

    await controller.rollback("agent-1", "support-triage", { versionId: "version-1" });

    expect(service.rollback).toHaveBeenCalledWith("agent-1", "support-triage", { versionId: "version-1" });
  });
});

function response(overrides: Record<string, unknown>) {
  return {
    workflowKey: "default",
    filePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/default.ts",
    draftHash: "draft-v1",
    activeHash: null,
    reloadStatus: "draft" as const,
    loadedAt: null,
    updatedAt: new Date("2026-07-13T12:00:00Z"),
    revision: 1,
    error: null,
    ...overrides
  };
}
