import { AgentStatus } from "@prisma/client";
import { AgentsService } from "../src/modules/agents/agents.service";

describe("GFU-29 Agent backend contract", () => {
  const now = new Date("2026-07-14T08:00:00.000Z");
  const agent = (overrides: Record<string, unknown> = {}) => ({
    id: "agent-1",
    name: "Ops Agent",
    slug: "ops-agent",
    status: AgentStatus.ready,
    workspaceName: "ops-agent--agent1",
    workspacePath: ".homelab/agents/ops-agent--agent1",
    modelProviderId: "provider-1",
    modelProvider: "provider-1",
    modelSecretRef: null,
    soul: "# Ops Agent\n",
    revision: 7,
    soulRevision: 3,
    initializationError: null,
    initializedAt: now,
    createdAt: now,
    updatedAt: now,
    provider: { id: "provider-1", name: "OpenAI", isActive: true },
    ...overrides
  });

  const prisma: any = {
    agent: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn()
    },
    modelProvider: { findFirst: jest.fn() },
    agentCreateRequest: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (callback: (tx: any) => unknown) => callback(prisma))
  };
  const workspaces: any = {
    getGitStatus: jest.fn(() => "clean"),
    readSoul: jest.fn(),
    writeSoul: jest.fn(),
    deleteSoul: jest.fn()
  };
  const providers: any = { resolveProviderForAgent: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agent.count.mockResolvedValue(1);
    prisma.agent.findMany.mockResolvedValue([agent()]);
    prisma.modelProvider.findFirst.mockResolvedValue({
      id: "default-1",
      name: "Default",
      isActive: true
    });
    providers.resolveProviderForAgent.mockResolvedValue({
      id: "provider-1",
      name: "OpenAI"
    });
  });

  it("returns stable pagination, provider summary and revision", async () => {
    const service = new AgentsService(prisma, workspaces, providers);

    await expect(service.list({ query: " OPS ", page: 1, pageSize: 20 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "agent-1",
          slug: "ops-agent",
          revision: 7,
          gitStatus: "clean",
          providerSummary: {
            id: "provider-1",
            name: "OpenAI",
            source: "explicit"
          }
        })
      ],
      total: 1,
      page: 1,
      pageSize: 20
    });
    expect(prisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 20,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }]
      })
    );
  });

  it("rejects an invalid explicit provider before persistence", async () => {
    providers.resolveProviderForAgent.mockRejectedValueOnce(new Error("agent model provider not found"));
    const service = new AgentsService(prisma, workspaces, providers);

    await expect(service.create({ name: "Ops", modelProviderId: "missing" }, "request-1")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PROVIDER_NOT_FOUND" })
    });
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it("rejects stale Agent revisions without overwriting", async () => {
    prisma.agent.findUnique.mockResolvedValue(agent());
    const service = new AgentsService(prisma, workspaces, providers);

    await expect(service.update("agent-1", { name: "Changed", expectedRevision: 6 })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "REVISION_CONFLICT",
        currentRevision: 7
      })
    });
    expect(prisma.agent.updateMany).not.toHaveBeenCalled();
  });

  it("enforces ready, byte and Soul revision gates before writing", async () => {
    prisma.agent.findUnique.mockResolvedValue(agent());
    workspaces.readSoul.mockResolvedValue({ content: "old", status: "loaded" });
    const service = new AgentsService(prisma, workspaces, providers);

    await expect(
      service.saveSoul("agent-1", {
        content: "界".repeat(21846),
        expectedRevision: 3
      })
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "SOUL_TOO_LARGE" })
    });
    expect(workspaces.writeSoul).not.toHaveBeenCalled();
  });
});
