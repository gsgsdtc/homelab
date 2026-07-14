export interface AppEnvironment {
  PORT: number;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  HOMELAB_REPO_ROOT?: string;
  HOMELAB_WORKFLOW_MAX_SOURCE_BYTES: number;
  HOMELAB_WORKFLOW_RUNTIME_URL?: string;
  HOMELAB_WORKFLOW_RELOAD_TIMEOUT_MS: number;
  HOMELAB_WORKFLOW_ALLOWED_TOOL_IMPORTS: string[];
  HOMELAB_WORKFLOW_ALLOWED_ENV: string[];
  MODEL_PROVIDER_ENCRYPTION_KEY: string;
}

export function validateEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> & AppEnvironment {
  const jwtSecret = String(config.JWT_SECRET ?? "").trim();
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required");
  }
  const modelProviderEncryptionKey = String(
    config.MODEL_PROVIDER_ENCRYPTION_KEY ?? "",
  ).trim();
  if (!modelProviderEncryptionKey) {
    throw new Error("MODEL_PROVIDER_ENCRYPTION_KEY is required");
  }
  if (Buffer.from(modelProviderEncryptionKey, "base64").length !== 32) {
    throw new Error(
      "MODEL_PROVIDER_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }

  return {
    ...config,
    PORT: Number(config.PORT ?? 3000),
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: String(config.JWT_EXPIRES_IN ?? "1h"),
    HOMELAB_REPO_ROOT: config.HOMELAB_REPO_ROOT
      ? String(config.HOMELAB_REPO_ROOT).trim()
      : undefined,
    HOMELAB_WORKFLOW_MAX_SOURCE_BYTES: Number(
      config.HOMELAB_WORKFLOW_MAX_SOURCE_BYTES ?? 256 * 1024,
    ),
    HOMELAB_WORKFLOW_RUNTIME_URL: config.HOMELAB_WORKFLOW_RUNTIME_URL
      ? String(config.HOMELAB_WORKFLOW_RUNTIME_URL).trim()
      : undefined,
    HOMELAB_WORKFLOW_RELOAD_TIMEOUT_MS: Number(
      config.HOMELAB_WORKFLOW_RELOAD_TIMEOUT_MS ?? 30_000,
    ),
    HOMELAB_WORKFLOW_ALLOWED_TOOL_IMPORTS: parseList(
      config.HOMELAB_WORKFLOW_ALLOWED_TOOL_IMPORTS,
    ),
    HOMELAB_WORKFLOW_ALLOWED_ENV: parseList(config.HOMELAB_WORKFLOW_ALLOWED_ENV),
    MODEL_PROVIDER_ENCRYPTION_KEY: modelProviderEncryptionKey,
  };
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
