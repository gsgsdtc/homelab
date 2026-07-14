import { PrismaClient } from "@prisma/client";
import { execFileSync, spawnSync } from "child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join, resolve } from "path";

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

    // Reproduce the deployed target even before the coordination migration is
    // added to this branch: GFU-27 already expanded Agent with this column.
    if (!(await columnExists("modelProviderId"))) {
      await db.$executeRawUnsafe(
        `ALTER TABLE "Agent" ADD COLUMN "modelProviderId" TEXT`,
      );
    }
  });

  afterAll(async () => {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });

  it("plans four qa-* repairs without writes, preserves a failed GFU-27 state, then upgrades it", async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "ModelProvider" ("id", "name", "nameKey", "type", "baseUrl", "encryptedApiKey", "defaultModel", "isActive", "isDefault", "updatedAt")
      VALUES
        ('default-id', 'Default', 'default', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', TRUE, TRUE, NOW()),
        ('disabled-id', 'Disabled', 'disabled-provider', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', FALSE, FALSE, NOW()),
        ('name-fallback-id', 'Fallback', 'disabled-id', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', TRUE, FALSE, NOW()),
        ('legacy-name-id', 'Legacy Name', 'legacy-name', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', TRUE, FALSE, NOW())
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Agent" ("id", "name", "slug", "status", "workspaceName", "workspacePath", "modelProvider", "soul", "updatedAt")
      VALUES
        ('qa-agent-1', 'QA One', 'qa-one', 'ready', 'agent--qa-one', '.homelab/agents/agent--qa-one', 'missing-one', '', NOW()),
        ('qa-agent-2', 'QA Two', 'qa-two', 'ready', 'agent--qa-two', '.homelab/agents/agent--qa-two', 'missing-two', '', NOW()),
        ('qa-agent-3', 'QA Three', 'qa-three', 'ready', 'agent--qa-three', '.homelab/agents/agent--qa-three', 'missing-three', '', NOW()),
        ('qa-agent-4', 'QA Four', 'qa-four', 'ready', 'agent--qa-four', '.homelab/agents/agent--qa-four', 'missing-four', '', NOW()),
        ('agent-name-fallback', 'Named Agent', 'named-agent', 'ready', 'agent--named', '.homelab/agents/agent--named', 'Legacy-Name', '', NOW())
    `);

    const beforeRejectedMigration = await snapshotState();
    const rejected = runCheck("preflight");
    expect(rejected).toMatchObject({
      preflightPassed: false,
      disabled: [],
      unresolved: ["qa-agent-1", "qa-agent-2", "qa-agent-3", "qa-agent-4"],
      issues: [
        {
          agentId: "qa-agent-1",
          legacyProvider: "missing-one",
          reason: "unresolved",
        },
        {
          agentId: "qa-agent-2",
          legacyProvider: "missing-two",
          reason: "unresolved",
        },
        {
          agentId: "qa-agent-3",
          legacyProvider: "missing-three",
          reason: "unresolved",
        },
        {
          agentId: "qa-agent-4",
          legacyProvider: "missing-four",
          reason: "unresolved",
        },
      ],
      exitStatus: 2,
    });

    expect(() =>
      executeSql(resolve(migrationRoot, migrationName, "migration.sql")),
    ).toThrow();
    await expect(snapshotState()).resolves.toEqual(beforeRejectedMigration);
    await expect(columnExists("revision")).resolves.toBe(false);

    const plan = runCheck("plan", "default-id");
    expect(plan).toMatchObject({
      action: "plan",
      status: "ready",
      planPassed: true,
      targetProviderId: "default-id",
      remediationPlan: [
        {
          agentId: "qa-agent-1",
          fromLegacyProvider: "missing-one",
          toProviderId: "default-id",
        },
        {
          agentId: "qa-agent-2",
          fromLegacyProvider: "missing-two",
          toProviderId: "default-id",
        },
        {
          agentId: "qa-agent-3",
          fromLegacyProvider: "missing-three",
          toProviderId: "default-id",
        },
        {
          agentId: "qa-agent-4",
          fromLegacyProvider: "missing-four",
          toProviderId: "default-id",
        },
      ],
      exitStatus: 0,
    });
    await expect(snapshotState()).resolves.toEqual(beforeRejectedMigration);

    // The checker only produced a guarded plan. Applying the reviewed target
    // mapping remains an explicit operator action outside the migration tool.
    await db.$executeRawUnsafe(`
      UPDATE "Agent"
      SET "modelProvider" = 'default-id', "modelProviderId" = 'default-id'
      WHERE "id" LIKE 'qa-%'
    `);
    expect(runCheck("preflight")).toMatchObject({
      preflightPassed: true,
      mappedById: 4,
      mappedByName: 1,
      exitStatus: 0,
    });

    executeSql(resolve(migrationRoot, migrationName, "migration.sql"));

    await expect(columnExists("modelProviderId")).resolves.toBe(true);
    await expect(
      db.$queryRawUnsafe<
        Array<{ id: string; modelProvider: string; modelProviderId: string }>
      >(
        `SELECT "id", "modelProvider", "modelProviderId" FROM "Agent" ORDER BY "id"`,
      ),
    ).resolves.toEqual([
      {
        id: "agent-name-fallback",
        modelProvider: "legacy-name-id",
        modelProviderId: "legacy-name-id",
      },
      {
        id: "qa-agent-1",
        modelProvider: "default-id",
        modelProviderId: "default-id",
      },
      {
        id: "qa-agent-2",
        modelProvider: "default-id",
        modelProviderId: "default-id",
      },
      {
        id: "qa-agent-3",
        modelProvider: "default-id",
        modelProviderId: "default-id",
      },
      {
        id: "qa-agent-4",
        modelProvider: "default-id",
        modelProviderId: "default-id",
      },
    ]);
    expect(runCheck("validate")).toMatchObject({
      validationPassed: true,
      unresolved: 0,
      dualWriteDrift: 0,
      disabled: 0,
      exitStatus: 0,
    });

    // The real rollback target only knows the legacy column. The database
    // compatibility contract must still update the primary reference.
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "modelProvider" = 'name-fallback-id' WHERE "id" = 'agent-name-fallback'`,
    );
    await expect(
      db.$queryRawUnsafe<
        Array<{ modelProvider: string; modelProviderId: string }>
      >(
        `SELECT "modelProvider", "modelProviderId" FROM "Agent" WHERE "id" = 'agent-name-fallback'`,
      ),
    ).resolves.toEqual([
      {
        modelProvider: "name-fallback-id",
        modelProviderId: "name-fallback-id",
      },
    ]);

    await db.$executeRawUnsafe(
      `ALTER TABLE "Agent" DISABLE TRIGGER "gfu29_agent_provider_compat"`,
    );
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "modelProviderId" = 'default-id' WHERE "id" = 'agent-name-fallback'`,
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE "Agent" ENABLE TRIGGER "gfu29_agent_provider_compat"`,
    );
    const beforeFailedValidate = await db.$queryRawUnsafe(
      `SELECT "modelProvider", "modelProviderId", "revision" FROM "Agent" WHERE "id" = 'agent-name-fallback'`,
    );
    expect(runCheck("validate")).toMatchObject({
      validationPassed: false,
      dualWriteDrift: 1,
      exitStatus: 2,
    });
    await expect(
      db.$queryRawUnsafe(
        `SELECT "modelProvider", "modelProviderId", "revision" FROM "Agent" WHERE "id" = 'agent-name-fallback'`,
      ),
    ).resolves.toEqual(beforeFailedValidate);
    await expect(columnExists("modelProviderId")).resolves.toBe(true);
  });

  it("runs prisma migrate deploy over an actual applied GFU-27 migration history", async () => {
    const historySchema = `gfu29_history_${Date.now()}_${process.pid}`;
    const historyUrl = withSchema(adminUrl, historySchema);
    const historyDb = new PrismaClient({ datasourceUrl: historyUrl });
    const oldPrismaRoot = mkdtempSync(join(tmpdir(), "gfu29-gfu27-prisma-"));
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${historySchema}"`);
      cpSync(
        resolve(prismaRoot, "schema.prisma"),
        resolve(oldPrismaRoot, "schema.prisma"),
      );
      mkdirSync(resolve(oldPrismaRoot, "migrations"));
      cpSync(
        resolve(migrationRoot, "migration_lock.toml"),
        resolve(oldPrismaRoot, "migrations/migration_lock.toml"),
      );
      for (const name of readdirSync(migrationRoot)
        .filter(
          (entry) => entry <= "20260714073100_add_agent_chat_model_provider",
        )
        .sort()) {
        cpSync(
          resolve(migrationRoot, name),
          resolve(oldPrismaRoot, "migrations", name),
          { recursive: true },
        );
      }

      migrateDeploy(resolve(oldPrismaRoot, "schema.prisma"), historyUrl);
      await expect(
        historyDb.$queryRawUnsafe<Array<{ migration_name: string }>>(`
          SELECT migration_name FROM "_prisma_migrations"
          WHERE migration_name = '20260714073100_add_agent_chat_model_provider'
            AND finished_at IS NOT NULL
        `),
      ).resolves.toEqual([
        { migration_name: "20260714073100_add_agent_chat_model_provider" },
      ]);

      await historyDb.$executeRawUnsafe(`
        INSERT INTO "ModelProvider" ("id", "name", "nameKey", "type", "baseUrl", "encryptedApiKey", "defaultModel", "isActive", "isDefault", "updatedAt")
        VALUES ('history-provider', 'History', 'history', 'OPENAI_COMPATIBLE', 'https://fixture.invalid', 'encrypted', 'model', TRUE, TRUE, NOW())
      `);
      await historyDb.$executeRawUnsafe(`
        INSERT INTO "Agent" ("id", "name", "slug", "status", "workspaceName", "workspacePath", "modelProvider", "modelProviderId", "soul", "updatedAt")
        VALUES
          ('0e8fd8f6-a54d-40e0-a705-87f50bdbc835', 'QA History One', 'qa-gfu24-e2e-1783942867', 'ready', 'agent--qa-history-one', '.homelab/agents/agent--qa-history-one', 'qa-provider-updated', NULL, '', NOW()),
          ('29199732-2d9f-447b-af87-e0f9bb2ffd73', 'QA History Two', 'qa-gfu25-20260714053638', 'ready', 'agent--qa-history-two', '.homelab/agents/agent--qa-history-two', 'openai', NULL, '', NOW()),
          ('a143df05-8d01-403d-a343-b2f869e7e544', 'QA History Three', 'qa-gfu24-rewrite-1783942911', 'ready', 'agent--qa-history-three', '.homelab/agents/agent--qa-history-three', 'qa-provider', NULL, '', NOW()),
          ('c3a11eb5-ede6-447d-b433-ab63fca7ca46', 'QA History Four', 'qa-gfu24-e2e-1783942816', 'ready', 'agent--qa-history-four', '.homelab/agents/agent--qa-history-four', 'qa-provider-updated', NULL, '', NOW()),
          ('f0000000-0000-4000-8000-000000000001', 'Non QA History', 'ops-history', 'ready', 'agent--ops-history', '.homelab/agents/agent--ops-history', 'old-ops-provider', NULL, '', NOW())
      `);

      const beforeFailedDeploy = await snapshotHistoryState(
        historyDb,
        historySchema,
      );
      expect(runCheck("preflight", undefined, historyUrl)).toMatchObject({
        preflightPassed: false,
        unresolved: [
          "0e8fd8f6-a54d-40e0-a705-87f50bdbc835",
          "29199732-2d9f-447b-af87-e0f9bb2ffd73",
          "a143df05-8d01-403d-a343-b2f869e7e544",
          "c3a11eb5-ede6-447d-b433-ab63fca7ca46",
          "f0000000-0000-4000-8000-000000000001",
        ],
        exitStatus: 2,
      });
      expect(() =>
        migrateDeploy(resolve(prismaRoot, "schema.prisma"), historyUrl),
      ).toThrow();
      await expect(
        snapshotHistoryState(historyDb, historySchema),
      ).resolves.toEqual(beforeFailedDeploy);

      migrateResolve(historyUrl, migrationName);
      expect(runCheck("plan", "history-provider", historyUrl)).toMatchObject({
        planPassed: false,
        writesExecuted: 0,
        remediationPlan: [
          {
            agentId: "0e8fd8f6-a54d-40e0-a705-87f50bdbc835",
            agentSlug: "qa-gfu24-e2e-1783942867",
            toProviderId: "history-provider",
            guardedSql: [
              'UPDATE "Agent"',
              "SET \"modelProvider\" = 'history-provider', \"modelProviderId\" = 'history-provider'",
              "WHERE \"id\" = '0e8fd8f6-a54d-40e0-a705-87f50bdbc835'",
              "  AND \"modelProvider\" IS NOT DISTINCT FROM 'qa-provider-updated'",
              '  AND "modelProviderId" IS NOT DISTINCT FROM NULL;',
            ].join("\n"),
          },
          {
            agentId: "29199732-2d9f-447b-af87-e0f9bb2ffd73",
            agentSlug: "qa-gfu25-20260714053638",
            toProviderId: "history-provider",
          },
          {
            agentId: "a143df05-8d01-403d-a343-b2f869e7e544",
            agentSlug: "qa-gfu24-rewrite-1783942911",
            toProviderId: "history-provider",
          },
          {
            agentId: "c3a11eb5-ede6-447d-b433-ab63fca7ca46",
            agentSlug: "qa-gfu24-e2e-1783942816",
            toProviderId: "history-provider",
          },
        ],
        nonQaBlockers: ["f0000000-0000-4000-8000-000000000001"],
        exitStatus: 2,
      });
      await expect(
        snapshotHistoryState(historyDb, historySchema),
      ).resolves.toEqual(beforeFailedDeploy);
      await historyDb.$executeRawUnsafe(`
        UPDATE "Agent"
        SET "modelProvider" = 'history-provider', "modelProviderId" = 'history-provider'
      `);

      migrateDeploy(resolve(prismaRoot, "schema.prisma"), historyUrl);
      await expect(
        historyDb.$queryRawUnsafe<Array<{ migration_name: string }>>(`
          SELECT migration_name FROM "_prisma_migrations"
          WHERE migration_name IN (
            '20260714073100_add_agent_chat_model_provider',
            '20260714083000_gfu29_agent_contract'
          ) AND finished_at IS NOT NULL
          ORDER BY migration_name
        `),
      ).resolves.toEqual([
        { migration_name: "20260714073100_add_agent_chat_model_provider" },
        { migration_name: "20260714083000_gfu29_agent_contract" },
      ]);
      await expect(
        historyDb.$queryRawUnsafe(`
          SELECT "modelProvider", "modelProviderId", "revision", "soulRevision"
          FROM "Agent"
          ORDER BY "id"
        `),
      ).resolves.toEqual([
        {
          modelProvider: "history-provider",
          modelProviderId: "history-provider",
          revision: 1,
          soulRevision: 1,
        },
        {
          modelProvider: "history-provider",
          modelProviderId: "history-provider",
          revision: 1,
          soulRevision: 1,
        },
        {
          modelProvider: "history-provider",
          modelProviderId: "history-provider",
          revision: 1,
          soulRevision: 1,
        },
        {
          modelProvider: "history-provider",
          modelProviderId: "history-provider",
          revision: 1,
          soulRevision: 1,
        },
        {
          modelProvider: "history-provider",
          modelProviderId: "history-provider",
          revision: 1,
          soulRevision: 1,
        },
      ]);
    } finally {
      await historyDb.$disconnect();
      await admin.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${historySchema}" CASCADE`,
      );
      rmSync(oldPrismaRoot, { recursive: true, force: true });
    }
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

  function migrateDeploy(schemaPath: string, datasourceUrl: string) {
    execFileSync(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath],
      {
        cwd: resolve(__dirname, ".."),
        env: { ...process.env, DATABASE_URL: datasourceUrl },
        stdio: "pipe",
      },
    );
  }

  function migrateResolve(datasourceUrl: string, rolledBackMigration: string) {
    execFileSync(
      "pnpm",
      [
        "exec",
        "prisma",
        "migrate",
        "resolve",
        "--rolled-back",
        rolledBackMigration,
        "--schema",
        resolve(prismaRoot, "schema.prisma"),
      ],
      {
        cwd: resolve(__dirname, ".."),
        env: { ...process.env, DATABASE_URL: datasourceUrl },
        stdio: "pipe",
      },
    );
  }

  function runCheck(
    action: "preflight" | "validate" | "plan",
    targetProviderId?: string,
    datasourceUrl = databaseUrl,
  ) {
    const scriptArgs = [checkScript, "--action", action];
    if (targetProviderId)
      scriptArgs.push("--target-provider-id", targetProviderId);
    const result = spawnSync(process.execPath, scriptArgs, {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: datasourceUrl },
    });
    return { ...JSON.parse(result.stdout), exitStatus: result.status };
  }

  async function snapshotState() {
    const columns = await db.$queryRawUnsafe<Array<{ column_name: string }>>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = 'Agent'
      ORDER BY column_name
    `);
    const agents = await db.$queryRawUnsafe(`
      SELECT "id", "modelProvider", "modelProviderId"
      FROM "Agent"
      ORDER BY "id"
    `);
    return { columns, agents };
  }

  async function snapshotHistoryState(
    client: PrismaClient,
    targetSchema: string,
  ) {
    const columns = await client.$queryRawUnsafe<
      Array<{ column_name: string }>
    >(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = '${targetSchema}' AND table_name = 'Agent'
      ORDER BY column_name
    `);
    const agents = await client.$queryRawUnsafe(`
      SELECT "id", "modelProvider", "modelProviderId"
      FROM "Agent"
      ORDER BY "id"
    `);
    return { columns, agents };
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
