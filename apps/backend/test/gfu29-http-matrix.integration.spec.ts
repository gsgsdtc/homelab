import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { AgentStatus, PrismaClient, UserRole } from "@prisma/client";
import { execFileSync } from "child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "fs/promises";
import { createHash } from "crypto";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { AgentsService } from "../src/modules/agents/agents.service";
import { AgentWorkflowSnapshotService } from "../src/modules/agents/agent-workflow-snapshot.service";
import { RuntimeReloadClient } from "../src/modules/agents/runtime-reload-client.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { ModelProviderCredentialsService } from "../src/modules/model-providers/model-provider-credentials.service";
import { CONFIRMED_GFU29_ENDPOINTS } from "./gfu29-endpoint-contract";

describe("GFU-29 X6 HTTP authentication and ready matrix", () => {
  jest.setTimeout(120_000);
  const adminUrl =
    process.env.GFU29_POSTGRES_ADMIN_URL ??
    `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres`;
  const fixtureScript = join(__dirname, "../scripts/gfu29-fixture.cjs");
  const previousEnv = { ...process.env };
  let fixtureRoot: string;
  let repoRoot: string;
  let seed: any;
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let adminToken: string;
  let userToken: string;
  const readyAgentId = "http-ready-agent-12345678";

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "gfu29-http-repo-"));
    fixtureRoot = join(repoRoot, ".homelab/agents/test-fixtures");
    await mkdir(fixtureRoot, { recursive: true });
    seed = fixture(["--action", "seed", "--worker-id", "http"]);
    process.env.DATABASE_URL = withSchema(adminUrl, seed.databaseNamespace);
    process.env.JWT_SECRET = "gfu29-http-test-secret";
    process.env.JWT_EXPIRES_IN = "1h";
    process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
    process.env.HOMELAB_REPO_ROOT = repoRoot;
    process.env.NODE_ENV = "test";
    process.env.GFU29_FIXTURE_ENABLED = "true";
    process.env.GFU29_TEST_RUN_ID = seed.testRunId;
    process.env.GFU29_TEST_CLOCK_ID = seed.testClockId;
    process.env.GFU29_DATABASE_NAMESPACE = seed.databaseNamespace;

    const { AppModule } = await import("../src/app.module");
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    const providerCredentials = app.get(ModelProviderCredentialsService);
    await prisma.modelProvider.updateMany({ data: { encryptedApiKey: providerCredentials.encrypt("fixture-api-key") } });
    await prisma.user.createMany({
      data: [
        {
          id: "http-admin",
          username: "http-admin",
          passwordHash: "unused",
          role: UserRole.ADMIN,
        },
        {
          id: "http-user",
          username: "http-user",
          passwordHash: "unused",
          role: UserRole.USER,
        },
      ],
    });
    await prisma.agentSkillSource.create({
      data: { id: "http-source", sourceType: "registry", label: "HTTP Source", registryKey: "http", isTrusted: true }
    });
    await prisma.agentSkillCatalogSkill.create({
      data: { id: "http-catalog-skill", sourceId: "http-source", skillId: "http-skill", name: "HTTP Skill" }
    });
    await prisma.agentSkillCatalogVersion.create({
      data: { id: "http-catalog-version", catalogSkillId: "http-catalog-skill", version: "1.0.0", immutableRef: "sha256:http-skill-1" }
    });
    const jwt = app.get(JwtService);
    adminToken = jwt.sign(
      { sub: "http-admin", username: "http-admin", role: UserRole.ADMIN },
      { secret: process.env.JWT_SECRET },
    );
    userToken = jwt.sign(
      { sub: "http-user", username: "http-user", role: UserRole.USER },
      { secret: process.env.JWT_SECRET },
    );

    const workspace = app.get(AgentWorkspaceService);
    const descriptor = workspace.buildDescriptor(
      "http-ready-agent",
      readyAgentId,
    );
    const row = await prisma.agent.create({
      data: {
        id: readyAgentId,
        name: "HTTP Ready Agent",
        slug: "http-ready-agent",
        status: AgentStatus.ready,
        workspaceName: descriptor.workspaceName,
        workspacePath: descriptor.relativeWorkspacePath,
        modelProviderId: seed.resources.explicitProviderId,
        modelProvider: seed.resources.explicitProviderId,
        soul: "# HTTP Soul\n",
      },
    });
    await workspace.initializeWorkspace(row, { allowExistingWorkspace: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (seed)
      fixture(["--action", "teardown", "--test-run-id", seed.testRunId]);
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    process.env = previousEnv;
  });

  it("returns 401 without Bearer and 403 for USER on every generated endpoint", async () => {
    for (const endpoint of endpoints(seed.resources.readyAgentId)) {
      const anonymous = await request(endpoint);
      expect(anonymous.status).toBe(401);
      const user = await request(endpoint, userToken);
      expect(user.status).toBe(403);
    }
  });

  it("rejects non-ready collection POST without rows and creates revision 1 draft for ready ADMIN", async () => {
    const before = await prisma.agentWorkflow.count({
      where: { agentId: seed.resources.initializingAgentId },
    });
    const rejected = await fetch(
      `${baseUrl}/agents/${seed.resources.initializingAgentId}/workflows`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          workflowKey: "matrix-flow",
          source: workflowSource("matrix-flow"),
        }),
      },
    );
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "AGENT_NOT_READY",
    });
    await expect(
      prisma.agentWorkflow.count({
        where: { agentId: seed.resources.initializingAgentId },
      }),
    ).resolves.toBe(before);

    const created = await fetch(`${baseUrl}/agents/${readyAgentId}/workflows`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        workflowKey: "matrix-flow",
        source: workflowSource("matrix-flow"),
      }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      workflowKey: "matrix-flow",
      revision: 1,
      reloadStatus: "draft",
      activeHash: null,
    });
    await expect(
      prisma.agentWorkflow.count({
        where: { agentId: readyAgentId, workflowKey: "matrix-flow" },
      }),
    ).resolves.toBe(1);
  });

  it("drives real Soul run, Workflow claim, fake runtime and TEST-CLOCK paths through fixture control", async () => {
    const agents = app.get(AgentsService);
    const snapshots = app.get(AgentWorkflowSnapshotService);
    const reloadClient = app.get(RuntimeReloadClient);

    const heldSoul = agents.loadSoulForRun(seed.resources.readyAgentId);
    await waitForControl((adapter) => adapter.barriers["RUN-SOUL-V1-HELD"].acknowledged === true);
    const soulSaved = await fetch(`${baseUrl}/agents/${seed.resources.readyAgentId}/soul`, {
      method: "PUT",
      headers: authHeaders(adminToken),
      body: JSON.stringify({ content: "# Soul v2 from App\n", expectedRevision: 1 })
    });
    const soulSavedBody = await soulSaved.json();
    fixture([
      "--action",
      "barrier",
      "--test-run-id",
      seed.testRunId,
      "--barrier-id",
      "RUN-SOUL-V1-HELD",
      "--operation",
      "release"
    ]);
    await expect(heldSoul).resolves.toBe("# Soul v1\n");
    if (soulSaved.status !== 200) throw new Error(`Soul save returned ${soulSaved.status}: ${JSON.stringify(soulSavedBody)}`);
    await expect(agents.loadSoulForRun(seed.resources.readyAgentId)).resolves.toBe("# Soul v2 from App\n");

    const heldClaim = snapshots.getClaimSnapshot(seed.resources.readyAgentId, "fixture-flow");
    await waitForControl((adapter) => adapter.barriers["CLAIM-WF-V1-SUSPENDED"].acknowledged === true);
    const updated = await fetch(`${baseUrl}/agents/${seed.resources.readyAgentId}/workflows/fixture-flow`, {
      method: "PUT",
      headers: authHeaders(adminToken),
      body: JSON.stringify({ source: workflowSource("fixture-flow").replace("workflow.commit();", "workflow.commit(); // v2"), expectedRevision: 1 })
    });
    const updatedBody = await updated.json();
    if (updated.status !== 200) {
      fixture([
        "--action",
        "barrier",
        "--test-run-id",
        seed.testRunId,
        "--barrier-id",
        "CLAIM-WF-V1-SUSPENDED",
        "--operation",
        "release"
      ]);
      await heldClaim;
      throw new Error(`Workflow update returned ${updated.status}: ${JSON.stringify(updatedBody)}`);
    }
    const draft = updatedBody as { draftHash: string };
    const reloaded = await fetch(`${baseUrl}/agents/${seed.resources.readyAgentId}/workflows/fixture-flow/reload`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({ expectedDraftHash: draft.draftHash })
    });
    expect(reloaded.status).toBe(201);
    fixture([
      "--action",
      "barrier",
      "--test-run-id",
      seed.testRunId,
      "--barrier-id",
      "CLAIM-WF-V1-SUSPENDED",
      "--operation",
      "release"
    ]);
    const oldClaim = await heldClaim;
    const newClaim = await snapshots.getClaimSnapshot(seed.resources.readyAgentId, "fixture-flow");
    expect(oldClaim.workflowHash).not.toBe(newClaim.workflowHash);
    expect(newClaim.workflowHash).toBe(draft.draftHash);

    const runtimeWait = reloadClient.reloadSkills(
      await prisma.agent.findUniqueOrThrow({ where: { id: seed.resources.readyAgentId } }),
      "cfg-v2"
    );
    await waitForControl((adapter) => adapter.clockWaiters?.[seed.testClockId]?.acknowledged === true);
    fixture(["--action", "advance-clock", "--test-run-id", seed.testRunId, "--milliseconds", "1000"]);
    await expect(runtimeWait).resolves.toEqual({ reloadStatus: "pending_restart", effectiveFor: "next_task" });
  });

  it.each(["initializingAgentId", "failedAgentId"] as const)(
    "returns 409 with zero side effects for every F5/F6/F7 write on %s",
    async (resourceKey) => {
      const agentId = seed.resources[resourceKey];
      await prisma.agentWorkflow.upsert({
        where: { agentId_workflowKey: { agentId, workflowKey: "flow" } },
        create: {
          agentId,
          workflowKey: "flow",
          relativePath: `.homelab/agents/${agentId}/src/mastra/workflows/flow.ts`,
          draftHash: "non-ready-draft",
          revision: "non-ready-draft",
          editRevision: 1,
          reloadStatus: "draft"
        },
        update: {}
      });
      const before = await sideEffectSnapshot(agentId);
      const writes = CONFIRMED_GFU29_ENDPOINTS.filter(({ ready }) => ready);
      for (const { method, route, path: buildPath } of writes) {
        const path = buildPath(agentId);
        const body = readyWriteBody(route);
        const response = await fetch(`${baseUrl}${path}`, { method, headers: authHeaders(adminToken), body: JSON.stringify(body) });
        const responseBody = await response.json();
        if (response.status !== 409) throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(responseBody)}`);
        expect({ method, path, status: response.status, responseBody }).toMatchObject({
          status: 409,
          responseBody: { code: "AGENT_NOT_READY" }
        });
      }
      await expect(sideEffectSnapshot(agentId)).resolves.toEqual(before);

      const validate = await fetch(`${baseUrl}/agents/${agentId}/workflows/flow/validate`, {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify({ source: workflowSource("flow") })
      });
      expect(validate.status).toBe(201);
      await expect(validate.json()).resolves.toMatchObject({ workflowKey: "flow", valid: true });
      await expect(sideEffectSnapshot(agentId)).resolves.toEqual(before);
    }
  );

  it("returns ownership-safe 404 for every nested endpoint and leaves both Agents unchanged", async () => {
    const change = await prisma.agentSkillChange.create({
      data: {
        id: "foreign-skill-change",
        actorType: "admin",
        actorId: "http-admin",
        targetAgentId: seed.resources.readyAgentId,
        operation: "install",
        skillName: "http-skill",
        sourceType: "registry"
      }
    });
    const before = {
      owner: await sideEffectSnapshot(seed.resources.readyAgentId),
      other: await sideEffectSnapshot(readyAgentId)
    };
    const ownedRequests = [
      ["GET", `/agents/${readyAgentId}/skills/changes/${change.id}`, undefined],
      ["GET", `/agents/${readyAgentId}/workflows/fixture-flow`, undefined],
      ["PUT", `/agents/${readyAgentId}/workflows/fixture-flow`, { source: workflowSource("fixture-flow"), expectedRevision: 1 }],
      ["POST", `/agents/${readyAgentId}/workflows/fixture-flow/validate`, { source: workflowSource("fixture-flow") }],
      ["POST", `/agents/${readyAgentId}/workflows/fixture-flow/reload`, {}],
      ["POST", `/agents/${readyAgentId}/workflows/fixture-flow/save-and-reload`, { source: workflowSource("fixture-flow"), expectedRevision: 1 }],
      ["GET", `/agents/${readyAgentId}/workflows/fixture-flow/versions`, undefined],
      ["POST", `/agents/${readyAgentId}/workflows/fixture-flow/rollback`, { versionId: `workflow-version-${seed.testRunId}` }],
      ["GET", "/skill-catalog/sources/missing-source/skills/http-skill/versions", undefined],
      ["GET", "/agents/missing-agent/workflow-capabilities", undefined]
    ] as Array<[string, string, Record<string, unknown> | undefined]>;
    for (const [method, path, body] of ownedRequests) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: authHeaders(adminToken),
        body: body ? JSON.stringify(body) : undefined
      });
      if (response.status !== 404) throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
    }
    await expect(
      Promise.all([sideEffectSnapshot(seed.resources.readyAgentId), sideEffectSnapshot(readyAgentId)])
    ).resolves.toEqual([before.owner, before.other]);
  });

  it("executes a ready ADMIN success case for every endpoint in the generated inventory", async () => {
    const covered = new Set<string>();
    const call = async (route: string, path: string, options: RequestInit = {}) => {
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...authHeaders(adminToken), ...(options.headers ?? {}) } });
      if (response.status < 200 || response.status >= 300) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
      covered.add(route);
      return response;
    };

    await call("GET /agents", "/agents");
    await call("GET /model-providers", "/model-providers");
    await call("POST /agents", "/agents", {
      method: "POST",
      headers: { "idempotency-key": "http-ready-matrix-create" },
      body: JSON.stringify({ name: "Matrix Created Agent", slug: "matrix-created-agent", modelProviderId: seed.resources.explicitProviderId })
    });
    await call("GET /agents/:id", `/agents/${readyAgentId}`);
    const currentAgent = await prisma.agent.findUniqueOrThrow({ where: { id: readyAgentId } });
    await call("PATCH /agents/:id", `/agents/${readyAgentId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "HTTP Ready Updated", expectedRevision: currentAgent.revision })
    });
    await call("GET /agents/:id/soul", `/agents/${readyAgentId}/soul`);
    const currentSoul = await prisma.agent.findUniqueOrThrow({ where: { id: readyAgentId } });
    await call("PUT /agents/:id/soul", `/agents/${readyAgentId}/soul`, {
      method: "PUT",
      body: JSON.stringify({ content: "# Ready matrix Soul\n", expectedRevision: currentSoul.soulRevision })
    });
    await call("POST /agents/:id/retry-initialization", `/agents/${seed.resources.x1AgentId}/retry-initialization`, { method: "POST", body: "{}" });

    await call("GET /skill-catalog/sources", "/skill-catalog/sources");
    await call("GET /skill-catalog/sources/:sourceId/skills", "/skill-catalog/sources/http-source/skills");
    await call(
      "GET /skill-catalog/sources/:sourceId/skills/:skillId/versions",
      "/skill-catalog/sources/http-source/skills/http-skill/versions"
    );
    await call("GET /agents/:id/skills", `/agents/${readyAgentId}/skills`);
    await call("GET /agents/:id/skills/changes/:changeId", `/agents/${seed.resources.readyAgentId}/skills/changes/foreign-skill-change`);
    await callWithClock(
      "POST /agents/:id/skills/install",
      `/agents/${readyAgentId}/skills/install`,
      skillBody("1.0.0"),
      covered
    );
    await callWithClock(
      "POST /agents/:id/skills/update",
      `/agents/${readyAgentId}/skills/update`,
      skillBody("1.1.0"),
      covered
    );
    await callWithClock(
      "POST /agents/:id/skills/remove",
      `/agents/${readyAgentId}/skills/remove`,
      { skillName: "http-skill" },
      covered
    );

    await call("GET /agents/:agentId/workflows", `/agents/${readyAgentId}/workflows`);
    await call("POST /agents/:agentId/workflows", `/agents/${readyAgentId}/workflows`, {
      method: "POST",
      body: JSON.stringify({ workflowKey: "ready-flow", source: workflowSource("ready-flow") })
    });
    await call("GET /agents/:agentId/workflows/:workflowKey", `/agents/${readyAgentId}/workflows/matrix-flow`);
    const updated = await call("PUT /agents/:agentId/workflows/:workflowKey", `/agents/${readyAgentId}/workflows/matrix-flow`, {
      method: "PUT",
      body: JSON.stringify({ source: workflowSource("matrix-flow").replace("workflow.commit();", "workflow.commit(); // ready-v2"), expectedRevision: 1 })
    });
    const updatedWorkflow = (await updated.json()) as { draftHash: string; revision: number };
    await call("POST /agents/:agentId/workflows/:workflowKey/validate", `/agents/${readyAgentId}/workflows/matrix-flow/validate`, {
      method: "POST",
      body: JSON.stringify({ source: workflowSource("matrix-flow") })
    });
    await call("POST /agents/:agentId/workflows/:workflowKey/reload", `/agents/${readyAgentId}/workflows/matrix-flow/reload`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftHash: updatedWorkflow.draftHash })
    });
    await call("POST /agents/:agentId/workflows/:workflowKey/save-and-reload", `/agents/${readyAgentId}/workflows/matrix-flow/save-and-reload`, {
      method: "POST",
      body: JSON.stringify({
        source: workflowSource("matrix-flow").replace("workflow.commit();", "workflow.commit(); // ready-v3"),
        expectedRevision: updatedWorkflow.revision
      })
    });
    const versions = await call("GET /agents/:agentId/workflows/:workflowKey/versions", `/agents/${readyAgentId}/workflows/matrix-flow/versions`);
    const [version] = (await versions.json()) as Array<{ id: string }>;
    await call("POST /agents/:agentId/workflows/:workflowKey/rollback", `/agents/${readyAgentId}/workflows/matrix-flow/rollback`, {
      method: "POST",
      body: JSON.stringify({ versionId: version.id })
    });
    await call("GET /agents/:agentId/workflow-capabilities", `/agents/${readyAgentId}/workflow-capabilities`);

    expect([...covered].sort()).toEqual(CONFIRMED_GFU29_ENDPOINTS.map(({ route }) => route).sort());
  });

  async function request(
    endpoint: { method: string; path: string },
    token?: string,
  ) {
    return fetch(`${baseUrl}${endpoint.path}`, {
      method: endpoint.method,
      headers: token
        ? authHeaders(token)
        : { "content-type": "application/json" },
      body: endpoint.method === "GET" ? undefined : JSON.stringify({}),
    });
  }

  async function sideEffectSnapshot(agentId: string) {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    return {
      agent: {
        status: agent.status,
        revision: agent.revision,
        soulRevision: agent.soulRevision,
        soul: agent.soul
      },
      skillChanges: await prisma.agentSkillChange.count({ where: { targetAgentId: agentId } }),
      skillInstallations: await prisma.agentSkillInstallation.count({ where: { agentId } }),
      workflows: await prisma.agentWorkflow.count({ where: { agentId } }),
      workflowVersions: await prisma.agentWorkflowVersion.count({ where: { workflow: { agentId } } }),
      workspaceDigest: await directoryDigest(join(repoRoot, agent.workspacePath))
    };
  }

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

  async function waitForControl(predicate: (adapter: any) => boolean) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const observed = fixture(["--action", "observe", "--test-run-id", seed.testRunId]);
      if (predicate(observed.adapter)) return observed;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("fixture control acknowledgement timed out");
  }

  async function callWithClock(route: string, path: string, body: Record<string, unknown>, covered: Set<string>) {
    const request = fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify(body)
    });
    const observed = await waitForControl((adapter) => adapter.clockWaiters?.[seed.testClockId]?.targetMillis > adapter.clockMillis);
    const target = observed.adapter.clockWaiters[seed.testClockId].targetMillis;
    fixture(["--action", "advance-clock", "--test-run-id", seed.testRunId, "--milliseconds", String(target - observed.clockMillis)]);
    const response = await request;
    if (response.status < 200 || response.status >= 300) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
    covered.add(route);
  }
});

