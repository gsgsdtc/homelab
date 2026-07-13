import { ConfigService } from "@nestjs/config";
import { ModelProviderCredentialsService } from "../src/modules/model-providers/model-provider-credentials.service";

describe("ModelProviderCredentialsService", () => {
  it("encrypts API keys with a versioned AES-GCM payload that can be decrypted", () => {
    const config = {
      getOrThrow: jest.fn(() => Buffer.alloc(32, 7).toString("base64"))
    } as unknown as ConfigService;
    const service = new ModelProviderCredentialsService(config);

    const encrypted = service.encrypt("sk-live-secret");

    expect(encrypted).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(encrypted).not.toContain("sk-live-secret");
    expect(service.decrypt(encrypted)).toBe("sk-live-secret");
  });
});
