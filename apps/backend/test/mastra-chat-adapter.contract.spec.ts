import { AddressInfo } from "net";
import { createServer, Server } from "http";

type LoadedAdapterModule = Record<string, any>;

function loadAdapterModule(): LoadedAdapterModule | null {
  try {
    return require("../src/modules/chat/openai-compatible-mastra-chat.adapter") as LoadedAdapterModule;
  } catch {
    return null;
  }
}

const adapterModule = loadAdapterModule();
const executorModule = require("../src/modules/chat/mastra-chat-runtime.executor") as Record<string, any>;

describe("OpenAICompatibleMastraChatAdapter", () => {
  it("provides the typed model-only adapter", () => {
    expect(adapterModule?.OpenAICompatibleMastraChatAdapter).toBeDefined();
  });

  if (!adapterModule) return;

  let providerServer: Server;
  let providerBaseUrl: string;
  let providerReply: { status: number; body: string; headers?: Record<string, string>; hold?: boolean };

  beforeAll(async () => {
    providerServer = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (providerReply.hold) return;
        response.writeHead(providerReply.status, {
          "content-type": "application/json",
          ...providerReply.headers
        });
        response.end(providerReply.body);
      });
    });
    await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const address = providerServer.address() as AddressInfo;
    providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      providerServer.close((error) => (error ? reject(error) : resolve()))
    );
  });

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
    workflow: {
      workflowKey: "default",
      activeHash: "workflow-v1",
      source: "model-only",
      executable: executable()
    },
    versionVector: "vector-v1"
  };

  function executable(overrides: Record<string, unknown> = {}) {
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
      }),
      ...overrides
    };
  }
  const input = {
    requestId: "req-1",
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
    return {
      adapter: new adapterModule!.OpenAICompatibleMastraChatAdapter(
        control,
        new executorModule.MastraChatRuntimeExecutor()
      ),
      control,
      clockWaiters
    };
  }

  afterEach(() => jest.restoreAllMocks());

  /**
   * @doc GFU-27 F2 R33/R36 / second-round PR #36 blocker 3
   * @purpose Verify the production Provider/model tokenizer enforces the 32,000-token boundary when code points diverge.
   * @context A regression lets non-ASCII context bypass the model context limit and reach the Provider.
   */
  it("uses the provider model tokenizer at the 32,000-token boundary instead of code-point length", () => {
    const { adapter } = createAdapter();
    const value = "😀".repeat(16_001);
    const legacySnapshot = {
      ...snapshot,
      provider: { ...snapshot.provider, model: "gpt-3.5-turbo" }
    };
    const modernSnapshot = {
      ...snapshot,
      provider: { ...snapshot.provider, model: "gpt-4o" }
    };

    expect([...value]).toHaveLength(16_001);
    expect(adapter.countTokens("😀", legacySnapshot)).toBe(2);
    expect(adapter.countTokens("😀", modernSnapshot)).toBe(1);
    expect(adapter.countTokens(value, legacySnapshot)).toBeGreaterThan(32_000);
  });

  it("rejects tool-capable workflows before any provider or tool execution", async () => {
    const { adapter } = createAdapter();
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(
      adapter.execute({
        ...input,
        snapshot: {
          ...snapshot,
          workflow: {
            ...snapshot.workflow,
            executable: executable({
              steps: { deploy: { id: "deploy", component: "tool", execute: jest.fn() } }
            })
          }
        }
      })
    ).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ httpStatus: 422, code: "TOOL_NOT_ALLOWED", retryable: false })
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("executes the executable frozen into the activeHash snapshot", async () => {
    const { adapter } = createAdapter();
    const frozen = executable();
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "from frozen" } }] }), { status: 200 })
    );

    await expect(
      adapter.execute({
        ...input,
        snapshot: { ...snapshot, workflow: { ...snapshot.workflow, activeHash: "workflow-v1", executable: frozen } }
      })
    ).resolves.toEqual({ text: "from frozen" });
    expect(frozen.createRun).toHaveBeenCalledWith({ runId: "exec-1" });
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

  it.each([
    [401, "PROVIDER_AUTH_FAILED", 502, false],
    [403, "PROVIDER_AUTH_FAILED", 502, false],
    [404, "MODEL_NOT_FOUND", 502, false],
    [429, "MODEL_RATE_LIMITED", 429, true],
    [400, "PROVIDER_REQUEST_REJECTED", 502, false],
    [503, "MODEL_UPSTREAM_ERROR", 502, true]
  ])(
    "maps a real HTTP provider %i response to %s",
    async (providerStatus, code, httpStatus, retryable) => {
      providerReply = { status: providerStatus, body: JSON.stringify({ error: { message: "sensitive upstream detail" } }) };
      const { adapter } = createAdapter();

      await expect(
        adapter.execute({
          ...input,
          snapshot: { ...snapshot, provider: { ...snapshot.provider, baseUrl: providerBaseUrl } }
        })
      ).rejects.toMatchObject({
        chatFailure: { httpStatus, code, message: expect.not.stringContaining("sensitive upstream detail"), retryable }
      });
    }
  );

  it.each([
    ["not-json", "PROVIDER_INVALID_RESPONSE"],
    [JSON.stringify({ choices: "invalid-schema" }), "MODEL_INVALID_OUTPUT"],
    [JSON.stringify({ choices: [{ message: { content: "" } }] }), "MODEL_INVALID_OUTPUT"],
    [JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "forbidden" }] } }] }), "TOOL_NOT_ALLOWED"]
  ])("validates a real HTTP provider body without falling back to tools (%s)", async (body, code) => {
    providerReply = { status: 200, body };
    const { adapter } = createAdapter();

    await expect(
      adapter.execute({
        ...input,
        snapshot: { ...snapshot, provider: { ...snapshot.provider, baseUrl: providerBaseUrl } }
      })
    ).rejects.toMatchObject({ chatFailure: expect.objectContaining({ code }) });
  });

  it("maps an actual provider transport failure", async () => {
    const { adapter } = createAdapter();
    await expect(
      adapter.execute({
        ...input,
        snapshot: { ...snapshot, provider: { ...snapshot.provider, baseUrl: "http://127.0.0.1:1/v1" } }
      })
    ).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ httpStatus: 502, code: "PROVIDER_TRANSPORT_ERROR", retryable: true })
    });
  });

  it("maps abort while waiting on a real provider response to MODEL_TIMEOUT", async () => {
    providerReply = { status: 200, body: "", hold: true };
    const { adapter } = createAdapter();
    const controller = new AbortController();
    const result = adapter.execute({
      ...input,
      signal: controller.signal,
      snapshot: { ...snapshot, provider: { ...snapshot.provider, baseUrl: providerBaseUrl } }
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(result).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ httpStatus: 504, code: "MODEL_TIMEOUT", retryable: true })
    });
  });

  it("rejects an oversized real HTTP body before reading it", async () => {
    providerReply = {
      status: 200,
      body: "x",
      headers: { "content-length": String(1024 * 1024 + 1) }
    };
    const { adapter } = createAdapter();

    await expect(
      adapter.execute({
        ...input,
        snapshot: { ...snapshot, provider: { ...snapshot.provider, baseUrl: providerBaseUrl } }
      })
    ).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ code: "PROVIDER_RESPONSE_TOO_LARGE", retryable: false })
    });
  });

  it("stops reading a real chunked HTTP body after one MiB", async () => {
    providerReply = { status: 200, body: "x".repeat(1024 * 1024 + 1) };
    const { adapter } = createAdapter();

    await expect(
      adapter.execute({
        ...input,
        snapshot: { ...snapshot, provider: { ...snapshot.provider, baseUrl: providerBaseUrl } }
      })
    ).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ code: "PROVIDER_RESPONSE_TOO_LARGE", retryable: false })
    });
  });

  it("holds an injected late success until the fake timeout boundary", async () => {
    const { adapter, control, clockWaiters } = createAdapter({ late_success: true });
    const result = adapter.execute({ ...input, snapshot: { ...snapshot, testNamespace: "namespace-1" } });
    for (let index = 0; index < 10 && control.waitForClock.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }

    expect(control.waitForClock).toHaveBeenCalledWith("namespace-1", 60_000, undefined);
    expect(clockWaiters).toHaveLength(1);
    clockWaiters[0]!();

    await expect(result).resolves.toEqual({ text: "late success" });
    expect(control.checkpoint).toHaveBeenCalledWith("namespace-1", "afterTimeoutBeforeLateResult", undefined);
  });
});
