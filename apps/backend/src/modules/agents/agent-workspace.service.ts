import { constants, existsSync } from "fs";
import { access, lstat, mkdir, realpath, writeFile } from "fs/promises";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { join, relative, resolve, sep } from "path";
import { Agent } from "@prisma/client";

export interface AgentWorkspaceDescriptor {
  rootPath: string;
  workspaceName: string;
  workspacePath: string;
  relativeWorkspacePath: string;
}

export interface InitializeWorkspaceInput {
  id: string;
  name: string;
  slug: string;
  workspaceName: string;
  workspacePath: string;
  modelProvider: string | null;
  modelSecretRef: string | null;
  soul: string;
}

export interface InitializeWorkspaceOptions {
  allowExistingWorkspace?: boolean;
}

const SECRET_IGNORE_RULES = ["**/.env", "**/.env.*", "**/*.secret", "**/secrets.local.*"];

@Injectable()
export class AgentWorkspaceService {
  constructor(private readonly config: ConfigService) {}

  buildDescriptor(slug: string, agentId: string): AgentWorkspaceDescriptor {
    const agentIdShort = this.buildAgentIdShort(agentId);
    const workspaceName = `${slug}--${agentIdShort}`;
    this.assertSafeSegment(workspaceName);
    const rootPath = this.getWorkspaceRoot();
    const workspacePath = resolve(rootPath, workspaceName);
    this.assertInsideRoot(rootPath, workspacePath);

    return {
      rootPath,
      workspaceName,
      workspacePath,
      relativeWorkspacePath: join(".homelab", "agents", workspaceName)
    };
  }

  async ensurePathAvailable(
    descriptor: AgentWorkspaceDescriptor,
    currentAgent?: Pick<Agent, "workspacePath">,
    options: InitializeWorkspaceOptions = {}
  ) {
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);

