import { describe, expect, it } from "vitest";

import {
  appendChatAttempt,
  applyChatRejection,
  applyChatResponse,
  createChatClientMessageId,
  createEmptyAgentChatState,
  getChatConfigurationTarget,
  type AgentChatRejected,
  validateChatContent,
} from "../src/admin/agent-chat";

describe("agent chat shared state", () => {
  it("validates Unicode whitespace and counts Unicode code points", () => {
    expect(validateChatContent("\u2003\u3000")).toEqual({
      codePoints: 2,
      error: "消息不能为空",
    });
    expect(validateChatContent("😀".repeat(8_000))).toEqual({
      codePoints: 8_000,
      error: null,
    });
    expect(validateChatContent("😀".repeat(8_001))).toEqual({
      codePoints: 8_001,
      error: "消息不能超过 8,000 个字符",
    });
  });

  it("creates DTO-compatible client message ids", () => {
    expect(
      createChatClientMessageId(() => "01234567-89ab-cdef-0123-456789abcdef"),
    ).toBe("0123456789abcdef0123456789abcdef");
  });

  it("keeps retries in one logical user bubble", () => {
    const initial = appendChatAttempt(
      createEmptyAgentChatState(),
      {
        clientMessageId: "message_attempt_0001",
        content: "检查当前配置",
        retryOfClientMessageId: null,
      },
      "message_attempt_0001",
    );
    const failed = applyChatResponse(initial, {
      requestId: "req-1",
      executionId: "exec-1",
      clientMessageId: "message_attempt_0001",
      logicalMessageId: "message_attempt_0001",
      retryOfClientMessageId: null,
      status: "failed",
      code: "MODEL_TIMEOUT",
      message: "模型响应超时",
      retryable: true,
      acceptedAt: "2026-07-14T00:00:00Z",
      completedAt: "2026-07-14T00:00:01Z",
      replayed: false,
    });
    const retried = appendChatAttempt(
      failed,
      {
        clientMessageId: "message_attempt_0002",
        content: "检查当前配置",
        retryOfClientMessageId: "message_attempt_0001",
      },
      "message_attempt_0001",
    );

    expect(retried.messages).toHaveLength(1);
    expect(retried.messages[0]).toMatchObject({
      content: "检查当前配置",
      activeClientMessageId: "message_attempt_0002",
      status: "sending",
    });
    expect(retried.messages[0].attempts).toHaveLength(2);
  });

  it("applies in-progress and succeeded replay DTOs without duplicating bubbles", () => {
    const queued = appendChatAttempt(
      createEmptyAgentChatState(),
      {
        clientMessageId: "message_attempt_0001",
        content: "hello",
        retryOfClientMessageId: null,
      },
      "message_attempt_0001",
    );
    const confirming = applyChatResponse(queued, {
      requestId: "req-1",
      executionId: "exec-1",
      clientMessageId: "message_attempt_0001",
      logicalMessageId: "message_attempt_0001",
      retryOfClientMessageId: null,
      status: "in_progress",
      acceptedAt: "2026-07-14T00:00:00Z",
      retryAfterMs: 1_000,
      replayed: true,
    });
    const succeeded = applyChatResponse(confirming, {
      requestId: "req-1",
      executionId: "exec-1",
      clientMessageId: "message_attempt_0001",
      logicalMessageId: "message_attempt_0001",
      retryOfClientMessageId: null,
      status: "succeeded",
      reply: "world",
      acceptedAt: "2026-07-14T00:00:00Z",
      completedAt: "2026-07-14T00:00:02Z",
      replayed: true,
    });

    expect(confirming.messages[0].status).toBe("confirming");
    expect(succeeded.messages).toHaveLength(1);
    expect(succeeded.messages[0]).toMatchObject({
      status: "succeeded",
      reply: "world",
      requestId: "req-1",
    });
  });

  it("terminalizes a provisional bubble when the request is rejected", () => {
    const queued = appendChatAttempt(
      createEmptyAgentChatState(),
      {
        clientMessageId: "message_attempt_0001",
        content: "hello",
        retryOfClientMessageId: null,
      },
      "message_attempt_0001",
    );

    const rejected = applyChatRejection(queued, {
      requestId: "req-rejected",
      executionId: null,
      clientMessageId: "message_attempt_0001",
      status: "rejected",
      code: "CHAT_SESSION_EXPIRED",
      message: "会话已过期",
      retryable: false,
    });

    expect(rejected.messages[0]).toMatchObject({
      status: "rejected",
      requestId: "req-rejected",
      rejection: {
        code: "CHAT_SESSION_EXPIRED",
        message: "会话已过期",
      },
    });
  });

  it("requires both frozen rejected DTO identifier fields", () => {
    // @ts-expect-error requestId is required by the frozen DTO.
    const missingRequestId: AgentChatRejected = {
      executionId: null,
      clientMessageId: null,
      status: "rejected",
      code: "CHAT_SESSION_BUSY",
      message: "busy",
      retryable: false,
    };
    // @ts-expect-error clientMessageId is required even when its value is null.
    const missingClientMessageId: AgentChatRejected = {
      requestId: "req-rejected",
      executionId: null,
      status: "rejected",
      code: "CHAT_SESSION_BUSY",
      message: "busy",
      retryable: false,
    };

    expect([missingRequestId, missingClientMessageId]).toHaveLength(2);
  });

  it("routes configuration failures to the matching admin area", () => {
    expect(getChatConfigurationTarget("PROVIDER_DISABLED", "agent-a")).toEqual({
      href: "/model-providers",
      label: "前往模型提供方配置",
    });
    expect(
      getChatConfigurationTarget("WORKFLOW_NOT_ACTIVE", "agent-a"),
    ).toEqual({
      href: "/agents/agent-a/workflows",
      label: "前往 Workflow 配置",
    });
    expect(
      getChatConfigurationTarget("SOUL_SNAPSHOT_UNAVAILABLE", "agent-a"),
    ).toEqual({ href: "/agents?selected=agent-a", label: "返回 Agent 配置" });
  });
});
