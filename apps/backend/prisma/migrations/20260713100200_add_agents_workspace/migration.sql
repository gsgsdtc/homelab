-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('initializing', 'ready', 'init_failed');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'initializing',
    "workspaceName" TEXT NOT NULL,
    "workspacePath" TEXT NOT NULL,
    "modelProvider" TEXT,
    "modelSecretRef" TEXT,
    "soul" TEXT NOT NULL DEFAULT '',
    "initializationError" TEXT,
    "initializedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_workspaceName_key" ON "Agent"("workspaceName");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_workspacePath_key" ON "Agent"("workspacePath");
