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
export type AgentGitStatus = "unavailable" | "dirty" | "clean";
export type AgentSoulFileStatus = "loaded" | "missing" | "error";

export interface AgentInitError {
  code?: string;
  message: string;
  requestId?: string;
}

export interface AgentProviderSummary {
  id: string | null;
  name: string | null;
  source: "explicit" | "default" | "invalid";
}

export interface Agent {
  id: string;
  name: string;
  slug?: string;
  status: AgentStatus | string;
  workspacePath: string | null;
  workspaceName: string | null;
  initError: AgentInitError | null;
  gitStatus: AgentGitStatus | string;
  modelProviderId?: string | null;
  providerSummary?: AgentProviderSummary;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentMutationPayload {
  name?: string;
  slug?: string;
  modelProviderId?: string | null;
}

export interface AgentUpdatePayload {
  name?: string;
  modelProviderId?: string | null;
  expectedRevision: number;
}

export interface AgentSoul {
  content: string;
  missing: boolean;
  revision: number;
  maxBytes: number;
}

export type AgentSkillSourceType = "registry" | "git";
export type AgentSkillChangeStatus =
  | "pending"
  | "validating"
  | "applying"
  | "reloading"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "rollback_failed";
export type AgentSkillReloadStatus =
  "loaded" | "failed" | "pending_restart" | "runtime_offline" | "unknown";
export type AgentSkillAuditStatus =
  "audit_written" | "audit_pending" | "audit_failed";
export type AgentSkillRollbackResult =
  "not_required" | "succeeded" | "failed" | "skipped";

export interface AgentSkill {
  name: string;
  version: string;
  sourceType: AgentSkillSourceType;
  sourceId: string;
  enabled: boolean;
  systemRequired: boolean;
  selfUpdateAllowed: boolean;
}

export interface AgentSkillState {
  agentId: string;
  activeConfigVersion?: string | null;
  previousConfigVersion?: string | null;
  stagedConfigVersion?: string | null;
  changeStatus: AgentSkillChangeStatus;
  reloadStatus: AgentSkillReloadStatus;
  auditStatus: AgentSkillAuditStatus;
  rollbackResult: AgentSkillRollbackResult;
  failedStage: string | null;
  errorCode: string | null;
  safeErrorSummary: string | null;
  skills: AgentSkill[];
}

export interface AgentSkillChange extends Omit<
  AgentSkillState,
  "agentId" | "skills"
> {
  changeId: string;
  skillName: string;
  operation: "install" | "update" | "remove";
  terminal?: boolean;
  finishedAt?: string | null;
  previousConfigVersion?: string | null;
  activeConfigVersion?: string | null;
  stagedConfigVersion?: string | null;
  sequenceIndex?: number;
  persistedConfigVersion?: string | null;
  runtimeLoadedVersion?: string | null;
  effectiveFor?: "next_task";
}

export interface SkillCatalogSource {
  id: string;
  label: string;
  sourceType: AgentSkillSourceType;
}

export interface SkillCatalogSkill {
  skillId: string;
  name: string;
  description?: string | null;
}

export interface SkillCatalogVersion {
  version: string;
  immutableRef: string;
  createdAt: string;
}

export type WorkflowReloadStatus = "draft" | "loading" | "succeeded" | "failed";
export interface AgentWorkflow {
  workflowKey: string;
  filePath?: string;
  source?: string;
  draftHash: string | null;
  activeHash: string | null;
  revision: number;
  reloadStatus: WorkflowReloadStatus | string;
  loadedAt?: string | null;
  updatedAt?: string;
  error?: { code?: string; message: string } | null;
}

export interface AgentWorkflowVersion {
  id: string;
  sourceHash: string;
  source: string;
  extension: "ts" | "js";
  promotedAt?: string;
}

export interface WorkflowCapabilities {
  sourceMaxBytes: number;
  reloadTimeoutMs: number;
  historyLimit: number;
  extensions: Array<"ts" | "js">;
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
  private readonly unauthorizedListeners = new Set<() => void>();

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

  onUnauthorized(listener: () => void) {
    this.unauthorizedListeners.add(listener);
    return () => this.unauthorizedListeners.delete(listener);
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

  listAgents(
    params: { query?: string; page?: number; pageSize?: number } = {},
  ) {
    return this.request<PageResult<Agent>>(`/agents${toQuery(params)}`);
  }

  getAgent(id: string) {
    return this.request<Agent>(`/agents/${encodeURIComponent(id)}`);
  }

  createAgent(
    payload: Required<Pick<AgentMutationPayload, "name">> &
      AgentMutationPayload,
    idempotencyKey?: string,
  ) {
    return this.request<Agent>("/agents", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: idempotencyKey
        ? { "Idempotency-Key": idempotencyKey }
        : undefined,
    });
  }

