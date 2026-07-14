import { validateEnvironment } from "../src/config/env.validation";

describe("validateEnvironment", () => {
  const modelProviderKey = Buffer.alloc(32, 1).toString("base64");

  it("rejects startup configuration when JWT_SECRET is missing", () => {
    expect(() => validateEnvironment({})).toThrow("JWT_SECRET is required");
  });

  it("rejects startup configuration when provider encryption key is missing", () => {
    expect(() => validateEnvironment({ JWT_SECRET: "local-secret" })).toThrow("MODEL_PROVIDER_ENCRYPTION_KEY is required");
  });

  it("rejects provider encryption keys that are not 32 decoded bytes", () => {
    expect(() =>
      validateEnvironment({
        JWT_SECRET: "local-secret",
        MODEL_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64")
      })
    ).toThrow("MODEL_PROVIDER_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  });

  it("accepts configured secrets and applies defaults", () => {
    expect(
      validateEnvironment({
        JWT_SECRET: "local-secret",
        MODEL_PROVIDER_ENCRYPTION_KEY: modelProviderKey
      })
    ).toMatchObject({
      PORT: 3000,
      JWT_SECRET: "local-secret",
      JWT_EXPIRES_IN: "1h",
      MODEL_PROVIDER_ENCRYPTION_KEY: modelProviderKey,
      AGENT_PROVIDER_READ_MODE: "primary"
    });
  });

  it("accepts only explicit primary or legacy Provider read modes", () => {
    expect(() =>
      validateEnvironment({
        JWT_SECRET: "local-secret",
        MODEL_PROVIDER_ENCRYPTION_KEY: modelProviderKey,
        AGENT_PROVIDER_READ_MODE: "unsafe"
      })
    ).toThrow("AGENT_PROVIDER_READ_MODE must be primary or legacy");
    expect(
      validateEnvironment({
        JWT_SECRET: "local-secret",
        MODEL_PROVIDER_ENCRYPTION_KEY: modelProviderKey,
        AGENT_PROVIDER_READ_MODE: "legacy"
      })
    ).toMatchObject({ AGENT_PROVIDER_READ_MODE: "legacy" });
  });
});
