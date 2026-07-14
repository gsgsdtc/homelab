import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

interface CatalogPage {
  page?: number;
  pageSize?: number;
}

@Injectable()
export class SkillCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async sources(input: CatalogPage = {}) {
    const { page, pageSize } = this.page(input);
    const where = { isTrusted: true };
    const [rows, total] = await Promise.all([
      this.prisma.agentSkillSource.findMany({
        where,
        select: { id: true, sourceType: true, label: true },
        orderBy: [{ label: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.agentSkillSource.count({ where })
    ]);
    return {
      items: rows.map((source) => ({
        id: source.id,
        sourceType: source.sourceType,
        label: source.label
      })),
      total,
      page,
      pageSize
    };
  }

  async skills(sourceId: string, input: CatalogPage = {}) {
    await this.assertTrustedSource(sourceId);
    const { page, pageSize } = this.page(input);
    const where = { sourceId };
    const [rows, total] = await Promise.all([
      this.prisma.agentSkillCatalogSkill.findMany({
        where,
        select: { skillId: true, name: true, description: true },
        orderBy: [{ name: "asc" }, { skillId: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.agentSkillCatalogSkill.count({ where })
    ]);
    return { items: rows, total, page, pageSize };
  }

  async versions(sourceId: string, skillId: string, input: CatalogPage = {}) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(skillId)) {
      throw new BadRequestException({
        code: "INVALID_SKILL_ID",
        message: "Skill ID is not URL-safe"
      });
    }
    await this.assertTrustedSource(sourceId);
    const skill = await this.prisma.agentSkillCatalogSkill.findUnique({
      where: { sourceId_skillId: { sourceId, skillId } },
      select: { id: true }
    });
    if (!skill) {
      throw new NotFoundException({
        code: "SUBRESOURCE_NOT_FOUND",
        message: "Catalog Skill not found"
      });
    }
    const { page, pageSize } = this.page(input);
    const where = { catalogSkillId: skill.id };
    const [rows, total] = await Promise.all([
      this.prisma.agentSkillCatalogVersion.findMany({
        where,
        select: { version: true, immutableRef: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.agentSkillCatalogVersion.count({ where })
    ]);
    return { items: rows, total, page, pageSize };
  }

  private async assertTrustedSource(sourceId: string) {
    const source = await this.prisma.agentSkillSource.findUnique({
      where: { id: sourceId },
      select: { id: true, isTrusted: true }
    });
    if (!source?.isTrusted) {
      throw new NotFoundException({
        code: "SUBRESOURCE_NOT_FOUND",
        message: "Catalog source not found"
      });
    }
  }

  private page(input: CatalogPage) {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    if (!Number.isInteger(page) || page < 1 || ![20, 50, 100].includes(pageSize)) {
      throw new BadRequestException({
        code: "INVALID_PAGINATION",
        message: "Invalid Catalog pagination"
      });
    }
    return { page, pageSize };
  }
}
