import { mkdtemp, readFile, rm, symlink } from "fs/promises";
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
});
