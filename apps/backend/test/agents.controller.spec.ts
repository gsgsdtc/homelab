import { BadRequestException, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AgentStatus, UserRole } from "@prisma/client";
import { RolesGuard } from "../src/common/guards/roles.guard";
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
    deleteSoul: jest.fn(),
    readSoulForRun: jest.fn()
  } as unknown as AgentWorkspaceService & {
    getGitStatus: jest.Mock;
    readSoul: jest.Mock;
    writeSoul: jest.Mock;
    deleteSoul: jest.Mock;
    readSoulForRun: jest.Mock;
  };

  let controller: AgentsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AgentsController(new AgentsService(prisma, workspaces));
    prisma.agent.findUnique.mockResolvedValue(agentFrom({ soul: "DB snapshot soul" }));
    prisma.agent.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => agentFrom({ id: where.id, ...data }));
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
    workspaces.readSoul
      .mockResolvedValueOnce({
        content: "Previous soul",
        status: "loaded"
      })
      .mockResolvedValueOnce({
        content: "Updated soul",
        status: "loaded"
      });

    await expect(
      controller.saveSoul("agent-12345678", {
        soul: "Updated soul",
        expectedRevision: 1
      })
    ).resolves.toMatchObject({
      content: "Updated soul",
      missing: false
    });
    expect(workspaces.writeSoul).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-12345678" }), "Updated soul");
    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { id: "agent-12345678" },
      data: { soul: "Updated soul", soulRevision: { increment: 1 } }
    });
  });

  it("restores the previous workspace/soul.md when DB snapshot sync fails", async () => {
    workspaces.readSoul.mockResolvedValueOnce({
      content: "Previous soul",
      status: "loaded"
    });
    workspaces.writeSoul.mockResolvedValue(undefined);
    prisma.agent.update.mockRejectedValueOnce(new Error("db unavailable"));

    await expect(
      controller.saveSoul("agent-12345678", {
        soul: "Updated soul",
        expectedRevision: 1
      })
    ).rejects.toThrow("db unavailable");

    expect(workspaces.writeSoul).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "agent-12345678" }), "Updated soul");
    expect(workspaces.writeSoul).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "agent-12345678" }), "Previous soul");
    expect(workspaces.deleteSoul).not.toHaveBeenCalled();
  });

  it("deletes a newly created workspace/soul.md when DB snapshot sync fails after a missing file", async () => {
    workspaces.readSoul.mockResolvedValueOnce({
      content: "# Ops Agent\n",
      status: "missing"
    });
    workspaces.writeSoul.mockResolvedValue(undefined);
    prisma.agent.update.mockRejectedValueOnce(new Error("db unavailable"));

    await expect(
      controller.saveSoul("agent-12345678", {
        soul: "Recovered soul",
        expectedRevision: 1
      })
    ).rejects.toThrow("db unavailable");

    expect(workspaces.writeSoul).toHaveBeenCalledTimes(1);
    expect(workspaces.deleteSoul).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-12345678" }));
  });

  it("rejects blank soul without changing workspace/soul.md or the DB snapshot", async () => {
    await expect(
      controller.saveSoul("agent-12345678", {
        soul: " \n\t ",
        expectedRevision: 1
      })
    ).rejects.toThrow(BadRequestException);

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

  it("denies non-admin soul saves before the Agent service can write workspace files", () => {
    const agents = {
      saveSoul: jest.fn()
    };
    const guardedController = new AgentsController(agents as never);
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => guardedController.saveSoul,
      getClass: () => AgentsController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "user_1", username: "user", role: UserRole.USER }
        })
      })
    } as unknown as ExecutionContext;

    const allowed = guard.canActivate(context);
    if (allowed) {
      void guardedController.saveSoul("agent-12345678", {
        soul: "Attempted bypass",
        expectedRevision: 1
      });
    }

    expect(allowed).toBe(false);
    expect(agents.saveSoul).not.toHaveBeenCalled();
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
      modelProviderId: null,
      revision: 1,
      soulRevision: 1,
      initializationError: null,
      initializedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }
});
