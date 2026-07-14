import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AgentsModule } from "../agents/agents.module";
import { ChatTestControlService } from "../chat-test-control/chat-test-control.service";
import { ModelProvidersModule } from "../model-providers/model-providers.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ChatConfigSnapshotService } from "./chat-config-snapshot.service";
import { ChatConfigSourceService } from "./chat-config-source.service";
import { ChatController } from "./chat.controller";
import { CHAT_RUNTIME, ChatSessionService, createChatRuntime } from "./chat-session.service";
import { MASTRA_CHAT_ADAPTER } from "./mastra-chat.adapter";
import { MastraChatRuntimeExecutor } from "./mastra-chat-runtime.executor";
import { OpenAICompatibleMastraChatAdapter } from "./openai-compatible-mastra-chat.adapter";

@Module({
  imports: [PrismaModule, ModelProvidersModule, AgentsModule],
  controllers: [ChatController],
  providers: [
    {
      provide: ChatTestControlService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ChatTestControlService({
          enabled:
            config.get<string>("NODE_ENV") === "test" &&
            String(config.get<string>("CHAT_TEST_CONTROL_ENABLED") ?? "false").toLowerCase() === "true"
        })
    },
    ChatConfigSourceService,
    ChatConfigSnapshotService,
    MastraChatRuntimeExecutor,
    OpenAICompatibleMastraChatAdapter,
    {
      provide: MASTRA_CHAT_ADAPTER,
      useExisting: OpenAICompatibleMastraChatAdapter
    },
    {
      provide: CHAT_RUNTIME,
      inject: [ChatTestControlService],
      useFactory: createChatRuntime
    },
    ChatSessionService
  ],
  exports: [ChatSessionService, ChatTestControlService]
})
export class ChatModule {}
