import {
  isAgentChatMessageResponse,
  type AgentChatEligibility,
  type AgentChatMessageRequest,
  type AgentChatMessageResponse,
  type AgentChatSession,
} from "./agent-chat";

export type UserRole = "USER" | "ADMIN";

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppKey {
  id: string;
  name: string;
  agentName: string | null;
  scopes: string[];
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppIdentity {
  id: string;
  name: string;
  agentName: string | null;
  scopes: string[];
}

export type AgentStatus = "initializing" | "ready" | "init_failed";
export type AgentGitStatus = "available" | "unavailable" | "dirty" | "clean";
export type AgentSoulFileStatus = "loaded" | "missing" | "error";

export interface AgentInitError {
  code?: string;
  message: string;
}

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  workspacePath: string | null;
  workspaceName: string | null;
  initError: AgentInitError | null;
  gitStatus: AgentGitStatus;
  modelProvider?: string | null;
  modelSecretRef?: string | null;
  soul?: string | null;
  soulFileStatus?: AgentSoulFileStatus;
  soulFileError?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentMutationPayload {
  name?: string;
  slug?: string;
  modelProvider?: string;
  modelSecretRef?: string;
  soul?: string;
}

export type ModelProviderType = "OPENAI_COMPATIBLE";

export interface ModelProvider {
  id: string;
  name: string;
  nameKey: string;
  type: ModelProviderType;
  baseUrl: string;
  defaultModel: string;
  isActive: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderPayload {
  name: string;
  type?: ModelProviderType;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  isActive?: boolean;
}

export type ModelProviderConnectionPayload =
  | {
      providerId: string;
    }
  | {
      baseUrl: string;
      apiKey: string;
      defaultModel: string;
    };

export interface ModelProviderConnectionResult {
  ok: boolean;
  error?: string;
}

export interface LoginSession {
  accessToken: string;
  tokenType: "Bearer";
  user: PublicUser;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TokenStore {
  getToken(): string | null;
  setToken(token: string): void;
  clearToken(): void;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class BrowserTokenStore implements TokenStore {
  constructor(private readonly key = "homelab.admin.jwt") {}

  getToken() {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage.getItem(this.key);
  }

  setToken(token: string) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(this.key, token);
    }
  }

  clearToken() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(this.key);
    }
  }
}

type Fetcher = typeof fetch;

export interface AdminApiClientOptions {
  baseUrl?: string;
  tokenStore?: TokenStore;
  fetcher?: Fetcher;
}

export class AdminApiClient {
  private readonly baseUrl: string;
  private readonly tokenStore: TokenStore;
  private readonly fetcher: Fetcher;

  constructor(options: AdminApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.tokenStore = options.tokenStore ?? new BrowserTokenStore();
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  getToken() {
    return this.tokenStore.getToken();
  }

  logout() {
    this.tokenStore.clearToken();
  }

  async login(username: string, password: string): Promise<LoginSession> {
    const session = await this.request<LoginSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      auth: false,
    });
    this.tokenStore.setToken(session.accessToken);
    return session;
  }

  me() {
    return this.request<PublicUser>("/auth/me");
  }

  listUsers(params: { q?: string; page?: number; pageSize?: number }) {
    return this.request<PageResult<PublicUser>>(`/users${toQuery(params)}`);
  }

  createUser(payload: {
    username: string;
    password: string;
    role: UserRole;
    isActive: boolean;
  }) {
    return this.request<PublicUser>("/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  updateUser(
    id: string,
    payload: { username?: string; role?: UserRole; isActive?: boolean },
  ) {
    return this.request<PublicUser>(`/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  deleteUser(id: string) {
    return this.request<{ deleted: true }>(`/users/${id}`, {
      method: "DELETE",
    });
  }

  resetPassword(id: string, password: string) {
    return this.request<{ reset: true }>(`/users/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  listAppKeys() {
    return this.request<AppKey[]>("/app-keys");
  }

  createAppKey(payload: {
    name: string;
    agentName?: string;
    scopes?: string[];
    expiresAt?: string;
  }) {
    return this.request<{ appKey: AppKey; key: string }>("/app-keys", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  revokeAppKey(id: string) {
    return this.request<{ revoked: true }>(`/app-keys/${id}`, {
      method: "DELETE",
    });
  }

  listModelProviders() {
    return this.request<ModelProvider[]>("/model-providers");
  }

  createModelProvider(payload: ModelProviderPayload & { apiKey: string }) {
    return this.request<ModelProvider>("/model-providers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  updateModelProvider(id: string, payload: Partial<ModelProviderPayload>) {
    return this.request<ModelProvider>(`/model-providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  setDefaultModelProvider(id: string) {
    return this.request<ModelProvider>(`/model-providers/${id}/default`, {
      method: "POST",
    });
  }

  enableModelProvider(id: string) {
    return this.request<ModelProvider>(`/model-providers/${id}/enable`, {
      method: "POST",
    });
  }

  disableModelProvider(id: string) {
    return this.request<ModelProvider>(`/model-providers/${id}/disable`, {
      method: "POST",
    });
  }

  testModelProviderConnection(payload: ModelProviderConnectionPayload) {
    return this.request<ModelProviderConnectionResult>(
      "/model-providers/test-connection",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  getAppIdentity(appKey: string) {
    return this.request<AppIdentity>("/app-identity/me", {
      auth: false,
      headers: {
        "X-App-Key": appKey,
      },
    });
  }

  listAgents() {
    return this.request<Agent[]>("/agents");
  }

  getAgent(id: string) {
    return this.request<Agent>(`/agents/${id}`);
  }

  createAgent(
    payload: Required<Pick<AgentMutationPayload, "name">> &
      AgentMutationPayload,
  ) {
    return this.request<Agent>("/agents", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  updateAgent(id: string, payload: AgentMutationPayload) {
    return this.request<Agent>(`/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  saveAgentSoul(id: string, soul: string) {
    return this.request<Agent>(`/agents/${id}/soul`, {
      method: "PATCH",
      body: JSON.stringify({ soul }),
    });
  }

  retryAgentInitialization(id: string) {
    return this.request<Agent>(`/agents/${id}/retry-initialization`, {
      method: "POST",
    });
  }

  getAgentChatEligibility(agentId: string) {
    return this.request<AgentChatEligibility>(
      `/agents/${agentId}/chat/eligibility`,
    );
  }

  createAgentChatSession(agentId: string) {
    return this.request<AgentChatSession>(`/agents/${agentId}/chat/sessions`, {
      method: "POST",
    });
  }

  async sendAgentChatMessage(
    agentId: string,
    sessionId: string,
    payload: AgentChatMessageRequest,
  ): Promise<AgentChatMessageResponse> {
    try {
      return await this.request<AgentChatMessageResponse>(
        `/agents/${agentId}/chat/sessions/${sessionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        isAgentChatMessageResponse(error.details)
      ) {
        return error.details;
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...headersToRecord(init.headers),
    };

    if (init.auth !== false) {
      const token = this.tokenStore.getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.tokenStore.clearToken();
      }
      const details = await readJson(response);
      throw new ApiError(
        getErrorMessage(details, response.statusText),
        response.status,
        details,
      );
    }

    return (await readJson(response)) as T;
  }
}

function toQuery(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

async function readJson(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function getErrorMessage(details: unknown, fallback: string) {
  if (details && typeof details === "object" && "message" in details) {
    const message = (details as { message?: unknown }).message;
    return Array.isArray(message) ? message.join(", ") : String(message);
  }
  return fallback || "Request failed";
}
