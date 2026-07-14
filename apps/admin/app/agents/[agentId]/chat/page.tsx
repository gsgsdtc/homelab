"use client";

import {
  ApiError,
  appendChatAttempt,
  applyChatRejection,
  applyChatResponse,
  createChatClientMessageId,
  createEmptyAgentChatState,
  getChatConfigurationTarget,
  markChatResultUnknown,
  validateChatContent,
  type AgentChatBubble,
  type AgentChatEligibility,
  type AgentChatMessageRequest,
  type AgentChatRejected,
  type AgentChatSession,
  type AgentChatState,
} from "@homelab/views";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { AuthShell } from "../../../components/auth-shell";
import { api } from "../../../lib/api";

type PagePhase =
  | "loading"
  | "ready"
  | "blocked"
  | "permission_denied"
  | "session_ended"
  | "error";

const sessionEndedCodes = new Set([
  "CHAT_SESSION_EXPIRED",
  "CHAT_SESSION_EVICTED",
  "CHAT_SESSION_LIMIT",
  "CHAT_MESSAGE_LIMIT",
  "CHAT_CONTEXT_LIMIT",
]);

const configurationCodes = new Set([
  "AGENT_NOT_READY",
  "PROVIDER_DISABLED",
  "PROVIDER_NOT_FOUND",
  "DEFAULT_PROVIDER_NOT_FOUND",
  "SOUL_SNAPSHOT_UNAVAILABLE",
  "SKILLS_SNAPSHOT_UNAVAILABLE",
  "WORKFLOW_NOT_ACTIVE",
]);

