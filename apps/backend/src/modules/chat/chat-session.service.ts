import { Inject, Injectable, Optional } from "@nestjs/common";
import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { ChatTestControlService } from "../chat-test-control/chat-test-control.service";
import { ChatConfigSnapshotService } from "./chat-config-snapshot.service";
import { ChatApiException, executionError, failureFrom } from "./chat.errors";
import { MASTRA_CHAT_ADAPTER, MastraChatAdapter } from "./mastra-chat.adapter";
import { ChatConfigurationSnapshot, ChatHttpResult, ChatMessageRequest, ChatTranscriptEntry } from "./chat.types";

const IDLE_TTL_MS = 30 * 60 * 1000;
const ABSOLUTE_TTL_MS = 2 * 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_POINTS = 8000;
const MAX_LOGICAL_MESSAGES = 20;
const MAX_ATTEMPTS = 3;
const MAX_TRANSCRIPT_BYTES = 524288;
const MAX_CONTEXT_TOKENS = 32000;
const MAX_REPLY_CODE_POINTS = 32000;
const MAX_REPLY_BYTES = 131072;
const MAX_ACTIVE_SESSIONS = 5;
const EXECUTION_TIMEOUT_MS = 60000;

export const CHAT_RUNTIME = Symbol("CHAT_RUNTIME");

interface ChatRuntime {
  now(testNamespace?: string): number;
  randomId(prefix: string): string;
  generation?(testNamespace?: string): number;
  increment?(testNamespace: string | undefined, counter: "idempotentReplays"): void;
  checkpoint?(testNamespace: string | undefined, key: "beforeExecute" | "afterExecuteBeforeCommit" | "afterTimeoutBeforeLateResult"): Promise<void>;
  timeout?(testNamespace: string | undefined, milliseconds: number): { promise: Promise<void>; cancel: () => void };
}

interface StoredExecution {
  clientMessageId: string;
  logicalMessageId: string;
  retryOfClientMessageId: string | null;
  content: string;
  requestId: string;
  executionId: string;
  acceptedAt: string;
  completedAt?: string;
  state: "in_progress" | "terminal";
  httpStatus?: number;
  body?: Record<string, unknown>;
  retryable?: boolean;
}

interface LogicalMessage {
  rootId: string;
  content: string;
  attemptIds: string[];
}

interface ChatSession {
  id: string;
  userId: string;
  agentId: string;
  testNamespace?: string;
  testGeneration: number;
  createdAtMs: number;
  lastAcceptedAtMs: number;
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
  tombstonedAtMs?: number;
  tombstoneReason?: "expired" | "evicted";
  contextLimitReached?: boolean;
  inFlightId?: string;
  executions: Map<string, StoredExecution>;
  logicalMessages: Map<string, LogicalMessage>;
  transcript: ChatTranscriptEntry[];
}

@Injectable()
export class ChatSessionService {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(
    @Inject(ChatConfigSnapshotService)
    private readonly snapshots: Pick<ChatConfigSnapshotService, "getEligibility" | "capture">,
    @Inject(MASTRA_CHAT_ADAPTER) private readonly adapter: MastraChatAdapter,
    @Optional()
    @Inject(CHAT_RUNTIME)
    private readonly runtime: ChatRuntime = {
      now: () => Date.now(),
      randomId: (prefix) => `${prefix}_${randomUUID()}`
    }
  ) {}

  getEligibility(agentId: string, testNamespace?: string) {
    return this.snapshots.getEligibility(agentId, testNamespace);
  }

  async createSession(userId: string, agentId: string, testNamespace?: string) {
    const eligibility = await this.snapshots.getEligibility(agentId, testNamespace);
    if (!eligibility.eligible) {
      throw new ChatApiException(422, eligibility.code ?? "AGENT_NOT_ELIGIBLE", eligibility.message ?? "Agent cannot chat");
    }
    const now = this.now(testNamespace);
    this.cleanup(now, testNamespace);
    this.evictIfRequired(userId, now, testNamespace);
    const id = this.runtime.randomId("session");
    const session: ChatSession = {
      id,
      userId,
      agentId,
      testNamespace,
      testGeneration: this.runtime.generation?.(testNamespace) ?? 0,
      createdAtMs: now,
      lastAcceptedAtMs: now,
      idleExpiresAtMs: now + IDLE_TTL_MS,
      absoluteExpiresAtMs: now + ABSOLUTE_TTL_MS,
      executions: new Map(),
      logicalMessages: new Map(),
      transcript: []
    };
    this.sessions.set(id, session);
    return {
      sessionId: id,
      createdAt: this.iso(now),
      idleExpiresAt: this.iso(session.idleExpiresAtMs),
      absoluteExpiresAt: this.iso(session.absoluteExpiresAtMs),
      tombstoneRetentionMs: TOMBSTONE_TTL_MS,
      maxCodePoints: MAX_CODE_POINTS,
      maxLogicalMessages: MAX_LOGICAL_MESSAGES,
      maxAttemptsPerMessage: MAX_ATTEMPTS,
      maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
      maxContextTokens: MAX_CONTEXT_TOKENS
    };
  }

