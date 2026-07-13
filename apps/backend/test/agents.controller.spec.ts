import { BadRequestException } from "@nestjs/common";
import { AgentStatus } from "@prisma/client";
import { AgentsController } from "../src/modules/agents/agents.controller";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { AgentsService } from "../src/modules/agents/agents.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("AgentsController broad unit", () => {
  const prisma = {
    agent: {
      findUnique: jest.fn(),
      update: jest.fn()
    }
  } as unknown as PrismaService & {
    agent: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  const workspaces = {
    getGitStatus: jest.fn(() => "available"),
    readSoul: jest.fn(),
    writeSoul: jest.fn(),
    readSoulForRun: jest.fn()
  } as unknown as AgentWorkspaceService & {
    getGitStatus: jest.Mock;
    readSoul: jest.Mock;
    writeSoul: jest.Mock;
    readSoulForRun: jest.Mock;
  };

  let controller: AgentsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AgentsController(new AgentsService(prisma, workspaces));
    prisma.agent.findUnique.mockResolvedValue(agentFrom({ soul: "DB snapshot soul" }));
    prisma.agent.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) =>
      agentFrom({ id: where.id, ...data })
    );
  });

  it("returns Agent detail soul from workspace/soul.md instead of the DB snapshot", async () => {
    workspaces.readSoul.mockResolvedValue({
      content: "Workspace soul from file",
      status: "loaded"
    });

    await expect(controller.get("agent-12345678")).resolves.toMatchObject({
      id: "agent-12345678",
      soul: "Workspace soul from file",
      soulFileStatus: "loaded"
    });
  });

  it("returns default recoverable content when workspace/soul.md is missing", async () => {
    workspaces.readSoul.mockResolvedValue({
      content: "# Ops Agent\n",
      status: "missing"
    });

    await expect(controller.get("agent-12345678")).resolves.toMatchObject({
      soul: "# Ops Agent\n",
      soulFileStatus: "missing"
    });
  });

  it("saves nonblank soul by writing workspace/soul.md and syncing the DB snapshot", async () => {
    workspaces.writeSoul.mockResolvedValue(undefined);
    workspaces.readSoul.mockResolvedValue({
      content: "Updated soul",
      status: "loaded"
    });

    await expect(controller.saveSoul("agent-12345678", { soul: "Updated soul" })).resolves.toMatchObject({
      soul: "Updated soul",
      soulFileStatus: "loaded"
    });
    expect(workspaces.writeSoul).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-12345678" }), "Updated soul");
    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { id: "agent-12345678" },
      data: { soul: "Updated soul" }
    });
  });

  it("rejects blank soul without changing workspace/soul.md or the DB snapshot", async () => {
    await expect(controller.saveSoul("agent-12345678", { soul: " \n\t " })).rejects.toThrow(BadRequestException);

    expect(workspaces.writeSoul).not.toHaveBeenCalled();
    expect(prisma.agent.update).not.toHaveBeenCalled();
  });

  it("loads a new run soul snapshot from workspace/soul.md on each run startup", async () => {
    workspaces.readSoulForRun.mockResolvedValueOnce("Run A soul").mockResolvedValueOnce("Run B soul");
    const service = new AgentsService(prisma, workspaces);

    await expect(service.loadSoulForRun("agent-12345678")).resolves.toBe("Run A soul");
    await expect(service.loadSoulForRun("agent-12345678")).resolves.toBe("Run B soul");
    expect(workspaces.readSoulForRun).toHaveBeenCalledTimes(2);
    expect(workspaces.readSoulForRun).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "agent-12345678" }));
  });

  function agentFrom(overrides: Partial<any>) {
    const now = new Date("2026-07-13T10:00:00Z");
    return {
      id: "agent-12345678",
      name: "Ops Agent",
      slug: "ops-agent",
      status: AgentStatus.ready,
      workspaceName: "ops-agent--agent123",
      workspacePath: ".homelab/agents/ops-agent--agent123",
      modelProvider: null,
      modelSecretRef: null,
      soul: "DB snapshot soul",
      initializationError: null,
      initializedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }
});
