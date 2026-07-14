import { INestApplication, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { AgentStatus, UserRole } from "@prisma/client";
import { execFileSync } from "child_process";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("GFU-29 T6 real Skills state machine", () => {
  jest.setTimeout(180_000);
  const adminUrl = process.env.GFU29_POSTGRES_ADMIN_URL ?? `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres`;
  const fixtureScript = join(__dirname, "../scripts/gfu29-fixture.cjs");
  const previousEnv = { ...process.env };
  let fixtureRoot: string;
  let repoRoot: string;
  let seed: any;
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let token: string;

  const cases = [
    { scenario: "runtime_offline", operation: "update", changeStatus: "succeeded", reloadStatus: "runtime_offline", rollbackResult: "not_required", auditStatus: "audit_written", sequenceIndex: 4, allowNext: true },
    { scenario: "pending_restart", operation: "update", changeStatus: "succeeded", reloadStatus: "pending_restart", rollbackResult: "not_required", auditStatus: "audit_written", sequenceIndex: 4, allowNext: true },
    { scenario: "rollback_ok", operation: "remove", changeStatus: "rolled_back", reloadStatus: "failed", rollbackResult: "succeeded", auditStatus: "audit_written", sequenceIndex: 6, allowNext: true },
    { scenario: "rollback_failed", operation: "update", changeStatus: "rollback_failed", reloadStatus: "failed", rollbackResult: "failed", auditStatus: "audit_written", sequenceIndex: 7, allowNext: false },
    { scenario: "audit_failed", operation: "update", changeStatus: "succeeded", reloadStatus: "loaded", rollbackResult: "not_required", auditStatus: "audit_failed", sequenceIndex: 4, allowNext: true }
  ] as const;

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "gfu29-skills-repo-"));
    fixtureRoot = join(repoRoot, ".homelab/agents/test-fixtures");
    await mkdir(fixtureRoot, { recursive: true });
    seed = fixture(["--action", "seed", "--worker-id", "skills-state-machine"]);
    Object.assign(process.env, {
      DATABASE_URL: withSchema(adminUrl, seed.databaseNamespace),
      JWT_SECRET: "gfu29-skills-state-machine-secret",
      JWT_EXPIRES_IN: "1h",
      MODEL_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
      HOMELAB_REPO_ROOT: repoRoot,
      NODE_ENV: "test",
      GFU29_FIXTURE_ENABLED: "true",
      GFU29_TEST_RUN_ID: seed.testRunId,
      GFU29_TEST_CLOCK_ID: seed.testClockId,
      GFU29_DATABASE_NAMESPACE: seed.databaseNamespace
    });
    const { AppModule } = await import("../src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    await prisma.user.create({ data: { id: "t6-admin", username: "t6-admin", passwordHash: "unused", role: UserRole.ADMIN } });
    await prisma.agentSkillSource.create({
      data: { id: "t6-source", sourceType: "registry", label: "T6 Source", registryKey: "t6", isTrusted: true }
    });
    token = app.get(JwtService).sign(
      { sub: "t6-admin", username: "t6-admin", role: UserRole.ADMIN },
      { secret: process.env.JWT_SECRET }
    );

    const workspaces = app.get(AgentWorkspaceService);
    for (const item of cases) {
      const id = agentId(item.scenario);
      const safeScenario = item.scenario.replaceAll("_", "-");
      const descriptor = workspaces.buildDescriptor(`t6-${safeScenario}`, id);
      const row = await prisma.agent.create({
        data: {
          id,
          name: `T6 ${item.scenario}`,
          slug: `t6-${safeScenario}`,
          status: AgentStatus.ready,
          workspaceName: descriptor.workspaceName,
          workspacePath: descriptor.relativeWorkspacePath,
          modelProviderId: seed.resources.explicitProviderId,
          modelProvider: seed.resources.explicitProviderId,
          soul: "# T6 Soul\n"
        }
      });
      await workspaces.initializeWorkspace(row, { allowExistingWorkspace: false });
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (seed) fixture(["--action", "teardown", "--test-run-id", seed.testRunId]);
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    process.env = previousEnv;
  });

  it.each(cases)("drives $scenario through the real HTTP/service/DB/file state machine", async (item) => {
    const id = agentId(item.scenario);
    setScenario("audit_failed");
    const baseline = await changeWithClock(id, "install", skillBody("1.0.0"));
    expect(baseline).toMatchObject({ changeStatus: "succeeded", reloadStatus: "loaded", auditStatus: "audit_failed", terminal: true });
    const cfgV1 = baseline.persistedConfigVersion as string;

    setScenario(item.scenario);
    const target = await changeWithClock(
      id,
      item.operation,
      item.operation === "remove" ? { skillName: "t6-skill" } : skillBody("2.0.0")
    );
    expect(target).toMatchObject({
      changeStatus: item.changeStatus,
      reloadStatus: item.reloadStatus,
      rollbackResult: item.rollbackResult,
      auditStatus: item.auditStatus,
      terminal: true,
      finishedAt: expect.any(String),
      sequenceIndex: item.sequenceIndex
    });

    const cfgV2 = target.stagedConfigVersion as string;
    expect(cfgV2).not.toBe(cfgV1);
    expect(target.persistedConfigVersion).toBe(item.scenario === "rollback_ok" ? cfgV1 : cfgV2);
    expect(target.runtimeLoadedVersion).toBe(item.scenario === "audit_failed" ? cfgV2 : cfgV1);
    await expect(readActiveVersion(id)).resolves.toBe(target.persistedConfigVersion);
    expect(fixture(["--action", "observe", "--test-run-id", seed.testRunId]).adapter.runtimeLoadedVersion).toBe(
      target.runtimeLoadedVersion
    );

    const queried = await fetch(`${baseUrl}/agents/${id}/skills/changes/${target.changeId}`, { headers: authHeaders() });
    expect(queried.status).toBe(200);
    await expect(queried.json()).resolves.toMatchObject({
      changeStatus: item.changeStatus,
      reloadStatus: item.reloadStatus,
      rollbackResult: item.rollbackResult,
      auditStatus: item.auditStatus,
      persistedConfigVersion: target.persistedConfigVersion,
      runtimeLoadedVersion: target.runtimeLoadedVersion,
      sequenceIndex: target.sequenceIndex,
      terminal: true
    });
    await expect(prisma.agentSkillChange.findUniqueOrThrow({ where: { id: target.changeId } })).resolves.toMatchObject({
      changeStatus: item.changeStatus,
      reloadStatus: item.reloadStatus,
      rollbackResult: item.rollbackResult,
      auditStatus: item.auditStatus,
      operation: item.operation,
      activeConfigVersion: target.persistedConfigVersion
    });

    const beforeNextCount = await prisma.agentSkillChange.count({ where: { targetAgentId: id } });
    if (!item.allowNext) {
      const blocked = await fetch(`${baseUrl}/agents/${id}/skills/update`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(skillBody("3.0.0"))
      });
      expect(blocked.status).toBe(409);
      await expect(blocked.json()).resolves.toMatchObject({ code: "AGENT_SKILL_RECOVERY_REQUIRED" });
      await expect(prisma.agentSkillChange.count({ where: { targetAgentId: id } })).resolves.toBe(beforeNextCount);
    } else {
      setScenario("pending_restart");
      const next = await changeWithClock(id, "update", skillBody("3.0.0"));
      expect(next).toMatchObject({ changeStatus: "succeeded", reloadStatus: "pending_restart" });
      await expect(prisma.agentSkillChange.count({ where: { targetAgentId: id } })).resolves.toBe(beforeNextCount + 1);
    }
  });

  async function changeWithClock(id: string, operation: "install" | "update" | "remove", body: Record<string, unknown>) {
    const pending = fetch(`${baseUrl}/agents/${id}/skills/${operation}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    const observed = await waitForControl((adapter) => adapter.clockWaiters?.[seed.testClockId]?.targetMillis > adapter.clockMillis);
    await expect(
      prisma.agentSkillChange.findFirstOrThrow({ where: { targetAgentId: id }, orderBy: { createdAt: "desc" } })
    ).resolves.toMatchObject({
      operation,
      changeStatus: "reloading",
      reloadStatus: "unknown",
      auditStatus: "audit_pending",
      activeConfigVersion: expect.any(String),
      stagedConfigVersion: expect.any(String),
      finishedAt: null
    });
    const target = observed.adapter.clockWaiters[seed.testClockId].targetMillis;
    fixture(["--action", "advance-clock", "--test-run-id", seed.testRunId, "--milliseconds", String(target - observed.clockMillis)]);
    const response = await pending;
    const result = await response.json();
    if (response.status < 200 || response.status >= 300) throw new Error(`${operation} returned ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }

  async function waitForControl(predicate: (adapter: any) => boolean) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const observed = fixture(["--action", "observe", "--test-run-id", seed.testRunId]);
      if (predicate(observed.adapter)) return observed;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("T6 TEST-CLOCK acknowledgement timed out");
  }

  function setScenario(scenario: string) {
    return fixture(["--action", "set-skill-scenario", "--test-run-id", seed.testRunId, "--scenario", scenario]);
  }

  async function readActiveVersion(id: string): Promise<string | null> {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id } });
    const state = JSON.parse(await readFile(join(repoRoot, agent.workspacePath, ".skills-state", "active.json"), "utf8"));
    return state.activeConfigVersion ?? null;
  }

  function fixture(args: string[]) {
    return JSON.parse(execFileSync(process.execPath, [fixtureScript, "--suite", "GFU-29", ...args], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test", GFU29_FIXTURE_ENABLED: "true", GFU29_FIXTURE_ROOT: fixtureRoot, GFU29_FIXTURE_DATABASE_URL: adminUrl }
    }));
  }

  function authHeaders() {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  function agentId(scenario: string) {
    return `t6-${scenario.replaceAll("_", "-")}-12345678`;
  }
});

function skillBody(version: string) {
  return { skillName: "t6-skill", sourceId: "t6-source", sourceType: "registry", version };
}

function withSchema(value: string, schema: string) {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  return url.toString();
}
