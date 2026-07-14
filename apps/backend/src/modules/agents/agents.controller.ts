import { Body, Controller, Get, Headers, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AgentsService } from "./agents.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
import { SaveAgentSoulDto } from "./dto/save-agent-soul.dto";
import { UpdateAgentDto } from "./dto/update-agent.dto";

@Controller("agents")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list(@Query("query") query?: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.agents.list({
      query,
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize)
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.agents.get(id);
  }

  @Post()
  create(@Body() dto: CreateAgentDto, @Headers("idempotency-key") idempotencyKey?: string) {
    return this.agents.create(dto, idempotencyKey?.trim() || undefined);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.update(id, dto);
  }

  @Get(":id/soul")
  getSoul(@Param("id") id: string) {
    return this.agents.getSoul(id);
  }

  @Put(":id/soul")
  saveSoul(@Param("id") id: string, @Body() dto: SaveAgentSoulDto) {
    return this.agents.saveSoul(id, dto);
  }

  @Post(":id/retry-initialization")
  retryInitialization(@Param("id") id: string) {
    return this.agents.retryInitialization(id);
  }
}
