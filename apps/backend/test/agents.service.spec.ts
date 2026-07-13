import { BadRequestException } from "@nestjs/common";
import { AgentStatus } from "@prisma/client";
import { AgentsService } from "../src/modules/agents/agents.service";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("AgentsService", () => {
  const prisma = {
    agent: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn()
    }
  } as unknown as PrismaService & {
    agent: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  const workspaces = {
    buildDescriptor: jest.fn(),
    initializeWorkspace: jest.fn(),
    getGitStatus: jest.fn(() => "available")
  } as unknown as AgentWorkspaceService & {
    buildDescriptor: jest.Mock;
    initializeWorkspace: jest.Mock;
    getGitStatus: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    workspaces.buildDescriptor.mockImplementation((slug: string, id: string) => ({
      rootPath: "/repo/.homelab/agents",
      workspaceName: `${slug}--${id.replace(/-/g, "").slice(0, 8)}`,
      workspacePath: `/repo/.homelab/agents/${slug}--${id.replace(/-/g, "").slice(0, 8)}`,
      relativeWorkspacePath: `.homelab/agents/${slug}--${id.replace(/-/g, "").slice(0, 8)}`
    }));
    prisma.agent.create.mockImplementation(async ({ data }: { data: any }) => agentFrom(data));
    prisma.agent.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) =>
      agentFrom({ id: where.id, ...data })
    );
  });

  it("creates an Agent, initializes its workspace, and marks it ready", async () => {
    const service = new AgentsService(prisma, workspaces);

    const result = await service.create({
      name: "Ops Agent",
      modelProvider: "openai",
      modelSecretRef: "OPENAI_API_KEY",
      soul: "Keep production stable."
    });

    expect(workspaces.buildDescriptor).toHaveBeenCalledWith("ops-agent", expect.any(String));
    expect(prisma.agent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Ops Agent",
        slug: "ops-agent",
        status: AgentStatus.initializing,
        workspaceName: expect.stringMatching(/^ops-agent--[a-z0-9]{8}$/),
        workspacePath: expect.stringMatching(/^\.homelab\/agents\/ops-agent--[a-z0-9]{8}$/),
        modelSecretRef: "OPENAI_API_KEY"
      })
    });
    expect(workspaces.initializeWorkspace).toHaveBeenCalledWith(expect.objectContaining({ slug: "ops-agent" }), {
      allowExistingWorkspace: false
    });
    expect(prisma.agent.update).toHaveBeenLastCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({
        status: AgentStatus.ready,
        initializationError: null,
        initializedAt: expect.any(Date)
      })
    });
    expect(result.status).toBe(AgentStatus.ready);
    expect(result.gitStatus).toBe("available");
  });

  it("marks the Agent init_failed when workspace initialization fails", async () => {
    workspaces.initializeWorkspace.mockRejectedValueOnce(new Error("soul.md write failed"));
    const service = new AgentsService(prisma, workspaces);

    const result = await service.create({ name: "Ops Agent" });

    expect(result.status).toBe(AgentStatus.init_failed);
    expect(result.initializationError).toBe("soul.md write failed");
    expect(prisma.agent.update).toHaveBeenLastCalledWith({
      where: { id: expect.any(String) },
      data: {
        status: AgentStatus.init_failed,
        initializationError: "soul.md write failed"
      }
    });
  });

  it("rejects obvious real secrets before creating workspace files", async () => {
    const service = new AgentsService(prisma, workspaces);

    await expect(service.create({ name: "Ops Agent", modelSecretRef: "sk-real-key" })).rejects.toThrow(
      BadRequestException
    );
    expect(prisma.agent.create).not.toHaveBeenCalled();
    expect(workspaces.initializeWorkspace).not.toHaveBeenCalled();
  });

  it("retries initialization against the same Agent workspace", async () => {
    prisma.agent.findUnique.mockResolvedValueOnce(
      agentFrom({
        id: "agent-12345678",
        status: AgentStatus.init_failed,
        workspaceName: "ops-agent--agent123",
        workspacePath: ".homelab/agents/ops-agent--agent123",
        initializationError: "previous failure"
      })
    );
    const service = new AgentsService(prisma, workspaces);

    await service.retryInitialization("agent-12345678");

    expect(workspaces.initializeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-12345678",
        workspacePath: ".homelab/agents/ops-agent--agent123"
      }),
      { allowExistingWorkspace: true }
    );
  });

  function agentFrom(overrides: Partial<any>) {
    const now = new Date("2026-07-13T10:00:00Z");
    return {
      id: "agent123456789",
      name: "Ops Agent",
      slug: "ops-agent",
      status: AgentStatus.initializing,
      workspaceName: "ops-agent--agent123",
      workspacePath: ".homelab/agents/ops-agent--agent123",
      modelProvider: null,
      modelSecretRef: null,
      soul: "",
      initializationError: null,
      initializedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }
});
