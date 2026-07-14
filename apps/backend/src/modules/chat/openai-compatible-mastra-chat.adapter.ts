import { Inject, Injectable } from "@nestjs/common";
import { Buffer } from "buffer";
import { encoding_for_model, get_encoding, Tiktoken } from "tiktoken";
import { ChatTestControlService } from "../chat-test-control/chat-test-control.service";
import { executionError } from "./chat.errors";
import { MastraChatAdapter, MastraChatExecuteInput } from "./mastra-chat.adapter";
import { MastraChatRuntimeExecutor, MastraWorkflowExecutable } from "./mastra-chat-runtime.executor";

const MAX_PROVIDER_BODY_BYTES = 1024 * 1024;
const MAX_REPLY_CODE_POINTS = 32000;
const MAX_REPLY_BYTES = 131072;

type AdapterControl = Pick<
  ChatTestControlService,
  "fault" | "increment" | "observe" | "checkpoint" | "now" | "waitForClock"
>;

@Injectable()
export class OpenAICompatibleMastraChatAdapter implements MastraChatAdapter {
  private readonly tokenizers = new Map<string, Tiktoken>();

  constructor(
    @Inject(ChatTestControlService) private readonly testControl: AdapterControl,
    private readonly runtime: MastraChatRuntimeExecutor
  ) {}

  async execute(input: MastraChatExecuteInput): Promise<{ text: string }> {
    const namespace = input.snapshot.testNamespace;
    const generation = input.snapshot.testGeneration;
    this.testControl.increment(namespace, "adapterCalls", generation);
    await this.testControl.checkpoint(namespace, "beforeExecute", generation);
    if (this.testControl.fault(namespace, "runtime_unavailable", generation)) {
      throw this.failure(503, "RUNTIME_UNAVAILABLE", "Chat runtime is unavailable", true);
    }
    this.testControl.increment(namespace, "runtimeCalls", generation);
    const output = await this.runtime.execute(
      input.snapshot.workflow.executable as MastraWorkflowExecutable,
      {
        executionId: input.executionId,
        workflowSource: input.snapshot.workflow.source,
        soul: input.snapshot.soul,
        skills: input.snapshot.skills,
        transcript: input.transcript,
        message: input.message,
        signal: input.signal
      },
      () => this.invokeProvider(input)
    );
    // A provider/workflow may settle after cancellation. Never let that late
    // result become observable or overwrite the session's terminal timeout.
    if (input.signal.aborted) {
      throw this.failure(504, "MODEL_TIMEOUT", "Model execution timed out", true);
    }
    const text = output.text;
    if (typeof text !== "string" || text.length === 0) {
      throw this.failure(502, "MODEL_INVALID_OUTPUT", "Model returned invalid output", false);
    }
    if ([...text].length > MAX_REPLY_CODE_POINTS || Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) {
      throw this.failure(502, "MODEL_OUTPUT_TOO_LARGE", "Model output is too large", false);
    }
    this.testControl.observe(namespace, {
      requestId: input.requestId,
      executionId: input.executionId,
      stage: "adapter",
      providerId: input.snapshot.provider.id,
      workflowHash: input.snapshot.workflow.activeHash,
      resultCode: "SUCCEEDED"
    }, generation);
    return { text };
  }

  countTokens(value: string, snapshot?: MastraChatExecuteInput["snapshot"]): number {
    const providerId = snapshot?.provider.id ?? "openai-compatible";
    const model = snapshot?.provider.model ?? "cl100k_base";
    const cacheKey = `${providerId}:${model}`;
    let tokenizer = this.tokenizers.get(cacheKey);
    if (!tokenizer) {
      try {
        tokenizer = encoding_for_model(model as Parameters<typeof encoding_for_model>[0]);
      } catch {
        // OpenAI-compatible providers may expose custom deployment names. The
        // pinned cl100k_base fallback keeps their resource accounting stable.
        tokenizer = get_encoding("cl100k_base");
      }
      this.tokenizers.set(cacheKey, tokenizer);
    }
    return tokenizer.encode(value, [], []).length;
  }

