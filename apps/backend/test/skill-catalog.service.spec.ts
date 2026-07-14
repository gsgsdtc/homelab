import { SkillCatalogService } from "../src/modules/agents/skill-catalog.service";

describe("GFU-29 SkillCatalogService", () => {
  const prisma: any = {
    agentSkillSource: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn()
    },
    agentSkillCatalogSkill: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn()
    },
    agentSkillCatalogVersion: { findMany: jest.fn(), count: jest.fn() }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agentSkillSource.count.mockResolvedValue(1);
    prisma.agentSkillSource.findMany.mockResolvedValue([
      {
        id: "source-1",
        sourceType: "registry",
        label: "Built-in",
        isTrusted: true,
        gitUrl: "https://secret"
      }
    ]);
  });

  it("returns only public fields for trusted sources", async () => {
    const service = new SkillCatalogService(prisma);

    await expect(service.sources({ page: 1, pageSize: 20 })).resolves.toEqual({
      items: [{ id: "source-1", sourceType: "registry", label: "Built-in" }],
      total: 1,
      page: 1,
      pageSize: 20
    });
    expect(prisma.agentSkillSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isTrusted: true },
        skip: 0,
        take: 20
      })
    );
  });
});