  async sendMessage(
    userId: string,
    agentId: string,
    sessionId: string,
    request: ChatMessageRequest,
    testNamespace?: string
  ): Promise<ChatHttpResult> {
    this.validateRequest(request);
    const now = this.now(testNamespace);
    this.cleanup(now, testNamespace);
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.agentId !== agentId || session.testNamespace !== testNamespace) {
      throw this.rejection(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found", request.clientMessageId);
    }
    if (session.testGeneration !== (this.runtime.generation?.(testNamespace) ?? 0)) {
      this.sessions.delete(session.id);
      throw this.rejection(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found", request.clientMessageId);
    }
    this.updateLifecycle(session, now);
    if (session.tombstonedAtMs !== undefined && now - session.tombstonedAtMs >= TOMBSTONE_TTL_MS) {
      this.sessions.delete(session.id);
      throw this.rejection(404, "CHAT_SESSION_NOT_FOUND", "Chat session not found", request.clientMessageId);
    }

    const existing = session.executions.get(request.clientMessageId);
    if (existing) {
      if (existing.content !== request.content || existing.retryOfClientMessageId !== request.retryOfClientMessageId) {
        throw this.rejection(409, "IDEMPOTENCY_CONFLICT", "Message ID was already used with another payload", request.clientMessageId);
      }
      this.runtime.increment?.(testNamespace, "idempotentReplays");
      return this.replay(existing);
    }

    if (session.tombstoneReason) {
      const code = session.tombstoneReason === "evicted" ? "CHAT_SESSION_EVICTED" : "CHAT_SESSION_EXPIRED";
      throw this.rejection(410, code, "Chat session is no longer active", request.clientMessageId);
    }
    if (session.contextLimitReached) {
      throw this.rejection(409, "CHAT_CONTEXT_LIMIT", "Chat context limit reached", request.clientMessageId);
    }
    if (session.inFlightId) {
      throw this.rejection(409, "MESSAGE_IN_PROGRESS", "Another message is in progress", request.clientMessageId);
    }

    const logical = this.resolveLogicalMessage(session, request);
    if (!request.retryOfClientMessageId && session.logicalMessages.size >= MAX_LOGICAL_MESSAGES) {
      throw this.rejection(409, "CHAT_MESSAGE_LIMIT", "Chat session message limit reached", request.clientMessageId);
    }
    if (logical.attemptIds.length >= MAX_ATTEMPTS) {
      throw this.rejection(409, "RETRY_LIMIT_REACHED", "Message retry limit reached", request.clientMessageId);
    }

    const acceptedAt = this.iso(now);
    const execution: StoredExecution = {
      clientMessageId: request.clientMessageId,
      logicalMessageId: logical.rootId,
      retryOfClientMessageId: request.retryOfClientMessageId,
      content: request.content,
      requestId: this.runtime.randomId("req"),
      executionId: this.runtime.randomId("exec"),
      acceptedAt,
      state: "in_progress"
    };
    if (!request.retryOfClientMessageId) {
      session.logicalMessages.set(logical.rootId, logical);
    }
    logical.attemptIds.push(request.clientMessageId);
    session.executions.set(request.clientMessageId, execution);
    session.inFlightId = request.clientMessageId;
    session.lastAcceptedAtMs = now;
    session.idleExpiresAtMs = now + IDLE_TTL_MS;

    try {
      const snapshot = await this.snapshots.capture(agentId, testNamespace);
      if (this.exceedsContext(session.transcript, request.content, snapshot)) {
        session.contextLimitReached = true;
        return this.failExecution(session, execution, {
          httpStatus: 409,
          code: "CHAT_CONTEXT_LIMIT",
          message: "Chat context limit reached",
          retryable: false
        });
      }
      await this.runtime.checkpoint?.(testNamespace, "beforeExecute");
      const controller = new AbortController();
      const timeout = this.startTimeout(testNamespace, EXECUTION_TIMEOUT_MS);
      const timeoutPromise = timeout.promise.then<never>(() => {
        controller.abort();
        throw executionError({
          httpStatus: 504,
          code: "MODEL_TIMEOUT",
          message: "Model execution timed out",
          retryable: true
        });
      });
      let output: { text: string };
      try {
        output = await Promise.race([
          this.adapter.execute({
            executionId: execution.executionId,
            snapshot,
            transcript: session.transcript.map((item) => ({ ...item })),
            message: request.content,
            signal: controller.signal
          }),
          timeoutPromise
        ]);
      } finally {
        timeout.cancel();
      }
      await this.runtime.checkpoint?.(testNamespace, "afterExecuteBeforeCommit");
      this.validateReply(output.text);
      const nextTranscript = [
        ...session.transcript,
        { role: "user" as const, content: request.content },
        { role: "assistant" as const, content: output.text }
      ];
      if (
        this.transcriptBytes(nextTranscript) > MAX_TRANSCRIPT_BYTES ||
        this.adapter.countTokens(this.serializeModelContext(nextTranscript, snapshot), snapshot) > MAX_CONTEXT_TOKENS
      ) {
        session.contextLimitReached = true;
        return this.failExecution(session, execution, {
          httpStatus: 409,
          code: "CHAT_CONTEXT_LIMIT",
          message: "Chat context limit reached",
          retryable: false
        });
      }
      session.transcript = nextTranscript;
      return this.succeedExecution(session, execution, output.text);
    } catch (error) {
      return this.failExecution(session, execution, failureFrom(error));
    }
  }

  private resolveLogicalMessage(session: ChatSession, request: ChatMessageRequest): LogicalMessage {
    if (!request.retryOfClientMessageId) {
      return { rootId: request.clientMessageId, content: request.content, attemptIds: [] };
    }
    const target = session.executions.get(request.retryOfClientMessageId);
    const logical = target ? session.logicalMessages.get(target.logicalMessageId) : undefined;
    const isDirectPrevious = Boolean(logical && logical.attemptIds.at(-1) === request.retryOfClientMessageId);
    if (
      !target ||
      !logical ||
      !isDirectPrevious ||
      target.state !== "terminal" ||
      target.body?.status !== "failed" ||
      target.retryable !== true ||
      target.content !== request.content
    ) {
      throw this.rejection(409, "INVALID_RETRY_TARGET", "Retry target is invalid", request.clientMessageId);
    }
    return logical;
  }

  private replay(execution: StoredExecution): ChatHttpResult {
    if (execution.state === "in_progress") {
      return {
        httpStatus: 202,
        body: {
          requestId: execution.requestId,
          executionId: execution.executionId,
          clientMessageId: execution.clientMessageId,
          logicalMessageId: execution.logicalMessageId,
          retryOfClientMessageId: execution.retryOfClientMessageId,
          status: "in_progress",
          acceptedAt: execution.acceptedAt,
          retryAfterMs: 1000,
          replayed: true
        }
      };
    }
    return { httpStatus: execution.httpStatus!, body: { ...execution.body!, replayed: true } };
  }

  private succeedExecution(session: ChatSession, execution: StoredExecution, reply: string): ChatHttpResult {
    const completedAt = this.iso(this.now(session.testNamespace));
    const body = {
      requestId: execution.requestId,
      executionId: execution.executionId,
      clientMessageId: execution.clientMessageId,
      logicalMessageId: execution.logicalMessageId,
      retryOfClientMessageId: execution.retryOfClientMessageId,
      status: "succeeded",
      reply,
      acceptedAt: execution.acceptedAt,
      completedAt,
      replayed: false
    };
    execution.state = "terminal";
    execution.httpStatus = 200;
    execution.body = body;
    execution.completedAt = completedAt;
    execution.retryable = false;
    session.inFlightId = undefined;
    return { httpStatus: 200, body };
  }

  private failExecution(session: ChatSession, execution: StoredExecution, failure: ReturnType<typeof failureFrom>): ChatHttpResult {
    const completedAt = this.iso(this.now(session.testNamespace));
    const body = {
      requestId: execution.requestId,
      executionId: execution.executionId,
      clientMessageId: execution.clientMessageId,
      logicalMessageId: execution.logicalMessageId,
      retryOfClientMessageId: execution.retryOfClientMessageId,
      status: "failed",
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      acceptedAt: execution.acceptedAt,
      completedAt,
      replayed: false
    };
    execution.state = "terminal";
    execution.httpStatus = failure.httpStatus;
    execution.body = body;
    execution.completedAt = completedAt;
    execution.retryable = failure.retryable;
    session.inFlightId = undefined;
    return { httpStatus: failure.httpStatus, body };
  }

  private validateRequest(request: ChatMessageRequest): void {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(request.clientMessageId)) {
      throw this.rejection(400, "INVALID_CLIENT_MESSAGE_ID", "Invalid client message ID", request.clientMessageId);
    }
    if (request.retryOfClientMessageId !== null && !/^[A-Za-z0-9_-]{16,64}$/.test(request.retryOfClientMessageId)) {
      throw this.rejection(400, "INVALID_RETRY_OF_ID", "Invalid retry target ID", request.clientMessageId);
    }
    if (typeof request.content !== "string" || request.content.trim().length === 0) {
      throw this.rejection(400, "INVALID_MESSAGE_CONTENT", "Message content must not be blank", request.clientMessageId);
    }
    if ([...request.content].length > MAX_CODE_POINTS) {
      throw this.rejection(400, "MESSAGE_TOO_LONG", "Message content is too long", request.clientMessageId);
    }
  }

