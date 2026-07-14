import { PrismaClient, UserRole } from "@prisma/client";
import { execFileSync, spawn, ChildProcess } from "child_process";
import { hashSync } from "bcryptjs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { createServer } from "net";
import { tmpdir, userInfo } from "os";
import { dirname, join } from "path";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { AgentsService } from "../src/modules/agents/agents.service";
import { PostgresCommitCoordinator } from "../src/modules/agents/postgres-commit-coordinator";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("GFU-29 real application rollback artifact", () => {
  jest.setTimeout(180_000);
  const adminUrl = process.env.GFU29_POSTGRES_ADMIN_URL ?? `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres`;
  const fixtureScript = join(__dirname, "../scripts/gfu29-fixture.cjs");
  const artifactScript = join(__dirname, "../scripts/gfu29-rollback-artifact.cjs");
  let fixtureRoot: string;
  let artifactRoot: string;
  let repoRoot: string;
  let seed: any;
  let prisma: PrismaClient;
  let workspaces: AgentWorkspaceService;
  let primary: AgentsService;
  let rollbackProcess: ChildProcess | undefined;
  let artifact: any;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "gfu29-rollback-fixture-"));
    artifactRoot = await mkdtemp(join(tmpdir(), "gfu29-rollback-artifact-"));
    repoRoot = await mkdtemp(join(tmpdir(), "gfu29-rollback-repo-"));
    seed = fixture(["--action", "seed", "--worker-id", "rollback"]);
    prisma = new PrismaClient({ datasourceUrl: withSchema(adminUrl, seed.databaseNamespace) });
    workspaces = new AgentWorkspaceService(config(repoRoot));
    primary = new AgentsService(
      prisma as unknown as PrismaService,
      workspaces,
      {
        resolveProviderForAgent: jest.fn(async (providerId?: string) => ({ id: providerId ?? seed.resources.defaultProviderId, name: "Fixture" }))
      } as any,
      new PostgresCommitCoordinator(prisma as unknown as PrismaService)
    );
  });

  afterAll(async () => {
    await stopRollback();
    if (prisma) await prisma.$disconnect();
    if (seed) fixture(["--action", "teardown", "--test-run-id", seed.testRunId]);
    if (artifactRoot) runArtifact(["--action", "clean", "--output-root", artifactRoot]);
    await Promise.all([
      fixtureRoot && rm(fixtureRoot, { recursive: true, force: true }),
      artifactRoot && rm(artifactRoot, { recursive: true, force: true }),
      repoRoot && rm(repoRoot, { recursive: true, force: true })
    ]);
  });

  it("builds and runs base commit 6c64adb against the expanded schema, then returns to primary consistently", async () => {
    const createdByPrimary = await primary.create({
      name: "Primary Before Rollback",
      slug: "primary-before-rollback",
      modelProviderId: seed.resources.explicitProviderId
    });
    await primary.update(createdByPrimary.id, {
      name: "Primary Updated Before Rollback",
      modelProviderId: seed.resources.alternateProviderId,
      expectedRevision: createdByPrimary.revision
    });

    artifact = runArtifact(["--action", "build", "--ref", "6c64adb", "--output-root", artifactRoot]);
    expect(artifact).toMatchObject({
      status: "ready",
      sourceCommit: "6c64adb022ecad72d9e395f830ade39cf48ddc03",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const password = "rollback-password";
    await prisma.user.create({
      data: {
        id: "rollback-admin",
        username: "rollback-admin",
        passwordHash: hashSync(password, 4),
        role: UserRole.ADMIN
      }
    });
    const port = await freePort();
    rollbackProcess = spawn(process.execPath, [artifact.entrypoint], {
      cwd: dirname(artifact.entrypoint),
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        DATABASE_URL: withSchema(adminUrl, seed.databaseNamespace),
        JWT_SECRET: "rollback-artifact-jwt-secret",
        MODEL_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
        HOMELAB_REPO_ROOT: repoRoot
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForHttp(`http://127.0.0.1:${port}/health`);
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "rollback-admin", password })
    });
    expect(login.status).toBe(201);
    const token = (await login.json() as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    expect((await fetch(`http://127.0.0.1:${port}/agents/${createdByPrimary.id}`, { headers })).status).toBe(200);
    const oldUpdate = await fetch(`http://127.0.0.1:${port}/agents/${createdByPrimary.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Rollback Binary Updated", modelProvider: seed.resources.explicitProviderId })
    });
    expect(oldUpdate.status).toBe(200);
    const oldCreate = await fetch(`http://127.0.0.1:${port}/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Rollback Binary Created", slug: "rollback-binary-created", modelProvider: seed.resources.alternateProviderId })
    });
    expect(oldCreate.status).toBe(201);
    const rollbackCreated = (await oldCreate.json()) as { id: string };
    await stopRollback();

    const oldUpdatedRow = await prisma.agent.findUniqueOrThrow({ where: { id: createdByPrimary.id } });
    const oldCreatedRow = await prisma.agent.findUniqueOrThrow({ where: { id: rollbackCreated.id } });
    expect(oldUpdatedRow.modelProvider).toBe(seed.resources.explicitProviderId);
    expect(oldUpdatedRow.modelProviderId).toBe(seed.resources.explicitProviderId);
    expect(oldCreatedRow.modelProvider).toBe(seed.resources.alternateProviderId);
    expect(oldCreatedRow.modelProviderId).toBe(seed.resources.alternateProviderId);
    await expect(readFile(join(repoRoot, oldUpdatedRow.workspacePath, "agent.yaml"), "utf8")).resolves.toContain(
      `provider: "${seed.resources.explicitProviderId}"`
    );
    await expect(readFile(join(repoRoot, oldCreatedRow.workspacePath, "agent.yaml"), "utf8")).resolves.toContain(
      `provider: "${seed.resources.alternateProviderId}"`
    );

    await expect(primary.get(createdByPrimary.id)).resolves.toMatchObject({ modelProviderId: seed.resources.explicitProviderId });
    await expect(primary.get(rollbackCreated.id)).resolves.toMatchObject({ modelProviderId: seed.resources.alternateProviderId });
    const returnedToPrimary = await primary.update(createdByPrimary.id, {
      modelProviderId: seed.resources.alternateProviderId,
      expectedRevision: oldUpdatedRow.revision
    });
    expect(returnedToPrimary.modelProviderId).toBe(seed.resources.alternateProviderId);
    const finalRow = await prisma.agent.findUniqueOrThrow({ where: { id: createdByPrimary.id } });
    expect(finalRow.modelProvider).toBe(finalRow.modelProviderId);
    await expect(readFile(join(repoRoot, finalRow.workspacePath, "agent.yaml"), "utf8")).resolves.toContain(
      `provider: "${finalRow.modelProviderId}"`
    );
  });

  function fixture(args: string[]) {
    return JSON.parse(execFileSync(process.execPath, [fixtureScript, "--suite", "GFU-29", ...args], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test", GFU29_FIXTURE_ENABLED: "true", GFU29_FIXTURE_ROOT: fixtureRoot, GFU29_FIXTURE_DATABASE_URL: adminUrl }
    }));
  }

  function runArtifact(args: string[]) {
    return JSON.parse(execFileSync(process.execPath, [artifactScript, ...args], { encoding: "utf8" }));
  }

  async function stopRollback() {
    if (!rollbackProcess || rollbackProcess.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => rollbackProcess!.once("exit", () => resolve()));
    rollbackProcess.kill("SIGTERM");
    await exited;
    rollbackProcess = undefined;
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHttp(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error("rollback target did not start");
}

function config(repoRoot: string) {
  return { get: jest.fn((key: string, fallback?: unknown) => (key === "HOMELAB_REPO_ROOT" ? repoRoot : fallback)) } as any;
}

function withSchema(value: string, schema: string) {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  return url.toString();
}
