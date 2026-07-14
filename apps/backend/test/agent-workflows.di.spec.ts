import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AgentsModule } from "../src/modules/agents/agents.module";
import { AgentWorkflowsService } from "../src/modules/agents/agent-workflows.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("AgentWorkflows DI reload wiring", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  let repoRoot: string;

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

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    repoRoot = await mkdtemp(join(tmpdir(), "homelab-workflow-di-"));
    prisma.agent.findUnique.mockResolvedValue(agent());
    prisma.agentWorkflow.update.mockImplementation(async ({ data }: any) => ({
      ...workflow({ activeHash: "active-v1" }),
      ...data
    }));
    prisma.agentWorkflow.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentWorkflowVersion.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("uses the app-registered in-process reload hook without HOMELAB_WORKFLOW_RUNTIME_URL and promotes only after success", async () => {
    const source = validSource("support-triage");
    const draftHash = hashOf(source);
    const item = workflow({ draftHash, activeHash: "active-v1" });
    await writeWorkflowSource(source);
    prisma.agentWorkflow.findFirst.mockResolvedValueOnce(item).mockResolvedValueOnce({
      ...item,
      activeHash: draftHash,
      reloadStatus: "succeeded",
      reloadError: null,
      loadedAt: now
    });
    prisma.agentWorkflowVersion.create.mockResolvedValue({
      id: "version-2",
      workflowId: item.id,
      sourceHash: draftHash,
      source
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              HOMELAB_REPO_ROOT: repoRoot,
              HOMELAB_WORKFLOW_RUNTIME_URL: undefined,
              HOMELAB_WORKFLOW_RELOAD_TIMEOUT_MS: 30_000
            })
          ]
        }),
        AgentsModule
      ]
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    const service = moduleRef.get(AgentWorkflowsService);

    const result = await service.reload("agent-1", "support-triage", { expectedDraftHash: draftHash });

    expect(prisma.agentWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: item.id, draftHash, relativePath: item.relativePath },
      data: expect.objectContaining({
        activeHash: draftHash,
        reloadStatus: "succeeded"
      })
    });
    expect(prisma.agentWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: item.id,
        sourceHash: draftHash,
        source
      })
    });
    expect(result.activeHash).toBe(draftHash);
    expect(result.reloadStatus).toBe("succeeded");
  });

  async function writeWorkflowSource(source: string) {
    const sourceRoot = join(repoRoot, ".homelab", "agents", "ops-agent--agent123", "src", "mastra", "workflows");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "support-triage.ts"), source, "utf8");
  }

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

function validSource(workflowKey: string) {
  return [
    'import { createWorkflow } from "@mastra/core/workflows";',
    `const workflow = createWorkflow({ id: "${workflowKey}" });`,
    "workflow.commit();",
    "export default workflow;",
    ""
  ].join("\n");
}

function hashOf(source: string) {
  return require("crypto").createHash("sha256").update(source, "utf8").digest("hex");
}
