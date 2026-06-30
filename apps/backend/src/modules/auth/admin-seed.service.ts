import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PasswordService } from "../users/password.service";

@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminSeedService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService
  ) {}

  async onApplicationBootstrap() {
    const username = this.config.get<string>("INITIAL_ADMIN_USERNAME");
    const password = this.config.get<string>("INITIAL_ADMIN_PASSWORD");

    if (!username || !password) {
      return;
    }

    const passwordHash = await this.passwords.hash(password);
    await this.prisma.user.upsert({
      where: { username },
      create: {
        username,
        passwordHash,
        role: UserRole.ADMIN,
        isActive: true
      },
      update: {
        passwordHash,
        role: UserRole.ADMIN,
        isActive: true
      }
    });

    this.logger.log(`Initial admin '${username}' is ready`);
  }
}
