import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ChangeAgentSkillDto } from "./dto/change-agent-skill.dto";
import { AgentSkillsService } from "./agent-skills.service";

@Controller("agents/:agentId/skills")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AgentSkillsController {
  constructor(private readonly skills: AgentSkillsService) {}

  @Get()
  list(@Param("agentId") agentId: string) {
    return this.skills.list(agentId);
  }

  @Get("changes/:changeId")
  getChange(@Param("agentId") agentId: string, @Param("changeId") changeId: string) {
    return this.skills.getChange(agentId, changeId);
  }

  @Post()
  install(@Param("agentId") agentId: string, @Body() dto: ChangeAgentSkillDto) {
    return this.skills.install(agentId, dto);
  }

  @Post("self-update")
  selfUpdate(@Param("agentId") agentId: string, @Body() dto: ChangeAgentSkillDto) {
    return this.skills.selfUpdate(agentId, dto);
  }

  @Patch(":skillName")
  update(@Param("agentId") agentId: string, @Param("skillName") skillName: string, @Body() dto: ChangeAgentSkillDto) {
    return this.skills.update(agentId, skillName, dto);
  }

  @Delete(":skillName")
  remove(@Param("agentId") agentId: string, @Param("skillName") skillName: string, @Body() dto: ChangeAgentSkillDto) {
    return this.skills.remove(agentId, skillName, dto);
  }
}
