import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AgentsService } from "./agents.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
import { UpdateAgentDto } from "./dto/update-agent.dto";

@Controller("agents")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list() {
    return this.agents.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.agents.get(id);
  }

  @Post()
  create(@Body() dto: CreateAgentDto) {
    return this.agents.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.update(id, dto);
  }

  @Post(":id/retry-initialization")
  retryInitialization(@Param("id") id: string) {
    return this.agents.retryInitialization(id);
  }
}
