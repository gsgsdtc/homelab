export interface AppEnvironment {
  PORT: number;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  HOMELAB_REPO_ROOT?: string;
}

export function validateEnvironment(config: Record<string, unknown>): Record<string, unknown> & AppEnvironment {
  const jwtSecret = String(config.JWT_SECRET ?? "").trim();
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required");
  }

  return {
    ...config,
    PORT: Number(config.PORT ?? 3000),
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: String(config.JWT_EXPIRES_IN ?? "1h"),
    HOMELAB_REPO_ROOT: config.HOMELAB_REPO_ROOT ? String(config.HOMELAB_REPO_ROOT).trim() : undefined
  };
}
