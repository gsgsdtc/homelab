import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";

describe("GFU-29 deterministic fixture CLI", () => {
  const script = join(__dirname, "../scripts/gfu29-fixture.cjs");
  const databaseUrl = process.env.GFU29_POSTGRES_ADMIN_URL ?? `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres`;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gfu29-fixture-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("seeds, resets and tears down the same isolated worker resources", () => {
    const seed = run(["--suite", "GFU-29", "--action", "seed", "--worker-id", "w1"]);
    expect(seed).toMatchObject({
      status: "ready",
      fixtureVersion: 2,
      workerId: "w1",
      databaseNamespace: expect.stringMatching(/^gfu29_w1_/),
      testClockId: expect.stringMatching(/^test-clock-gfu29-w1-/)
    });
    expect(seed.baselines).toMatchObject({
      agentRows: 4,
      soulUtf8_64kBytes: 65536,
      soulUtf8_64kPlus1Bytes: 65537,
      x1: {
        statusSequence: ["init_failed", "initializing", "ready"],
        missing: ["agent.yaml", "soul.md"],
        sentinelSha: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });

    const observed = run(["--suite", "GFU-29", "--action", "observe", "--test-run-id", seed.testRunId]);
    expect(observed.counts).toMatchObject({
      agentRows: 4,
      dbRows: expect.any(Number),
      workspaceEntries: expect.any(Number)
    });
    expect(observed.adapter.barriers).toMatchObject({
      "RUN-SOUL-V1-HELD": {
        barrierState: "held",
        acknowledged: true,
        soulHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      "CLAIM-WF-V1-SUSPENDED": {
        barrierState: "held",
        acknowledged: true,
        workflowHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
    expect(observed.adapter.skillScenarios).toMatchObject({
      runtime_offline: {
        persistedConfigVersion: "cfg-v2",
        runtimeLoadedVersion: "cfg-v1",
        terminal: true
      },
      pending_restart: {
        persistedConfigVersion: "cfg-v2",
        runtimeLoadedVersion: "cfg-v1",
        terminal: true
      },
      rollback_ok: {
        persistedConfigVersion: "cfg-v1",
        runtimeLoadedVersion: "cfg-v1",
        terminal: true
      },
      rollback_failed: {
        persistedConfigVersion: "cfg-v2",
        runtimeLoadedVersion: "cfg-v1",
        terminal: true,
        allowNextChange: false
      },
      audit_failed: {
        persistedConfigVersion: "cfg-v2",
        runtimeLoadedVersion: "cfg-v2",
        auditStatus: "audit_failed",
        terminal: true
      }
    });

    expect(
      run(["--suite", "GFU-29", "--action", "barrier", "--test-run-id", seed.testRunId, "--barrier-id", "RUN-SOUL-V1-HELD", "--operation", "release"])
    ).toMatchObject({ acknowledged: true, barrierState: "released" });
    expect(run(["--suite", "GFU-29", "--action", "advance-clock", "--test-run-id", seed.testRunId, "--milliseconds", "30000"])).toMatchObject({
      testClockId: seed.testClockId,
      clockMillis: 30000
    });

    const reset = run(["--suite", "GFU-29", "--action", "reset", "--test-run-id", seed.testRunId]);
    expect(reset).toMatchObject({
      status: "ready",
      testRunId: seed.testRunId,
      resources: seed.resources
    });

    const teardown = run(["--suite", "GFU-29", "--action", "teardown", "--test-run-id", seed.testRunId]);
    expect(teardown).toEqual({
      status: "clean",
      dbRows: 0,
      workspaceEntries: 0,
      fakeAdapterEntries: 0
    });
  });

  it("creates a unique isolated test run for repeated seeds on the same worker", () => {
    const first = run(["--suite", "GFU-29", "--action", "seed", "--worker-id", "w1"]);
    const second = run(["--suite", "GFU-29", "--action", "seed", "--worker-id", "w1"]);

    expect(second.testRunId).not.toBe(first.testRunId);
    expect(second.databaseNamespace).not.toBe(first.databaseNamespace);
    run(["--suite", "GFU-29", "--action", "teardown", "--test-run-id", first.testRunId]);
    run(["--suite", "GFU-29", "--action", "teardown", "--test-run-id", second.testRunId]);
  });

  it("accepts the npm argument separator used by the documented fixture command", () => {
    const seed = run(["--", "--suite", "GFU-29", "--action", "seed", "--worker-id", "npm-separator"]);

    expect(seed).toMatchObject({ status: "ready", workerId: "npm-separator" });
    run(["--", "--suite", "GFU-29", "--action", "teardown", "--test-run-id", seed.testRunId]);
  });

  it("fails closed unless the test control plane is explicitly enabled", () => {
    const result = spawnSync(process.execPath, [script, "--suite", "GFU-29", "--action", "seed", "--worker-id", "w1"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        GFU29_FIXTURE_ROOT: root,
        GFU29_FIXTURE_ENABLED: ""
      }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FIXTURE_CONTROL_DISABLED");
  });

  it("fails closed in production", () => {
    const result = spawnSync(process.execPath, [script, "--suite", "GFU-29", "--action", "seed", "--worker-id", "w1"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        GFU29_FIXTURE_ROOT: root,
        GFU29_FIXTURE_ENABLED: "true"
      }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FIXTURE_CONTROL_DISABLED");
  });

  function run(args: string[]) {
    return JSON.parse(
      execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          GFU29_FIXTURE_ROOT: root,
          GFU29_FIXTURE_ENABLED: "true",
          GFU29_FIXTURE_DATABASE_URL: databaseUrl
        }
      })
    );
  }
});
