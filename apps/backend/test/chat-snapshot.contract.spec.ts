type LoadedSnapshotModule = Record<string, any>;

function loadSnapshotModule(): LoadedSnapshotModule | null {
  try {
    return require("../src/modules/chat/chat-config-snapshot.service") as LoadedSnapshotModule;
  } catch {
    return null;
  }
}

const snapshotModule = loadSnapshotModule();

describe("ChatConfigSnapshotService", () => {
  it("provides atomic active configuration snapshots", () => {
    expect(snapshotModule?.ChatConfigSnapshotService).toBeDefined();
  });

  if (!snapshotModule) {
    return;
  }

  function createHarness(vectors: string[]) {
    let vectorIndex = 0;
    const source = {
      getAgent: jest.fn().mockResolvedValue({
        id: "agent-1",
        name: "Ops Agent",
        status: "ready",
        modelProviderId: "provider-1",
        workspaceName: "ops-agent--12345678",
        workspacePath: ".homelab/agents/ops-agent--12345678"
      }),
      resolveProvider: jest.fn().mockResolvedValue({
        id: "provider-1",
        name: "Primary",
        baseUrl: "https://provider.test",
        apiKey: "canary-secret",
        defaultModel: "gpt-test",
        revision: "provider-v1"
      }),
      readSoul: jest.fn().mockResolvedValue({ content: "System prompt", status: "loaded" }),
      readSkills: jest.fn().mockResolvedValue([]),
      readWorkflow: jest.fn().mockResolvedValue({
        workflowKey: "default",
        activeHash: "workflow-v1",
        source: "model-only"
      }),
      readVersionVector: jest.fn(() => Promise.resolve(vectors[Math.min(vectorIndex++, vectors.length - 1)]))
    };
    const testControl = { checkpoint: jest.fn(), increment: jest.fn(), fault: jest.fn(), generation: jest.fn(() => 0) };
    const service = new snapshotModule!.ChatConfigSnapshotService(source, testControl);
    return { service, source, testControl };
  }

  it("retries immediately until the initial and final vectors match", async () => {
    const { service, source } = createHarness(["v1", "v2", "v2", "v2"]);

    const result = await service.capture("agent-1");

    expect(result.versionVector).toBe("v2");
    expect(source.readVersionVector).toHaveBeenCalledTimes(4);
    expect(source.resolveProvider).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable terminal conflict after exactly three inconsistent attempts", async () => {
    const { service, source } = createHarness(["a", "b", "c", "d", "e", "f"]);

    await expect(service.capture("agent-1")).rejects.toMatchObject({
      chatFailure: expect.objectContaining({
        httpStatus: 409,
        code: "CONFIG_SNAPSHOT_CONFLICT",
        retryable: true
      })
    });
    expect(source.readVersionVector).toHaveBeenCalledTimes(6);
  });

  it("returns safe eligibility without exposing provider credentials", async () => {
    const { service } = createHarness(["v1", "v1"]);

    const result = await service.getEligibility("agent-1");

    expect(result).toEqual({
      agentId: "agent-1",
      eligible: true,
      code: null,
      message: null,
      agent: { name: "Ops Agent", status: "ready" },
      providerSummary: { id: "provider-1", name: "Primary", model: "gpt-test" }
    });
    expect(JSON.stringify(result)).not.toContain("canary-secret");
  });
});
