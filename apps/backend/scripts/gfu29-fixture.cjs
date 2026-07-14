#!/usr/bin/env node
"use strict";

const { createHash, randomUUID } = require("crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("fs");
const { spawnSync } = require("child_process");
const { resolve } = require("path");
const { PrismaClient } = require("@prisma/client");

const args = parseArgs(process.argv.slice(2));
if (
  process.env.NODE_ENV !== "test" ||
  process.env.GFU29_FIXTURE_ENABLED !== "true"
) {
  fail(
    "FIXTURE_CONTROL_DISABLED",
    "GFU-29 fixture control is disabled outside an explicitly enabled test environment",
  );
}
if (args.suite !== "GFU-29")
  fail("INVALID_FIXTURE_SUITE", "--suite must be GFU-29");
const baseDatabaseUrl =
  process.env.GFU29_FIXTURE_DATABASE_URL || process.env.DATABASE_URL;
if (!baseDatabaseUrl)
  fail(
    "FIXTURE_DATABASE_REQUIRED",
    "an isolated PostgreSQL fixture URL is required",
  );
assertSafeDatabase(baseDatabaseUrl);

const root = resolve(
  process.env.GFU29_FIXTURE_ROOT || ".homelab/test-fixtures/gfu29",
);
main().catch((error) => fail("FIXTURE_CONTROL_FAILED", safeMessage(error)));

async function main() {
  if (args.action === "seed") output(publicSeed(await seed()));
  else if (args.action === "reset") output(publicSeed(await reset()));
  else if (args.action === "teardown") output(await teardown());
  else if (args.action === "advance-clock") output(await advanceClock());
  else if (args.action === "barrier") output(await barrier());
  else if (args.action === "observe") output(await observe());
  else fail("INVALID_FIXTURE_ACTION", "unsupported --action");
}

async function seed() {
  const workerId = safeSegment(required("worker-id"));
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const state = buildState(`gfu29-${workerId}-${suffix}`, workerId, suffix);
  await deploySchema(state);
  await seedDatabase(state);
  seedWorkspace(state);
  seedFakeAdapter(state);
  writeState(state);
  return refreshBaselines(state);
}

async function reset() {
  const state = loadState(required("test-run-id"));
  await dropSchema(state.databaseNamespace);
  rmSync(state.workspaceRoot, { recursive: true, force: true });
  rmSync(adapterRoot(state), { recursive: true, force: true });
  state.clockMillis = 0;
  await deploySchema(state);
  await seedDatabase(state);
  seedWorkspace(state);
  seedFakeAdapter(state);
  writeState(state);
  return refreshBaselines(state);
}

async function teardown() {
  const state = loadState(required("test-run-id"));
  const before = await observeCounts(state);
  await dropSchema(state.databaseNamespace);
  rmSync(state.workspaceRoot, { recursive: true, force: true });
  rmSync(adapterRoot(state), { recursive: true, force: true });
  const schemaExists = await schemaExistsOnAdmin(state.databaseNamespace);
  const workspaceEntries = countEntries(state.workspaceRoot);
  const fakeAdapterEntries = countEntries(adapterRoot(state));
  if (schemaExists || workspaceEntries !== 0 || fakeAdapterEntries !== 0) {
    throw new Error(
      `teardown verification failed after cleaning ${before.dbRows} database rows`,
    );
  }
  rmSync(resolve(root, state.testRunId), { recursive: true, force: true });
  return { status: "clean", dbRows: 0, workspaceEntries, fakeAdapterEntries };
}

async function advanceClock() {
  const state = loadState(required("test-run-id"));
  const milliseconds = Number(required("milliseconds"));
  if (!Number.isInteger(milliseconds) || milliseconds < 0)
    fail("INVALID_TEST_CLOCK_ADVANCE", "milliseconds must be >= 0");
  state.clockMillis += milliseconds;
  const adapter = loadAdapter(state);
  adapter.clockMillis = state.clockMillis;
  for (const scenario of Object.values(adapter.skillScenarios)) {
    while (
      scenario.sequence[scenario.sequenceIndex + 1]?.atMillis <=
      state.clockMillis
    )
      scenario.sequenceIndex += 1;
    Object.assign(scenario, scenario.sequence[scenario.sequenceIndex].value);
  }
  writeAdapter(state, adapter);
  writeState(state);
  return {
    status: "ready",
    testRunId: state.testRunId,
    testClockId: state.testClockId,
    clockMillis: state.clockMillis,
  };
}

async function barrier() {
  const state = loadState(required("test-run-id"));
  const barrierId = required("barrier-id");
  const operation = required("operation");
  const adapter = loadAdapter(state);
  const item = adapter.barriers[barrierId];
  if (!item) fail("FIXTURE_BARRIER_NOT_FOUND", "barrier was not found");
  if (operation !== "hold" && operation !== "release")
    fail(
      "INVALID_FIXTURE_BARRIER_OPERATION",
      "operation must be hold or release",
    );
  item.barrierState = operation === "hold" ? "held" : "released";
  item.acknowledged = true;
  writeAdapter(state, adapter);
  return {
    status: "ready",
    testRunId: state.testRunId,
    barrierId,
    acknowledged: true,
    barrierState: item.barrierState,
  };
}

async function observe() {
  const state = loadState(required("test-run-id"));
  return {
    status: "ready",
    testRunId: state.testRunId,
    clockMillis: state.clockMillis,
    counts: await observeCounts(state),
    adapter: loadAdapter(state),
  };
}

function buildState(testRunId, workerId, suffix) {
  const runRoot = resolve(root, testRunId);
  const id = (name) => `${name}-${suffix}`;
  return {
    status: "ready",
    fixtureVersion: 2,
    testRunId,
    workerId,
    databaseNamespace: `gfu29_${workerId.replace(/[^a-zA-Z0-9]/g, "_")}_${suffix}`,
    workspaceRoot: resolve(runRoot, "workspaces"),
    testClockId: `test-clock-gfu29-${workerId}-${suffix}`,
    clockMillis: 0,
    resources: {
      defaultProviderId: id("provider-default"),
      explicitProviderId: id("provider-explicit"),
      alternateProviderId: id("provider-alternate"),
      disabledProviderId: id("provider-disabled"),
      readyAgentId: id("agent-ready"),
      initializingAgentId: id("agent-initializing"),
      failedAgentId: id("agent-failed"),
      x1AgentId: id("x1-init-failed-missing-sentinel"),
      soulUtf8_64k: "SOUL-UTF8-64K",
      soulUtf8_64kPlus1: "SOUL-UTF8-64K+1",
      heldSoulRun: "RUN-SOUL-V1-HELD",
      suspendedWorkflowClaim: "CLAIM-WF-V1-SUSPENDED",
      fakeAdapterId: id("fake-adapter"),
    },
    baselines: {},
  };
}

async function deploySchema(state) {
  const databaseUrl = databaseUrlFor(state.databaseNamespace);
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      resolve(__dirname, "../prisma/schema.prisma"),
    ],
    {
      cwd: resolve(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `fixture schema migration failed: ${result.stderr || result.stdout}`,
    );
}

async function seedDatabase(state) {
  const prisma = clientFor(state.databaseNamespace);
  const r = state.resources;
  try {
    await prisma.modelProvider.createMany({
      data: [
        provider(
          r.defaultProviderId,
          "Fixture Default",
          "fixture-default",
          true,
          true,
        ),
        provider(
          r.explicitProviderId,
          "Fixture Explicit",
          "fixture-explicit",
          true,
          false,
        ),
        provider(
          r.alternateProviderId,
          "Fixture Alternate",
          "fixture-alternate",
          true,
          false,
        ),
        provider(
          r.disabledProviderId,
          "Fixture Disabled",
          "fixture-disabled",
          false,
          false,
        ),
      ],
    });
    await prisma.agent.createMany({
      data: [
        agentRow(
          state,
          r.readyAgentId,
          "ready",
          "ready-agent",
          r.explicitProviderId,
        ),
        agentRow(
          state,
          r.initializingAgentId,
          "initializing",
          "initializing-agent",
          null,
        ),
        agentRow(state, r.failedAgentId, "init_failed", "failed-agent", null),
        agentRow(
          state,
          r.x1AgentId,
          "init_failed",
          "x1-agent",
          r.explicitProviderId,
        ),
      ],
    });
    await prisma.agentWorkflow.create({
      data: {
        id: `workflow-${state.testRunId}`,
        agentId: r.readyAgentId,
        workflowKey: "fixture-flow",
        extension: "ts",
        relativePath: workspaceRelative(
          state,
          r.readyAgentId,
          "src/mastra/workflows/fixture-flow.ts",
        ),
        draftHash: sha("workflow-v1"),
        activeHash: sha("workflow-v1"),
        revision: sha("workflow-v1"),
        editRevision: 1,
        reloadStatus: "succeeded",
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

function seedWorkspace(state) {
  mkdirSync(state.workspaceRoot, { recursive: true });
  const r = state.resources;
  for (const [agentId, status] of [
    [r.readyAgentId, "ready"],
    [r.initializingAgentId, "initializing"],
    [r.failedAgentId, "init_failed"],
    [r.x1AgentId, "init_failed"],
  ]) {
    const dir = workspaceDir(state, agentId);
    mkdirSync(resolve(dir, "skills"), { recursive: true });
    mkdirSync(resolve(dir, "src/mastra/workflows"), { recursive: true });
    writeFileSync(
      resolve(dir, "USER-SENTINEL"),
      `sentinel:${agentId}\n`,
      "utf8",
    );
    writeFileSync(resolve(dir, "skills/skills.yaml"), "skills: []\n", "utf8");
    if (agentId !== r.x1AgentId) {
      writeFileSync(
        resolve(dir, "agent.yaml"),
        `id: ${agentId}\nstatus: ${status}\nmodel:\n  provider: null\n`,
        "utf8",
      );
      writeFileSync(resolve(dir, "soul.md"), "# Soul v1\n", "utf8");
    }
  }
  writeFileSync(
    resolve(
      workspaceDir(state, r.readyAgentId),
      "src/mastra/workflows/fixture-flow.ts",
    ),
    "workflow-v1",
    "utf8",
  );
}

function seedFakeAdapter(state) {
  const adapter = {
    clockMillis: 0,
    barriers: {
      "RUN-SOUL-V1-HELD": {
        runId: `run-${state.testRunId}`,
        soulHash: sha("# Soul v1\n"),
        barrierState: "held",
        acknowledged: true,
      },
      "CLAIM-WF-V1-SUSPENDED": {
        taskId: `task-${state.testRunId}`,
        claimId: `claim-${state.testRunId}`,
        workflowHash: sha("workflow-v1"),
        barrierState: "held",
        acknowledged: true,
      },
    },
    skillScenarios: buildSkillScenarios(),
  };
  writeAdapter(state, adapter);
}

function buildSkillScenarios() {
  const scenario = (value) => ({
    ...value,
    sequenceIndex: 0,
    sequence: [{ atMillis: 0, value }],
  });
  return {
    runtime_offline: scenario({
      changeStatus: "succeeded",
      reloadStatus: "runtime_offline",
      rollback: "not_required",
      persistedConfigVersion: "cfg-v2",
      runtimeLoadedVersion: "cfg-v1",
      terminal: true,
      allowNextChange: true,
    }),
    pending_restart: scenario({
      changeStatus: "succeeded",
      reloadStatus: "pending_restart",
      rollback: "not_required",
      persistedConfigVersion: "cfg-v2",
      runtimeLoadedVersion: "cfg-v1",
      terminal: true,
      allowNextChange: true,
    }),
    rollback_ok: scenario({
      changeStatus: "rolled_back",
      reloadStatus: "failed",
      rollback: "succeeded",
      persistedConfigVersion: "cfg-v1",
      runtimeLoadedVersion: "cfg-v1",
      terminal: true,
      allowNextChange: true,
    }),
    rollback_failed: scenario({
      changeStatus: "rollback_failed",
      reloadStatus: "failed",
      rollback: "failed",
      persistedConfigVersion: "cfg-v2",
      runtimeLoadedVersion: "cfg-v1",
      terminal: true,
      allowNextChange: false,
    }),
    audit_failed: scenario({
      changeStatus: "succeeded",
      reloadStatus: "loaded",
      rollback: "not_required",
      auditStatus: "audit_failed",
      persistedConfigVersion: "cfg-v2",
      runtimeLoadedVersion: "cfg-v2",
      terminal: true,
      allowNextChange: true,
    }),
  };
}

async function refreshBaselines(state) {
  const counts = await observeCounts(state);
  const x1Dir = workspaceDir(state, state.resources.x1AgentId);
  const sentinel = readFileSync(resolve(x1Dir, "USER-SENTINEL"));
  state.baselines = {
    ...counts,
    x1: {
      statusSequence: ["init_failed", "initializing", "ready"],
      missing: ["agent.yaml", "soul.md"],
      sentinelSha: sha(sentinel),
      workspaceEntries: listEntries(x1Dir),
    },
    soulMaxBytes: 65536,
    soulUtf8_64kBytes: Buffer.byteLength(buildUtf8Soul(65536)),
    soulUtf8_64kPlus1Bytes: Buffer.byteLength(buildUtf8Soul(65537)),
    workflowMaxBytes: 262144,
    workflowReloadTimeoutMs: 30000,
  };
  writeState(state);
  return state;
}

async function observeCounts(state) {
  const prisma = clientFor(state.databaseNamespace);
  try {
    const [agents, providers, workflows] = await Promise.all([
      prisma.agent.count(),
      prisma.modelProvider.count(),
      prisma.agentWorkflow.count(),
    ]);
    return {
      dbRows: agents + providers + workflows,
      agentRows: agents,
      workspaceEntries: countEntries(state.workspaceRoot),
      fakeAdapterEntries: countEntries(adapterRoot(state)),
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function dropSchema(namespace) {
  const admin = clientForAdmin();
  try {
    await admin.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${namespace}" CASCADE`,
    );
  } finally {
    await admin.$disconnect();
  }
}

async function schemaExistsOnAdmin(namespace) {
  const admin = clientForAdmin();
  try {
    const rows = await admin.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '${namespace}') AS present`,
    );
    return rows[0].present;
  } finally {
    await admin.$disconnect();
  }
}

function clientFor(namespace) {
  return new PrismaClient({ datasourceUrl: databaseUrlFor(namespace) });
}

function clientForAdmin() {
  return new PrismaClient({ datasourceUrl: baseDatabaseUrl });
}

function databaseUrlFor(namespace) {
  const url = new URL(baseDatabaseUrl);
  url.searchParams.set("schema", namespace);
  return url.toString();
}

function assertSafeDatabase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("FIXTURE_DATABASE_UNSAFE", "fixture database URL is invalid");
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol))
    fail("FIXTURE_DATABASE_UNSAFE", "fixture control requires PostgreSQL");
  if (
    process.env.GFU29_FIXTURE_ALLOW_REMOTE !== "true" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    fail(
      "FIXTURE_DATABASE_UNSAFE",
      "fixture database must be local unless explicitly allowed in CI",
    );
  }
}

function provider(id, name, nameKey, isActive, isDefault) {
  return {
    id,
    name,
    nameKey,
    type: "OPENAI_COMPATIBLE",
    baseUrl: "https://fixture.invalid/v1",
    encryptedApiKey: "fixture-encrypted",
    defaultModel: "fixture-model",
    isActive,
    isDefault,
  };
}

function agentRow(state, id, status, slug, providerId) {
  return {
    id,
    name: slug,
    slug,
    status,
    workspaceName: `${slug}--${id.replace(/[^a-z0-9]/g, "").slice(-8)}`,
    workspacePath: workspaceRelative(state, id),
    modelProviderId: providerId,
    modelProvider: providerId,
    soul: "# Soul v1\n",
    initializationError:
      status === "init_failed" ? "fixture initialization failure" : null,
    initializedAt: status === "ready" ? new Date(0) : null,
  };
}

function workspaceRelative(state, agentId, suffix = "") {
  return [
    ".homelab",
    "test-fixtures",
    state.testRunId,
    "workspaces",
    agentId,
    suffix,
  ]
    .filter(Boolean)
    .join("/");
}

function workspaceDir(state, agentId) {
  return resolve(state.workspaceRoot, agentId);
}
function adapterRoot(state) {
  return resolve(root, state.testRunId, "fake-adapter");
}
function adapterPath(state) {
  return resolve(adapterRoot(state), "state.json");
}
function writeAdapter(state, value) {
  mkdirSync(adapterRoot(state), { recursive: true });
  writeFileSync(
    adapterPath(state),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}
function loadAdapter(state) {
  return JSON.parse(readFileSync(adapterPath(state), "utf8"));
}
function statePath(testRunId) {
  return resolve(root, testRunId, "state.json");
}
function writeState(state) {
  mkdirSync(resolve(root, state.testRunId), { recursive: true });
  writeFileSync(
    statePath(state.testRunId),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}
function loadState(rawId) {
  const id = safeSegment(rawId);
  if (!existsSync(statePath(id)))
    fail("FIXTURE_NOT_FOUND", "fixture testRunId was not found");
  return JSON.parse(readFileSync(statePath(id), "utf8"));
}
function publicSeed(state) {
  const { clockMillis: _clockMillis, ...publicState } = state;
  return publicState;
}
function countEntries(path) {
  if (!existsSync(path)) return 0;
  return listEntries(path).length;
}
function listEntries(path, prefix = "") {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? [rel, ...listEntries(resolve(path, entry.name), rel)]
        : [rel];
    })
    .sort();
}
function buildUtf8Soul(bytes) {
  const marker = "界";
  const markerBytes = Buffer.byteLength(marker);
  return (
    marker.repeat(Math.floor(bytes / markerBytes)) +
    "a".repeat(bytes % markerBytes)
  );
}
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(values) {
  const parsed = {};
  const normalizedValues = values.filter((value) => value !== "--");
  for (let index = 0; index < normalizedValues.length; index += 2) {
    if (
      !normalizedValues[index]?.startsWith("--") ||
      normalizedValues[index + 1] === undefined
    )
      fail("INVALID_FIXTURE_ARGUMENTS", "arguments use --key value pairs");
    parsed[normalizedValues[index].slice(2)] = normalizedValues[index + 1];
  }
  return parsed;
}
function required(key) {
  if (!args[key]) fail("INVALID_FIXTURE_ARGUMENTS", `--${key} is required`);
  return args[key];
}
function safeSegment(value) {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(value))
    fail("INVALID_FIXTURE_ID", "fixture identifiers must be URL-safe");
  return value;
}
function safeMessage(error) {
  return String(error instanceof Error ? error.message : error).replace(
    /postgres(?:ql)?:\/\/[^\s@]+@/gi,
    "postgresql://[redacted]@",
  );
}
function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function fail(code, message) {
  process.stderr.write(
    `${JSON.stringify({ status: "error", code, message })}\n`,
  );
  process.exit(1);
}
