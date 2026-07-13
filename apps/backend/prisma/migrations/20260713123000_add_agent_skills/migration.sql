CREATE TYPE "AgentSkillSourceType" AS ENUM ('registry', 'trusted_git', 'system');
CREATE TYPE "AgentSkillOperation" AS ENUM ('install', 'update', 'remove', 'self_update');
CREATE TYPE "AgentSkillChangeStatus" AS ENUM ('pending', 'validating', 'applying', 'reloading', 'succeeded', 'failed', 'rolled_back', 'rollback_failed');
CREATE TYPE "AgentSkillReloadStatus" AS ENUM ('loaded', 'failed', 'pending_restart', 'runtime_offline', 'unknown');
CREATE TYPE "AgentSkillAuditStatus" AS ENUM ('audit_written', 'audit_pending', 'audit_failed');
CREATE TYPE "AgentSkillRollbackResult" AS ENUM ('not_required', 'succeeded', 'failed', 'skipped');
CREATE TYPE "AgentSkillChangeResult" AS ENUM ('pending', 'succeeded', 'rejected', 'failed', 'rolled_back', 'rollback_failed', 'pending_restart', 'runtime_offline');

CREATE TABLE "TrustedSkillSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL DEFAULT 'trusted_git',
    "url" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrustedSkillSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL,
    "sourceId" TEXT,
    "version" TEXT NOT NULL,
    "commitSha" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "systemRequired" BOOLEAN NOT NULL DEFAULT false,
    "selfUpdateAllowed" BOOLEAN NOT NULL DEFAULT false,
    "activeConfigVersion" TEXT,
    "lastChangeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentSkillChange" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'admin',
    "actorId" TEXT,
    "operation" "AgentSkillOperation" NOT NULL,
    "skillName" TEXT NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL,
    "sourceId" TEXT,
    "requestedVersion" TEXT NOT NULL,
    "resolvedVersion" TEXT,
    "commitSha" TEXT,
    "previousVersion" TEXT,
    "previousConfigVersion" TEXT,
    "activeConfigVersion" TEXT,
    "stagedConfigVersion" TEXT,
    "result" "AgentSkillChangeResult" NOT NULL DEFAULT 'pending',
    "changeStatus" "AgentSkillChangeStatus" NOT NULL DEFAULT 'pending',
    "reloadStatus" "AgentSkillReloadStatus" NOT NULL DEFAULT 'unknown',
    "auditStatus" "AgentSkillAuditStatus" NOT NULL DEFAULT 'audit_written',
    "rollbackResult" "AgentSkillRollbackResult" NOT NULL DEFAULT 'not_required',
    "failedStage" TEXT,
    "errorCode" TEXT,
    "safeErrorSummary" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "AgentSkillChange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentSkillSelfUpdatePolicy" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "operation" "AgentSkillOperation" NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL,
    "sourceId" TEXT,
    "versionConstraint" TEXT NOT NULL,
    "allowLatest" BOOLEAN NOT NULL DEFAULT false,
    "allowPrerelease" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentSkillSelfUpdatePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentSkill_agentId_skillName_key" ON "AgentSkill"("agentId", "skillName");
CREATE INDEX "AgentSkill_agentId_idx" ON "AgentSkill"("agentId");
CREATE INDEX "AgentSkill_sourceId_idx" ON "AgentSkill"("sourceId");
CREATE INDEX "AgentSkillChange_agentId_changeStatus_idx" ON "AgentSkillChange"("agentId", "changeStatus");
CREATE INDEX "AgentSkillChange_agentId_createdAt_idx" ON "AgentSkillChange"("agentId", "createdAt");
CREATE INDEX "AgentSkillChange_sourceId_idx" ON "AgentSkillChange"("sourceId");
CREATE INDEX "AgentSkillSelfUpdatePolicy_agentId_skillName_idx" ON "AgentSkillSelfUpdatePolicy"("agentId", "skillName");

ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrustedSkillSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentSkillChange" ADD CONSTRAINT "AgentSkillChange_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentSkillChange" ADD CONSTRAINT "AgentSkillChange_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrustedSkillSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentSkillSelfUpdatePolicy" ADD CONSTRAINT "AgentSkillSelfUpdatePolicy_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