  updateAgent(id: string, payload: AgentUpdatePayload) {
    return this.request<Agent>(`/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  getAgentSoul(id: string) {
    return this.request<AgentSoul>(`/agents/${encodeURIComponent(id)}/soul`);
  }

  saveAgentSoul(id: string, content: string, expectedRevision: number) {
    return this.request<AgentSoul>(`/agents/${encodeURIComponent(id)}/soul`, {
      method: "PUT",
      body: JSON.stringify({ content, expectedRevision }),
    });
  }

  retryAgentInitialization(id: string) {
    return this.request<Agent>(
      `/agents/${encodeURIComponent(id)}/retry-initialization`,
      {
        method: "POST",
      },
    );
  }

  listSkillCatalogSources(params: { page?: number; pageSize?: number } = {}) {
    return this.request<PageResult<SkillCatalogSource>>(
      `/skill-catalog/sources${toQuery(params)}`,
    );
  }

  listSkillCatalogSkills(
    sourceId: string,
    params: { page?: number; pageSize?: number } = {},
  ) {
    return this.request<PageResult<SkillCatalogSkill>>(
      `/skill-catalog/sources/${encodeURIComponent(sourceId)}/skills${toQuery(params)}`,
    );
  }

  listSkillCatalogVersions(
    sourceId: string,
    skillId: string,
    params: { page?: number; pageSize?: number } = {},
  ) {
    return this.request<PageResult<SkillCatalogVersion>>(
      `/skill-catalog/sources/${encodeURIComponent(sourceId)}/skills/${encodeURIComponent(skillId)}/versions${toQuery(params)}`,
    );
  }

  listAgentSkills(agentId: string) {
    return this.request<AgentSkillState>(
      `/agents/${encodeURIComponent(agentId)}/skills`,
    );
  }

  installAgentSkill(
    agentId: string,
    payload: {
      skillName: string;
      sourceId: string;
      sourceType: AgentSkillSourceType;
      version: string;
    },
  ) {
    return this.request<AgentSkillChange>(
      `/agents/${encodeURIComponent(agentId)}/skills/install`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  updateAgentSkill(
    agentId: string,
    payload: {
      skillName: string;
      sourceId: string;
      sourceType: AgentSkillSourceType;
      version: string;
    },
  ) {
    return this.request<AgentSkillChange>(
      `/agents/${encodeURIComponent(agentId)}/skills/update`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  removeAgentSkill(agentId: string, skillName: string) {
    return this.request<AgentSkillChange>(
      `/agents/${encodeURIComponent(agentId)}/skills/remove`,
      { method: "POST", body: JSON.stringify({ skillName }) },
    );
  }

  getAgentSkillChange(agentId: string, changeId: string) {
    return this.request<AgentSkillChange>(
      `/agents/${encodeURIComponent(agentId)}/skills/changes/${encodeURIComponent(changeId)}`,
    );
  }

  listAgentWorkflows(agentId: string) {
    return this.request<AgentWorkflow[]>(
      `/agents/${encodeURIComponent(agentId)}/workflows`,
    );
  }

  createAgentWorkflow(
    agentId: string,
    payload: {
      workflowKey: string;
      source: string;
      extension: "ts" | "js";
    },
  ) {
    return this.request<AgentWorkflow>(
      `/agents/${encodeURIComponent(agentId)}/workflows`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  getAgentWorkflow(agentId: string, workflowKey: string) {
    return this.request<AgentWorkflow>(
      `/agents/${encodeURIComponent(agentId)}/workflows/${encodeURIComponent(workflowKey)}`,
    );
  }

  saveAgentWorkflowDraft(
    agentId: string,
    workflowKey: string,
    payload: {
      source: string;
      extension: "ts" | "js";
      expectedRevision: number;
    },
  ) {
    return this.request<AgentWorkflow>(
      `/agents/${encodeURIComponent(agentId)}/workflows/${encodeURIComponent(workflowKey)}`,
      { method: "PUT", body: JSON.stringify(payload) },
    );
  }

  validateAgentWorkflow(
    agentId: string,
    workflowKey: string,
    payload: { source: string; extension: "ts" | "js" },
  ) {
    return this.request<{
      workflowKey: string;
      valid: boolean;
      sourceHash: string;
      errors?: string[];
    }>(
      `/agents/${encodeURIComponent(agentId)}/workflows/${encodeURIComponent(workflowKey)}/validate`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  reloadAgentWorkflow(
    agentId: string,
    workflowKey: string,
    expectedDraftHash?: string,
  ) {
    return this.request<AgentWorkflow>(
      `/agents/${encodeURIComponent(agentId)}/workflows/${encodeURIComponent(workflowKey)}/reload`,
      { method: "POST", body: JSON.stringify({ expectedDraftHash }) },
    );
  }

  saveAndReloadAgentWorkflow(
    agentId: string,
    workflowKey: string,
    payload: {
      source: string;
      extension: "ts" | "js";
      expectedRevision: number;
    },
  ) {
    return this.request<AgentWorkflow>(
      `/agents/${encodeURIComponent(agentId)}/workflows/${encodeURIComponent(workflowKey)}/save-and-reload`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  listAgentWorkflowVersions(agentId: string, workflowKey: string) {
    return this.request<AgentWorkflowVersion[]>(
      `/agents/${encodeURIComponent(agentId)}/workflows/${encodeURIComponent(workflowKey)}/versions`,
    );
  }

  rollbackAgentWorkflow(
    agentId: string,
    workflowKey: string,
    versionId: string,
  ) {
    return this.request<AgentWorkflow>(
      `/agents/${encodeURIComponent(agentId)}/workflows/${encodeURIComponent(workflowKey)}/rollback`,
      { method: "POST", body: JSON.stringify({ versionId }) },
    );
  }

  getWorkflowCapabilities(agentId: string) {
    return this.request<WorkflowCapabilities>(
      `/agents/${encodeURIComponent(agentId)}/workflow-capabilities`,
    );
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
        this.unauthorizedListeners.forEach((listener) => listener());
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
