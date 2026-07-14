import { AgentStatus, PrismaClient } from "@prisma/client";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { AgentWorkflowRuntimeClient } from "../src/modules/agents/agent-workflow-runtime.client";
import { AgentWorkflowSnapshotService } from "../src/modules/agents/agent-workflow-snapshot.service";
import { AgentWorkflowValidator } from "../src/modules/agents/agent-workflow-validator.service";
import { AgentWorkflowsService } from "../src/modules/agents/agent-workflows.service";
import { AgentSkillsService } from "../src/modules/agents/agent-skills.service";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { AgentsService } from "../src/modules/agents/agents.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("GFU-29 file and PostgreSQL revision integration", () => {
  jest.setTimeout(120_000);
  const adminUrl =
    process.env.GFU29_POSTGRES_ADMIN_URL ??
    `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres`;
  const fixtureScript = join(__dirname, "../scripts/gfu29-fixture.cjs");
  let fixtureRoot: string;
  let repoRoot: string;
  let seed: any;
  let prisma: PrismaClient;
  let workspaces: AgentWorkspaceService;
  let agents: AgentsService;
  let workflows: AgentWorkflowsService;
  const agentId = "concurrency-agent-12345678";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "gfu29-concurrency-fixture-"));
    repoRoot = await mkdtemp(join(tmpdir(), "gfu29-concurrency-repo-"));
    seed = fixture(["--action", "seed", "--worker-id", "concurrency"]);
    prisma = new PrismaClient({
      datasourceUrl: withSchema(adminUrl, seed.databaseNamespace),
    });
    workspaces = new AgentWorkspaceService(config(repoRoot));
    agents = new AgentsService(prisma as unknown as PrismaService, workspaces, {
      resolveProviderForAgent: jest.fn(async (providerId?: string) => ({
        id: providerId ?? seed.resources.defaultProviderId,
        name: "Fixture",
      })),
    } as any);
    const validator = new AgentWorkflowValidator(config(repoRoot));
    workflows = new AgentWorkflowsService(
      prisma as unknown as PrismaService,
      workspaces,
      validator,
      { reloadWorkflow: jest.fn() } as unknown as AgentWorkflowRuntimeClient,
    );

    const descriptor = workspaces.buildDescriptor("concurrency-agent", agentId);
    const row = await prisma.agent.create({
      data: {
        id: agentId,
        name: "Concurrency Agent",
        slug: "concurrency-agent",
        status: AgentStatus.ready,
        workspaceName: descriptor.workspaceName,
        workspacePath: descriptor.relativeWorkspacePath,
        modelProviderId: seed.resources.explicitProviderId,
        modelProvider: seed.resources.explicitProviderId,
        soul: "# Soul v1\n",
      },
    });
    await workspaces.initializeWorkspace(row, {
      allowExistingWorkspace: false,
    });
    await workflows.create(agentId, {
      workflowKey: "concurrent-flow",
      source: workflowSource("v1"),
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fixture(["--action", "teardown", "--test-run-id", seed.testRunId]);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("allows exactly one same-revision Agent PATCH and keeps DB plus agent.yaml aligned", async () => {
    const results = await Promise.allSettled([
      agents.update(agentId, { name: "Winner A", expectedRevision: 1 }),
      agents.update(agentId, { name: "Winner B", expectedRevision: 1 }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );

    const row = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
    });
    const yaml = await readFile(
      join(repoRoot, row.workspacePath, "agent.yaml"),
      "utf8",
    );
    expect(row.revision).toBe(2);
    expect(yaml).toContain(`name: "${row.name}"`);
    expect(yaml).toContain(`provider: "${row.modelProviderId}"`);
    expect(row.modelProvider).toBe(row.modelProviderId);
  });

  it("replays the X1 failed workspace fixture with one accepted concurrent retry and no sentinel overwrite", async () => {
    const x1Id = "x1-concurrency-agent-87654321";
    const descriptor = workspaces.buildDescriptor("x1-concurrency-agent", x1Id);
    await mkdir(descriptor.workspacePath, { recursive: true });
    const sentinelPath = join(descriptor.workspacePath, "USER-SENTINEL");
    await writeFile(sentinelPath, "do-not-overwrite\n", "utf8");
    const sentinelBefore = sha(await readFile(sentinelPath, "utf8"));
    await prisma.agent.create({
      data: {
        id: x1Id,
        name: "X1 Agent",
        slug: "x1-concurrency-agent",
        status: AgentStatus.init_failed,
        workspaceName: descriptor.workspaceName,
        workspacePath: descriptor.relativeWorkspacePath,
        modelProviderId: seed.resources.explicitProviderId,
        modelProvider: seed.resources.explicitProviderId,
        soul: "# X1 Soul\n",
        initializationError: "missing generated files",
      },
    });

    const results = await Promise.allSettled([
      agents.retryInitialization(x1Id),
      agents.retryInitialization(x1Id),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    await expect(
      prisma.agent.findUniqueOrThrow({ where: { id: x1Id } }),
    ).resolves.toMatchObject({
      id: x1Id,
      status: AgentStatus.ready,
      workspacePath: descriptor.relativeWorkspacePath,
    });
    expect(sha(await readFile(sentinelPath, "utf8"))).toBe(sentinelBefore);
    expect(await readdir(descriptor.workspacePath)).toEqual(
      expect.arrayContaining([
        "USER-SENTINEL",
        "agent.yaml",
        "soul.md",
        "skills",
        "workflows",
      ]),
    );
  });

  it("runs the expand-compatible legacy-read rollback target through create and update", async () => {
    const legacyReadAgents = new (AgentsService as any)(
      prisma as unknown as PrismaService,
      workspaces,
      {
        resolveProviderForAgent: jest.fn(async (providerId?: string) => ({
          id: providerId ?? seed.resources.defaultProviderId,
          name: "Fixture",
        })),
      },
      {
        get: jest.fn((key: string) =>
          key === "AGENT_PROVIDER_READ_MODE" ? "legacy" : undefined,
        ),
      },
    ) as AgentsService;

    const updated = await legacyReadAgents.update(agentId, {
      modelProviderId: seed.resources.alternateProviderId,
      expectedRevision: 2,
    });
    const updatedRow = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
    });
    const updatedYaml = await readFile(
      join(repoRoot, updatedRow.workspacePath, "agent.yaml"),
      "utf8",
    );
    expect(updated.modelProviderId).toBe(seed.resources.alternateProviderId);
    expect(updatedRow.modelProvider).toBe(seed.resources.alternateProviderId);
    expect(updatedRow.modelProviderId).toBe(seed.resources.alternateProviderId);
    expect(updatedYaml).toContain(
      `provider: "${seed.resources.alternateProviderId}"`,
    );

    await prisma.agent.update({
      where: { id: agentId },
      data: { modelProvider: seed.resources.explicitProviderId },
    });
    await writeFile(
      join(repoRoot, updatedRow.workspacePath, "agent.yaml"),
      updatedYaml.replace(
        seed.resources.alternateProviderId,
        seed.resources.explicitProviderId,
      ),
      "utf8",
    );
    await expect(legacyReadAgents.get(agentId)).resolves.toMatchObject({
      modelProviderId: seed.resources.explicitProviderId,
      providerSummary: {
        id: seed.resources.explicitProviderId,
        source: "explicit",
      },
    });
    await legacyReadAgents.update(agentId, {
      name: "Legacy Updated",
      expectedRevision: 3,
    });
    const converged = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
    });
    expect(converged.modelProvider).toBe(seed.resources.explicitProviderId);
    expect(converged.modelProviderId).toBe(seed.resources.explicitProviderId);

    const created = await legacyReadAgents.create({
      name: "Rollback Created",
      modelProviderId: seed.resources.explicitProviderId,
    });
    const createdRow = await prisma.agent.findUniqueOrThrow({
      where: { id: created.id },
    });
    const createdYaml = await readFile(
      join(repoRoot, createdRow.workspacePath, "agent.yaml"),
      "utf8",
    );
    expect(createdRow.modelProvider).toBe(seed.resources.explicitProviderId);
    expect(createdRow.modelProviderId).toBe(seed.resources.explicitProviderId);
    expect(createdYaml).toContain(
      `provider: "${seed.resources.explicitProviderId}"`,
    );
  });

  it("keeps T4 Soul, Skills and Workflow baselines unchanged for both non-ready states", async () => {
    const skills = new AgentSkillsService(
      prisma as unknown as PrismaService,
      workspaces,
      { validate: jest.fn() } as any,
      { reloadSkills: jest.fn() } as any,
    );
    const ids = [
      seed.resources.initializingAgentId,
      seed.resources.failedAgentId,
    ];
    const before = await Promise.all(
      ids.map(async (id) => ({
        agent: await prisma.agent.findUniqueOrThrow({
          where: { id },
          select: { soul: true, soulRevision: true },
        }),
        changes: await prisma.agentSkillChange.count({
          where: { targetAgentId: id },
        }),
        installs: await prisma.agentSkillInstallation.count({
          where: { agentId: id },
        }),
        workflows: await prisma.agentWorkflow.count({ where: { agentId: id } }),
      })),
    );

    for (const [index, id] of ids.entries()) {
      await expect(
        agents.saveSoul(id, { content: "# forbidden\n", expectedRevision: 1 }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "AGENT_NOT_READY" }),
      });
      await expect(
        skills.installAdmin(
          id,
          {
            skillName: "fixture-skill",
            sourceId: "missing",
            sourceType: "registry",
            version: "1.0.0",
          },
          "admin",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "AGENT_NOT_READY" }),
      });
      await expect(
        workflows.create(id, {
          workflowKey: `forbidden-${index}`,
          source: workflowSource("forbidden"),
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "AGENT_NOT_READY" }),
      });
    }

    await expect(
      Promise.all(
        ids.map(async (id) => ({
          agent: await prisma.agent.findUniqueOrThrow({
            where: { id },
            select: { soul: true, soulRevision: true },
          }),
          changes: await prisma.agentSkillChange.count({
            where: { targetAgentId: id },
          }),
          installs: await prisma.agentSkillInstallation.count({
            where: { agentId: id },
          }),
          workflows: await prisma.agentWorkflow.count({
            where: { agentId: id },
          }),
        })),
      ),
    ).resolves.toEqual(before);
  });

  it("allows exactly one same-revision Soul save and keeps file hash equal to DB", async () => {
    const results = await Promise.allSettled([
      agents.saveSoul(agentId, { content: "# Soul A\n", expectedRevision: 1 }),
      agents.saveSoul(agentId, { content: "# Soul B\n", expectedRevision: 1 }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );

    const row = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
    });
    const file = await readFile(
      join(repoRoot, row.workspacePath, "soul.md"),
      "utf8",
    );
    expect(row.soulRevision).toBe(2);
    expect(sha(file)).toBe(sha(row.soul));
  });

  it("keeps an X3 held run on Soul v1 while a new run reads Soul v2", async () => {
    const heldRunSoul = await agents.loadSoulForRun(agentId);
    await agents.saveSoul(agentId, {
      content: "# Soul after barrier\n",
      expectedRevision: 2,
    });
    const newRunSoul = await agents.loadSoulForRun(agentId);

    expect(sha(heldRunSoul)).not.toBe(sha(newRunSoul));
    expect(heldRunSoul).toMatch(/^# Soul [AB]/);
    expect(newRunSoul).toBe("# Soul after barrier\n");
  });

  it("allows exactly one same-revision Workflow save and enforces validate ownership", async () => {
    const results = await Promise.allSettled([
      workflows.update(agentId, "concurrent-flow", {
        source: workflowSource("v2-a"),
        expectedRevision: 1,
      }),
      workflows.update(agentId, "concurrent-flow", {
        source: workflowSource("v2-b"),
        expectedRevision: 1,
      }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );

    const row = await prisma.agentWorkflow.findUniqueOrThrow({
      where: {
        agentId_workflowKey: { agentId, workflowKey: "concurrent-flow" },
      },
    });
    const agent = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
    });
    const file = await workspaces.readWorkflowSource(
      agent,
      "concurrent-flow",
      "ts",
    );
    expect(row.editRevision).toBe(2);
    expect(sha(file)).toBe(row.draftHash);
    await expect(
      workflows.validate(seed.resources.readyAgentId, "concurrent-flow", {
        source: workflowSource("probe"),
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "SUBRESOURCE_NOT_FOUND" }),
    });
  });

  it("keeps an X4 suspended claim on its captured workflow hash after reload", async () => {
    const runtime = {
      reloadWorkflow: jest.fn(async () => ({
        status: "succeeded",
        loadedAt: new Date(),
      })),
    };
    const service = new AgentWorkflowsService(
      prisma as unknown as PrismaService,
      workspaces,
      new AgentWorkflowValidator(config(repoRoot)),
      runtime as unknown as AgentWorkflowRuntimeClient,
    );
    const snapshots = new AgentWorkflowSnapshotService(
      prisma as unknown as PrismaService,
    );
    const initial = await prisma.agentWorkflow.findUniqueOrThrow({
      where: {
        agentId_workflowKey: { agentId, workflowKey: "concurrent-flow" },
      },
    });
    await service.reload(agentId, "concurrent-flow", {
      expectedDraftHash: initial.draftHash ?? undefined,
    });
    const suspendedClaim = await snapshots.getClaimSnapshot(
      agentId,
      "concurrent-flow",
    );

    const draft = await service.update(agentId, "concurrent-flow", {
      source: workflowSource("v3"),
      expectedRevision: initial.editRevision,
    });
    await service.reload(agentId, "concurrent-flow", {
      expectedDraftHash: draft.draftHash ?? undefined,
    });
    const newClaim = await snapshots.getClaimSnapshot(
      agentId,
      "concurrent-flow",
    );

    expect(suspendedClaim.workflowHash).toBe(initial.draftHash);
    expect(newClaim.workflowHash).toBe(draft.draftHash);
    expect(newClaim.workflowHash).not.toBe(suspendedClaim.workflowHash);
  });

  function fixture(args: string[]) {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [fixtureScript, "--suite", "GFU-29", ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "test",
            GFU29_FIXTURE_ENABLED: "true",
            GFU29_FIXTURE_ROOT: fixtureRoot,
            GFU29_FIXTURE_DATABASE_URL: adminUrl,
          },
        },
      ),
    );
  }
});

function workflowSource(marker: string) {
  return [
    'import { createWorkflow } from "@mastra/core/workflows";',
    'const workflow = createWorkflow({ id: "concurrent-flow" });',
    `workflow.commit(); // ${marker}`,
    "export default workflow;",
    "",
  ].join("\n");
}

function config(repoRoot: string) {
  return {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === "HOMELAB_REPO_ROOT") return repoRoot;
      if (
        key === "HOMELAB_WORKFLOW_ALLOWED_TOOL_IMPORTS" ||
        key === "HOMELAB_WORKFLOW_ALLOWED_ENV"
      )
        return [];
      return fallback;
    }),
  } as any;
}

function withSchema(value: string, schema: string) {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function sha(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
