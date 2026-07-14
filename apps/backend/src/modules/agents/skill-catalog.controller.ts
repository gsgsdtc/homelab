import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SkillCatalogService } from "./skill-catalog.service";

@Controller("skill-catalog")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class SkillCatalogController {
  constructor(private readonly catalog: SkillCatalogService) {}

  @Get("sources")
  sources(@Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.catalog.sources(this.page(page, pageSize));
  }

  @Get("sources/:sourceId/skills")
  skills(@Param("sourceId") sourceId: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.catalog.skills(sourceId, this.page(page, pageSize));
  }

  @Get("sources/:sourceId/skills/:skillId/versions")
  versions(@Param("sourceId") sourceId: string, @Param("skillId") skillId: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.catalog.versions(sourceId, skillId, this.page(page, pageSize));
  }

  private page(page?: string, pageSize?: string) {
    return {
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize)
    };
  }
}
