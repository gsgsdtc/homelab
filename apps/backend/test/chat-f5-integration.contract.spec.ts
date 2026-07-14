import { ChatTestControlService } from "../src/modules/chat-test-control/chat-test-control.service";
import { createChatRuntime, ChatSessionService } from "../src/modules/chat/chat-session.service";
import { MastraChatRuntimeExecutor } from "../src/modules/chat/mastra-chat-runtime.executor";
import { OpenAICompatibleMastraChatAdapter } from "../src/modules/chat/openai-compatible-mastra-chat.adapter";

describe("chat F5 generation and late-result integration", () => {
  const agentId = "agent-1";
  const userId = "admin-1";

  function executable() {
    return {
      id: "default",
      committed: true,
      steps: {},
      createRun: jest.fn().mockResolvedValue({
        cancel: jest.fn(),
        start: jest.fn(async ({ inputData }: any) => ({
          status: "success",
          result: await inputData.model.generate(),
          input: inputData,
          steps: {}
        }))
      })
    };
  }

  function harness(control: ChatTestControlService) {
    let sequence = 0;
    const snapshots = {
      getEligibility: jest.fn().mockResolvedValue({
        agentId,
        eligible: true,
        code: null,
        message: null,
        agent: { name: "Agent", status: "ready" },
        providerSummary: { id: "provider-1", name: "Provider", model: "model" }
      }),
      capture: jest.fn(async (_agentId: string, namespace?: string, generation?: number) => {
        control.increment(namespace, "snapshotAttempts", generation);
        return {
          provider: {
            id: "provider-1",
            baseUrl: "https://provider.test/v1",
            apiKey: "sk-canary-secret",
            model: "model"
          },
          soul: "system",
          soulRevision: "soul-v1",
          skills: {},
          workflow: {
            workflowKey: "default" as const,
            activeHash: "workflow-v1",
            source: 'import { createWorkflow } from "@mastra/core/workflows";',
            executable: executable()
          },
          versionVector: "vector-v1",
          testNamespace: namespace,
          testGeneration: generation
        };
      })
    };
    const adapter = new OpenAICompatibleMastraChatAdapter(control, new MastraChatRuntimeExecutor());
    const runtime = createChatRuntime(control);
    runtime.randomId = (prefix) => `${prefix}_${String(sequence++).padStart(20, "0")}`;
    const sessions = new ChatSessionService(snapshots as any, adapter, runtime);
    return { sessions, adapter };
  }

  afterEach(() => jest.restoreAllMocks());

  it("atomically cancels a barrier-held old generation without polluting reset state", async () => {
    const control = new ChatTestControlService({ enabled: true });
    const namespace = control.createNamespace();
    const { sessions } = harness(control);
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "old generation reply" } }] }), { status: 200 })
    );
    control.enableBarrier(namespace.id, "afterExecuteBeforeCommit");
    const session = await sessions.createSession(userId, agentId, namespace.id);
    const pending = sessions.sendMessage(
      userId,
      agentId,
      session.sessionId,
      { clientMessageId: "Message_123456789", content: "hello", retryOfClientMessageId: null },
      namespace.id
    );
    for (let index = 0; index < 20 && control.getNamespace(namespace.id).observations.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(control.getNamespace(namespace.id).counters).toEqual(
      expect.objectContaining({ snapshotAttempts: 1, adapterCalls: 1, runtimeCalls: 1, modelCalls: 1 })
    );

    control.reset(namespace.id);

    await expect(pending).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ code: "TEST_NAMESPACE_RESET", retryable: false })
    });
    expect(control.getNamespace(namespace.id)).toEqual(
      expect.objectContaining({
        counters: expect.objectContaining({ adapterCalls: 0, runtimeCalls: 0, modelCalls: 0 }),
        observations: []
      })
    );
    await expect(
      sessions.sendMessage(
        userId,
        agentId,
        session.sessionId,
        { clientMessageId: "short", content: "\u0085", retryOfClientMessageId: null },
        namespace.id
      )
    ).rejects.toMatchObject({ status: 404, response: expect.objectContaining({ code: "CHAT_SESSION_NOT_FOUND" }) });
    control.delete(namespace.id);
    expect(control.listActiveNamespaces()).toEqual([]);
  });

  it("keeps MODEL_TIMEOUT terminal after a real adapter late success and records safe request observations", async () => {
    const control = new ChatTestControlService({ enabled: true });
    const namespace = control.createNamespace();
    const { sessions } = harness(control);
    control.setFaults(namespace.id, { late_success: true });
    control.enableBarrier(namespace.id, "afterTimeoutBeforeLateResult");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "retry success" } }] }), { status: 200 })
    );
    const session = await sessions.createSession(userId, agentId, namespace.id);
    const original = { clientMessageId: "Message_123456789", content: "hello", retryOfClientMessageId: null };
    const pending = sessions.sendMessage(userId, agentId, session.sessionId, original, namespace.id);
    for (let index = 0; index < 30 && control.getNamespace(namespace.id).counters.modelCalls === 0; index += 1) {
      await Promise.resolve();
    }

    control.advanceClock(namespace.id, 60_000);
    const timedOut = await pending;
    expect(timedOut).toEqual({
      httpStatus: 504,
      body: expect.objectContaining({ status: "failed", code: "MODEL_TIMEOUT", retryable: true })
    });
    control.setFaults(namespace.id, {});
    control.releaseBarrier(namespace.id, "afterTimeoutBeforeLateResult");
    await Promise.resolve();

    const replay = await sessions.sendMessage(userId, agentId, session.sessionId, original, namespace.id);
    expect(replay).toEqual({ httpStatus: 504, body: { ...timedOut.body, replayed: true } });
    const retry = await sessions.sendMessage(
      userId,
      agentId,
      session.sessionId,
      {
        clientMessageId: "Message_retry_0001",
        content: "hello",
        retryOfClientMessageId: "Message_123456789"
      },
      namespace.id
    );
    expect(retry.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const providerBody = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(providerBody.messages.filter((message: any) => message.role === "user")).toEqual([
      { role: "user", content: "hello" }
    ]);
    const observations = control.observations(namespace.id, { requestId: String(timedOut.body.requestId) });
    expect(observations).toEqual([
      expect.objectContaining({
        requestId: timedOut.body.requestId,
        executionId: timedOut.body.executionId,
        snapshotVersion: "vector-v1",
        resultCode: "MODEL_TIMEOUT"
      })
    ]);
    expect(control.observations(namespace.id, { requestId: String(retry.body.requestId) })).toEqual([
      expect.objectContaining({
        requestId: retry.body.requestId,
        executionId: retry.body.executionId,
        resultCode: "SUCCEEDED"
      }),
      expect.objectContaining({
        requestId: retry.body.requestId,
        executionId: retry.body.executionId,
        snapshotVersion: "vector-v1",
        resultCode: "SUCCEEDED"
      })
    ]);
    expect(JSON.stringify(control.getNamespace(namespace.id))).not.toContain("sk-canary-secret");
    expect(control.getNamespace(namespace.id).counters).toEqual(
      expect.objectContaining({ snapshotAttempts: 2, modelCalls: 2, adapterCalls: 2, runtimeCalls: 2 })
    );
    control.delete(namespace.id);
    expect(control.listActiveNamespaces()).toEqual([]);
  });

  it("records a deterministic failed execution by request and execution ID", async () => {
    const control = new ChatTestControlService({ enabled: true });
    const namespace = control.createNamespace();
    const { sessions } = harness(control);
    control.setFaults(namespace.id, { provider_401: true });
    const session = await sessions.createSession(userId, agentId, namespace.id);

    const failed = await sessions.sendMessage(
      userId,
      agentId,
      session.sessionId,
      { clientMessageId: "Message_123456789", content: "hello", retryOfClientMessageId: null },
      namespace.id
    );

    expect(failed).toEqual({
      httpStatus: 502,
      body: expect.objectContaining({ status: "failed", code: "PROVIDER_AUTH_FAILED", retryable: false })
    });
    expect(control.observations(namespace.id, { executionId: String(failed.body.executionId) })).toEqual([
      expect.objectContaining({
        requestId: failed.body.requestId,
        executionId: failed.body.executionId,
        snapshotVersion: "vector-v1",
        resultCode: "PROVIDER_AUTH_FAILED"
      })
    ]);
    expect(control.getNamespace(namespace.id).counters).toEqual(
      expect.objectContaining({ snapshotAttempts: 1, adapterCalls: 1, runtimeCalls: 1, modelCalls: 1 })
    );
    expect(JSON.stringify(control.getNamespace(namespace.id))).not.toContain("sk-canary-secret");
    control.delete(namespace.id);
    expect(control.listActiveNamespaces()).toEqual([]);
  });
});
