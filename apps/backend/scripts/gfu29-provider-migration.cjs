#!/usr/bin/env node
"use strict";

const { PrismaClient } = require("@prisma/client");

const args = parseArgs(process.argv.slice(2));
const action = args.action || "preflight";
if (action !== "preflight" && action !== "validate" && action !== "plan") {
  fail(
    "INVALID_PROVIDER_MIGRATION_ACTION",
    "--action must be preflight, plan, or validate",
  );
}
if (!process.env.DATABASE_URL)
  fail("DATABASE_URL_REQUIRED", "DATABASE_URL is required");

const prisma = new PrismaClient();
main().finally(() => prisma.$disconnect());

async function main() {
  try {
    const tables = await prisma.$queryRawUnsafe(`
      SELECT to_regclass('"Agent"')::text AS agent,
             to_regclass('"ModelProvider"')::text AS provider
    `);
    if (!tables[0]?.agent || !tables[0]?.provider) {
      output({
        action,
        status: "ready",
        preflightPassed: true,
        skipped: "schema_not_initialized",
      });
      return;
    }
    const report =
      action === "preflight"
        ? await preflight()
        : action === "plan"
          ? await plan(args["target-provider-id"])
          : await validate();
    output(report);
    if (
      report.preflightPassed === false ||
      report.planPassed === false ||
      report.validationPassed === false
    )
      process.exitCode = 2;
  } catch (error) {
    fail("PROVIDER_MIGRATION_CHECK_FAILED", safeMessage(error));
  }
}

async function preflight() {
  // This action contains SELECT statements only. Deployment invokes it before
  // `prisma migrate deploy`; the migration repeats the gate transactionally.
  const { mappings, hasEnabledDefault } = await providerMappings();
  const issues = mappings.flatMap((row) => {
    const reason = mappingIssue(row);
    return reason
      ? [
          {
            agentId: row.agentId,
            legacyProvider: row.legacy,
            modelProviderId: row.modelProviderId,
            reason,
          },
        ]
      : [];
  });
  const unresolved = issues
    .filter((issue) => issue.reason === "unresolved")
    .map((issue) => issue.agentId);
  const disabled = issues
    .filter((issue) => issue.reason === "disabled")
    .map((issue) => issue.agentId);
  const defaulted = mappings.filter((row) => row.legacy === null).length;
  const missingDefault = defaulted > 0 && !hasEnabledDefault;
  return {
    action: "preflight",
    status: "ready",
    preflightPassed: issues.length === 0 && !missingDefault,
    total: mappings.length,
    mappedById: mappings.filter(
      (row) => row.legacy !== null && row.idMatch !== null,
    ).length,
    mappedByName: mappings.filter(
      (row) =>
        row.legacy !== null && row.idMatch === null && row.nameMatch !== null,
    ).length,
    defaulted,
    unresolved,
    disabled,
    issues,
    missingDefault,
  };
}

async function plan(targetProviderId) {
  if (!targetProviderId) {
    return {
      action: "plan",
      status: "error",
      planPassed: false,
      reason: "target_provider_id_required",
      message: "--target-provider-id must be an exact enabled Provider ID",
    };
  }
  const targets = await prisma.$queryRawUnsafe(
    `SELECT "id", "isActive" FROM "ModelProvider" WHERE "id" = $1`,
    targetProviderId,
  );
  if (targets.length !== 1 || targets[0].isActive !== true) {
    return {
      action: "plan",
      status: "error",
      planPassed: false,
      targetProviderId,
      reason: "target_provider_missing_or_disabled",
    };
  }

  const { mappings } = await providerMappings();
  const blocked = mappings
    .map((row) => ({ row, reason: mappingIssue(row) }))
    .filter(({ reason }) => reason !== null);
  const nonQaBlockers = blocked
    .filter(({ row }) => !row.agentId.startsWith("qa-"))
    .map(({ row }) => row.agentId);
  const remediationPlan = blocked
    .filter(({ row }) => row.agentId.startsWith("qa-"))
    .map(({ row, reason }) => ({
      agentId: row.agentId,
      fromLegacyProvider: row.legacy,
      fromModelProviderId: row.modelProviderId,
      toProviderId: targetProviderId,
      reason,
      guardedSql: guardedUpdate(row, targetProviderId),
    }));
  return {
    action: "plan",
    status: nonQaBlockers.length === 0 ? "ready" : "error",
    planPassed: nonQaBlockers.length === 0,
    targetProviderId,
    remediationPlan,
    nonQaBlockers,
    writesExecuted: 0,
  };
}

