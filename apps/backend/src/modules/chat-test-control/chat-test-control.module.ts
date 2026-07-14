import { DynamicModule, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ChatModule } from "../chat/chat.module";
import { ChatTestControlController } from "./chat-test-control.controller";
import { ChatTestOperatorGuard } from "./chat-test-operator.guard";

export interface ChatTestControlModuleOptions {
  nodeEnv?: string;
  enabled?: boolean;
}

@Module({})
export class ChatTestControlModule {
  static register(options: ChatTestControlModuleOptions = {}): DynamicModule {
    const enabled = options.nodeEnv === "test" && options.enabled === true;
    return {
      module: ChatTestControlModule,
      imports: [ChatModule, AuthModule],
      controllers: enabled ? [ChatTestControlController] : [],
      providers: enabled ? [ChatTestOperatorGuard] : []
    };
  }
}

export { ChatTestOperatorGuard } from "./chat-test-operator.guard";
