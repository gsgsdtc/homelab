export interface ChatEligibilityResponse {
  agentId: string;
  eligible: boolean;
  code: string | null;
  message: string | null;
  agent: { name: string; status: string };
  providerSummary: { id: string; name: string; model: string } | null;
}

export interface ChatProviderSnapshot {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  revision?: string;
}

export interface ChatConfigurationSnapshot {
  provider: ChatProviderSnapshot;
  soul: string;
  soulRevision: string;
  skills: Record<string, unknown>;
  workflow: {
    workflowKey: "default";
    activeHash: string;
    source: string;
    executable: unknown;
  };
  versionVector: string;
  testNamespace?: string;
  testGeneration?: number;
}

export interface ChatTranscriptEntry {
  role: "user" | "assistant";
  content: string;
}

export interface ChatMessageRequest {
  clientMessageId: string;
  content: string;
  retryOfClientMessageId: string | null;
}

export interface ChatFailure {
  httpStatus: number;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ChatExecutionError extends Error {
  chatFailure: ChatFailure;
}

export interface ChatHttpResult {
  httpStatus: number;
  body: Record<string, unknown>;
}