export default function AgentChatPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const router = useRouter();
  const [phase, setPhase] = useState<PagePhase>("loading");
  const [eligibility, setEligibility] = useState<AgentChatEligibility | null>(
    null,
  );
  const [session, setSession] = useState<AgentChatSession | null>(null);
  const [chat, setChat] = useState<AgentChatState>(() =>
    createEmptyAgentChatState(),
  );
  const [draft, setDraft] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [pageMessage, setPageMessage] = useState("");
  const [pageCode, setPageCode] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const chatRef = useRef(chat);
  const sessionRef = useRef(session);

  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const updateChat = useCallback(
    (update: (current: AgentChatState) => AgentChatState) => {
      setChat((current) => {
        const next = update(current);
        chatRef.current = next;
        return next;
      });
    },
    [],
  );

  const initialize = useCallback(
    async (clearTranscript: boolean) => {
      setPhase("loading");
      setPageMessage("");
      setPageCode("");
      setFieldError("");
      setBusy(false);
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      try {
        const nextEligibility = await api.getAgentChatEligibility(agentId);
        if (!mountedRef.current) return;
        setEligibility(nextEligibility);
        if (!nextEligibility.eligible) {
          setPhase("blocked");
          setPageCode(nextEligibility.code ?? "AGENT_NOT_READY");
          setPageMessage(nextEligibility.message ?? "Agent 当前不可聊天");
          return;
        }
        const nextSession = await api.createAgentChatSession(agentId);
        if (!mountedRef.current) return;
        setSession(nextSession);
        sessionRef.current = nextSession;
        if (clearTranscript) {
          const empty = createEmptyAgentChatState();
          setChat(empty);
          chatRef.current = empty;
          setDraft("");
        }
        setPageMessage(
          clearTranscript ? "新会话已创建，可以继续发送消息" : "",
        );
        setPhase("ready");
      } catch (error) {
        if (!mountedRef.current) return;
        handlePageError(error, {
          onSessionEnded: (rejected) => {
            setPhase("session_ended");
            setPageCode(rejected.code);
            setPageMessage(rejected.message);
          },
          onBlocked: (rejected) => {
            setPhase("blocked");
            setPageCode(rejected.code);
            setPageMessage(rejected.message);
          },
          onPermissionDenied: () => {
            const empty = createEmptyAgentChatState();
            setChat(empty);
            chatRef.current = empty;
            setPhase("permission_denied");
            setPageMessage("无权限使用 Agent 聊天");
          },
          onOther: (message) => {
            setPhase("error");
            setPageMessage(message || "聊天初始化失败，请重试");
          },
        });
      }
    },
    [agentId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void initialize(false);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [initialize]);

  useEffect(() => {
    if (phase === "ready" && !busy) inputRef.current?.focus();
  }, [busy, phase]);

  const processPayload = useCallback(
    async (
      payload: AgentChatMessageRequest,
      automaticConfirmations = 0,
    ): Promise<void> => {
      const currentSession = sessionRef.current;
      if (!currentSession) return;
      setBusy(true);
      setPageMessage("");
      try {
        const response = await api.sendAgentChatMessage(
          agentId,
          currentSession.sessionId,
          payload,
        );
        if (!mountedRef.current) return;
        updateChat((current) => applyChatResponse(current, response));
        if (response.status === "in_progress") {
          if (automaticConfirmations < 65) {
            pollTimerRef.current = setTimeout(() => {
              void processPayload(payload, automaticConfirmations + 1);
            }, response.retryAfterMs);
          } else {
            updateChat((current) =>
              markChatResultUnknown(current, payload.clientMessageId),
            );
            setBusy(false);
          }
          return;
        }
        setBusy(false);
        if (response.status === "failed") {
          setPageCode(response.code);
          setPageMessage(response.message);
          if (sessionEndedCodes.has(response.code)) {
            setPhase("session_ended");
          } else if (configurationCodes.has(response.code)) {
            setPhase("blocked");
          }
        }
      } catch (error) {
        if (!mountedRef.current) return;
        setBusy(false);
        if (isPermissionError(error)) {
          const empty = createEmptyAgentChatState();
          setChat(empty);
          chatRef.current = empty;
          setPhase("permission_denied");
          setPageMessage("无权限使用 Agent 聊天");
          return;
        }
        const rejected = getRejected(error);
        if (!rejected) {
          updateChat((current) =>
            markChatResultUnknown(current, payload.clientMessageId),
          );
          return;
        }
        updateChat((current) =>
          applyChatRejection(current, rejected, payload.clientMessageId),
        );
        if (sessionEndedCodes.has(rejected.code)) {
          setPhase("session_ended");
          setPageCode(rejected.code);
          setPageMessage(rejected.message);
          return;
        }
        if (configurationCodes.has(rejected.code)) {
          setPhase("blocked");
          setPageCode(rejected.code);
          setPageMessage(rejected.message);
          return;
        }
        setPageMessage(rejected.message);
      }
    },
    [agentId, updateChat],
  );

  useEffect(() => {
    const confirmUnknown = () => {
      const unknown = chatRef.current.messages.find(
        (message) => message.status === "result_unknown",
      );
      const payload = unknown ? getActivePayload(unknown) : null;
      if (payload && !busy) void processPayload(payload);
    };
    window.addEventListener("online", confirmUnknown);
    return () => window.removeEventListener("online", confirmUnknown);
  }, [busy, processPayload]);

  const shouldConfirmLeaving =
    draft.length > 0 ||
    chat.messages.some(
      (message) =>
        message.status === "succeeded" ||
        message.status === "failed" ||
        message.status === "rejected",
    );

  useEffect(() => {
    if (!shouldConfirmLeaving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [shouldConfirmLeaving]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !session ||
      phase !== "ready" ||
      busy ||
      hasUnresolvedChatAttempt(chatRef.current)
    ) {
      return;
    }
    const validation = validateChatContent(draft, session.maxCodePoints);
    if (validation.error) {
      setFieldError(validation.error);
      return;
    }
    setFieldError("");
    const clientMessageId = createChatClientMessageId();
    const payload: AgentChatMessageRequest = {
      clientMessageId,
      content: draft,
      retryOfClientMessageId: null,
    };
    updateChat((current) =>
      appendChatAttempt(current, payload, clientMessageId),
    );
    setDraft("");
    void processPayload(payload);
  }

  function retry(message: AgentChatBubble) {
    const previous = getActivePayload(message);
    if (
      !previous ||
      !session ||
      busy ||
      hasUnresolvedChatAttempt(chatRef.current) ||
      message.attempts.length >= session.maxAttemptsPerMessage
    ) {
      return;
    }
    const payload: AgentChatMessageRequest = {
      clientMessageId: createChatClientMessageId(),
      content: message.content,
      retryOfClientMessageId: previous.clientMessageId,
    };
    updateChat((current) =>
      appendChatAttempt(current, payload, message.logicalMessageId),
    );
    void processPayload(payload);
  }

  function goBack() {
    if (
      shouldConfirmLeaving &&
      !window.confirm("离开后临时聊天内容将丢失，确定返回 Agent 管理吗？")
    ) {
      return;
    }
    router.push(`/agents?selected=${encodeURIComponent(agentId)}`);
  }

  const configTarget = pageCode
    ? getChatConfigurationTarget(pageCode, agentId)
    : null;
  const hasUnresolvedAttempt = hasUnresolvedChatAttempt(chat);
  const canCompose =
    phase === "ready" && Boolean(session) && !busy && !hasUnresolvedAttempt;

  return (
    <AuthShell>
      <section className="page-header chat-page-header">
        <div>
          <p className="eyebrow">Agent Chat</p>
          <h2>
            {eligibility?.agent.name
              ? `与 ${eligibility.agent.name} 对话`
              : "Agent 对话"}
          </h2>
        </div>
        <button
          className="ghost-button inline-ghost"
          onClick={goBack}
          type="button"
        >
          返回 Agent
        </button>
      </section>

      <div
        className="chat-live-region"
        role="status"
        aria-label="聊天页面状态"
        aria-live="polite"
        aria-atomic="true"
      >
        {getLiveStatus(phase, busy, pageMessage, chat.messages.at(-1))}
      </div>

      {phase === "loading" ? (
        <div className="notice" role="status">
          正在检查 Agent 配置...
        </div>
      ) : null}

      {phase === "permission_denied" ? (
        <div className="notice error" role="alert">
          <strong>无权限使用 Agent 聊天</strong>
          <p>请使用管理员账号重新登录。</p>
        </div>
      ) : null}

      {phase === "error" ? (
        <div className="notice error chat-blocked" role="alert">
          <strong>{pageMessage}</strong>
          <button onClick={() => void initialize(false)} type="button">
            重试初始化
          </button>
        </div>
      ) : null}

      {phase === "blocked" ? (
        <div className="notice error chat-blocked" role="alert">
          <div>
            <strong>{pageMessage}</strong>
            <p>输入和发送已禁用，请先修复 Agent 配置。</p>
          </div>
          {configTarget ? (
            <a className="button-link" href={configTarget.href}>
              {configTarget.label}
            </a>
          ) : null}
        </div>
      ) : null}

      {phase === "session_ended" ? (
        <div
          className="notice chat-blocked"
          role="status"
          aria-label="会话状态"
        >
          <div>
            <strong>{pageMessage}</strong>
            <p>旧对话已转为只读，可创建一个新的临时会话继续。</p>
          </div>
          <button onClick={() => void initialize(true)} type="button">
            开始新会话
          </button>
        </div>
      ) : null}

      {eligibility?.eligible &&
      session &&
      phase !== "permission_denied" &&
      phase !== "error" ? (
        <section className="chat-shell" aria-label="临时 Agent 对话">
          <header className="chat-session-summary">
            <div>
              <span className="status on">可聊天</span>
              <span>
                {eligibility.providerSummary
                  ? `${eligibility.providerSummary.name} / ${eligibility.providerSummary.model}`
                  : "模型配置已就绪"}
              </span>
            </div>
            <div>
              <span>闲置 30 分钟 / 最长 2 小时</span>
              <span>
                消息：{chat.messages.length} / {session.maxLogicalMessages}
              </span>
            </div>
          </header>
          <div className="chat-temporary-note">
            临时会话：刷新或退出后不会保留聊天内容，请勿依赖历史恢复。
          </div>

          <div className="chat-transcript" aria-label="聊天内容">
            {chat.messages.length === 0 ? (
              <div className="chat-empty">
                <strong>开始与 Agent 对话</strong>
                <span>发送消息后，完整回复会显示在这里。</span>
              </div>
            ) : (
              chat.messages.map((message) => (
                <ChatBubble
                  key={message.logicalMessageId}
                  message={message}
                  maxAttempts={session.maxAttemptsPerMessage}
                  newAttemptsDisabled={busy || hasUnresolvedAttempt}
                  confirmationDisabled={busy}
                  onConfirm={(payload) => void processPayload(payload)}
                  onRetry={() => retry(message)}
                />
              ))
            )}
          </div>

          <form className="chat-composer" onSubmit={submit}>
            <label htmlFor="agent-chat-message">
              消息内容
              <textarea
                ref={inputRef}
                id="agent-chat-message"
                aria-describedby="chat-input-help chat-input-error"
                disabled={!canCompose}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (fieldError) setFieldError("");
                }}
                placeholder="输入消息，最多 8,000 个字符"
                rows={4}
                value={draft}
              />
            </label>
            <div className="chat-composer-footer">
              <div>
                <span id="chat-input-help">
                  {Array.from(draft).length.toLocaleString("en-US")} /{" "}
                  {session.maxCodePoints.toLocaleString("en-US")}
                </span>
                {fieldError ? (
                  <span
                    id="chat-input-error"
                    className="error-text"
                    role="alert"
                  >
                    {fieldError}
                  </span>
                ) : null}
              </div>
              <button disabled={!canCompose} type="submit">
                {busy ? "处理中" : "发送"}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <label className="chat-disabled-composer">
          消息内容
          <textarea aria-label="消息内容" disabled rows={4} />
        </label>
      )}
    </AuthShell>
  );
}

