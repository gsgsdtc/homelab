import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminApiClient,
  ApiError,
  BrowserTokenStore,
  type TokenStore,
} from "../src/admin/api";

class MemoryTokenStore implements TokenStore {
  token: string | null = null;

  getToken() {
    return this.token;
  }

  setToken(token: string) {
    this.token = token;
  }

  clearToken() {
    this.token = null;
  }
}

const okJson = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("AdminApiClient", () => {
  const store = new MemoryTokenStore();
  const fetchMock = vi.fn();

  beforeEach(() => {
    store.clearToken();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the JWT returned by the login endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accessToken: "jwt-token",
          tokenType: "Bearer",
          user: { id: "u1", username: "admin", role: "ADMIN", isActive: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    const session = await client.login("admin", "password123");

    expect(session.user.username).toBe("admin");
    expect(store.getToken()).toBe("jwt-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backend/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "password123" }),
      }),
    );
  });

  it("binds the default browser fetch before sending requests", async () => {
    const originalFetch = globalThis.fetch;
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return okJson({
        accessToken: "jwt-token",
        tokenType: "Bearer",
        user: { id: "u1", username: "admin", role: "ADMIN", isActive: true },
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = browserFetch;

    try {
      const client = new AdminApiClient({
        baseUrl: "/api/backend",
        tokenStore: store,
      });

      await expect(client.login("admin", "password123")).resolves.toMatchObject(
        {
          user: { username: "admin" },
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds bearer authorization to protected user and app key calls", async () => {
    store.setToken("jwt-token");
    fetchMock.mockResolvedValueOnce(
      okJson({ items: [], total: 0, page: 2, pageSize: 20 }),
    );
    fetchMock.mockResolvedValueOnce(okJson([]));
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await client.listUsers({ q: "ada", page: 2, pageSize: 20 });
    await client.listAppKeys();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/users?q=ada&page=2&pageSize=20",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/app-keys",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
      }),
    );
  });

  it("clears the token when the backend rejects a protected request", async () => {
    store.setToken("expired");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
      }),
    );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await expect(client.me()).rejects.toMatchObject({ status: 401 });

    expect(store.getToken()).toBeNull();
  });

  it("sends user mutations to the backend", async () => {
    store.setToken("jwt-token");
    fetchMock
      .mockResolvedValueOnce(
        okJson({ id: "u1", username: "ada", role: "ADMIN", isActive: true }),
      )
      .mockResolvedValueOnce(
        okJson({ id: "u1", username: "ada2", role: "USER", isActive: false }),
      )
      .mockResolvedValueOnce(okJson({ reset: true }))
      .mockResolvedValueOnce(okJson({ deleted: true }));
    const client = new AdminApiClient({
      baseUrl: "/api/backend/",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await client.createUser({
      username: "ada",
      password: "password123",
      role: "ADMIN",
      isActive: true,
    });
    await client.updateUser("u1", {
      username: "ada2",
      role: "USER",
      isActive: false,
    });
    await client.resetPassword("u1", "new-password");
    await client.deleteUser("u1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/users",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/users/u1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/backend/users/u1/reset-password",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/backend/users/u1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends AppKey mutations to the backend", async () => {
    store.setToken("jwt-token");
    fetchMock.mockResolvedValueOnce(
      okJson({ appKey: { id: "k1", name: "agent" }, key: "hl_secret" }),
    );
    fetchMock.mockResolvedValueOnce(okJson({ revoked: true }));
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await client.createAppKey({
      name: "agent",
      agentName: "qa-agent",
      scopes: ["pages:test"],
      expiresAt: "2026-07-01T00:00:00.000Z",
    });
    await client.revokeAppKey("k1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/app-keys",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "agent",
          agentName: "qa-agent",
          scopes: ["pages:test"],
          expiresAt: "2026-07-01T00:00:00.000Z",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/app-keys/k1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends Agent workspace management calls to the backend", async () => {
    store.setToken("jwt-token");
    const agent = {
      id: "agent-1",
      name: "Ops Agent",
      status: "init_failed",
      workspaceName: "ops-agent--agent123",
      workspacePath: ".homelab/agents/ops-agent--agent123/",
      initError: {
        code: "WORKSPACE_FILE_WRITE_FAILED",
        message: "soul.md 写入失败",
      },
      gitStatus: "dirty",
      modelProvider: "openai",
      modelSecretRef: "OPENAI_API_KEY",
      soul: "Run homelab tasks",
    };
    fetchMock
      .mockResolvedValueOnce(okJson([agent]))
      .mockResolvedValueOnce(okJson(agent))
      .mockResolvedValueOnce(
        okJson({ ...agent, status: "ready", initError: null }),
      )
      .mockResolvedValueOnce(okJson({ ...agent, name: "Ops Agent 2" }))
      .mockResolvedValueOnce(okJson({ ...agent, soul: "Managed soul content" }))
      .mockResolvedValueOnce(
        okJson({ ...agent, status: "ready", initError: null }),
      );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await expect(client.listAgents()).resolves.toEqual([agent]);
    await expect(client.getAgent("agent-1")).resolves.toEqual(agent);
    await client.createAgent({
      name: "Ops Agent",
      slug: "ops-agent",
      modelProvider: "openai",
      modelSecretRef: "OPENAI_API_KEY",
      soul: "Run homelab tasks",
    });
    await client.updateAgent("agent-1", {
      name: "Ops Agent 2",
      soul: "Updated soul",
    });
    await client.saveAgentSoul("agent-1", "Managed soul content");
    await client.retryAgentInitialization("agent-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/agents",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/agents/agent-1",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/backend/agents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Ops Agent",
          slug: "ops-agent",
          modelProvider: "openai",
          modelSecretRef: "OPENAI_API_KEY",
          soul: "Run homelab tasks",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/backend/agents/agent-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Ops Agent 2", soul: "Updated soul" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/backend/agents/agent-1/soul",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ soul: "Managed soul content" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/backend/agents/agent-1/retry-initialization",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the frozen Agent chat DTO endpoints and returns terminal failures", async () => {
    store.setToken("jwt-token");
    fetchMock
      .mockResolvedValueOnce(
        okJson({
          agentId: "agent-1",
          eligible: true,
          code: null,
          message: null,
          agent: { name: "Ops Agent", status: "ready" },
          providerSummary: { name: "OpenAI", model: "gpt-4.1-mini" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "session-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requestId: "req-1",
            executionId: "exec-1",
            clientMessageId: "message_attempt_0001",
            logicalMessageId: "message_attempt_0001",
            retryOfClientMessageId: null,
            status: "failed",
            code: "MODEL_TIMEOUT",
            message: "模型响应超时",
            retryable: true,
            acceptedAt: "2026-07-14T00:00:00Z",
            completedAt: "2026-07-14T00:00:01Z",
            replayed: false,
          }),
          { status: 504, headers: { "Content-Type": "application/json" } },
        ),
      );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await client.getAgentChatEligibility("agent-1");
    await client.createAgentChatSession("agent-1");
    await expect(
      client.sendAgentChatMessage("agent-1", "session-1", {
        clientMessageId: "message_attempt_0001",
        content: "检查当前配置",
        retryOfClientMessageId: null,
      }),
    ).resolves.toMatchObject({ status: "failed", retryable: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/agents/agent-1/chat/eligibility",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/agents/agent-1/chat/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/backend/agents/agent-1/chat/sessions/session-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientMessageId: "message_attempt_0001",
          content: "检查当前配置",
          retryOfClientMessageId: null,
        }),
      }),
    );
  });

  it("sends model provider list and mutations to the backend without API key in URLs", async () => {
    store.setToken("jwt-token");
    fetchMock
      .mockResolvedValueOnce(
        okJson([{ id: "p1", name: "OpenAI", hasApiKey: true }]),
      )
      .mockResolvedValueOnce(
        okJson({ id: "p1", name: "OpenAI", hasApiKey: true }),
      )
      .mockResolvedValueOnce(
        okJson({ id: "p1", name: "OpenAI US", hasApiKey: true }),
      )
      .mockResolvedValueOnce(
        okJson({ id: "p1", name: "OpenAI US", hasApiKey: true }),
      )
      .mockResolvedValueOnce(
        okJson({ id: "p1", name: "OpenAI US", hasApiKey: true }),
      )
      .mockResolvedValueOnce(
        okJson({ id: "p1", name: "OpenAI US", hasApiKey: true }),
      );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await client.listModelProviders();
    await client.createModelProvider({
      name: "OpenAI",
      type: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      defaultModel: "gpt-4.1-mini",
      isActive: true,
    });
    await client.updateModelProvider("p1", {
      name: "OpenAI US",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
    });
    await client.setDefaultModelProvider("p1");
    await client.enableModelProvider("p1");
    await client.disableModelProvider("p1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/model-providers",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/model-providers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "OpenAI",
          type: "OPENAI_COMPATIBLE",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-secret",
          defaultModel: "gpt-4.1-mini",
          isActive: true,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/backend/model-providers/p1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: "OpenAI US",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4.1-mini",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/backend/model-providers/p1/default",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/backend/model-providers/p1/enable",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/backend/model-providers/p1/disable",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      fetchMock.mock.calls.map((call) => String(call[0])).join(" "),
    ).not.toContain("sk-secret");
  });

  it("tests model provider connections with form values or a saved provider id", async () => {
    store.setToken("jwt-token");
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    fetchMock.mockResolvedValueOnce(
      okJson({ ok: false, error: "connection test timed out" }),
    );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await client.testModelProviderConnection({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      defaultModel: "gpt-4.1-mini",
    });
    const result = await client.testModelProviderConnection({
      providerId: "p1",
    });

    expect(result).toEqual({ ok: false, error: "connection test timed out" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/model-providers/test-connection",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-secret",
          defaultModel: "gpt-4.1-mini",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/model-providers/test-connection",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ providerId: "p1" }),
      }),
    );
    expect(
      fetchMock.mock.calls.map((call) => String(call[0])).join(" "),
    ).not.toContain("sk-secret");
  });

  it("checks AppKey access with the X-App-Key header instead of URL params", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ name: "mobile-agent", scopes: ["pages:portal"] }),
    );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    const identity = await client.getAppIdentity("hl_secret");

    expect(identity.name).toBe("mobile-agent");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backend/app-identity/me",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-App-Key": "hl_secret" }),
      }),
    );
    expect(fetchMock.mock.calls[0][0]).not.toContain("hl_secret");
  });

  it("uses backend validation messages and handles empty success bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: ["username must be longer"] }), {
        status: 400,
        statusText: "Bad Request",
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    await expect(
      client.createUser({
        username: "a",
        password: "short",
        role: "USER",
        isActive: true,
      }),
    ).rejects.toEqual(
      new ApiError("username must be longer", 400, {
        message: ["username must be longer"],
      }),
    );
    await expect(client.deleteUser("u1")).resolves.toBeNull();
  });

  it("stores browser tokens only when window storage exists", () => {
    const store = new BrowserTokenStore("test-token");

    expect(store.getToken()).toBeNull();
    expect(() => store.setToken("jwt-token")).not.toThrow();
    expect(() => store.clearToken()).not.toThrow();
  });

  it("supports token reads, logout, and empty user query params", async () => {
    store.setToken("jwt-token");
    fetchMock.mockResolvedValueOnce(
      okJson({ items: [], total: 0, page: 1, pageSize: 10 }),
    );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });

    expect(client.getToken()).toBe("jwt-token");
    await client.listUsers({});
    client.logout();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backend/users",
      expect.any(Object),
    );
    expect(client.getToken()).toBeNull();
  });

  it("normalizes custom headers and falls back to response status text", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 500, statusText: "Server Error" }),
    );
    const client = new AdminApiClient({
      baseUrl: "/api/backend",
      tokenStore: store,
      fetcher: fetchMock,
    });
    const request = (
      client as unknown as {
        request<T>(path: string, init?: RequestInit): Promise<T>;
      }
    ).request.bind(client);

    await request("/headers", { headers: new Headers({ "X-Test": "one" }) });
    await request("/array-headers", { headers: [["X-Test", "two"]] });
    await expect(request("/broken")).rejects.toMatchObject({
      message: "Server Error",
      status: 500,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/backend/headers",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-test": "one" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/backend/array-headers",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Test": "two" }),
      }),
    );
  });
});
