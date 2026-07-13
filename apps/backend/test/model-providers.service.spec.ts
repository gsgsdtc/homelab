import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ModelProvidersService } from "../src/modules/model-providers/model-providers.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("ModelProvidersService", () => {
  const encrypted = "v1:iv:tag:ciphertext";
  const credentials = {
    encrypt: jest.fn((value: string) => `${encrypted}:${value.length}`),
    decrypt: jest.fn(() => "decrypted-key")
  };
  const connectionTester = {
    test: jest.fn()
  };
  const prismaMock = {
    modelProvider: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn()
    },
    $transaction: jest.fn()
  };
  const prisma = prismaMock as unknown as PrismaService;
  const modelProvider = prismaMock.modelProvider as Record<string, jest.Mock>;
  const transaction = prismaMock.$transaction as jest.Mock;

  type MockTransaction = {
    modelProvider: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
  };

  const service = () => new ModelProvidersService(prisma, credentials, connectionTester);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates provider records with normalized unique names and encrypted credentials only", async () => {
    modelProvider.create.mockImplementation(async ({ data, select }: { data: any; select: any }) => ({
      id: "provider_1",
      name: data.name,
      nameKey: data.nameKey,
      type: data.type,
      baseUrl: data.baseUrl,
      encryptedApiKey: data.encryptedApiKey,
      defaultModel: data.defaultModel,
      isActive: data.isActive,
      isDefault: data.isDefault,
      createdAt: new Date(),
      updatedAt: new Date(),
      select
    }));

    const result = await service().create({
      name: " OpenAI ",
      type: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.example.com/v1/",
      apiKey: "sk-live-secret",
      defaultModel: " gpt-4.1-mini ",
      isActive: true
    });

    expect(modelProvider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "OpenAI",
          nameKey: "openai",
          encryptedApiKey: expect.stringContaining(encrypted),
          defaultModel: "gpt-4.1-mini"
        })
      })
    );
    expect(JSON.stringify(result)).not.toContain("sk-live-secret");
    expect(JSON.stringify(result)).not.toContain(encrypted);
    expect(result.hasApiKey).toBe(true);
  });

  it("keeps the existing credential when updating without a replacement API key", async () => {
    modelProvider.findUnique.mockResolvedValue({ id: "provider_1", encryptedApiKey: "old" });
    modelProvider.update.mockResolvedValue({
      id: "provider_1",
      name: "OpenAI",
      nameKey: "openai",
      type: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.example.com/v1",
      encryptedApiKey: "old",
      defaultModel: "gpt-4.1-mini",
      isActive: true,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await service().update("provider_1", { name: "OpenAI", apiKey: "" });

    expect(modelProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ encryptedApiKey: expect.any(String) })
      })
    );
  });

  it("switches the default provider transactionally", async () => {
    const tx = {
      modelProvider: {
        findUnique: jest.fn().mockResolvedValue({ id: "provider_2", isActive: true }),
        updateMany: jest.fn(),
        update: jest.fn().mockResolvedValue({
          id: "provider_2",
          name: "Backup",
          nameKey: "backup",
          type: "OPENAI_COMPATIBLE",
          baseUrl: "https://backup.example.com/v1",
          encryptedApiKey: "encrypted",
          defaultModel: "gpt-4.1-mini",
          isActive: true,
          isDefault: true,
          createdAt: new Date(),
          updatedAt: new Date()
        })
      }
    };
    transaction.mockImplementation((callback: (client: MockTransaction) => Promise<unknown>) => callback(tx));

    const result = await service().setDefault("provider_2");

    expect(tx.modelProvider.updateMany).toHaveBeenCalledWith({ data: { isDefault: false } });
    expect(tx.modelProvider.update).toHaveBeenCalledWith({
      where: { id: "provider_2" },
      data: { isDefault: true },
      select: expect.any(Object)
    });
    expect(result.isDefault).toBe(true);
  });

  it("rejects disabling the current default provider", async () => {
    modelProvider.findUnique.mockResolvedValue({ id: "provider_1", isDefault: true });

    await expect(service().setActive("provider_1", false)).rejects.toThrow(BadRequestException);
    expect(modelProvider.update).not.toHaveBeenCalled();
  });

  it("resolves the enabled default provider when an agent has no dedicated provider", async () => {
    modelProvider.findFirst.mockResolvedValue({
      id: "provider_1",
      name: "OpenAI",
      type: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.example.com/v1",
      encryptedApiKey: "encrypted",
      defaultModel: "gpt-4.1-mini",
      isActive: true,
      isDefault: true
    });

    await expect(service().resolveProviderForAgent()).resolves.toMatchObject({
      id: "provider_1",
      apiKey: "decrypted-key"
    });
  });

  it("does not silently fall back when an agent provider is disabled", async () => {
    modelProvider.findUnique.mockResolvedValue({
      id: "provider_1",
      isActive: false
    });

    await expect(service().resolveProviderForAgent("provider_1")).rejects.toThrow(BadRequestException);
  });

  it("sanitizes failed connection test summaries", async () => {
    modelProvider.findUnique.mockResolvedValue({
      id: "provider_1",
      baseUrl: "https://api.example.com/v1",
      encryptedApiKey: "encrypted",
      defaultModel: "gpt-4.1-mini"
    });
    connectionTester.test.mockResolvedValue({
      ok: false,
      error: "401 Authorization: Bearer sk-live-secret rejected"
    });

    const result = await service().testConnection({ providerId: "provider_1" });

    expect(connectionTester.test).toHaveBeenCalledWith({
      baseUrl: "https://api.example.com/v1",
      apiKey: "decrypted-key",
      model: "gpt-4.1-mini"
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-live-secret");
    expect(result.error).not.toContain("Bearer");
  });

  it("fails resolver with a business error when no default provider is configured", async () => {
    modelProvider.findFirst.mockResolvedValue(null);

    await expect(service().resolveProviderForAgent()).rejects.toThrow(NotFoundException);
  });
});