function ChatBubble({
  message,
  maxAttempts,
  newAttemptsDisabled,
  confirmationDisabled,
  onConfirm,
  onRetry,
}: {
  message: AgentChatBubble;
  maxAttempts: number;
  newAttemptsDisabled: boolean;
  confirmationDisabled: boolean;
  onConfirm: (payload: AgentChatMessageRequest) => void;
  onRetry: () => void;
}) {
  const payload = getActivePayload(message);
  const hasRetry =
    message.status === "failed" &&
    message.failure?.retryable &&
    message.attempts.length < maxAttempts;
  return (
    <article className="chat-turn">
      <div className="chat-bubble user-bubble">
        <span className="chat-speaker">你</span>
        <p>{message.content}</p>
      </div>
      <div
        className="chat-result"
        role="status"
        aria-label="消息状态"
        aria-live="polite"
        aria-atomic="true"
      >
        {message.status === "sending" ? <span>回复中...</span> : null}
        {message.status === "confirming" ? (
          <span>正在确认发送结果...</span>
        ) : null}
        {message.status === "result_unknown" ? (
          <>
            <span>发送结果未知，请继续确认</span>
            <button
              className="ghost-button inline-ghost"
              disabled={!payload || confirmationDisabled}
              onClick={() => payload && onConfirm(payload)}
              type="button"
            >
              继续确认
            </button>
          </>
        ) : null}
        {message.status === "failed" && message.failure ? (
          <>
            <span className="error-text">
              消息发送失败：{message.failure.message}
            </span>
            {hasRetry ? (
              <button
                className="ghost-button inline-ghost"
                disabled={newAttemptsDisabled}
                onClick={onRetry}
                type="button"
              >
                重新执行
              </button>
            ) : message.failure.retryable ? (
              <span>已达到最多 {maxAttempts} 次执行</span>
            ) : null}
          </>
        ) : null}
        {message.status === "rejected" && message.rejection ? (
          <span className="error-text">
            请求未执行：{message.rejection.message}
          </span>
        ) : null}
        {message.status === "succeeded" ? <span>回复已完成</span> : null}
        {message.requestId ? (
          <code className="chat-request-id">
            requestId: {message.requestId}
          </code>
        ) : null}
      </div>
      {message.status === "succeeded" ? (
        <div className="chat-bubble agent-bubble">
          <span className="chat-speaker">Agent</span>
          <p>{message.reply}</p>
        </div>
      ) : null}
    </article>
  );
}

