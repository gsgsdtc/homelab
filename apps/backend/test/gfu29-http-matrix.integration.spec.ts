import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { AgentStatus, PrismaClient, UserRole } from "@prisma/client";
import { execFileSync } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

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
    fixtureRoot = await mkdtemp(join(tmpdir(), "gfu29-http-fixture-"));
    repoRoot = await mkdtemp(join(tmpdir(), "gfu29-http-repo-"));
    seed = fixture(["--action", "seed", "--worker-id", "http"]);
    process.env.DATABASE_URL = withSchema(adminUrl, seed.databaseNamespace);
    process.env.JWT_SECRET = "gfu29-http-test-secret";
    process.env.JWT_EXPIRES_IN = "1h";
    process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
    process.env.HOMELAB_REPO_ROOT = repoRoot;

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

function endpoints(agentId: string) {
  return [
    ["GET", "/agents"],
    ["POST", "/agents"],
    ["GET", `/agents/${agentId}`],
    ["PATCH", `/agents/${agentId}`],
    ["GET", `/agents/${agentId}/soul`],
    ["PUT", `/agents/${agentId}/soul`],
    ["POST", `/agents/${agentId}/retry-initialization`],
    ["GET", "/skill-catalog/sources"],
    ["GET", "/skill-catalog/sources/source/skills"],
    ["GET", "/skill-catalog/sources/source/skills/skill/versions"],
    ["GET", `/agents/${agentId}/skills`],
    ["GET", `/agents/${agentId}/skills/changes/change`],
    ["POST", `/agents/${agentId}/skills/install`],
    ["POST", `/agents/${agentId}/skills/update`],
    ["POST", `/agents/${agentId}/skills/remove`],
    ["GET", `/agents/${agentId}/workflows`],
    ["POST", `/agents/${agentId}/workflows`],
    ["GET", `/agents/${agentId}/workflows/flow`],
    ["PUT", `/agents/${agentId}/workflows/flow`],
    ["POST", `/agents/${agentId}/workflows/flow/validate`],
    ["POST", `/agents/${agentId}/workflows/flow/reload`],
    ["POST", `/agents/${agentId}/workflows/flow/save-and-reload`],
    ["GET", `/agents/${agentId}/workflows/flow/versions`],
    ["POST", `/agents/${agentId}/workflows/flow/rollback`],
    ["GET", `/agents/${agentId}/workflow-capabilities`],
  ].map(([method, path]) => ({ method, path }));
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

function withSchema(value: string, schema: string) {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  return url.toString();
}
