import { ChatConfigurationSnapshot, ChatTranscriptEntry } from "./chat.types";

export interface MastraChatExecuteInput {
  executionId: string;
  snapshot: ChatConfigurationSnapshot;
  transcript: ChatTranscriptEntry[];
  message: string;
  signal: AbortSignal;
}

export interface MastraChatAdapter {
  execute(input: MastraChatExecuteInput): Promise<{ text: string }>;
  countTokens(value: string, snapshot?: ChatConfigurationSnapshot): number;
}

export const MASTRA_CHAT_ADAPTER = Symbol("MASTRA_CHAT_ADAPTER");
