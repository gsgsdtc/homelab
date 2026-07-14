import { DynamicImportMastraWorkflowRuntimeRegistry } from "../src/modules/agents/mastra-workflow-runtime.registry";
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

describe("ChatConfigSourceService active workflow", () => {
  /**
   * @doc GFU-27 F1 R13 / second-round PR #36 blocker 1
   * @purpose Verify DB activeHash cold-loads a real Mastra executable without treating its builder `.then` as a Promise.
   * @context A regression leaves the first chat execution after process restart permanently pending.
   */
  it("cold-loads the DB activeHash as a real Mastra executable without thenable assimilation", async () => {
    const activeHash = "hash-db-active-real-mastra";
    const prisma = {
      agentWorkflow: {
        findUnique: jest.fn().mockResolvedValue({
          id: "workflow-1",
          activeHash,
          reloadStatus: "succeeded"
        })
      },
      agentWorkflowVersion: {
        findFirst: jest.fn().mockResolvedValue({
          sourceHash: activeHash,
          extension: "ts",
          source: [
            'import { createWorkflow } from "@mastra/core/workflows";',
            'const workflow = createWorkflow({ id: "default" });',
            "workflow.commit();",
            "export default workflow;",
            ""
          ].join("\n")
        })
      }
    };
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();
    const source = new ChatConfigSourceService(prisma as any, {} as any, {} as any, registry);

    const result = await Promise.race([
      source.readWorkflow({ id: "agent-db-active" } as any).then((workflow) => ({ status: "loaded" as const, workflow })),
      new Promise<{ status: "still-pending" }>((resolve) =>
        setTimeout(() => resolve({ status: "still-pending" }), 100)
      )
    ]);

    expect(result.status).toBe("loaded");
    expect((result as any).workflow).toEqual({
      workflowKey: "default",
      activeHash,
      source: expect.any(String),
      executable: expect.objectContaining({ committed: true, createRun: expect.any(Function) })
    });
    expect(registry.getWorkflow("agent-db-active", "default", activeHash)).toBe(
      (result as any).workflow.executable
    );
  });
});
