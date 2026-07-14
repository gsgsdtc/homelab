import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

describe("built-in skills acceptance source", () => {
  it("is seeded idempotently with a deterministic trusted source id", () => {
    const migrationsRoot = resolve(__dirname, "../prisma/migrations");
    const migrationSql = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readFileSync(resolve(migrationsRoot, entry.name, "migration.sql"), "utf8"))
      .find((sql) => sql.includes("builtin-registry"));

    expect(migrationSql).toBeDefined();
    expect(migrationSql).toContain('INSERT INTO "AgentSkillSource"');
    expect(migrationSql).toContain("'builtin-registry'");
    expect(migrationSql).toContain("'registry'");
    expect(migrationSql).toContain("'Built-in Registry'");
    expect(migrationSql).toContain("'builtin'");
    expect(migrationSql).toContain('ON CONFLICT ("id") DO UPDATE');
    expect(migrationSql).toContain('"isTrusted" = EXCLUDED."isTrusted"');
  });
});
