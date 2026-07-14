#!/usr/bin/env node
"use strict";

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { resolve } = require("path");

const args = parseArgs(process.argv.slice(2));
if (process.env.NODE_ENV === "production" || process.env.GFU29_FIXTURE_ENABLED === "false") {
  fail("FIXTURE_CONTROL_DISABLED", "GFU-29 fixture control is disabled in production");
}
if (args.suite !== "GFU-29") fail("INVALID_FIXTURE_SUITE", "--suite must be GFU-29");

const root = resolve(process.env.GFU29_FIXTURE_ROOT || ".homelab/test-fixtures/gfu29");
if (args.action === "seed") seed();
else if (args.action === "reset") reset();
else if (args.action === "teardown") teardown();
else if (args.action === "advance-clock") advanceClock();
else fail("INVALID_FIXTURE_ACTION", "unsupported --action");

function seed() {
  const workerId = safeSegment(required("worker-id"));
  const testRunId = `gfu29-${workerId}`;
  const state = buildState(testRunId, workerId);
  writeState(state);
  output(publicSeed(state));
}

function reset() {
  const state = loadState(required("test-run-id"));
  const resetState = buildState(state.testRunId, state.workerId);
  writeState(resetState);
  output(publicSeed(resetState));
}

function teardown() {
  const testRunId = safeSegment(required("test-run-id"));
  rmSync(resolve(root, testRunId), { recursive: true, force: true });
  output({ status: "clean", dbRows: 0, workspaceEntries: 0, fakeAdapterEntries: 0 });
}

function advanceClock() {
  const state = loadState(required("test-run-id"));
  const milliseconds = Number(required("milliseconds"));
  if (!Number.isInteger(milliseconds) || milliseconds < 0) fail("INVALID_TEST_CLOCK_ADVANCE", "milliseconds must be >= 0");
  state.clockMillis += milliseconds;
  writeState(state);
  output({ status: "ready", testRunId: state.testRunId, testClockId: state.testClockId, clockMillis: state.clockMillis });
}

function buildState(testRunId, workerId) {
  const runRoot = resolve(root, testRunId);
  return {
    status: "ready",
    fixtureVersion: 1,
    testRunId,
    workerId,
    databaseNamespace: `gfu29_${workerId.replace(/[^a-zA-Z0-9]/g, "_")}`,
    workspaceRoot: resolve(runRoot, "workspaces"),
    testClockId: `test-clock-gfu29-${workerId}`,
    clockMillis: 0,
    resources: {
      defaultProviderId: `provider-default-${workerId}`,
      explicitProviderId: `provider-explicit-${workerId}`,
      disabledProviderId: `provider-disabled-${workerId}`,
      readyAgentId: `agent-ready-${workerId}`,
      initializingAgentId: `agent-initializing-${workerId}`,
      failedAgentId: `agent-failed-${workerId}`,
      x1AgentId: `x1-init-failed-missing-sentinel-${workerId}`,
      soulUtf8_64k: "SOUL-UTF8-64K",
      soulUtf8_64kPlus1: "SOUL-UTF8-64K+1",
      heldSoulRun: "RUN-SOUL-V1-HELD",
      suspendedWorkflowClaim: "CLAIM-WF-V1-SUSPENDED",
      fakeAdapterId: `fake-adapter-${workerId}`
    },
    baselines: {
      agentRows: 4,
      workspaceEntries: 4,
      fakeAdapterEntries: 0,
      statusSequence: ["init_failed", "initializing", "ready"],
      soulMaxBytes: 65536,
      workflowMaxBytes: 262144,
      workflowReloadTimeoutMs: 30000
    }
  };
}

function writeState(state) {
  const runRoot = resolve(root, state.testRunId);
  mkdirSync(state.workspaceRoot, { recursive: true });
  mkdirSync(resolve(runRoot, "fake-adapter"), { recursive: true });
  writeFileSync(resolve(runRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function loadState(rawId) {
  const testRunId = safeSegment(rawId);
  const path = resolve(root, testRunId, "state.json");
  if (!existsSync(path)) fail("FIXTURE_NOT_FOUND", "fixture testRunId was not found");
  return JSON.parse(readFileSync(path, "utf8"));
}

function publicSeed(state) {
  const { clockMillis: _clockMillis, ...outputState } = state;
  return outputState;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key || !key.startsWith("--") || values[index + 1] === undefined) fail("INVALID_FIXTURE_ARGUMENTS", "arguments use --key value pairs");
    parsed[key.slice(2)] = values[index + 1];
  }
  return parsed;
}

function required(key) {
  if (!args[key]) fail("INVALID_FIXTURE_ARGUMENTS", `--${key} is required`);
  return args[key];
}

function safeSegment(value) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) fail("INVALID_FIXTURE_ID", "fixture identifiers must be URL-safe");
  return value;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ status: "error", code, message })}\n`);
  process.exit(1);
}