  private validateReply(reply: unknown): asserts reply is string {
    if (typeof reply !== "string" || reply.length === 0) {
      throw executionError({
        httpStatus: 502,
        code: "MODEL_INVALID_OUTPUT",
        message: "Model returned invalid output",
        retryable: false
      });
    }
    if ([...reply].length > MAX_REPLY_CODE_POINTS || Buffer.byteLength(reply, "utf8") > MAX_REPLY_BYTES) {
      throw executionError({
        httpStatus: 502,
        code: "MODEL_OUTPUT_TOO_LARGE",
        message: "Model output is too large",
        retryable: false
      });
    }
  }

  private exceedsContext(transcript: ChatTranscriptEntry[], content: string, snapshot: ChatConfigurationSnapshot): boolean {
    const next = [...transcript, { role: "user" as const, content }];
    return (
      this.transcriptBytes(next) > MAX_TRANSCRIPT_BYTES ||
      this.adapter.countTokens(this.serializeModelContext(next, snapshot), snapshot) > MAX_CONTEXT_TOKENS
    );
  }

  private transcriptBytes(transcript: ChatTranscriptEntry[]): number {
    return Buffer.byteLength(this.serializeTranscript(transcript), "utf8");
  }

  private serializeTranscript(transcript: ChatTranscriptEntry[]): string {
    return transcript.map((entry) => `${entry.role}:${entry.content}`).join("\n");
  }

