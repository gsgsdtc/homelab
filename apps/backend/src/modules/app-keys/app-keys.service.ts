import { randomBytes, createHash } from "crypto";
import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AppKey, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAppKeyDto } from "./dto/create-app-key.dto";

export type PublicAppKey = Omit<AppKey, "keyHash">;

export interface AppKeyIdentity {
  id: string;
  name: string;
  agentName: string | null;
  scopes: string[];
}

@Injectable()
export class AppKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateAppKeyDto) {
    const rawKey = `hl_${randomBytes(32).toString("base64url")}`;
    const appKey = await this.prisma.appKey.create({
      data: {
        name: dto.name,
        agentName: dto.agentName,
        scopes: dto.scopes ?? [],
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        keyHash: this.hashKey(rawKey)
      },
      select: this.publicSelect()
    });

    return {
      appKey,
      key: rawKey
    };
  }

  async list(): Promise<PublicAppKey[]> {
    return this.prisma.appKey.findMany({
      orderBy: { createdAt: "desc" },
      select: this.publicSelect()
    });
  }

  async revoke(id: string): Promise<void> {
    const existing = await this.prisma.appKey.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new NotFoundException("app key not found");
    }

    await this.prisma.appKey.update({
      where: { id },
      data: { isActive: false }
    });
  }

  async validateRawKey(rawKey: string): Promise<AppKeyIdentity> {
    const appKey = await this.prisma.appKey.findUnique({
      where: { keyHash: this.hashKey(rawKey) }
    });

    if (!appKey || !appKey.isActive || this.isExpired(appKey)) {
      throw new UnauthorizedException("invalid app key");
    }

    await this.prisma.appKey.update({
      where: { id: appKey.id },
      data: { lastUsedAt: new Date() }
    });

    return {
      id: appKey.id,
      name: appKey.name,
      agentName: appKey.agentName,
      scopes: appKey.scopes
    };
  }

  private hashKey(rawKey: string): string {
    return createHash("sha256").update(rawKey).digest("hex");
  }

  private isExpired(appKey: AppKey): boolean {
    return Boolean(appKey.expiresAt && appKey.expiresAt.getTime() <= Date.now());
  }

  private publicSelect() {
    return {
      id: true,
      name: true,
      agentName: true,
      scopes: true,
      isActive: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true
    } satisfies Prisma.AppKeySelect;
  }
}
