import { ModelProviderConnectionTester } from "../src/modules/model-providers/model-provider-connection-tester.service";

describe("ModelProviderConnectionTester", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("sends provider tests through the backend with Authorization header", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      new ModelProviderConnectionTester().test({
        baseUrl: "https://api.example.com/v1/",
        apiKey: "sk-live-secret",
        model: "gpt-4.1-mini"
      })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-live-secret"
        })
      })
    );
  });

  it("returns safe summaries for provider authentication failures", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;

    await expect(
      new ModelProviderConnectionTester().test({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-live-secret",
        model: "gpt-4.1-mini"
      })
    ).resolves.toEqual({ ok: false, error: "authentication failed" });
  });
});