function getActivePayload(message: AgentChatBubble) {
  return message.attempts.at(-1)?.payload ?? null;
}

function hasUnresolvedChatAttempt(chat: AgentChatState) {
  return chat.messages.some(
    (message) =>
      message.status === "sending" ||
      message.status === "confirming" ||
      message.status === "result_unknown",
  );
}

function getRejected(error: unknown): AgentChatRejected | null {
  if (!error || typeof error !== "object" || !("details" in error)) return null;
  const details = (error as { details?: unknown }).details;
  if (
    !details ||
    typeof details !== "object" ||
    typeof (details as { requestId?: unknown }).requestId !== "string" ||
    (details as { executionId?: unknown }).executionId !== null ||
    !(
      (details as { clientMessageId?: unknown }).clientMessageId === null ||
      typeof (details as { clientMessageId?: unknown }).clientMessageId ===
        "string"
    ) ||
    (details as { status?: unknown }).status !== "rejected" ||
    typeof (details as { code?: unknown }).code !== "string" ||
    typeof (details as { message?: unknown }).message !== "string" ||
    (details as { retryable?: unknown }).retryable !== false
  ) {
    return null;
  }
  return details as AgentChatRejected;
}

function isPermissionError(error: unknown) {
  if (error instanceof ApiError)
    return error.status === 401 || error.status === 403;
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function handlePageError(
  error: unknown,
  handlers: {
    onSessionEnded: (rejected: AgentChatRejected) => void;
    onBlocked: (rejected: AgentChatRejected) => void;
    onPermissionDenied: () => void;
    onOther: (message: string) => void;
  },
) {
  if (isPermissionError(error)) {
    handlers.onPermissionDenied();
    return;
  }
  const rejected = getRejected(error);
  if (rejected && sessionEndedCodes.has(rejected.code)) {
    handlers.onSessionEnded(rejected);
    return;
  }
  if (rejected && configurationCodes.has(rejected.code)) {
    handlers.onBlocked(rejected);
    return;
  }
  handlers.onOther(error instanceof Error ? error.message : "");
}

function getLiveStatus(
  phase: PagePhase,
  busy: boolean,
  message: string,
  latestMessage?: AgentChatBubble,
) {
  if (phase === "loading") return "正在初始化聊天";
  if (phase !== "ready") return message;
  if (busy) return "正在处理消息";
  if (latestMessage?.status === "result_unknown") {
    return "发送结果未知，请继续确认";
  }
  if (latestMessage?.status === "failed" && latestMessage.failure) {
    return `消息发送失败：${latestMessage.failure.message}`;
  }
  if (latestMessage?.status === "rejected" && latestMessage.rejection) {
    return `请求未执行：${latestMessage.rejection.message}`;
  }
  if (latestMessage?.status === "succeeded") return "Agent 回复已完成";
  return message || "聊天已就绪";
}
