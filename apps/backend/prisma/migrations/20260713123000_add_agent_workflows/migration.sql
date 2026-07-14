-- CreateEnum
CREATE TYPE "WorkflowReloadStatus" AS ENUM ('draft', 'loading', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "AgentWorkflow" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "extension" TEXT NOT NULL DEFAULT 'ts',
    "relativePath" TEXT NOT NULL,
    "draftHash" TEXT,
    "activeHash" TEXT,
    "revision" TEXT,
    "reloadStatus" "WorkflowReloadStatus" NOT NULL DEFAULT 'draft',
    "reloadError" TEXT,
    "loadedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWorkflowVersion" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "extension" TEXT NOT NULL DEFAULT 'ts',
    "relativePath" TEXT NOT NULL,
    "createdById" TEXT,
    "promotedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rollbackOfVersionId" TEXT,

    CONSTRAINT "AgentWorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflow_agentId_workflowKey_key" ON "AgentWorkflow"("agentId", "workflowKey");

-- CreateIndex
CREATE INDEX "AgentWorkflow_agentId_reloadStatus_idx" ON "AgentWorkflow"("agentId", "reloadStatus");

-- CreateIndex
CREATE INDEX "AgentWorkflowVersion_workflowId_promotedAt_idx" ON "AgentWorkflowVersion"("workflowId", "promotedAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowVersion_workflowId_sourceHash_idx" ON "AgentWorkflowVersion"("workflowId", "sourceHash");

-- AddForeignKey
ALTER TABLE "AgentWorkflow" ADD CONSTRAINT "AgentWorkflow_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowVersion" ADD CONSTRAINT "AgentWorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "AgentWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowVersion" ADD CONSTRAINT "AgentWorkflowVersion_rollbackOfVersionId_fkey" FOREIGN KEY ("rollbackOfVersionId") REFERENCES "AgentWorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
