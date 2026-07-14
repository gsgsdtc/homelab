import { Allow } from "class-validator";

export class ChatMessageDto {
  @Allow()
  clientMessageId!: string;

  @Allow()
  content!: string;

  @Allow()
  retryOfClientMessageId!: string | null;
}
