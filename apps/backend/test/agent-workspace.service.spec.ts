import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";

describe("AgentWorkspaceService", () => {
  let repoRoot: string;
  let service: AgentWorkspaceService;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "homelab-agent-workspace-"));
    service = new AgentWorkspaceService({
      get: jest.fn((key: string) => (key === "HOMELAB_REPO_ROOT" ? repoRoot : undefined))
    } as any);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("creates deterministic workspace files and the agents gitignore", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");

    await service.initializeWorkspace(
      {
        id: "12345678-abcd",
        name: "Ops Agent",
        slug: "ops-agent",
        workspaceName: descriptor.workspaceName,
        workspacePath: descriptor.relativeWorkspacePath,
        modelProvider: "openai",
        modelSecretRef: "OPENAI_API_KEY",
        soul: "Keep production stable."
      },
      { allowExistingWorkspace: false }
    );

    await expect(readFile(join(descriptor.workspacePath, "agent.yaml"), "utf8")).resolves.toContain(
      "secretRef: OPENAI_API_KEY"
    );
    await expect(readFile(join(descriptor.workspacePath, "soul.md"), "utf8")).resolves.toBe(
      "Keep production stable."
    );
    await expect(readFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "utf8")).resolves.toBe(
      "skills: []\n"
    );
    await expect(readFile(join(descriptor.workspacePath, "workflows", "workflow.yaml"), "utf8")).resolves.toBe(
      "workflows: []\n"
    );
    await expect(readFile(join(descriptor.workspacePath, "secrets.example.env"), "utf8")).resolves.toContain(
      "OPENAI_API_KEY="
    );
    await expect(readFile(join(repoRoot, ".homelab", "agents", ".gitignore"), "utf8")).resolves.toBe(
      "**/.env\n**/.env.*\n**/*.secret\n**/secrets.local.*\n"
    );
  });

  it("keeps soul and workflow workspace capabilities available after baseline integration", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const agent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: null,
      modelSecretRef: null,
      soul: "Initial soul."
    };
    await service.initializeWorkspace(agent, { allowExistingWorkspace: false });

    const integratedService = service as AgentWorkspaceService & {
      writeSoul(input: typeof agent, content: string): Promise<void>;
      readSoulForRun(input: typeof agent): Promise<string>;
    };

    expect(typeof integratedService.writeSoul).toBe("function");
    expect(typeof service.writeWorkflowSource).toBe("function");

    await integratedService.writeSoul(agent, "Updated soul.\n");
    await service.writeWorkflowSource(agent, "default", "ts", "export default workflow;\n");

    await expect(integratedService.readSoulForRun(agent)).resolves.toBe("Updated soul.\n");
    await expect(service.readWorkflowSource(agent, "default", "ts")).resolves.toBe("export default workflow;\n");
  });

  it("preserves snapshots across the QA install, update, and remove lifecycle", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const agent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: null,
      modelSecretRef: null,
      soul: ""
    };
    await service.initializeWorkspace(agent, { allowExistingWorkspace: false });

    const first = await service.stageSkillsConfig(agent, {
      changeId: "change-1",
      operation: "install",
      skillName: "qa-smoke-skill",
      sourceType: "registry",
      sourceId: "builtin-registry",
      version: "1.0.0",
      resolvedVersion: "1.0.0",
      currentSkills: []
    });
    await service.commitSkillsConfig(agent, "change-1", first.stagedConfigVersion);
    await expect(
      readFile(join(descriptor.workspacePath, ".skills-state", "versions", first.stagedConfigVersion, "skills.yaml"), "utf8")
    ).resolves.toContain('version: "1.0.0"');

    const second = await service.stageSkillsConfig(agent, {
      changeId: "change-2",
      operation: "update",
      skillName: "qa-smoke-skill",
      sourceType: "registry",
      sourceId: "builtin-registry",
      version: "1.0.1",
      resolvedVersion: "1.0.1",
      currentSkills: [
        {
          name: "qa-smoke-skill",
          version: "1.0.0",
          sourceType: "registry",
          sourceId: "builtin-registry",
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false
        }
      ]
    });
    await service.commitSkillsConfig(agent, "change-2", second.stagedConfigVersion);

    await expect(readFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "utf8")).resolves.toContain(
      'version: "1.0.1"'
    );
    await expect(
      readFile(join(descriptor.workspacePath, ".skills-state", "versions", first.stagedConfigVersion, "skills.yaml"), "utf8")
    ).resolves.toContain('version: "1.0.0"');

    const third = await service.stageSkillsConfig(agent, {
      changeId: "change-3",
      operation: "remove",
      skillName: "qa-smoke-skill",
      sourceType: "registry",
      sourceId: "builtin-registry",
      currentSkills: [
        {
          name: "qa-smoke-skill",
          version: "1.0.1",
          sourceType: "registry",
          sourceId: "builtin-registry",
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false
        }
      ]
    });
    await service.commitSkillsConfig(agent, "change-3", third.stagedConfigVersion);

    await expect(readFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "utf8")).resolves.toBe(
      "skills: []\n"
    );
    await expect(
      readFile(join(descriptor.workspacePath, ".skills-state", "versions", second.stagedConfigVersion, "skills.yaml"), "utf8")
    ).resolves.toContain('version: "1.0.1"');

    await service.rollbackSkillsConfig(agent, "change-3", third.previousConfigVersion);

    await expect(readFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "utf8")).resolves.toContain(
      'version: "1.0.1"'
    );
  });

  it("reads immutable skill bundles by config version and rejects missing or corrupt bundles", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const agent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: null,
      modelSecretRef: null,
      soul: ""
    };
    await service.initializeWorkspace(agent, { allowExistingWorkspace: false });
    const staged = await service.stageSkillsConfig(agent, {
      changeId: "change-chat",
      operation: "install",
      skillName: "chat-skill",
      sourceType: "registry",
      sourceId: "builtin-registry",
      version: "1.0.0",
      resolvedVersion: "1.0.0",
      currentSkills: []
    });
    await service.commitSkillsConfig(agent, "change-chat", staged.stagedConfigVersion);

    await expect(service.readSkillsConfigVersion(agent, staged.stagedConfigVersion)).resolves.toEqual([
      expect.objectContaining({ name: "chat-skill", version: "1.0.0", sourceId: "builtin-registry" })
    ]);

    const versionPath = join(
      descriptor.workspacePath,
      ".skills-state",
      "versions",
      staged.stagedConfigVersion,
      "skills.yaml"
    );
    await writeFile(versionPath, "skills: []\n", "utf8");
    await expect(service.readSkillsConfigVersion(agent, staged.stagedConfigVersion)).rejects.toThrow(
      "skill config version integrity check failed"
    );
    await expect(service.readSkillsConfigVersion(agent, "cfg_0000000000000000")).rejects.toThrow();
  });

  it("rejects an existing unbound workspace path during first initialization", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    await service.initializeWorkspace(
      {
        id: "12345678-abcd",
        name: "Ops Agent",
        slug: "ops-agent",
        workspaceName: descriptor.workspaceName,
        workspacePath: descriptor.relativeWorkspacePath,
        modelProvider: null,
        modelSecretRef: null,
        soul: ""
      },
      { allowExistingWorkspace: false }
    );

    await expect(
      service.initializeWorkspace(
        {
          id: "12345678-abcd",
          name: "Ops Agent",
          slug: "ops-agent",
          workspaceName: descriptor.workspaceName,
          workspacePath: descriptor.relativeWorkspacePath,
          modelProvider: null,
          modelSecretRef: null,
          soul: ""
        },
        { allowExistingWorkspace: false }
      )
    ).rejects.toThrow("workspace path already exists");
  });

  it("rejects a workspace symlink that escapes the agents root", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const outside = await mkdtemp(join(tmpdir(), "homelab-outside-"));
    await service.initializeWorkspace(
      {
        id: "87654321-abcd",
        name: "Other Agent",
        slug: "other-agent",
        workspaceName: "other-agent--87654321",
        workspacePath: ".homelab/agents/other-agent--87654321",
        modelProvider: null,
        modelSecretRef: null,
        soul: ""
      },
      { allowExistingWorkspace: false }
    );
    await symlink(outside, descriptor.workspacePath);

    await expect(
      service.initializeWorkspace(
        {
          id: "12345678-abcd",
          name: "Ops Agent",
          slug: "ops-agent",
          workspaceName: descriptor.workspaceName,
          workspacePath: descriptor.relativeWorkspacePath,
          modelProvider: null,
          modelSecretRef: null,
          soul: ""
        },
        { allowExistingWorkspace: true }
      )
    ).rejects.toThrow("workspace path escapes the agents root");

    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked .homelab parent that would move workspace writes outside the repo", async () => {
    const outside = await mkdtemp(join(tmpdir(), "homelab-outside-"));
    await symlink(outside, join(repoRoot, ".homelab"));

    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");

    await expect(
      service.initializeWorkspace(
        {
          id: "12345678-abcd",
          name: "Ops Agent",
          slug: "ops-agent",
          workspaceName: descriptor.workspaceName,
          workspacePath: descriptor.relativeWorkspacePath,
          modelProvider: null,
          modelSecretRef: null,
          soul: ""
        },
        { allowExistingWorkspace: false }
      )
    ).rejects.toThrow("workspace root must not contain symbolic links");

    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked agents root that points outside the repo", async () => {
    const outside = await mkdtemp(join(tmpdir(), "homelab-outside-"));
    await mkdir(join(repoRoot, ".homelab"));
    await symlink(outside, join(repoRoot, ".homelab", "agents"));

    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");

    await expect(
      service.initializeWorkspace(
        {
          id: "12345678-abcd",
          name: "Ops Agent",
          slug: "ops-agent",
          workspaceName: descriptor.workspaceName,
          workspacePath: descriptor.relativeWorkspacePath,
          modelProvider: null,
          modelSecretRef: null,
          soul: ""
        },
        { allowExistingWorkspace: false }
      )
    ).rejects.toThrow("workspace root must not contain symbolic links");

    await rm(outside, { recursive: true, force: true });
  });

  it("does not overwrite existing workspace files on retry but fills missing files", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const agent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: null,
      modelSecretRef: null,
      soul: "Initial soul."
    };
    await service.initializeWorkspace(agent, { allowExistingWorkspace: false });
    await writeFile(join(descriptor.workspacePath, "soul.md"), "User edited soul.\n", "utf8");
    await writeFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "skills:\n  - user-skill\n", "utf8");
    await rm(join(descriptor.workspacePath, "workflows", "workflow.yaml"));

    await service.initializeWorkspace(
      {
        ...agent,
        soul: "Updated generated soul."
      },
      { allowExistingWorkspace: true }
    );

    await expect(readFile(join(descriptor.workspacePath, "soul.md"), "utf8")).resolves.toBe("User edited soul.\n");
    await expect(readFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "utf8")).resolves.toBe(
      "skills:\n  - user-skill\n"
    );
    await expect(readFile(join(descriptor.workspacePath, "workflows", "workflow.yaml"), "utf8")).resolves.toBe(
      "workflows: []\n"
    );
  });

  it("syncs updated generated files when they have not been edited by a user", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const previousAgent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: "openai",
      modelSecretRef: "OPENAI_API_KEY",
      soul: "Initial soul."
    };
    await service.initializeWorkspace(previousAgent, { allowExistingWorkspace: false });

    await service.syncWorkspace(
      {
        ...previousAgent,
        name: "Ops Agent Updated",
        modelProvider: "anthropic",
        modelSecretRef: "ANTHROPIC_API_KEY",
        soul: "Updated soul."
      },
      previousAgent
    );

    const agentYaml = await readFile(join(descriptor.workspacePath, "agent.yaml"), "utf8");
    expect(agentYaml).toContain('name: "Ops Agent Updated"');
    expect(agentYaml).toContain('provider: "anthropic"');
    expect(agentYaml).toContain("secretRef: ANTHROPIC_API_KEY");
    await expect(readFile(join(descriptor.workspacePath, "soul.md"), "utf8")).resolves.toBe("Updated soul.");
  });

  it("overwrites soul.md during update sync because soul is an admin-managed editable file", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const previousAgent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: "openai",
      modelSecretRef: "OPENAI_API_KEY",
      soul: "Initial soul."
    };
    await service.initializeWorkspace(previousAgent, { allowExistingWorkspace: false });
    await writeFile(join(descriptor.workspacePath, "soul.md"), "User edited soul.\n", "utf8");

    await service.syncWorkspace(
      {
        ...previousAgent,
        soul: "Updated soul."
      },
      previousAgent
    );

    await expect(readFile(join(descriptor.workspacePath, "soul.md"), "utf8")).resolves.toBe("Updated soul.");
  });

  it("rejects overwriting soul.md when the soul path is a symbolic link", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const previousAgent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: "openai",
      modelSecretRef: "OPENAI_API_KEY",
      soul: "Initial soul."
    };
    await service.initializeWorkspace(previousAgent, { allowExistingWorkspace: false });
    await rm(join(descriptor.workspacePath, "soul.md"));
    await symlink(join(descriptor.workspacePath, "agent.yaml"), join(descriptor.workspacePath, "soul.md"));

    await expect(
      service.syncWorkspace(
        {
          ...previousAgent,
          soul: "Updated soul."
        },
        previousAgent
      )
    ).rejects.toThrow("soul path must not be a symbolic link");
  });

  it("writes Mastra workflow source only to the controlled workspace path", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const agent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: null,
      modelSecretRef: null,
      soul: ""
    };
    await service.initializeWorkspace(agent, { allowExistingWorkspace: false });

    const result = await service.writeWorkflowSource(
      agent,
      "support-triage",
      "ts",
      "export default workflow;\n"
    );

    expect(result.relativePath).toBe(
      ".homelab/agents/ops-agent--12345678/src/mastra/workflows/support-triage.ts"
    );
    await expect(
      readFile(join(descriptor.workspacePath, "src", "mastra", "workflows", "support-triage.ts"), "utf8")
    ).resolves.toBe("export default workflow;\n");
  });

  it("rejects workflow source keys that could escape the controlled path", async () => {
    const descriptor = service.buildDescriptor("ops-agent", "12345678-abcd");
    const agent = {
      id: "12345678-abcd",
      name: "Ops Agent",
      slug: "ops-agent",
      workspaceName: descriptor.workspaceName,
      workspacePath: descriptor.relativeWorkspacePath,
      modelProvider: null,
      modelSecretRef: null,
      soul: ""
    };
    await service.initializeWorkspace(agent, { allowExistingWorkspace: false });

    await expect(service.writeWorkflowSource(agent, "../escape", "ts", "export default workflow;\n")).rejects.toThrow(
      "workflow key contains unsafe characters"
    );
    await expect(
      readFile(join(repoRoot, ".homelab", "agents", "escape.ts"), "utf8")
    ).rejects.toThrow();
  });
});
