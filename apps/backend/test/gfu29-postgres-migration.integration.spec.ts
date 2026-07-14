import { PrismaClient } from "@prisma/client";
import { execFileSync, spawnSync } from "child_process";
import { readdirSync } from "fs";
import { userInfo } from "os";
import { resolve } from "path";

describe("GFU-29 PostgreSQL Provider migration", () => {
  jest.setTimeout(120_000);
  const adminUrl =
    process.env.GFU29_POSTGRES_ADMIN_URL ??
    `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres`;
  const schema = `gfu29_migration_${Date.now()}_${process.pid}`;
  const databaseUrl = withSchema(adminUrl, schema);
  const prismaRoot = resolve(__dirname, "../prisma");
  const migrationRoot = resolve(prismaRoot, "migrations");
  const migrationName = "20260714083000_gfu29_agent_contract";
  const checkScript = resolve(
    __dirname,
    "../scripts/gfu29-provider-migration.cjs",
  );
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  const db = new PrismaClient({ datasourceUrl: databaseUrl });

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const migrations = readdirSync(migrationRoot)
      .filter((name) => name < migrationName)
      .sort();
    for (const name of migrations)
      executeSql(resolve(migrationRoot, name, "migration.sql"));
  });

  afterAll(async () => {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });

  it("reports a disabled ID without changing schema or data, then backfills and validates atomically", async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "ModelProvider" ("id", "name", "nameKey", "type", "baseUrl", "encryptedApiKey", "defaultModel", "isActive", "isDefault", "updatedAt")
      VALUES
        ('default-id', 'Default', 'default', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', TRUE, TRUE, NOW()),
        ('disabled-id', 'Disabled', 'disabled-provider', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', FALSE, FALSE, NOW()),
        ('name-fallback-id', 'Fallback', 'disabled-id', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', TRUE, FALSE, NOW())
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Agent" ("id", "name", "slug", "status", "workspaceName", "workspacePath", "modelProvider", "soul", "updatedAt")
      VALUES ('agent-disabled', 'Agent', 'agent', 'ready', 'agent--disabled', '.homelab/agents/agent--disabled', 'disabled-id', '', NOW())
    `);

    const rejected = runCheck("preflight");
    expect(rejected).toMatchObject({
      preflightPassed: false,
      disabled: ["agent-disabled"],
      unresolved: [],
      exitStatus: 2,
    });
    await expect(columnExists("modelProviderId")).resolves.toBe(false);
    await expect(
      db.$queryRawUnsafe<Array<{ modelProvider: string }>>(
        `SELECT "modelProvider" FROM "Agent" WHERE "id" = 'agent-disabled'`,
      ),
    ).resolves.toEqual([{ modelProvider: "disabled-id" }]);

    await db.$executeRawUnsafe(
      `UPDATE "ModelProvider" SET "isActive" = TRUE WHERE "id" = 'disabled-id'`,
    );
    expect(runCheck("preflight")).toMatchObject({
      preflightPassed: true,
      mappedById: 1,
      mappedByName: 0,
      exitStatus: 0,
    });

    executeSql(resolve(migrationRoot, migrationName, "migration.sql"));

    await expect(columnExists("modelProviderId")).resolves.toBe(true);
    await expect(
      db.$queryRawUnsafe<Array<{ modelProviderId: string }>>(
        `SELECT "modelProviderId" FROM "Agent" WHERE "id" = 'agent-disabled'`,
      ),
    ).resolves.toEqual([{ modelProviderId: "disabled-id" }]);
    expect(runCheck("validate")).toMatchObject({
      validationPassed: true,
      unresolved: 0,
      dualWriteDrift: 0,
      disabled: 0,
      exitStatus: 0,
    });
  });

  function executeSql(file: string) {
    execFileSync(
      "pnpm",
      [
        "exec",
        "prisma",
        "db",
        "execute",
        "--schema",
        resolve(prismaRoot, "schema.prisma"),
        "--file",
        file,
      ],
      {
        cwd: resolve(__dirname, ".."),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
  }

  function runCheck(action: "preflight" | "validate") {
    const result = spawnSync(
      process.execPath,
      [checkScript, "--action", action],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );
    return { ...JSON.parse(result.stdout), exitStatus: result.status };
  }

  async function columnExists(column: string) {
    const rows = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'Agent' AND column_name = '${column}') AS present`,
    );
    return rows[0].present;
  }
});

function withSchema(value: string, schema: string) {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  return url.toString();
}