async function providerMappings() {
  const columns = await prisma.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Agent'
        AND column_name = 'modelProviderId'
    ) AS expanded
  `);
  const providerIdProjection = columns[0].expanded
    ? 'agent."modelProviderId"'
    : "NULL::text";
  const mappings = await prisma.$queryRawUnsafe(`
    WITH mapping AS (
      SELECT agent."id" AS "agentId",
             NULLIF(BTRIM(agent."modelProvider"), '') AS legacy,
             ${providerIdProjection} AS "modelProviderId",
             id_provider."id" AS "idMatch",
             name_provider."id" AS "nameMatch",
             COALESCE(id_provider."isActive", name_provider."isActive") AS "targetActive",
             primary_provider."isActive" AS "primaryActive"
      FROM "Agent" AS agent
      LEFT JOIN "ModelProvider" AS id_provider
        ON id_provider."id" = BTRIM(agent."modelProvider")
      LEFT JOIN "ModelProvider" AS name_provider
        ON id_provider."id" IS NULL
       AND name_provider."nameKey" = LOWER(BTRIM(agent."modelProvider"))
      LEFT JOIN "ModelProvider" AS primary_provider
        ON primary_provider."id" = ${providerIdProjection}
    )
    SELECT * FROM mapping ORDER BY "agentId"
  `);
  const defaults = await prisma.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM "ModelProvider" WHERE "isDefault" = TRUE AND "isActive" = TRUE
    ) AS "hasEnabledDefault"
  `);
  return { mappings, hasEnabledDefault: defaults[0].hasEnabledDefault };
}

function mappingIssue(row) {
  if (row.legacy !== null && row.idMatch === null && row.nameMatch === null)
    return "unresolved";
  if (row.legacy !== null && row.targetActive !== true) return "disabled";
  if (row.modelProviderId !== null && row.primaryActive !== true)
    return "primary_unresolved_or_disabled";
  const resolvedId = row.idMatch ?? row.nameMatch;
  if (
    row.legacy !== null &&
    row.modelProviderId !== null &&
    resolvedId !== row.modelProviderId
  )
    return "column_drift";
  return null;
}

function guardedUpdate(row, targetProviderId) {
  return [
    'UPDATE "Agent"',
    `SET "modelProvider" = ${sqlLiteral(targetProviderId)}, "modelProviderId" = ${sqlLiteral(targetProviderId)}`,
    `WHERE "id" = ${sqlLiteral(row.agentId)}`,
    `  AND "modelProvider" IS NOT DISTINCT FROM ${sqlLiteral(row.legacy)}`,
    `  AND "modelProviderId" IS NOT DISTINCT FROM ${sqlLiteral(row.modelProviderId)};`,
  ].join("\n");
}

function sqlLiteral(value) {
  if (value === null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function validate() {
  const columns = await prisma.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Agent'
        AND column_name = 'modelProviderId'
    ) AS expanded
  `);
  if (!columns[0].expanded) {
    return {
      action: "validate",
      status: "error",
      validationPassed: false,
      reason: "schema_not_expanded",
    };
  }
  const rows = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(agent."modelProvider"), '') IS NOT NULL
               AND agent."modelProviderId" IS NULL
           )::int AS unresolved,
           COUNT(*) FILTER (
             WHERE COALESCE(NULLIF(BTRIM(agent."modelProvider"), ''), '')
                   IS DISTINCT FROM COALESCE(agent."modelProviderId", '')
           )::int AS "dualWriteDrift",
           COUNT(*) FILTER (
             WHERE agent."modelProviderId" IS NOT NULL AND provider."isActive" IS NOT TRUE
           )::int AS disabled
    FROM "Agent" AS agent
    LEFT JOIN "ModelProvider" AS provider ON provider."id" = agent."modelProviderId"
  `);
  const row = rows[0];
  return {
    action: "validate",
    status: "ready",
    validationPassed:
      row.unresolved === 0 && row.dualWriteDrift === 0 && row.disabled === 0,
    ...row,
  };
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--") || values[index + 1] === undefined) {
      fail(
        "INVALID_PROVIDER_MIGRATION_ARGUMENTS",
        "arguments use --key value pairs",
      );
    }
    parsed[key.slice(2)] = values[index + 1];
  }
  return parsed;
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
  process.exitCode = 1;
}
