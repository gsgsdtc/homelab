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
    syncWorkspace: jest.fn(),
    readSoul: jest.fn(),
    writeSoul: jest.fn(),
    readSoulForRun: jest.fn(),
    getGitStatus: jest.fn(() => "available")
  } as unknown as AgentWorkspaceService & {
    buildDescriptor: jest.Mock;
    initializeWorkspace: jest.Mock;
    syncWorkspace: jest.Mock;
    readSoul: jest.Mock;
    writeSoul: jest.Mock;
    readSoulForRun: jest.Mock;
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
    prisma.agent.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => agentFrom({ id: where.id, ...data }));
    prisma.agent.findUnique.mockResolvedValue(agentFrom());
    workspaces.readSoul.mockResolvedValue({
      content: "Workspace soul.",
      status: "loaded"
    });
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
    expect(result).toMatchObject({
      id: expect.any(String),
      name: "Ops Agent",
      status: AgentStatus.ready,
      workspacePath: expect.stringMatching(/^\.homelab\/agents\/ops-agent--[a-z0-9]{8}$/),
      workspaceName: expect.stringMatching(/^ops-agent--[a-z0-9]{8}$/),
      initError: null,
      gitStatus: "available"
    });
  });

  it("marks the Agent init_failed when workspace initialization fails", async () => {
    workspaces.initializeWorkspace.mockRejectedValueOnce(new Error("soul.md write failed"));
    const service = new AgentsService(prisma, workspaces);

    const result = await service.create({ name: "Ops Agent" });

    expect(result.status).toBe(AgentStatus.init_failed);
    expect(result.initError).toEqual({
      code: "WORKSPACE_INITIALIZATION_FAILED",
      message: "soul.md write failed"
    });
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

    await expect(service.create({ name: "Ops Agent", modelSecretRef: "sk-real-key" })).rejects.toThrow(BadRequestException);
    expect(prisma.agent.create).not.toHaveBeenCalled();
    expect(workspaces.initializeWorkspace).not.toHaveBeenCalled();
  });

  it("rejects real secrets in every field that can be written to workspace files or paths", async () => {
    const service = new AgentsService(prisma, workspaces);
    const cases = [
      { name: "sk-secret1234567890" },
      { name: "Ops Agent", slug: "sk-secret1234567890" },
      { name: "Ops Agent", modelProvider: "ghp_secret1234567890" },
      { name: "Ops Agent", soul: "Use token xoxb-secret1234567890" },
      { name: "Ops Agent", modelSecretRef: "-----BEGIN PRIVATE KEY-----abc" }
    ];

    for (const dto of cases) {
      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    }
    expect(prisma.agent.create).not.toHaveBeenCalled();
    expect(workspaces.initializeWorkspace).not.toHaveBeenCalled();
  });

  it("rejects real secrets in update fields before writing workspace files", async () => {
    const service = new AgentsService(prisma, workspaces);

    await expect(
      service.update("agent-123", {
        soul: "JWT eyJsecretpayload.eyJsecretpayload",
        expectedRevision: 1
      })
    ).rejects.toThrow(BadRequestException);

    expect(prisma.agent.update).not.toHaveBeenCalled();
    expect(workspaces.initializeWorkspace).not.toHaveBeenCalled();
  });

  it("syncs workspace files during update using the previous Agent as the managed baseline", async () => {
    prisma.agent.findUnique.mockResolvedValueOnce(
      agentFrom({
        id: "agent-12345678",
        name: "Ops Agent",
        modelProvider: "openai",
        modelSecretRef: "OPENAI_API_KEY",
        soul: "Initial soul."
      })
    );
    prisma.agent.findUnique.mockResolvedValueOnce(
      agentFrom({
        id: "agent-12345678",
        name: "Ops Agent Updated",
        modelProviderId: "anthropic",
        modelProvider: "anthropic",
        modelSecretRef: "ANTHROPIC_API_KEY",
        soul: "Updated soul.",
        status: AgentStatus.ready,
        revision: 2
      })
    );
    prisma.agent.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) =>
      agentFrom({
        id: where.id,
        name: data.name ?? "Ops Agent Updated",
        modelProvider: data.modelProvider ?? "anthropic",
        modelSecretRef: data.modelSecretRef ?? "ANTHROPIC_API_KEY",
        soul: data.soul ?? "Updated soul.",
        ...data
      })
    );
    const service = new AgentsService(prisma, workspaces);

    const result = await service.update("agent-12345678", {
      name: "Ops Agent Updated",
      modelProvider: "anthropic",
      modelSecretRef: "ANTHROPIC_API_KEY",
      soul: "Updated soul.",
      expectedRevision: 1
    });

    expect(workspaces.syncWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-12345678",
        name: "Ops Agent Updated",
        modelProvider: "anthropic",
        modelSecretRef: "ANTHROPIC_API_KEY",
        soul: "Updated soul."
      }),
      expect.objectContaining({
        id: "agent-12345678",
        name: "Ops Agent",
        modelProvider: "openai",
        modelSecretRef: "OPENAI_API_KEY",
        soul: "Initial soul."
      })
    );
    expect(workspaces.initializeWorkspace).not.toHaveBeenCalled();
    expect(result.status).toBe(AgentStatus.ready);
  });

  it("returns init_failed when update sync finds user-edited workspace files", async () => {
    prisma.agent.findUnique.mockResolvedValueOnce(agentFrom({ id: "agent-12345678", status: AgentStatus.ready }));
    workspaces.syncWorkspace.mockRejectedValueOnce(new Error("workspace file has user edits: soul.md"));
    const service = new AgentsService(prisma, workspaces);

    await expect(
      service.update("agent-12345678", {
        soul: "Updated soul.",
        expectedRevision: 1
      })
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "AGENT_UPDATE_FAILED" })
    });
  });

  it("returns fixed detail API fields for initializing, ready, and init_failed statuses", async () => {
    const service = new AgentsService(prisma, workspaces);
    const statuses = [
      { status: AgentStatus.initializing, expectedInitError: null },
      { status: AgentStatus.ready, expectedInitError: null },
      {
        status: AgentStatus.init_failed,
        expectedInitError: {
          code: "WORKSPACE_INITIALIZATION_FAILED",
          message: "workspace path already exists"
        }
      }
    ];

    for (const item of statuses) {
      prisma.agent.findUnique.mockResolvedValueOnce(
        agentFrom({
          id: `agent-${item.status}`,
          status: item.status,
          initializationError: item.status === AgentStatus.init_failed ? "workspace path already exists" : "ignored previous error"
        })
      );

      const result = await service.get(`agent-${item.status}`);

      expect(result).toMatchObject({
        id: `agent-${item.status}`,
        name: "Ops Agent",
        status: item.status,
        workspacePath: ".homelab/agents/ops-agent--agent123",
        workspaceName: "ops-agent--agent123",
        initError: item.expectedInitError,
        gitStatus: "available",
        soul: "Workspace soul.",
        soulFileStatus: "loaded"
      });
    }
  });

  it("exposes status as the run-entry gate for UI assertions", async () => {
    prisma.agent.findUnique.mockResolvedValueOnce(
      agentFrom({
        id: "agent-initializing",
        status: AgentStatus.initializing
      })
    );
    prisma.agent.findUnique.mockResolvedValueOnce(
      agentFrom({
        id: "agent-ready",
        status: AgentStatus.ready
      })
    );
    prisma.agent.findUnique.mockResolvedValueOnce(
      agentFrom({
        id: "agent-failed",
        status: AgentStatus.init_failed,
        initializationError: "soul.md write failed"
      })
    );
    const service = new AgentsService(prisma, workspaces);

    await expect(service.get("agent-initializing")).resolves.toMatchObject({
      status: AgentStatus.initializing
    });
    await expect(service.get("agent-ready")).resolves.toMatchObject({
      status: AgentStatus.ready
    });
    await expect(service.get("agent-failed")).resolves.toMatchObject({
      status: AgentStatus.init_failed,
      initError: {
        code: "WORKSPACE_INITIALIZATION_FAILED",
        message: "soul.md write failed"
      }
    });
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

  it("does not clear a non-soul update user-edit conflict and mark the Agent ready on retry", async () => {
    const conflictedAgent = agentFrom({
      id: "agent-12345678",
      status: AgentStatus.init_failed,
      workspaceName: "ops-agent--agent123",
      workspacePath: ".homelab/agents/ops-agent--agent123",
      soul: "Updated soul.",
      initializationError: "workspace file has user edits: skills/skills.yaml"
    });
    prisma.agent.findUnique.mockResolvedValueOnce(conflictedAgent);
    workspaces.syncWorkspace.mockRejectedValueOnce(new Error("workspace file has user edits: skills/skills.yaml"));
    const service = new AgentsService(prisma, workspaces);

    const result = await service.retryInitialization("agent-12345678");

    expect(workspaces.syncWorkspace).toHaveBeenCalledWith(conflictedAgent, conflictedAgent);
    expect(workspaces.initializeWorkspace).not.toHaveBeenCalled();
    expect(result.status).toBe(AgentStatus.init_failed);
    expect(result.initError).toEqual({
      code: "WORKSPACE_INITIALIZATION_FAILED",
      message: "workspace file has user edits: skills/skills.yaml"
    });
  });

  function agentFrom(overrides: Partial<any> = {}) {
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
      modelProviderId: null,
      revision: 1,
      soulRevision: 1,
      initializationError: null,
      initializedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }
});
