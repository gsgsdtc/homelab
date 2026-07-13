export interface AppEnvironment {
  PORT: number;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  HOMELAB_REPO_ROOT?: string;
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
    MODEL_PROVIDER_ENCRYPTION_KEY: modelProviderEncryptionKey,
  };
}
