import { RuntimeReloadClient } from "../src/modules/agents/runtime-reload-client.service";

describe("RuntimeReloadClient", () => {
  it("ignores HOMELAB_SKILL_RELOAD_MODE without the protected test gate", async () => {
    const client = new RuntimeReloadClient({
      get: jest.fn((key: string) => (key === "HOMELAB_SKILL_RELOAD_MODE" ? "loaded" : undefined))
    } as any);

    await expect(client.reloadSkills({ id: "agent-1", workspacePath: ".homelab/agents/a" }, "config-1")).resolves.toEqual({
      reloadStatus: "pending_restart",
      effectiveFor: "next_task"
    });
  });

  it("allows test-gated reload failure injection", async () => {
    const client = new RuntimeReloadClient({
      get: jest.fn((key: string) => {
        if (key === "NODE_ENV") return "test";
        if (key === "HOMELAB_ENABLE_SKILL_RELOAD_TEST_MODE") return "true";
        if (key === "HOMELAB_SKILL_RELOAD_MODE") return "runtime_offline";
        return undefined;
      })
    } as any);

    await expect(client.reloadSkills({ id: "agent-1", workspacePath: ".homelab/agents/a" }, "config-1")).resolves.toEqual({
      reloadStatus: "runtime_offline",
      effectiveFor: "next_task"
    });
  });

  it("does not allow test mode to fake loaded without a real runtime endpoint", async () => {
    const client = new RuntimeReloadClient({
      get: jest.fn((key: string) => {
        if (key === "NODE_ENV") return "test";
        if (key === "HOMELAB_ENABLE_SKILL_RELOAD_TEST_MODE") return "true";
        if (key === "HOMELAB_SKILL_RELOAD_MODE") return "loaded";
        return undefined;
      })
    } as any);

    await expect(client.reloadSkills({ id: "agent-1", workspacePath: ".homelab/agents/a" }, "config-1")).resolves.toEqual({
      reloadStatus: "pending_restart",
      effectiveFor: "next_task"
    });
  });
});
