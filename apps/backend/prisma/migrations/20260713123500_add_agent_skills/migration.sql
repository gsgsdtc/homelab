-- CreateEnum
CREATE TYPE "AgentSkillSourceType" AS ENUM ('registry', 'git');

-- CreateEnum
CREATE TYPE "AgentSkillOperation" AS ENUM ('install', 'update', 'remove');

-- CreateEnum
CREATE TYPE "AgentSkillActorType" AS ENUM ('admin', 'agent');

-- CreateEnum
CREATE TYPE "AgentSkillChangeStatus" AS ENUM ('pending', 'validating', 'applying', 'reloading', 'succeeded', 'failed', 'rolled_back', 'rollback_failed');

-- CreateEnum
CREATE TYPE "AgentSkillReloadStatus" AS ENUM ('loaded', 'failed', 'pending_restart', 'runtime_offline', 'unknown');

-- CreateEnum
CREATE TYPE "AgentSkillAuditStatus" AS ENUM ('audit_written', 'audit_pending', 'audit_failed');

-- CreateEnum
CREATE TYPE "AgentSkillRollbackResult" AS ENUM ('not_required', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "AgentSkillFailedStage" AS ENUM ('permission', 'audit_init', 'source_validation', 'version_resolution', 'manifest_validation', 'staging_write', 'atomic_switch', 'reload', 'rollback', 'audit_write', 'concurrency_lock');

-- CreateTable
CREATE TABLE "AgentSkillSource" (
    "id" TEXT NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL,
    "label" TEXT NOT NULL,
    "registryKey" TEXT,
    "gitUrl" TEXT,
    "isTrusted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSkillSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkillInstallation" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "systemRequired" BOOLEAN NOT NULL DEFAULT false,
    "selfUpdateAllowed" BOOLEAN NOT NULL DEFAULT false,
    "lastChangeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSkillInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkillChange" (
    "id" TEXT NOT NULL,
    "actorType" "AgentSkillActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetAgentId" TEXT NOT NULL,
    "operation" "AgentSkillOperation" NOT NULL,
    "skillName" TEXT NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL,
    "sourceId" TEXT,
    "requestedVersion" TEXT,
    "resolvedVersion" TEXT,
    "previousVersion" TEXT,
    "previousConfigVersion" TEXT,
    "activeConfigVersion" TEXT,
    "stagedConfigVersion" TEXT,
    "changeStatus" "AgentSkillChangeStatus" NOT NULL DEFAULT 'pending',
    "reloadStatus" "AgentSkillReloadStatus" NOT NULL DEFAULT 'unknown',
    "auditStatus" "AgentSkillAuditStatus" NOT NULL DEFAULT 'audit_pending',
    "rollbackResult" "AgentSkillRollbackResult" NOT NULL DEFAULT 'not_required',
    "failedStage" "AgentSkillFailedStage",
    "errorCode" TEXT,
    "safeErrorSummary" TEXT,
    "effectiveFor" TEXT NOT NULL DEFAULT 'next_task',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSkillChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkillSelfUpdatePolicy" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "operation" "AgentSkillOperation" NOT NULL,
    "skillName" TEXT NOT NULL,
    "sourceType" "AgentSkillSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "versionConstraint" TEXT NOT NULL,
    "allowPrerelease" BOOLEAN NOT NULL DEFAULT false,
    "allowLatest" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSkillSelfUpdatePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkillInstallation_agentId_skillName_key" ON "AgentSkillInstallation"("agentId", "skillName");

-- CreateIndex
CREATE INDEX "AgentSkillInstallation_agentId_idx" ON "AgentSkillInstallation"("agentId");

-- CreateIndex
CREATE INDEX "AgentSkillInstallation_sourceId_idx" ON "AgentSkillInstallation"("sourceId");

-- CreateIndex
CREATE INDEX "AgentSkillChange_targetAgentId_changeStatus_idx" ON "AgentSkillChange"("targetAgentId", "changeStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkillChange_one_active_per_agent_key" ON "AgentSkillChange"("targetAgentId") WHERE "changeStatus" IN ('pending', 'validating', 'applying', 'reloading', 'rollback_failed');

-- CreateIndex
CREATE INDEX "AgentSkillChange_targetAgentId_createdAt_idx" ON "AgentSkillChange"("targetAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSkillChange_sourceId_idx" ON "AgentSkillChange"("sourceId");

-- CreateIndex
CREATE INDEX "AgentSkillSelfUpdatePolicy_agentId_operation_skillName_idx" ON "AgentSkillSelfUpdatePolicy"("agentId", "operation", "skillName");

-- CreateIndex
CREATE INDEX "AgentSkillSelfUpdatePolicy_sourceId_idx" ON "AgentSkillSelfUpdatePolicy"("sourceId");

-- AddForeignKey
ALTER TABLE "AgentSkillInstallation" ADD CONSTRAINT "AgentSkillInstallation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillInstallation" ADD CONSTRAINT "AgentSkillInstallation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "AgentSkillSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillChange" ADD CONSTRAINT "AgentSkillChange_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillChange" ADD CONSTRAINT "AgentSkillChange_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "AgentSkillSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillSelfUpdatePolicy" ADD CONSTRAINT "AgentSkillSelfUpdatePolicy_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillSelfUpdatePolicy" ADD CONSTRAINT "AgentSkillSelfUpdatePolicy_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "AgentSkillSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
