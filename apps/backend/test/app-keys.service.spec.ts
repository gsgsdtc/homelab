import { UnauthorizedException } from "@nestjs/common";
import { AppKeysService } from "../src/modules/app-keys/app-keys.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("AppKeysService", () => {
  const prisma = {
    appKey: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn()
    }
  } as unknown as PrismaService & {
    appKey: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates an app key and only stores its hash", async () => {
    prisma.appKey.create.mockImplementation(async ({ data, select }: { data: any; select: any }) => ({
      id: "key_1",
      name: data.name,
      agentName: data.agentName,
      scopes: data.scopes,
      isActive: true,
      expiresAt: data.expiresAt,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      select
    }));

    const service = new AppKeysService(prisma);
    const result = await service.create({ name: "agent", agentName: "tester", scopes: ["health:read"] });

    expect(result.key).toMatch(/^hl_/);
    expect(prisma.appKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          keyHash: expect.not.stringContaining(result.key)
        })
      })
    );
  });

  it("rejects inactive keys", async () => {
    prisma.appKey.findUnique.mockResolvedValue({
      id: "key_1",
      name: "agent",
      keyHash: "hash",
      agentName: "tester",
      scopes: [],
      isActive: false,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const service = new AppKeysService(prisma);

    await expect(service.validateRawKey("secret")).rejects.toThrow(UnauthorizedException);
    expect(prisma.appKey.update).not.toHaveBeenCalled();
  });
});
