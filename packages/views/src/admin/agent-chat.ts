export interface AgentChatProviderSummary {
  name: string;
  model: string;
}

export interface AgentChatEligibility {
  agentId: string;
  eligible: boolean;
  code: string | null;
  message: string | null;
  agent: {
    name: string;
    status: string;
  };
  providerSummary: AgentChatProviderSummary | null;
}

export interface AgentChatSession {
  sessionId: string;
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  tombstoneRetentionMs: number;
  maxCodePoints: number;
  maxLogicalMessages: number;
  maxAttemptsPerMessage: number;
  maxTranscriptBytes: number;
  maxContextTokens: number;
}

export interface AgentChatMessageRequest {
  clientMessageId: string;
  content: string;
  retryOfClientMessageId: string | null;
}

interface AgentChatMessageBase {
  requestId: string;
  executionId: string;
  clientMessageId: string;
  logicalMessageId: string;
  retryOfClientMessageId: string | null;
  acceptedAt: string;
  replayed: boolean;
}

export interface AgentChatMessageSucceeded extends AgentChatMessageBase {
  status: "succeeded";
  reply: string;
  completedAt: string;
}

export interface AgentChatMessageInProgress extends AgentChatMessageBase {
  status: "in_progress";
  retryAfterMs: number;
}

export interface AgentChatMessageFailed extends AgentChatMessageBase {
  status: "failed";
  code: string;
  message: string;
  retryable: boolean;
  completedAt: string;
}

export type AgentChatMessageResponse =
  | AgentChatMessageSucceeded
  | AgentChatMessageInProgress
  | AgentChatMessageFailed;

export interface AgentChatRejected {
  requestId?: string;
  executionId: null;
  clientMessageId?: string | null;
  status: "rejected";
  code: string;
  message: string;
  retryable: false;
}

export type AgentChatBubbleStatus =
  "sending" | "confirming" | "result_unknown" | "succeeded" | "failed";

export interface AgentChatAttempt {
  payload: AgentChatMessageRequest;
  response?: AgentChatMessageResponse;
}

export interface AgentChatBubble {
  logicalMessageId: string;
  content: string;
  activeClientMessageId: string;
  status: AgentChatBubbleStatus;
  attempts: AgentChatAttempt[];
  reply?: string;
  requestId?: string;
  executionId?: string;
  failure?: AgentChatMessageFailed;
}

export interface AgentChatState {
  messages: AgentChatBubble[];
}

export function createEmptyAgentChatState(): AgentChatState {
  return { messages: [] };
}

export function validateChatContent(
  content: string,
  maxCodePoints = 8_000,
): { codePoints: number; error: string | null } {
  const codePoints = Array.from(content).length;
  if (!content.replace(/\p{White_Space}/gu, "")) {
    return { codePoints, error: "消息不能为空" };
  }
  if (codePoints > maxCodePoints) {
    return {
      codePoints,
      error: `消息不能超过 ${maxCodePoints.toLocaleString("en-US")} 个字符`,
    };
  }
  return { codePoints, error: null };
}

export function createChatClientMessageId(
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
) {
  return randomUUID().replaceAll("-", "");
}

export function appendChatAttempt(
  state: AgentChatState,
  payload: AgentChatMessageRequest,
  logicalMessageId: string,
): AgentChatState {
  const index = state.messages.findIndex(
    (message) => message.logicalMessageId === logicalMessageId,
  );
  if (index === -1) {
    return {
      messages: [
        ...state.messages,
        {
          logicalMessageId,
          content: payload.content,
          activeClientMessageId: payload.clientMessageId,
          status: "sending",
          attempts: [{ payload }],
        },
      ],
    };
  }

  return updateMessage(state, index, (message) => ({
    ...message,
    activeClientMessageId: payload.clientMessageId,
    status: "sending",
    attempts: [...message.attempts, { payload }],
    failure: undefined,
    requestId: undefined,
    executionId: undefined,
  }));
}

export function applyChatResponse(
  state: AgentChatState,
  response: AgentChatMessageResponse,
): AgentChatState {
  const index = state.messages.findIndex(
    (message) =>
      message.logicalMessageId === response.logicalMessageId ||
      message.activeClientMessageId === response.clientMessageId,
  );
  if (index === -1) {
    return state;
  }

  return updateMessage(state, index, (message) => {
    const attempts = message.attempts.map((attempt) =>
      attempt.payload.clientMessageId === response.clientMessageId
        ? { ...attempt, response }
        : attempt,
    );
    const common = {
      ...message,
      attempts,
      requestId: response.requestId,
      executionId: response.executionId,
    };
    if (response.status === "in_progress") {
      return { ...common, status: "confirming" as const };
    }
    if (response.status === "failed") {
      return {
        ...common,
        status: "failed" as const,
        failure: response,
      };
    }
    return {
      ...common,
      status: "succeeded" as const,
      reply: response.reply,
      failure: undefined,
    };
  });
}

export function markChatResultUnknown(
  state: AgentChatState,
  clientMessageId: string,
): AgentChatState {
  const index = state.messages.findIndex(
    (message) => message.activeClientMessageId === clientMessageId,
  );
  if (index === -1) {
    return state;
  }
  return updateMessage(state, index, (message) => ({
    ...message,
    status: "result_unknown",
  }));
}

export function getChatConfigurationTarget(code: string, agentId: string) {
  if (
    code === "PROVIDER_DISABLED" ||
    code === "PROVIDER_NOT_FOUND" ||
    code === "DEFAULT_PROVIDER_NOT_FOUND"
  ) {
    return { href: "/model-providers", label: "前往模型提供方配置" };
  }
  if (code === "WORKFLOW_NOT_ACTIVE") {
    return {
      href: `/agents/${agentId}/workflows`,
      label: "前往 Workflow 配置",
    };
  }
  if (code === "SKILLS_SNAPSHOT_UNAVAILABLE") {
    return {
      href: `/agents/${agentId}/skills`,
      label: "前往 Skills 配置",
    };
  }
  return {
    href: `/agents?selected=${encodeURIComponent(agentId)}`,
    label: "返回 Agent 配置",
  };
}

export function isAgentChatMessageResponse(
  value: unknown,
): value is AgentChatMessageResponse {
  if (!value || typeof value !== "object" || !("status" in value)) {
    return false;
  }
  const status = (value as { status?: unknown }).status;
  return (
    status === "succeeded" || status === "in_progress" || status === "failed"
  );
}

function updateMessage(
  state: AgentChatState,
  index: number,
  update: (message: AgentChatBubble) => AgentChatBubble,
): AgentChatState {
  return {
    messages: state.messages.map((message, messageIndex) =>
      messageIndex === index ? update(message) : message,
    ),
  };
}