function endpoints(agentId: string) {
  return CONFIRMED_GFU29_ENDPOINTS.map(({ method, path }) => ({ method, path: path(agentId) }));
}

function readyWriteBody(route: string): Record<string, unknown> {
  if (route === "PUT /agents/:id/soul") return { content: "# forbidden\n", expectedRevision: 1 };
  if (route.endsWith("/skills/install")) return skillBody("1.0.0");
  if (route.endsWith("/skills/update")) return skillBody("1.1.0");
  if (route.endsWith("/skills/remove")) return { skillName: "http-skill" };
  if (route === "POST /agents/:agentId/workflows") return { workflowKey: "forbidden-flow", source: workflowSource("forbidden-flow") };
  if (route === "PUT /agents/:agentId/workflows/:workflowKey") return { source: workflowSource("flow"), expectedRevision: 1 };
  if (route.endsWith("/save-and-reload")) return { source: workflowSource("flow"), expectedRevision: 1 };
  if (route.endsWith("/rollback")) return { versionId: "missing-version" };
  return {};
}

function authHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function workflowSource(key: string) {
  return [
    'import { createWorkflow } from "@mastra/core/workflows";',
    `const workflow = createWorkflow({ id: "${key}" });`,
    "workflow.commit();",
    "export default workflow;",
    "",
  ].join("\n");
}

function skillBody(version: string) {
  return { skillName: "http-skill", sourceId: "http-source", sourceType: "registry", version };
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      hash.update(relative);
      if (entry.isDirectory()) await visit(join(path, entry.name), relative);
      else hash.update(await readFile(join(path, entry.name)));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function withSchema(value: string, schema: string) {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  return url.toString();
}