  private async invokeProvider(input: MastraChatExecuteInput): Promise<{ text: string }> {
    const namespace = input.snapshot.testNamespace;
    const generation = input.snapshot.testGeneration;
    this.testControl.increment(namespace, "modelCalls", generation);
    if (this.testControl.fault(namespace, "late_success", generation)) {
      const deadline = this.testControl.now(namespace, generation) + 60_000;
      await this.testControl.waitForClock(namespace!, deadline, generation).promise;
      await this.testControl.checkpoint(namespace, "afterTimeoutBeforeLateResult", generation);
      return { text: "late success" };
    }
    this.injectProviderFault(namespace, generation);

    let response: Response;
    try {
      response = await fetch(`${input.snapshot.provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.snapshot.provider.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: input.snapshot.provider.model,
          messages: [
            { role: "system", content: input.snapshot.soul },
            ...input.transcript,
            { role: "user", content: input.message }
          ],
          stream: false,
          tools: []
        }),
        signal: input.signal
      });
    } catch (error) {
      if (input.signal.aborted) {
        throw this.failure(504, "MODEL_TIMEOUT", "Model execution timed out", true);
      }
      void error;
      throw this.failure(502, "PROVIDER_TRANSPORT_ERROR", "Model provider transport failed", true);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_PROVIDER_BODY_BYTES) {
      throw this.failure(502, "PROVIDER_RESPONSE_TOO_LARGE", "Model provider response is too large", false);
    }
    const body = await this.readBoundedBody(response);
    if (!response.ok) {
      this.throwProviderStatus(response.status);
    }

    let payload: any;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw this.failure(502, "PROVIDER_INVALID_RESPONSE", "Model provider returned an invalid response", false);
    }
    const message = payload?.choices?.[0]?.message;
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      throw this.failure(422, "TOOL_NOT_ALLOWED", "Tools are not allowed in P0 chat", false);
    }
    const text = message?.content;
    if (typeof text !== "string" || text.length === 0) {
      throw this.failure(502, "MODEL_INVALID_OUTPUT", "Model returned invalid output", false);
    }
    if ([...text].length > MAX_REPLY_CODE_POINTS || Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) {
      throw this.failure(502, "MODEL_OUTPUT_TOO_LARGE", "Model output is too large", false);
    }
    return { text };
  }

  private injectProviderFault(namespace?: string, generation?: number): void {
    const faults: Array<[string, number, string, string, boolean]> = [
      ["provider_401", 502, "PROVIDER_AUTH_FAILED", "Model provider authentication failed", false],
      ["model_not_found", 502, "MODEL_NOT_FOUND", "Configured model was not found", false],
      ["provider_429", 429, "MODEL_RATE_LIMITED", "Model provider rate limit reached", true],
      ["provider_5xx", 502, "MODEL_UPSTREAM_ERROR", "Model provider failed", true],
      ["transport_error", 502, "PROVIDER_TRANSPORT_ERROR", "Model provider transport failed", true],
      ["provider_4xx", 502, "PROVIDER_REQUEST_REJECTED", "Model provider rejected the request", false],
      ["invalid_json", 502, "PROVIDER_INVALID_RESPONSE", "Model provider returned an invalid response", false],
      ["empty_output", 502, "MODEL_INVALID_OUTPUT", "Model returned invalid output", false],
      ["oversized_body", 502, "PROVIDER_RESPONSE_TOO_LARGE", "Model provider response is too large", false],
      ["oversized_reply", 502, "MODEL_OUTPUT_TOO_LARGE", "Model output is too large", false],
      ["timeout", 504, "MODEL_TIMEOUT", "Model execution timed out", true]
    ];
    for (const [fault, status, code, message, retryable] of faults) {
      if (this.testControl.fault(namespace, fault, generation)) {
        throw this.failure(status, code, message, retryable);
      }
    }
  }

  private throwProviderStatus(status: number): never {
    if (status === 401 || status === 403) {
      throw this.failure(502, "PROVIDER_AUTH_FAILED", "Model provider authentication failed", false);
    }
    if (status === 404) {
      throw this.failure(502, "MODEL_NOT_FOUND", "Configured model was not found", false);
    }
    if (status === 429) {
      throw this.failure(429, "MODEL_RATE_LIMITED", "Model provider rate limit reached", true);
    }
    if (status >= 500) {
      throw this.failure(502, "MODEL_UPSTREAM_ERROR", "Model provider failed", true);
    }
    throw this.failure(502, "PROVIDER_REQUEST_REJECTED", "Model provider rejected the request", false);
  }

  private async readBoundedBody(response: Response): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PROVIDER_BODY_BYTES) {
          await reader.cancel();
          throw this.failure(502, "PROVIDER_RESPONSE_TOO_LARGE", "Model provider response is too large", false);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  private failure(httpStatus: number, code: string, message: string, retryable: boolean) {
    return executionError({ httpStatus, code, message, retryable });
  }
}
