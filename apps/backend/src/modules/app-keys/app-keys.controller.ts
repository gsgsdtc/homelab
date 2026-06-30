import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AppKeysService } from "./app-keys.service";
import { CreateAppKeyDto } from "./dto/create-app-key.dto";

@Controller("app-keys")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AppKeysController {
  constructor(private readonly appKeys: AppKeysService) {}

  @Get()
  list() {
    return this.appKeys.list();
  }

  @Post()
  create(@Body() dto: CreateAppKeyDto) {
    return this.appKeys.create(dto);
  }

  @Delete(":id")
  async revoke(@Param("id") id: string) {
    await this.appKeys.revoke(id);
    return { revoked: true };
  }
}
