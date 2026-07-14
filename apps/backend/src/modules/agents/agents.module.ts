import { Module } from "@nestjs/common";
import { AppKeysModule } from "../app-keys/app-keys.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AgentSkillsController, AgentSkillsSelfUpdateController } from "./agent-skills.controller";
import { AgentSkillsService } from "./agent-skills.service";
import { AgentWorkspaceService } from "./agent-workspace.service";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { RuntimeReloadClient } from "./runtime-reload-client.service";
import { SkillPackageValidator } from "./skill-package-validator.service";

@Module({
  imports: [PrismaModule, AppKeysModule],
  controllers: [AgentsController, AgentSkillsController, AgentSkillsSelfUpdateController],
  providers: [AgentsService, AgentSkillsService, AgentWorkspaceService, SkillPackageValidator, RuntimeReloadClient],
  exports: [AgentsService]
})
export class AgentsModule {}
