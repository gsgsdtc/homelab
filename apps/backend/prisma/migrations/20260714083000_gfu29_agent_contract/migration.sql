-- Expand-only GFU-29 migration. The legacy "modelProvider" column remains
-- available for application rollback during the compatibility window.
ALTER TABLE "Agent"
  ADD COLUMN "modelProviderId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "soulRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "AgentWorkflow" ADD COLUMN "editRevision" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "Agent_modelProviderId_idx" ON "Agent"("modelProviderId");

-- Backfill explicit legacy values by Provider ID first.
UPDATE "Agent" AS agent
SET "modelProviderId" = provider."id"
FROM "ModelProvider" AS provider
WHERE NULLIF(BTRIM(agent."modelProvider"), '') IS NOT NULL
  AND provider."isActive" = TRUE
  AND provider."id" = BTRIM(agent."modelProvider");

-- Only values not matched by ID may use the unique normalized Provider name.
UPDATE "Agent" AS agent
SET "modelProviderId" = provider."id"
FROM "ModelProvider" AS provider
WHERE NULLIF(BTRIM(agent."modelProvider"), '') IS NOT NULL
  AND agent."modelProviderId" IS NULL
  AND provider."isActive" = TRUE
  AND provider."nameKey" = LOWER(BTRIM(agent."modelProvider"));

-- Abort rather than silently defaulting unresolved or disabled explicit values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Agent"
    WHERE NULLIF(BTRIM("modelProvider"), '') IS NOT NULL
      AND "modelProviderId" IS NULL
  ) THEN
    RAISE EXCEPTION 'GFU-29 provider preflight failed: unresolved or disabled legacy Agent provider';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Agent"
    WHERE NULLIF(BTRIM("modelProvider"), '') IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM "ModelProvider"
    WHERE "isDefault" = TRUE AND "isActive" = TRUE
  ) THEN
    RAISE EXCEPTION 'GFU-29 provider preflight failed: enabled default Provider is required';
  END IF;
END $$;

ALTER TABLE "Agent"
  ADD CONSTRAINT "Agent_modelProviderId_fkey"
  FOREIGN KEY ("modelProviderId") REFERENCES "ModelProvider"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AgentCreateRequest" (
  "key" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentCreateRequest_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "AgentCreateRequest_agentId_key" ON "AgentCreateRequest"("agentId");
ALTER TABLE "AgentCreateRequest"
  ADD CONSTRAINT "AgentCreateRequest_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentSkillCatalogSkill" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentSkillCatalogSkill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentSkillCatalogSkill_sourceId_skillId_key" ON "AgentSkillCatalogSkill"("sourceId", "skillId");
CREATE INDEX "AgentSkillCatalogSkill_sourceId_name_idx" ON "AgentSkillCatalogSkill"("sourceId", "name");
ALTER TABLE "AgentSkillCatalogSkill" ADD CONSTRAINT "AgentSkillCatalogSkill_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "AgentSkillSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentSkillCatalogVersion" (
  "id" TEXT NOT NULL,
  "catalogSkillId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "immutableRef" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentSkillCatalogVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentSkillCatalogVersion_catalogSkillId_version_key" ON "AgentSkillCatalogVersion"("catalogSkillId", "version");
CREATE INDEX "AgentSkillCatalogVersion_catalogSkillId_createdAt_idx" ON "AgentSkillCatalogVersion"("catalogSkillId", "createdAt");
ALTER TABLE "AgentSkillCatalogVersion" ADD CONSTRAINT "AgentSkillCatalogVersion_catalogSkillId_fkey"
  FOREIGN KEY ("catalogSkillId") REFERENCES "AgentSkillCatalogSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
