import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateModelProviderDto } from "./dto/create-model-provider.dto";
import { TestModelProviderConnectionDto } from "./dto/test-model-provider-connection.dto";
import { UpdateModelProviderDto } from "./dto/update-model-provider.dto";
import { ModelProvidersService } from "./model-providers.service";

@Controller("model-providers")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class ModelProvidersController {
  constructor(private readonly providers: ModelProvidersService) {}

  @Get()
  list() {
    return this.providers.list();
  }

  @Post()
  create(@Body() dto: CreateModelProviderDto) {
    return this.providers.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateModelProviderDto) {
    return this.providers.update(id, dto);
  }

  @Post(":id/default")
  setDefault(@Param("id") id: string) {
    return this.providers.setDefault(id);
  }

  @Post(":id/enable")
  enable(@Param("id") id: string) {
    return this.providers.setActive(id, true);
  }

  @Post(":id/disable")
  disable(@Param("id") id: string) {
    return this.providers.setActive(id, false);
  }

  @Post("test-connection")
  testConnection(@Body() dto: TestModelProviderConnectionDto) {
    return this.providers.testConnection(dto);
  }
}
