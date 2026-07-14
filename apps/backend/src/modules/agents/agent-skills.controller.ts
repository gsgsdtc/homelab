import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtUser } from "../../common/types/jwt-user";
import { AppKeyIdentity } from "../app-keys/app-keys.service";
import { AppKeyGuard } from "../app-keys/app-key.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AgentSkillsService } from "./agent-skills.service";
import {
  AgentSkillInstallDto,
  AgentSkillRemoveDto,
  AgentSkillSelfUpdateDto,
  AgentSkillUpdateDto
} from "./dto/agent-skill-change.dto";

@Controller("agents/:id/skills")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AgentSkillsController {
  constructor(private readonly skills: AgentSkillsService) {}

  @Get()
  list(@Param("id") id: string) {
    return this.skills.list(id);
  }

  @Get("changes/:changeId")
  getChange(@Param("id") id: string, @Param("changeId") changeId: string) {
    return this.skills.getChange(id, changeId);
  }

  @Post("install")
  install(@Param("id") id: string, @Body() dto: AgentSkillInstallDto, @CurrentUser() user: JwtUser) {
    return this.skills.installAdmin(id, dto, user.sub);
  }

  @Post("update")
  update(@Param("id") id: string, @Body() dto: AgentSkillUpdateDto, @CurrentUser() user: JwtUser) {
    return this.skills.updateAdmin(id, dto, user.sub);
  }

  @Post("remove")
  remove(@Param("id") id: string, @Body() dto: AgentSkillRemoveDto, @CurrentUser() user: JwtUser) {
    return this.skills.removeAdmin(id, dto, user.sub);
  }
}

@Controller("agent-skills")
export class AgentSkillsSelfUpdateController {
  constructor(private readonly skills: AgentSkillsService) {}

  @Post("self-update")
  @UseGuards(AppKeyGuard)
  selfUpdate(@Req() request: Request & { appIdentity?: AppKeyIdentity }, @Body() dto: AgentSkillSelfUpdateDto) {
    if (!request.appIdentity) {
      throw new Error("missing app identity");
    }
    return this.skills.selfUpdate(request.appIdentity, dto);
  }
}
