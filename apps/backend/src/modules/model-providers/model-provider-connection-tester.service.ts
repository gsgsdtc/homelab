import { Injectable } from "@nestjs/common";

export interface TestProviderConnectionInput {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TestProviderConnectionResult {
  ok: boolean;
  error?: string;
}

@Injectable()
export class ModelProviderConnectionTester {
  async test(input: TestProviderConnectionInput): Promise<TestProviderConnectionResult> {
    const baseUrl = input.baseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        })
      });

      if (response.ok) {
        return { ok: true };
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "authentication failed" };
      }
      if (response.status === 404) {
        return { ok: false, error: "model or endpoint not found" };
      }

      return { ok: false, error: `provider returned HTTP ${response.status}` };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false, error: "connection test timed out" };
      }
      return { ok: false, error: "connection test failed" };
    } finally {
      clearTimeout(timeout);
    }
  }
}
