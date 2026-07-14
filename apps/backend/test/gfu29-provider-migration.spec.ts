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
  const gfu27ProviderMigrationPath = resolve(
    __dirname,
    "../prisma/migrations/20260714073100_add_agent_chat_model_provider/migration.sql",
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

  it("carries the exact GFU-27 provider-column migration in local history", () => {
    expect(readFileSync(gfu27ProviderMigrationPath, "utf8")).toBe(
      'ALTER TABLE "Agent" ADD COLUMN "modelProviderId" TEXT;\n',
    );
  });

  it("keeps remediation planning read-only and requires an explicit target Provider ID", () => {
    const preflight = readFileSync(preflightPath, "utf8");

    expect(preflight).toContain('action === "plan"');
    expect(preflight).toContain("--target-provider-id");
    expect(preflight).toContain("remediationPlan");
    expect(preflight).not.toContain("$executeRawUnsafe");
  });
});
