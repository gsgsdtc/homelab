import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AgentChatPage from "./page";

const mocks = vi.hoisted(() => ({
  api: {
    createAgentChatSession: vi.fn(),
    getAgentChatEligibility: vi.fn(),
    sendAgentChatMessage: vi.fn(),
  },
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "agent-a" }),
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("../../../components/auth-shell", () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("../../../lib/api", () => ({ api: mocks.api }));

const eligibility = {
  agentId: "agent-a",
  eligible: true,
  code: null,
  message: null,
  agent: { name: "Ops Agent", status: "ready" },
  providerSummary: { name: "OpenAI", model: "gpt-4.1-mini" },
};

const session = {
  sessionId: "session-a",
  createdAt: "2026-07-14T00:00:00Z",
  idleExpiresAt: "2026-07-14T00:30:00Z",
  absoluteExpiresAt: "2026-07-14T02:00:00Z",
  tombstoneRetentionMs: 900_000,
  maxCodePoints: 8_000,
  maxLogicalMessages: 20,
  maxAttemptsPerMessage: 3,
  maxTranscriptBytes: 524_288,
  maxContextTokens: 32_000,
};

describe("AgentChatPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    mocks.api.createAgentChatSession.mockReset();
    mocks.api.getAgentChatEligibility.mockReset();
    mocks.api.sendAgentChatMessage.mockReset();
    mocks.push.mockReset();
  });

  function mockReady() {
    mocks.api.getAgentChatEligibility.mockResolvedValue(eligibility);
    mocks.api.createAgentChatSession.mockResolvedValue(session);
  }

  async function getReadyInput() {
    await screen.findByText("OpenAI / gpt-4.1-mini");
    const input = screen.getByLabelText("消息内容");
    await waitFor(() => expect(input).toBeEnabled());
    return input;
  }

  it("enters a ready temporary session and sends a complete reply", async () => {
    mockReady();
    mocks.api.sendAgentChatMessage.mockImplementation(
      (
        _agentId: string,
        _sessionId: string,
        payload: { clientMessageId: string },
      ) =>
        Promise.resolve({
          requestId: "req-1",
          executionId: "exec-1",
          clientMessageId: payload.clientMessageId,
          logicalMessageId: payload.clientMessageId,
          retryOfClientMessageId: null,
          status: "succeeded",
          reply: "配置正常",
          acceptedAt: "2026-07-14T00:00:00Z",
          completedAt: "2026-07-14T00:00:01Z",
          replayed: false,
        }),
    );

    render(<AgentChatPage />);

    expect(
      await screen.findByRole("heading", { name: "与 Ops Agent 对话" }),
    ).toBeInTheDocument();
    expect(screen.getByText("OpenAI / gpt-4.1-mini")).toBeInTheDocument();
    expect(screen.getByText(/刷新或退出后不会保留/)).toBeInTheDocument();
    const input = await getReadyInput();
    expect(input).toHaveFocus();

    await userEvent.type(input, "检查当前配置");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("配置正常")).toBeInTheDocument();
    expect(screen.getAllByText("检查当前配置")).toHaveLength(1);
    expect(input).toBeEnabled();
  });

  it("shows a matching recovery action for blocked configuration", async () => {
    mocks.api.getAgentChatEligibility.mockResolvedValue({
      ...eligibility,
      eligible: false,
      code: "WORKFLOW_NOT_ACTIVE",
      message: "Agent 默认聊天 Workflow 未生效",
      providerSummary: null,
    });

    render(<AgentChatPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent 默认聊天 Workflow 未生效",
    );
    expect(
      screen.getByRole("link", { name: "前往 Workflow 配置" }),
    ).toHaveAttribute("href", "/agents/agent-a/workflows");
    expect(screen.getByLabelText("消息内容")).toBeDisabled();
    expect(mocks.api.createAgentChatSession).not.toHaveBeenCalled();
  });

  it("confirms a network-unknown result with the original payload", async () => {
    mockReady();
    mocks.api.sendAgentChatMessage
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce(
        (
          _agentId: string,
          _sessionId: string,
          payload: { clientMessageId: string },
        ) =>
          Promise.resolve({
            requestId: "req-1",
            executionId: "exec-1",
            clientMessageId: payload.clientMessageId,
            logicalMessageId: payload.clientMessageId,
            retryOfClientMessageId: null,
            status: "succeeded",
            reply: "原请求已完成",
            acceptedAt: "2026-07-14T00:00:00Z",
            completedAt: "2026-07-14T00:00:01Z",
            replayed: true,
          }),
      );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "message0-0000-0000-0000-000000000001",
    );

    render(<AgentChatPage />);
    const input = await getReadyInput();
    await userEvent.type(input, "检查当前配置");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(
      await screen.findByText("发送结果未知，请继续确认"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "继续确认" }));
    expect(await screen.findByText("原请求已完成")).toBeInTheDocument();
    expect(mocks.api.sendAgentChatMessage).toHaveBeenCalledTimes(2);
    expect(mocks.api.sendAgentChatMessage.mock.calls[1][2]).toEqual(
      mocks.api.sendAgentChatMessage.mock.calls[0][2],
    );
    expect(screen.getAllByText("检查当前配置")).toHaveLength(1);
  });

  it("retries a retryable terminal failure in the same bubble", async () => {
    mockReady();
    mocks.api.sendAgentChatMessage
      .mockImplementationOnce(
        (
          _agentId: string,
          _sessionId: string,
          payload: { clientMessageId: string },
        ) =>
          Promise.resolve({
            requestId: "req-1",
            executionId: "exec-1",
            clientMessageId: payload.clientMessageId,
            logicalMessageId: payload.clientMessageId,
            retryOfClientMessageId: null,
            status: "failed",
            code: "MODEL_TIMEOUT",
            message: "模型响应超时",
            retryable: true,
            acceptedAt: "2026-07-14T00:00:00Z",
            completedAt: "2026-07-14T00:00:01Z",
            replayed: false,
          }),
      )
      .mockImplementationOnce(
        (
          _agentId: string,
          _sessionId: string,
          payload: {
            clientMessageId: string;
            retryOfClientMessageId: string;
          },
        ) =>
          Promise.resolve({
            requestId: "req-2",
            executionId: "exec-2",
            clientMessageId: payload.clientMessageId,
            logicalMessageId: payload.retryOfClientMessageId,
            retryOfClientMessageId: payload.retryOfClientMessageId,
            status: "succeeded",
            reply: "重试成功",
            acceptedAt: "2026-07-14T00:00:02Z",
            completedAt: "2026-07-14T00:00:03Z",
            replayed: false,
          }),
      );

    render(<AgentChatPage />);
    const input = await getReadyInput();
    await userEvent.type(input, "检查当前配置");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("模型响应超时")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新执行" }));
    expect(await screen.findByText("重试成功")).toBeInTheDocument();
    expect(screen.getAllByText("检查当前配置")).toHaveLength(1);
    expect(mocks.api.sendAgentChatMessage.mock.calls[1][2]).toMatchObject({
      content: "检查当前配置",
      retryOfClientMessageId:
        mocks.api.sendAgentChatMessage.mock.calls[0][2].clientMessageId,
    });
  });

  it("keeps an over-limit draft and exposes validation feedback", async () => {
    mockReady();
    render(<AgentChatPage />);
    const input = await getReadyInput();

    fireEvent.change(input, { target: { value: "😀".repeat(8_001) } });
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.getByText("消息不能超过 8,000 个字符")).toBeInTheDocument();
    expect(input).toHaveValue("😀".repeat(8_001));
    expect(mocks.api.sendAgentChatMessage).not.toHaveBeenCalled();
  });

  it("starts a fresh session after the previous session expires", async () => {
    mockReady();
    mocks.api.createAgentChatSession
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, sessionId: "session-b" });
    mocks.api.sendAgentChatMessage.mockRejectedValue({
      name: "ApiError",
      status: 410,
      details: {
        status: "rejected",
        code: "CHAT_SESSION_EXPIRED",
        message: "会话已过期",
      },
    });

    render(<AgentChatPage />);
    const input = await getReadyInput();
    await userEvent.type(input, "hello");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("status")).toHaveTextContent("会话已过期");
    expect(input).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "开始新会话" }));
    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    expect(mocks.api.createAgentChatSession).toHaveBeenCalledTimes(2);
  });

  it("automatically confirms an in-progress replay until it succeeds", async () => {
    mockReady();
    mocks.api.sendAgentChatMessage
      .mockImplementationOnce(
        (
          _agentId: string,
          _sessionId: string,
          payload: { clientMessageId: string },
        ) =>
          Promise.resolve({
            requestId: "req-1",
            executionId: "exec-1",
            clientMessageId: payload.clientMessageId,
            logicalMessageId: payload.clientMessageId,
            retryOfClientMessageId: null,
            status: "in_progress",
            acceptedAt: "2026-07-14T00:00:00Z",
            retryAfterMs: 1,
            replayed: true,
          }),
      )
      .mockImplementationOnce(
        (
          _agentId: string,
          _sessionId: string,
          payload: { clientMessageId: string },
        ) =>
          Promise.resolve({
            requestId: "req-1",
            executionId: "exec-1",
            clientMessageId: payload.clientMessageId,
            logicalMessageId: payload.clientMessageId,
            retryOfClientMessageId: null,
            status: "succeeded",
            reply: "确认完成",
            acceptedAt: "2026-07-14T00:00:00Z",
            completedAt: "2026-07-14T00:00:02Z",
            replayed: true,
          }),
      );

    render(<AgentChatPage />);
    const input = await getReadyInput();
    await userEvent.type(input, "hello");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("确认完成")).toBeInTheDocument();
    expect(mocks.api.sendAgentChatMessage).toHaveBeenCalledTimes(2);
    expect(mocks.api.sendAgentChatMessage.mock.calls[1][2]).toEqual(
      mocks.api.sendAgentChatMessage.mock.calls[0][2],
    );
  });

  it("retries a recoverable initialization error", async () => {
    mocks.api.getAgentChatEligibility
      .mockRejectedValueOnce(new Error("服务暂不可用"))
      .mockResolvedValueOnce(eligibility);
    mocks.api.createAgentChatSession.mockResolvedValue(session);

    render(<AgentChatPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂不可用");

    await userEvent.click(screen.getByRole("button", { name: "重试初始化" }));
    expect(await getReadyInput()).toBeEnabled();
  });

  it("removes transcript content when message permission is denied", async () => {
    mockReady();
    mocks.api.sendAgentChatMessage.mockRejectedValue({
      status: 403,
      details: { message: "Forbidden", statusCode: 403 },
    });

    render(<AgentChatPage />);
    const input = await getReadyInput();
    await userEvent.type(input, "private message");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无权限使用 Agent 聊天",
    );
    expect(screen.queryByText("private message")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("聊天内容")).not.toBeInTheDocument();
  });

  it("confirms application navigation when a draft would be lost", async () => {
    mockReady();
    const confirm = vi.spyOn(window, "confirm");
    confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<AgentChatPage />);
    const input = await getReadyInput();
    await userEvent.type(input, "unfinished draft");

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "返回 Agent" }));
    expect(mocks.push).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "返回 Agent" }));
    expect(mocks.push).toHaveBeenCalledWith("/agents?selected=agent-a");
  });
});