    try {
      const stat = await lstat(descriptor.workspacePath);
      if (stat.isSymbolicLink()) {
        throw new Error("workspace path must not be a symbolic link");
      }
      if (!stat.isDirectory()) {
        throw new Error("workspace path exists and is not a directory");
      }
      if (
        !options.allowExistingWorkspace ||
        !currentAgent ||
        currentAgent.workspacePath !== descriptor.relativeWorkspacePath
      ) {
        throw new Error("workspace path already exists");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async initializeWorkspace(agent: InitializeWorkspaceInput, options: InitializeWorkspaceOptions = {}): Promise<void> {
    const descriptor = this.descriptorFromAgent(agent);
    await this.ensurePathAvailable(descriptor, { workspacePath: agent.workspacePath }, options);
    await mkdir(descriptor.workspacePath, { recursive: true });
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    await mkdir(join(descriptor.workspacePath, "skills"), { recursive: true });
    await mkdir(join(descriptor.workspacePath, "workflows"), { recursive: true });
    await this.writeGeneratedFiles(agent, descriptor);
    await this.ensureAgentsGitignore(descriptor.rootPath);
  }

  getGitStatus(): "available" | "unavailable" {
    return this.isGitRepository() ? "available" : "unavailable";
  }

  private descriptorFromAgent(agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">) {
    const rootPath = this.getWorkspaceRoot();
    const workspacePath = resolve(this.getRepoRoot(), agent.workspacePath);
    this.assertInsideRoot(rootPath, workspacePath);
    return {
      rootPath,
      workspaceName: agent.workspaceName,
      workspacePath,
      relativeWorkspacePath: agent.workspacePath
    };
  }

  private async writeGeneratedFiles(agent: InitializeWorkspaceInput, descriptor: AgentWorkspaceDescriptor) {
    const agentYaml = [
      `id: ${agent.id}`,
      `name: ${this.quoteYaml(agent.name)}`,
      `slug: ${agent.slug}`,
      `workspacePath: ${descriptor.relativeWorkspacePath}`,
      "model:",
      `  provider: ${agent.modelProvider ? this.quoteYaml(agent.modelProvider) : "null"}`,
      `  secretRef: ${agent.modelSecretRef ?? "null"}`,
      ""
    ].join("\n");

    await writeFile(join(descriptor.workspacePath, "agent.yaml"), agentYaml, "utf8");
    await writeFile(join(descriptor.workspacePath, "soul.md"), agent.soul || `# ${agent.name}\n`, "utf8");
    await writeFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "skills: []\n", "utf8");
    await writeFile(join(descriptor.workspacePath, "workflows", "workflow.yaml"), "workflows: []\n", "utf8");
    await writeFile(join(descriptor.workspacePath, "secrets.example.env"), this.buildSecretsExample(agent), "utf8");
    await writeFile(join(descriptor.workspacePath, "README.md"), this.buildReadme(agent, descriptor), "utf8");
  }

  private async ensureAgentsGitignore(rootPath: string) {
    await mkdir(rootPath, { recursive: true });
    await writeFile(join(rootPath, ".gitignore"), `${SECRET_IGNORE_RULES.join("\n")}\n`, "utf8");
  }

  private buildSecretsExample(agent: InitializeWorkspaceInput): string {
    const ref = agent.modelSecretRef ?? "MODEL_API_KEY";
    return ["# Real secret values must stay outside Git-tracked files.", `${ref}=`, ""].join("\n");
  }

  private buildReadme(agent: InitializeWorkspaceInput, descriptor: AgentWorkspaceDescriptor): string {
    return [
      `# ${agent.name}`,
      "",
      `Workspace: \`${descriptor.relativeWorkspacePath}/\``,
      "",
      "This directory stores Git-trackable Agent configuration only.",
      "Do not write API keys, tokens, private keys, cookies, passwords, or other real secrets here.",
      "Use `secretRef` values in configuration and provide real values through environment variables or the backend secret provider.",
      "",
      "Generated files:",
      "",
      "- `agent.yaml`",
      "- `soul.md`",
      "- `skills/skills.yaml`",
      "- `workflows/workflow.yaml`",
      "- `secrets.example.env`",
      ""
    ].join("\n");
  }

  private getRepoRoot(): string {
    return resolve(String(this.config.get<string>("HOMELAB_REPO_ROOT") ?? process.cwd()));
  }

  private getWorkspaceRoot(): string {
    return resolve(this.getRepoRoot(), ".homelab", "agents");
  }

  private buildAgentIdShort(agentId: string): string {
    const normalized = agentId.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.length < 8) {
      throw new Error("agent id cannot produce an 8 character workspace identifier");
    }
    return normalized.slice(0, 8);
  }

  private assertSafeSegment(segment: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]{8}$/.test(segment)) {
      throw new Error("workspace name contains unsafe characters");
    }
  }

  private assertInsideRoot(rootPath: string, targetPath: string): void {
    const rel = relative(rootPath, targetPath);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(targetPath) === resolve(rootPath)) {
      throw new Error("workspace path escapes the agents root");
    }
  }

  private async assertNoSymlinkEscape(rootPath: string, targetPath: string): Promise<void> {
    const realRoot = await this.realpathIfExists(rootPath);
    if (!realRoot) {
      return;
    }

    const existingTarget = await this.nearestExistingPath(targetPath);
    if (!existingTarget) {
      return;
    }

    const realTarget = await realpath(existingTarget);
    this.assertInsideOrEqual(realRoot, realTarget);
  }

  private async nearestExistingPath(targetPath: string): Promise<string | null> {
    let current = targetPath;
    const repoRoot = this.getRepoRoot();
    while (current !== repoRoot && current !== resolve(current, "..")) {
      try {
        await access(current, constants.F_OK);
        return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        current = resolve(current, "..");
      }
    }
    return null;
  }

  private assertInsideOrEqual(rootPath: string, targetPath: string): void {
    const rel = relative(rootPath, targetPath);
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new Error("workspace path escapes the agents root");
    }
  }

  private async realpathIfExists(path: string): Promise<string | null> {
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private isGitRepository(): boolean {
    return existsSync(join(this.getRepoRoot(), ".git"));
  }

  private quoteYaml(value: string): string {
    return JSON.stringify(value);
  }
}
