import { constants, existsSync } from "fs";
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from "fs/promises";
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
  syncExistingGenerated?: boolean;
  previousAgent?: InitializeWorkspaceInput;
}

export interface WorkflowSourceWriteResult {
  relativePath: string;
  path: string;
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
    await this.assertWorkspaceRootChainSafe();
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
    await this.assertWorkspaceRootChainSafe();
    await mkdir(descriptor.workspacePath, { recursive: true });
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    await mkdir(join(descriptor.workspacePath, "skills"), { recursive: true });
    await mkdir(join(descriptor.workspacePath, "workflows"), { recursive: true });
    await this.writeGeneratedFiles(agent, descriptor, options, options.previousAgent);
    await this.ensureAgentsGitignore(descriptor.rootPath);
  }

  async syncWorkspace(agent: InitializeWorkspaceInput, previousAgent: InitializeWorkspaceInput): Promise<void> {
    await this.initializeWorkspace(agent, {
      allowExistingWorkspace: true,
      syncExistingGenerated: true,
      previousAgent
    });
  }

  getGitStatus(): "available" | "unavailable" {
    return this.isGitRepository() ? "available" : "unavailable";
  }

  workflowSourceRelativePath(
    agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">,
    workflowKey: string,
    extension: "ts" | "js" = "ts"
  ): string {
    this.assertSafeWorkflowKey(workflowKey);
    this.assertSafeWorkflowExtension(extension);
    const descriptor = this.descriptorFromAgent(agent);
    const sourcePath = this.workflowSourcePath(descriptor, workflowKey, extension);
    return relative(this.getRepoRoot(), sourcePath);
  }

  async writeWorkflowSource(
    agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">,
    workflowKey: string,
    extension: "ts" | "js",
    source: string
  ): Promise<WorkflowSourceWriteResult> {
    this.assertSafeWorkflowKey(workflowKey);
    this.assertSafeWorkflowExtension(extension);
    const descriptor = this.descriptorFromAgent(agent);
    await this.assertWorkspaceRootChainSafe();
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    const sourcePath = this.workflowSourcePath(descriptor, workflowKey, extension);
    const sourceRoot = join(descriptor.workspacePath, "src", "mastra", "workflows");
    this.assertInsideOrEqual(sourceRoot, sourcePath);
    await mkdir(sourceRoot, { recursive: true });
    await this.assertNoSymlinkEscape(descriptor.rootPath, sourceRoot);
    const tempPath = join(sourceRoot, `${workflowKey}.${Date.now()}.tmp`);
    await writeFile(tempPath, source, "utf8");
    await rename(tempPath, sourcePath);
    return {
      path: sourcePath,
      relativePath: relative(this.getRepoRoot(), sourcePath)
    };
  }

  async readWorkflowSource(
    agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">,
    workflowKey: string,
    extension: "ts" | "js"
  ): Promise<string> {
    this.assertSafeWorkflowKey(workflowKey);
    this.assertSafeWorkflowExtension(extension);
    const descriptor = this.descriptorFromAgent(agent);
    const sourcePath = this.workflowSourcePath(descriptor, workflowKey, extension);
    return readFile(sourcePath, "utf8");
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

  private workflowSourcePath(
    descriptor: Pick<AgentWorkspaceDescriptor, "workspacePath">,
    workflowKey: string,
    extension: "ts" | "js"
  ) {
    return join(descriptor.workspacePath, "src", "mastra", "workflows", `${workflowKey}.${extension}`);
  }

  private async writeGeneratedFiles(
    agent: InitializeWorkspaceInput,
    descriptor: AgentWorkspaceDescriptor,
    options: InitializeWorkspaceOptions,
    previousAgent?: InitializeWorkspaceInput
  ) {
    const previousDescriptor = previousAgent ? this.descriptorFromAgent(previousAgent) : undefined;
    const generatedFiles = this.buildGeneratedFiles(agent, descriptor);
    const previousGeneratedFiles =
      previousAgent && previousDescriptor ? this.buildGeneratedFiles(previousAgent, previousDescriptor) : new Map();

    for (const [relativePath, content] of generatedFiles) {
      await this.writeGeneratedFile(
        join(descriptor.workspacePath, relativePath),
        content,
        options,
        previousGeneratedFiles.get(relativePath),
        relativePath
      );
    }
  }

  private buildGeneratedFiles(
    agent: InitializeWorkspaceInput,
    descriptor: AgentWorkspaceDescriptor
  ): Map<string, string> {
    const files = new Map<string, string>();
    files.set("agent.yaml", this.buildAgentYaml(agent, descriptor));
    files.set("soul.md", agent.soul || `# ${agent.name}\n`);
    files.set("skills/skills.yaml", "skills: []\n");
    files.set("workflows/workflow.yaml", "workflows: []\n");
    files.set("secrets.example.env", this.buildSecretsExample(agent));
    files.set("README.md", this.buildReadme(agent, descriptor));
    return files;
  }

  private buildAgentYaml(agent: InitializeWorkspaceInput, descriptor: AgentWorkspaceDescriptor): string {
    return [
      `id: ${agent.id}`,
      `name: ${this.quoteYaml(agent.name)}`,
      `slug: ${agent.slug}`,
      `workspacePath: ${descriptor.relativeWorkspacePath}`,
      "model:",
      `  provider: ${agent.modelProvider ? this.quoteYaml(agent.modelProvider) : "null"}`,
      `  secretRef: ${agent.modelSecretRef ?? "null"}`,
      ""
    ].join("\n");
  }

  private async writeGeneratedFile(
    path: string,
    content: string,
    options: InitializeWorkspaceOptions,
    previousContent?: string,
    relativePath = path
  ) {
    if (!(await this.pathExists(path))) {
      await writeFile(path, content, "utf8");
      return;
    }

    if (!options.allowExistingWorkspace) {
      await writeFile(path, content, "utf8");
      return;
    }

    if (!options.syncExistingGenerated) {
      return;
    }

    const existingContent = await readFile(path, "utf8");
    if (existingContent === content) {
      return;
    }
    if (previousContent !== undefined && existingContent === previousContent) {
      await writeFile(path, content, "utf8");
      return;
    }
    throw new Error(`workspace file has user edits: ${relativePath}`);
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

  private assertSafeWorkflowKey(workflowKey: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workflowKey)) {
      throw new Error("workflow key contains unsafe characters");
    }
  }

  private assertSafeWorkflowExtension(extension: string): asserts extension is "ts" | "js" {
    if (extension !== "ts" && extension !== "js") {
      throw new Error("workflow extension must be ts or js");
    }
  }

  private assertInsideRoot(rootPath: string, targetPath: string): void {
    const rel = relative(rootPath, targetPath);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(targetPath) === resolve(rootPath)) {
      throw new Error("workspace path escapes the agents root");
    }
  }

  private async assertNoSymlinkEscape(rootPath: string, targetPath: string): Promise<void> {
    const realRepoRoot = await this.realpathIfExists(this.getRepoRoot());
    if (!realRepoRoot) {
      return;
    }

    const existingTarget = await this.nearestExistingPath(targetPath);
    if (!existingTarget) {
      return;
    }

    const realTarget = await realpath(existingTarget);
    this.assertInsideOrEqual(realRepoRoot, realTarget);
    if (this.isInsideOrEqual(rootPath, existingTarget)) {
      const realRoot = await this.realpathIfExists(rootPath);
      if (realRoot) {
        this.assertInsideOrEqual(realRoot, realTarget);
      }
    }
  }

  private async assertWorkspaceRootChainSafe(): Promise<void> {
    const repoRoot = this.getRepoRoot();
    const realRepoRoot = await this.realpathIfExists(repoRoot);
    if (!realRepoRoot) {
      return;
    }

    for (const path of [join(repoRoot, ".homelab"), join(repoRoot, ".homelab", "agents")]) {
      const stat = await this.lstatIfExists(path);
      if (!stat) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new Error("workspace root must not contain symbolic links");
      }
      const realPath = await realpath(path);
      this.assertInsideOrEqual(realRepoRoot, realPath);
    }
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

  private isInsideOrEqual(rootPath: string, targetPath: string): boolean {
    const rel = relative(rootPath, targetPath);
    return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
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

  private async lstatIfExists(path: string) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
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
