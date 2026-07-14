import { readFileSync } from "fs";
import { resolve } from "path";

describe("GFU-29 Provider migration safety", () => {
  const migrationPath = resolve(
    __dirname,
    "../prisma/migrations/20260714083000_gfu29_agent_contract/migration.sql",
  );
  const preflightPath = resolve(
    __dirname,
    "../scripts/gfu29-provider-migration.cjs",
  );

  it("runs a read-only report before schema expansion and wraps backfill plus validation atomically", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const preflight = readFileSync(preflightPath, "utf8");

    expect(preflight).toContain('action === "preflight"');
    expect(preflight).toContain("preflightPassed");
    expect(migration.indexOf("BEGIN;")).toBeGreaterThanOrEqual(0);
    expect(migration.indexOf("provider preflight failed")).toBeLessThan(
      migration.indexOf('ALTER TABLE "Agent"'),
    );
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("treats an existing disabled Provider ID as disabled instead of falling back to nameKey", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("id_match");
    expect(migration).toContain("id_match IS NULL");
    expect(migration).toContain("disabled");
  });
});
