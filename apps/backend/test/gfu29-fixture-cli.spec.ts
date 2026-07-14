import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("GFU-29 deterministic fixture CLI", () => {
  const script = join(__dirname, "../scripts/gfu29-fixture.cjs");
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gfu29-fixture-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("seeds, resets and tears down the same isolated worker resources", () => {
    const seed = run(["--suite", "GFU-29", "--action", "seed", "--worker-id", "w1"]);
    expect(seed).toMatchObject({
      status: "ready",
      fixtureVersion: 1,
      workerId: "w1",
      databaseNamespace: "gfu29_w1",
      testClockId: "test-clock-gfu29-w1"
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

  it("fails closed in production", () => {
    const result = spawnSync(process.execPath, [script, "--suite", "GFU-29", "--action", "seed", "--worker-id", "w1"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        GFU29_FIXTURE_ROOT: root
      }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FIXTURE_CONTROL_DISABLED");
  });

  function run(args: string[]) {
    return JSON.parse(
      execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test", GFU29_FIXTURE_ROOT: root }
      })
    );
  }
});
