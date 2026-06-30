import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppKeysModule } from "./modules/app-keys/app-keys.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { UsersModule } from "./modules/users/users.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => ({
        ...config,
        PORT: Number(config.PORT ?? 3000),
        JWT_SECRET: config.JWT_SECRET ?? "change-me-in-local-dev",
        JWT_EXPIRES_IN: config.JWT_EXPIRES_IN ?? "1h"
      })
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AppKeysModule
  ]
})
export class AppModule {}
