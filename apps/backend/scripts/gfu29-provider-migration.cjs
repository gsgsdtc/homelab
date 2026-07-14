#!/usr/bin/env node
"use strict";

const { PrismaClient } = require("@prisma/client");

const args = parseArgs(process.argv.slice(2));
const action = args.action || "preflight";
if (action !== "preflight" && action !== "validate") {
  fail(
    "INVALID_PROVIDER_MIGRATION_ACTION",
    "--action must be preflight or validate",
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
      action === "preflight" ? await preflight() : await validate();
    output(report);
    if (report.preflightPassed === false || report.validationPassed === false)
      process.exitCode = 2;
  } catch (error) {
    fail("PROVIDER_MIGRATION_CHECK_FAILED", safeMessage(error));
  }
}

async function preflight() {
  // This action contains SELECT statements only. Deployment invokes it before
  // `prisma migrate deploy`; the migration repeats the gate transactionally.
  const rows = await prisma.$queryRawUnsafe(`
    WITH mapping AS (
      SELECT agent."id" AS "agentId",
             NULLIF(BTRIM(agent."modelProvider"), '') AS legacy,
             id_provider."id" AS "idMatch",
             name_provider."id" AS "nameMatch",
             COALESCE(id_provider."isActive", name_provider."isActive") AS "targetActive"
      FROM "Agent" AS agent
      LEFT JOIN "ModelProvider" AS id_provider
        ON id_provider."id" = BTRIM(agent."modelProvider")
      LEFT JOIN "ModelProvider" AS name_provider
        ON id_provider."id" IS NULL
       AND name_provider."nameKey" = LOWER(BTRIM(agent."modelProvider"))
    )
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE legacy IS NOT NULL AND "idMatch" IS NOT NULL)::int AS "mappedById",
           COUNT(*) FILTER (WHERE legacy IS NOT NULL AND "idMatch" IS NULL AND "nameMatch" IS NOT NULL)::int AS "mappedByName",
           COUNT(*) FILTER (WHERE legacy IS NULL)::int AS defaulted,
           COALESCE(ARRAY_AGG("agentId" ORDER BY "agentId") FILTER (
             WHERE legacy IS NOT NULL AND "idMatch" IS NULL AND "nameMatch" IS NULL
           ), ARRAY[]::text[]) AS unresolved,
           COALESCE(ARRAY_AGG("agentId" ORDER BY "agentId") FILTER (
             WHERE legacy IS NOT NULL AND ("idMatch" IS NOT NULL OR "nameMatch" IS NOT NULL) AND "targetActive" IS NOT TRUE
           ), ARRAY[]::text[]) AS disabled
    FROM mapping
  `);
  const defaults = await prisma.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM "ModelProvider" WHERE "isDefault" = TRUE AND "isActive" = TRUE
    ) AS "hasEnabledDefault"
  `);
  const row = rows[0];
  const missingDefault = row.defaulted > 0 && !defaults[0].hasEnabledDefault;
  return {
    action: "preflight",
    status: "ready",
    preflightPassed:
      row.unresolved.length === 0 &&
      row.disabled.length === 0 &&
      !missingDefault,
    total: row.total,
    mappedById: row.mappedById,
    mappedByName: row.mappedByName,
    defaulted: row.defaulted,
    unresolved: row.unresolved,
    disabled: row.disabled,
    missingDefault,
  };
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
