type LoadedChatModule = Record<string, any>;

function loadChatModule(): LoadedChatModule | null {
  try {
    return require("../src/modules/chat/chat-session.service") as LoadedChatModule;
  } catch {
    return null;
  }
}

const chatModule = loadChatModule();

describe("P0 chat backend contract", () => {
  it("provides the temporary chat session state machine", () => {
    expect(chatModule?.ChatSessionService).toBeDefined();
  });

  if (!chatModule) {
    return;
  }

  const agentId = "agent-1";
  const userId = "admin-1";
  const validId = "Message_123456789";
  const eligibility = {
    agentId,
    eligible: true,
    code: null,
    message: null,
    agent: { name: "Ops Agent", status: "ready" },
    providerSummary: { id: "provider-1", name: "Primary", model: "gpt-test" }
  };

  function createHarness(
    options: {
      execute?: jest.Mock;
      countTokens?: jest.Mock;
      now?: () => number;
      randomId?: (prefix: string) => string;
      timeout?: () => { promise: Promise<void>; cancel: () => void };
    } = {}
  ) {
    const snapshot = {
      getEligibility: jest.fn().mockResolvedValue(eligibility),
      capture: jest.fn().mockResolvedValue({
        provider: { id: "provider-1", baseUrl: "https://provider.test", apiKey: "secret", model: "gpt-test" },
        soul: "Keep systems stable.",
        soulRevision: "soul-hash",
        skills: {},
        workflow: { workflowKey: "default", activeHash: "workflow-hash", source: "model-only" },
        versionVector: "vector-1"
      })
    };
    const adapter = {
      execute:
        options.execute ??
        jest.fn().mockResolvedValue({
          text: "Acknowledged."
        }),
      countTokens: options.countTokens ?? jest.fn((value: string) => [...value].length)
    };
    const service = new chatModule!.ChatSessionService(snapshot, adapter, {
      now: options.now ?? (() => Date.parse("2026-07-14T00:00:00.000Z")),
      randomId:
        options.randomId ??
        jest.fn((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2).padEnd(20, "0")}`),
      timeout: options.timeout
    });
    return { service, snapshot, adapter };
  }

  it("creates an isolated bounded session and returns frozen limits", async () => {
    const { service } = createHarness();

    const result = await service.createSession(userId, agentId);

    expect(result).toEqual(
      expect.objectContaining({
        sessionId: expect.any(String),
        createdAt: "2026-07-14T00:00:00.000Z",
        idleExpiresAt: "2026-07-14T00:30:00.000Z",
        absoluteExpiresAt: "2026-07-14T02:00:00.000Z",
        tombstoneRetentionMs: 900000,
        maxCodePoints: 8000,
        maxLogicalMessages: 20,
        maxAttemptsPerMessage: 3,
        maxTranscriptBytes: 524288,
        maxContextTokens: 32000,
        maxRetainedTombstones: 100
      })
    );
  });

  it("executes once and replays the original terminal DTO for the same payload", async () => {
    const { service, adapter, snapshot } = createHarness();
    const session = await service.createSession(userId, agentId);
    const request = { clientMessageId: validId, content: "hello", retryOfClientMessageId: null };

    const first = await service.sendMessage(userId, agentId, session.sessionId, request);
    const replay = await service.sendMessage(userId, agentId, session.sessionId, request);

    expect(first.httpStatus).toBe(200);
    expect(first.body).toEqual(
      expect.objectContaining({
        clientMessageId: validId,
        logicalMessageId: validId,
        retryOfClientMessageId: null,
        status: "succeeded",
        reply: "Acknowledged.",
        replayed: false
      })
    );
    expect(replay).toEqual({ httpStatus: 200, body: { ...first.body, replayed: true } });
    expect(snapshot.capture).toHaveBeenCalledTimes(1);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("checks idempotency before the per-session in-flight rejection", async () => {
    let release!: (value: { text: string }) => void;
    const pending = new Promise<{ text: string }>((resolve) => {
      release = resolve;
    });
    const { service, adapter } = createHarness({ execute: jest.fn().mockReturnValue(pending) });
    const session = await service.createSession(userId, agentId);
    const original = { clientMessageId: validId, content: "hello", retryOfClientMessageId: null };
    const firstPromise = service.sendMessage(userId, agentId, session.sessionId, original);
    await Promise.resolve();

    const sameId = await service.sendMessage(userId, agentId, session.sessionId, original);
    await expect(
      service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: "Message_987654321",
        content: "second",
        retryOfClientMessageId: null
      })
    ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "MESSAGE_IN_PROGRESS" }) });

    expect(sameId.httpStatus).toBe(202);
    expect(sameId.body).toEqual(expect.objectContaining({ status: "in_progress", replayed: true, retryAfterMs: 1000 }));
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    release({ text: "done" });
    await firstPromise;
  });

  it("rejects same id with a byte-distinct payload without changing the original", async () => {
    const { service } = createHarness();
    const session = await service.createSession(userId, agentId);
    await service.sendMessage(userId, agentId, session.sessionId, {
      clientMessageId: validId,
      content: "hello",
      retryOfClientMessageId: null
    });

    await expect(
      service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: validId,
        content: "hello ",
        retryOfClientMessageId: null
      })
    ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }) });
  });

  it("enforces owner and agent isolation with the same not-found response", async () => {
    const { service } = createHarness();
    const session = await service.createSession(userId, agentId);
    const request = { clientMessageId: validId, content: "hello", retryOfClientMessageId: null };

    await expect(service.sendMessage("other-admin", agentId, session.sessionId, request)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" })
    });
    await expect(service.sendMessage(userId, "other-agent", session.sessionId, request)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" })
    });
  });

  it("checks session ownership before malformed payloads to prevent enumeration", async () => {
    const { service, adapter } = createHarness();
    const session = await service.createSession(userId, agentId);

    await expect(
      service.sendMessage("other-admin", agentId, session.sessionId, {
        clientMessageId: "short",
        content: "\u0085",
        retryOfClientMessageId: "bad"
      })
    ).rejects.toMatchObject({ status: 404, response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" }) });
    await expect(
      service.sendMessage(userId, "other-agent", session.sessionId, {
        clientMessageId: "short",
        content: "\u0085",
        retryOfClientMessageId: "bad"
      })
    ).rejects.toMatchObject({ status: 404, response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" }) });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("keeps expired sessions as tombstones for exact id replay", async () => {
    let now = Date.parse("2026-07-14T00:00:00.000Z");
    const { service, adapter } = createHarness({ now: () => now });
    const session = await service.createSession(userId, agentId);
    const request = { clientMessageId: validId, content: "hello", retryOfClientMessageId: null };
    const first = await service.sendMessage(userId, agentId, session.sessionId, request);
    now += 30 * 60 * 1000;

    const replay = await service.sendMessage(userId, agentId, session.sessionId, request);
    await expect(
      service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: "Message_987654321",
        content: "new",
        retryOfClientMessageId: null
      })
    ).rejects.toMatchObject({ status: 410, response: expect.objectContaining({ code: "CHAT_SESSION_EXPIRED" }) });

    expect(replay).toEqual({ httpStatus: 200, body: { ...first.body, replayed: true } });
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    now += 15 * 60 * 1000;
    await expect(service.sendMessage(userId, agentId, session.sessionId, request)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" })
    });
  });

  it("allows a new attempt only after a retryable terminal failure", async () => {
    const retryable = Object.assign(new Error("rate limited"), {
      chatFailure: { httpStatus: 429, code: "MODEL_RATE_LIMITED", message: "Model is busy", retryable: true }
    });
    const execute = jest.fn().mockRejectedValueOnce(retryable).mockResolvedValueOnce({ text: "Recovered" });
    const { service } = createHarness({ execute });
    const session = await service.createSession(userId, agentId);
    const first = await service.sendMessage(userId, agentId, session.sessionId, {
      clientMessageId: validId,
      content: "hello",
      retryOfClientMessageId: null
    });

    const second = await service.sendMessage(userId, agentId, session.sessionId, {
      clientMessageId: "Message_retry_0001",
      content: "hello",
      retryOfClientMessageId: validId
    });

    expect(first.httpStatus).toBe(429);
    expect(first.body).toEqual(expect.objectContaining({ status: "failed", code: "MODEL_RATE_LIMITED", retryable: true }));
    expect(second.body).toEqual(
      expect.objectContaining({
        status: "succeeded",
        logicalMessageId: validId,
        retryOfClientMessageId: validId,
        reply: "Recovered"
      })
    );
  });

  it("commits timeout once and discards a late adapter success", async () => {
    let releaseAdapter!: (value: { text: string }) => void;
    let fireTimeout!: () => void;
    const execute = jest.fn().mockReturnValue(
      new Promise<{ text: string }>((resolve) => {
        releaseAdapter = resolve;
      })
    );
    const timeout = jest.fn(() => ({
      promise: new Promise<void>((resolve) => {
        fireTimeout = resolve;
      }),
      cancel: jest.fn()
    }));
    const { service } = createHarness({ execute, timeout });
    const session = await service.createSession(userId, agentId);
    const request = { clientMessageId: validId, content: "hello", retryOfClientMessageId: null };
    const resultPromise = service.sendMessage(userId, agentId, session.sessionId, request);
    for (let index = 0; index < 10 && !fireTimeout; index += 1) await Promise.resolve();

    fireTimeout();
    const timedOut = await resultPromise;
    releaseAdapter({ text: "must not be committed" });
    await Promise.resolve();
    const replay = await service.sendMessage(userId, agentId, session.sessionId, request);

    expect(timedOut).toEqual({
      httpStatus: 504,
      body: expect.objectContaining({ status: "failed", code: "MODEL_TIMEOUT", retryable: true, replayed: false })
    });
    expect(replay).toEqual({ httpStatus: 504, body: { ...timedOut.body, replayed: true } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the started execution on its frozen snapshot and captures updates only for the next message", async () => {
    let releaseFirst!: (value: { text: string }) => void;
    const execute = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ text: string }>((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ text: "reply from v2" });
    const { service, snapshot, adapter } = createHarness({ execute });
    const frozen = (version: string) => ({
      provider: { id: `provider-${version}`, baseUrl: "https://provider.test", apiKey: "secret", model: "gpt-test" },
      soul: `soul-${version}`,
      soulRevision: `soul-${version}`,
      skills: { skill: { configVersion: `cfg-${version}` } },
      workflow: {
        workflowKey: "default",
        activeHash: `workflow-${version}`,
        source: "model-only",
        executable: { id: version }
      },
      versionVector: `vector-${version}`
    });
    snapshot.capture.mockReset().mockResolvedValueOnce(frozen("v1")).mockResolvedValueOnce(frozen("v2"));
    const session = await service.createSession(userId, agentId);
    const first = service.sendMessage(userId, agentId, session.sessionId, {
      clientMessageId: validId,
      content: "first",
      retryOfClientMessageId: null
    });
    for (let index = 0; index < 10 && adapter.execute.mock.calls.length === 0; index += 1) await Promise.resolve();

    expect(adapter.execute.mock.calls[0]![0].snapshot).toEqual(frozen("v1"));
    releaseFirst({ text: "reply from v1" });
    await expect(first).resolves.toEqual({ httpStatus: 200, body: expect.objectContaining({ reply: "reply from v1" }) });
    await service.sendMessage(userId, agentId, session.sessionId, {
      clientMessageId: "Message_987654321",
      content: "second",
      retryOfClientMessageId: null
    });

    expect(adapter.execute.mock.calls[1]![0].snapshot).toEqual(frozen("v2"));
  });

  it("blocks new IDs after the session reaches its context limit", async () => {
    const { service, adapter } = createHarness({ execute: jest.fn().mockResolvedValue({ text: "x".repeat(32_000) }) });
    const session = await service.createSession(userId, agentId);
    const first = await service.sendMessage(userId, agentId, session.sessionId, {
      clientMessageId: validId,
      content: "hello",
      retryOfClientMessageId: null
    });

    expect(first).toEqual({
      httpStatus: 409,
      body: expect.objectContaining({ status: "failed", code: "CHAT_CONTEXT_LIMIT", retryable: false })
    });
    await expect(
      service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: "Message_987654321",
        content: "new",
        retryOfClientMessageId: null
      })
    ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "CHAT_CONTEXT_LIMIT" }) });
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("validates message IDs, unicode whitespace and code-point limits before reservation", async () => {
    const { service, adapter } = createHarness();
    const session = await service.createSession(userId, agentId);

    await expect(
      service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: "short",
        content: "hello",
        retryOfClientMessageId: null
      })
    ).rejects.toMatchObject({ status: 400, response: expect.objectContaining({ code: "INVALID_CLIENT_MESSAGE_ID" }) });
    await expect(
      service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: validId,
        content: "\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000",
        retryOfClientMessageId: null
      })
    ).rejects.toMatchObject({ status: 400, response: expect.objectContaining({ code: "INVALID_MESSAGE_CONTENT" }) });
    await expect(
      service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: validId,
        content: "😀".repeat(8001),
        retryOfClientMessageId: null
      })
    ).rejects.toMatchObject({ status: 400, response: expect.objectContaining({ code: "MESSAGE_TOO_LONG" }) });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each([7_999, 8_000])("accepts exactly %s Unicode code points", async (codePoints) => {
    const { service, adapter } = createHarness();
    const session = await service.createSession(userId, agentId);

    const result = await service.sendMessage(userId, agentId, session.sessionId, {
      clientMessageId: validId,
      content: "😀".repeat(codePoints),
      retryOfClientMessageId: null
    });

    expect(result.httpStatus).toBe(200);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("bounds retained tombstones under high-frequency session churn", async () => {
    let sequence = 0;
    const snapshot = {
      getEligibility: jest.fn().mockResolvedValue(eligibility),
      capture: jest.fn()
    };
    const adapter = { execute: jest.fn(), countTokens: jest.fn() };
    const service = new chatModule!.ChatSessionService(snapshot, adapter, {
      now: () => Date.parse("2026-07-14T00:00:00.000Z"),
      randomId: jest.fn((prefix: string) => `${prefix}_${String(sequence++).padStart(20, "0")}`)
    });
    const sessions: string[] = [];
    for (let index = 0; index < 106; index += 1) {
      sessions.push((await service.createSession(userId, agentId)).sessionId);
    }
    const request = { clientMessageId: validId, content: "hello", retryOfClientMessageId: null };

    await expect(service.sendMessage(userId, agentId, sessions[0]!, request)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" })
    });
    await expect(service.sendMessage(userId, agentId, sessions[1]!, request)).rejects.toMatchObject({
      status: 410,
      response: expect.objectContaining({ code: "CHAT_SESSION_EVICTED" })
    });
  });

  it("bounds retained tombstone bytes even when terminal DTOs contain maximum replies", async () => {
    let sequence = 0;
    const largeReply = "😀".repeat(32_000);
    const { service } = createHarness({
      execute: jest.fn().mockResolvedValue({ text: largeReply }),
      countTokens: jest.fn(() => 0),
      randomId: (prefix: string) => `${prefix}_${String(sequence++).padStart(20, "0")}`
    });
    const sessions: string[] = [];
    for (let index = 0; index < 80; index += 1) {
      const session = await service.createSession(userId, agentId);
      sessions.push(session.sessionId);
      const result = await service.sendMessage(userId, agentId, session.sessionId, {
        clientMessageId: `Message_${String(index).padStart(16, "0")}`,
        content: "hello",
        retryOfClientMessageId: null
      });
      expect(result.httpStatus).toBe(200);
    }
    const request = { clientMessageId: validId, content: "hello", retryOfClientMessageId: null };

    await expect(service.sendMessage(userId, agentId, sessions[0]!, request)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" })
    });
    await expect(service.sendMessage(userId, agentId, sessions[74]!, request)).rejects.toMatchObject({
      status: 410,
      response: expect.objectContaining({ code: "CHAT_SESSION_EVICTED" })
    });
  });
});
