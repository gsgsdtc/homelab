import { ChatConfigSourceService } from "../src/modules/chat/chat-config-source.service";

describe("ChatConfigSourceService immutable skills", () => {
  const agent = { id: "agent-1", modelProviderId: null } as any;

  it("loads each active config version bundle and freezes the matching skill entry", async () => {
    const prisma = {
      agentSkillInstallation: {
        findMany: jest.fn().mockResolvedValue([
          {
            skillName: "chat-skill",
            version: "1.0.0",
            configVersion: "cfg_1111111111111111",
            sourceType: "registry",
            sourceId: "source-1"
          }
        ])
      }
    };
    const workspaces = {
      readSkillsConfigVersion: jest.fn().mockResolvedValue([
        {
          name: "chat-skill",
          version: "1.0.0",
          sourceType: "registry",
          sourceId: "source-1",
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false
        }
      ])
    };
    const source = new ChatConfigSourceService(prisma as any, {} as any, workspaces as any, {} as any);

    await expect(source.readSkills(agent)).resolves.toEqual([
      expect.objectContaining({
        name: "chat-skill",
        configVersion: "cfg_1111111111111111",
        bundle: expect.objectContaining({ name: "chat-skill", version: "1.0.0" })
      })
    ]);
    expect(workspaces.readSkillsConfigVersion).toHaveBeenCalledWith(agent, "cfg_1111111111111111");
  });

  it.each(["pending_restart", "runtime_offline"])(
    "uses the committed immutable bundle when the last reload status is %s",
    async (reloadStatus) => {
      const prisma = {
        agentSkillInstallation: {
          findMany: jest.fn().mockResolvedValue([
            {
              skillName: "chat-skill",
              version: "1.0.0",
              configVersion: "cfg_1111111111111111",
              sourceType: "registry",
              sourceId: "source-1"
            }
          ])
        },
        agentSkillChange: {
          findFirst: jest.fn().mockResolvedValue({ reloadStatus, activeConfigVersion: "cfg_1111111111111111" })
        }
      };
      const workspaces = {
        readSkillsConfigVersion: jest.fn().mockResolvedValue([
          {
            name: "chat-skill",
            version: "1.0.0",
            sourceType: "registry",
            sourceId: "source-1",
            enabled: true
          }
        ])
      };
      const source = new ChatConfigSourceService(prisma as any, {} as any, workspaces as any, {} as any);

      await expect(source.readSkills(agent)).resolves.toEqual([
        expect.objectContaining({ name: "chat-skill", configVersion: "cfg_1111111111111111" })
      ]);
      expect(prisma.agentSkillChange.findFirst).not.toHaveBeenCalled();
      expect(workspaces.readSkillsConfigVersion).toHaveBeenCalledWith(agent, "cfg_1111111111111111");
    }
  );

  it("maps missing or corrupt active bundles to SKILLS_SNAPSHOT_UNAVAILABLE", async () => {
    const prisma = {
      agentSkillInstallation: {
        findMany: jest.fn().mockResolvedValue([
          {
            skillName: "chat-skill",
            version: "1.0.0",
            configVersion: "cfg_1111111111111111",
            sourceType: "registry",
            sourceId: "source-1"
          }
        ])
      }
    };
    const workspaces = { readSkillsConfigVersion: jest.fn().mockRejectedValue(new Error("ENOENT")) };
    const source = new ChatConfigSourceService(prisma as any, {} as any, workspaces as any, {} as any);

    await expect(source.readSkills(agent)).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ httpStatus: 422, code: "SKILLS_SNAPSHOT_UNAVAILABLE", retryable: false })
    });
  });

  it("allows no skills without reading workspace state", async () => {
    const prisma = { agentSkillInstallation: { findMany: jest.fn().mockResolvedValue([]) } };
    const workspaces = { readSkillsConfigVersion: jest.fn() };
    const source = new ChatConfigSourceService(prisma as any, {} as any, workspaces as any, {} as any);

    await expect(source.readSkills(agent)).resolves.toEqual([]);
    expect(workspaces.readSkillsConfigVersion).not.toHaveBeenCalled();
  });
});
