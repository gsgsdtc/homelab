type LoadedAdapterModule = Record<string, any>;

function loadAdapterModule(): LoadedAdapterModule | null {
  try {
    return require("../src/modules/chat/openai-compatible-mastra-chat.adapter") as LoadedAdapterModule;
  } catch {
    return null;
  }
}

const adapterModule = loadAdapterModule();

describe("OpenAICompatibleMastraChatAdapter", () => {
  it("provides the typed model-only adapter", () => {
    expect(adapterModule?.OpenAICompatibleMastraChatAdapter).toBeDefined();
  });

  if (!adapterModule) return;

  const snapshot = {
    provider: {
      id: "provider-1",
      baseUrl: "https://provider.test/v1",
      apiKey: "sk-canary-secret",
      model: "gpt-test"
    },
    soul: "System prompt",
    soulRevision: "soul-v1",
    skills: {},
    workflow: { workflowKey: "default", activeHash: "workflow-v1", source: "model-only" },
    versionVector: "vector-v1"
  };
  const input = {
    executionId: "exec-1",
    snapshot,
    transcript: [],
    message: "hello",
    signal: new AbortController().signal
  };

  function createAdapter(faults: Record<string, boolean> = {}) {
    const clockWaiters: Array<() => void> = [];
    const control = {
      fault: jest.fn((_namespace: string | undefined, key: string) => Boolean(faults[key])),
      increment: jest.fn(),
      observe: jest.fn(),
      checkpoint: jest.fn(),
      now: jest.fn(() => 0),
      waitForClock: jest.fn(() => ({
        promise: new Promise<void>((resolve) => clockWaiters.push(resolve)),
        cancel: jest.fn()
      }))
    };
    return { adapter: new adapterModule!.OpenAICompatibleMastraChatAdapter(control), control, clockWaiters };
  }

  afterEach(() => jest.restoreAllMocks());

  it("rejects tool-capable workflows before any provider or tool execution", async () => {
    const { adapter } = createAdapter();
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(
      adapter.execute({
        ...input,
        snapshot: { ...snapshot, workflow: { ...snapshot.workflow, source: "tools: { deploy: handler }" } }
      })
    ).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ httpStatus: 422, code: "TOOL_NOT_ALLOWED", retryable: false })
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns one complete text response without leaking credentials", async () => {
    const { adapter } = createAdapter();
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "complete reply" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(adapter.execute(input)).resolves.toEqual({ text: "complete reply" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://provider.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-canary-secret" }),
        body: expect.not.stringContaining("sk-canary-secret")
      })
    );
  });

  it("stops reading a chunked provider response once it exceeds one MiB", async () => {
    const { adapter } = createAdapter();
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          }
        }),
        { status: 200 }
      )
    );

    await expect(adapter.execute(input)).rejects.toMatchObject({
      chatFailure: expect.objectContaining({
        httpStatus: 502,
        code: "PROVIDER_RESPONSE_TOO_LARGE",
        retryable: false
      })
    });
  });

  it.each([
    ["provider_401", 502, "PROVIDER_AUTH_FAILED", false],
    ["model_not_found", 502, "MODEL_NOT_FOUND", false],
    ["provider_429", 429, "MODEL_RATE_LIMITED", true],
    ["provider_5xx", 502, "MODEL_UPSTREAM_ERROR", true],
    ["transport_error", 502, "PROVIDER_TRANSPORT_ERROR", true],
    ["provider_4xx", 502, "PROVIDER_REQUEST_REJECTED", false],
    ["invalid_json", 502, "PROVIDER_INVALID_RESPONSE", false],
    ["empty_output", 502, "MODEL_INVALID_OUTPUT", false],
    ["oversized_body", 502, "PROVIDER_RESPONSE_TOO_LARGE", false],
    ["oversized_reply", 502, "MODEL_OUTPUT_TOO_LARGE", false],
    ["timeout", 504, "MODEL_TIMEOUT", true]
  ])("maps injected %s deterministically", async (fault, status, code, retryable) => {
    const { adapter } = createAdapter({ [fault]: true });

    await expect(adapter.execute({ ...input, snapshot: { ...snapshot, testNamespace: "namespace-1" } })).rejects.toMatchObject({
      chatFailure: { httpStatus: status, code, message: expect.any(String), retryable }
    });
  });

  it("holds an injected late success until the fake timeout boundary", async () => {
    const { adapter, control, clockWaiters } = createAdapter({ late_success: true });
    const result = adapter.execute({ ...input, snapshot: { ...snapshot, testNamespace: "namespace-1" } });
    await Promise.resolve();

    expect(control.waitForClock).toHaveBeenCalledWith("namespace-1", 60_000);
    expect(clockWaiters).toHaveLength(1);
    clockWaiters[0]!();

    await expect(result).resolves.toEqual({ text: "late success" });
    expect(control.checkpoint).toHaveBeenCalledWith("namespace-1", "afterTimeoutBeforeLateResult");
  });
});