  private serializeModelContext(transcript: ChatTranscriptEntry[], snapshot: ChatConfigurationSnapshot): string {
    return [
      `soul:${snapshot.soul}`,
      `skills:${JSON.stringify(snapshot.skills)}`,
      `workflow:${snapshot.workflow.activeHash}`,
      this.serializeTranscript(transcript)
    ].join("\n");
  }

  private updateLifecycle(session: ChatSession, now: number): void {
    if (!session.tombstoneReason && (now >= session.idleExpiresAtMs || now >= session.absoluteExpiresAtMs)) {
      session.tombstoneReason = "expired";
      session.tombstonedAtMs = Math.min(session.idleExpiresAtMs, session.absoluteExpiresAtMs);
    }
  }

  private cleanup(now: number, testNamespace?: string): void {
    for (const [id, session] of this.sessions) {
      if (session.testNamespace !== testNamespace) continue;
      this.updateLifecycle(session, now);
      if (session.tombstonedAtMs !== undefined && now - session.tombstonedAtMs >= TOMBSTONE_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }

  private evictIfRequired(userId: string, now: number, testNamespace?: string): void {
    const active = [...this.sessions.values()].filter(
      (session) => session.userId === userId && session.testNamespace === testNamespace && !session.tombstoneReason
    );
    if (active.length < MAX_ACTIVE_SESSIONS) return;
    const candidates = active
      .filter((session) => !session.inFlightId)
      .sort(
        (a, b) =>
          a.lastAcceptedAtMs - b.lastAcceptedAtMs || a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)
      );
    const victim = candidates[0];
    if (!victim) {
      throw this.rejection(429, "CHAT_SESSION_LIMIT", "All chat sessions are busy", null);
    }
    victim.tombstoneReason = "evicted";
    victim.tombstonedAtMs = now;
  }

  private rejection(status: number, code: string, message: string, clientMessageId: string | null) {
    return new ChatApiException(status, code, message, {
      requestId: this.runtime.randomId("req"),
      clientMessageId
    });
  }

  private now(testNamespace?: string): number {
    return this.runtime.now(testNamespace);
  }

  private startTimeout(testNamespace: string | undefined, milliseconds: number) {
    if (this.runtime.timeout) return this.runtime.timeout(testNamespace, milliseconds);
    let timer: NodeJS.Timeout;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    });
    return { promise, cancel: () => clearTimeout(timer) };
  }

  private iso(milliseconds: number): string {
    return new Date(milliseconds).toISOString();
  }
}

export function createChatRuntime(testControl: ChatTestControlService): ChatRuntime {
  return {
    now: (namespace) => testControl.now(namespace),
    generation: (namespace) => testControl.generation(namespace),
    randomId: (prefix) => `${prefix}_${randomUUID()}`,
    increment: (namespace, counter) => testControl.increment(namespace, counter),
    checkpoint: (namespace, key) => testControl.checkpoint(namespace, key),
    timeout: (namespace, milliseconds) => {
      if (namespace) {
        return testControl.waitForClock(namespace, testControl.now(namespace) + milliseconds);
      }
      let timer: NodeJS.Timeout;
      const promise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
      });
      return { promise, cancel: () => clearTimeout(timer) };
    }
  };
}
