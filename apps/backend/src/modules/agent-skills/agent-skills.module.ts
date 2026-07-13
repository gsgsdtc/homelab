import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AgentSkillsController } from "./agent-skills.controller";
import { AgentSkillsService } from "./agent-skills.service";
import { AgentSkillWorkspaceStore } from "./agent-skill-workspace.store";
import { RuntimeReloadClient } from "./runtime-reload.client";
import { SkillPackageValidator } from "./skill-package-validator.service";

@Module({
  imports: [PrismaModule],
  controllers: [AgentSkillsController],
  providers: [AgentSkillsService, AgentSkillWorkspaceStore, RuntimeReloadClient, SkillPackageValidator],
  exports: [AgentSkillsService]
})
export class AgentSkillsModule {}
