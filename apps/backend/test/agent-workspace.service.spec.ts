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

  it("stages, commits, and rolls back managed skills snapshots", async () => {
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
      skillName: "skill-a",
      sourceType: "registry",
      sourceId: "source-1",
      version: "1.2.0",
      resolvedVersion: "1.2.0",
      currentSkills: []
    });
    await service.commitSkillsConfig(agent, "change-1", first.stagedConfigVersion);
    const second = await service.stageSkillsConfig(agent, {
      changeId: "change-2",
      operation: "update",
      skillName: "skill-a",
      sourceType: "registry",
      sourceId: "source-1",
      version: "1.3.0",
      resolvedVersion: "1.3.0",
      currentSkills: [
        {
          name: "skill-a",
          version: "1.2.0",
          sourceType: "registry",
          sourceId: "source-1",
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false
        }
      ]
    });
    await service.commitSkillsConfig(agent, "change-2", second.stagedConfigVersion);

    await expect(readFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "utf8")).resolves.toContain(
      'version: "1.3.0"'
    );

    await service.rollbackSkillsConfig(agent, "change-2", second.previousConfigVersion);

    await expect(readFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "utf8")).resolves.toContain(
      'version: "1.2.0"'
    );
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

  it("does not overwrite user-edited files during update sync and returns a conflict", async () => {
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

    await expect(
      service.syncWorkspace(
        {
          ...previousAgent,
          soul: "Updated soul."
        },
        previousAgent
      )
    ).rejects.toThrow("workspace file has user edits: soul.md");
    await expect(readFile(join(descriptor.workspacePath, "soul.md"), "utf8")).resolves.toBe("User edited soul.\n");
  });
});
