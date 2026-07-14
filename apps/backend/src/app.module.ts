import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppKeysModule } from "./modules/app-keys/app-keys.module";
import { AgentsModule } from "./modules/agents/agents.module";
import { AuthModule } from "./modules/auth/auth.module";
import { validateEnvironment } from "./config/env.validation";
import { HealthModule } from "./modules/health/health.module";
import { ModelProvidersModule } from "./modules/model-providers/model-providers.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { UsersModule } from "./modules/users/users.module";
import { ChatModule } from "./modules/chat/chat.module";
import { ChatTestControlModule } from "./modules/chat-test-control/chat-test-control.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AppKeysModule,
    AgentsModule,
    ModelProvidersModule,
    ChatModule,
    ChatTestControlModule.register({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.CHAT_TEST_CONTROL_ENABLED === "true",
    }),
  ],
})
export class AppModule {}
