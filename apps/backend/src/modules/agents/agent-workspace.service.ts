import { constants, existsSync } from "fs";
import { access, cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "fs/promises";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { join, relative, resolve, sep } from "path";
import { Agent } from "@prisma/client";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { AgentSkillMutation, SkillConfigEntry } from "./agent-skill-types";

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
  modelProviderId?: string | null;
  modelProvider?: string | null;
  modelSecretRef?: string | null;
  soul: string;
}

export interface InitializeWorkspaceOptions {
  allowExistingWorkspace?: boolean;
  syncExistingGenerated?: boolean;
  previousAgent?: InitializeWorkspaceInput;
}

export interface StagedSkillsConfig {
  previousConfigVersion: string | null;
  stagedConfigVersion: string;
  config: {
    skills: SkillConfigEntry[];
  };
}

export interface WorkflowSourceWriteResult {
  relativePath: string;
  path: string;
}

export type AgentSoulFileStatus = "loaded" | "missing" | "error";

export interface AgentSoulRead {
  content: string | null;
  status: AgentSoulFileStatus;
  message?: string;
}

const SECRET_IGNORE_RULES = ["**/.env", "**/.env.*", "**/*.secret", "**/secrets.local.*"];
const SOUL_FILE_NAME = "soul.md";

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

  async ensurePathAvailable(descriptor: AgentWorkspaceDescriptor, currentAgent?: Pick<Agent, "workspacePath">, options: InitializeWorkspaceOptions = {}) {
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
      if (!options.allowExistingWorkspace || !currentAgent || currentAgent.workspacePath !== descriptor.relativeWorkspacePath) {
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
    await mkdir(join(descriptor.workspacePath, "workflows"), {
      recursive: true
    });
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

  async listSkills(agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">): Promise<SkillConfigEntry[]> {
    const descriptor = this.descriptorFromAgent(agent);
    const skillsPath = join(descriptor.workspacePath, "skills", "skills.yaml");
    const content = (await this.pathExists(skillsPath)) ? await readFile(skillsPath, "utf8") : "skills: []\n";
    return this.parseManagedSkills(content);
  }

  async stageSkillsConfig(agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">, mutation: AgentSkillMutation): Promise<StagedSkillsConfig> {
    const descriptor = this.descriptorFromAgent(agent);
    await this.assertWorkspaceRootChainSafe();
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);

    const previousConfigVersion = await this.readActiveConfigVersion(descriptor.workspacePath);
    const skills = this.applySkillMutation(mutation);
    const content = this.serializeSkills(skills);
    const stagedConfigVersion = this.buildConfigVersion(content);
    const stagingPath = join(descriptor.workspacePath, ".skills-state", "staging", mutation.changeId, "skills.yaml");
    await mkdir(join(stagingPath, ".."), { recursive: true });
    await writeFile(stagingPath, content, "utf8");

    return {
      previousConfigVersion,
      stagedConfigVersion,
      config: { skills }
    };
  }

  async commitSkillsConfig(
    agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">,
    changeId: string,
    stagedConfigVersion: string
  ): Promise<{ activeConfigVersion: string }> {
    const descriptor = this.descriptorFromAgent(agent);
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    const stagingPath = join(descriptor.workspacePath, ".skills-state", "staging", changeId, "skills.yaml");
    const versionDir = join(descriptor.workspacePath, ".skills-state", "versions", stagedConfigVersion);
    const versionPath = join(versionDir, "skills.yaml");
    await mkdir(versionDir, { recursive: true });
    await cp(stagingPath, versionPath);
    await mkdir(join(descriptor.workspacePath, "skills"), { recursive: true });
    await cp(versionPath, join(descriptor.workspacePath, "skills", "skills.yaml"));
    await this.writeActiveConfig(descriptor.workspacePath, stagedConfigVersion);
    await rm(join(descriptor.workspacePath, ".skills-state", "staging", changeId), { recursive: true, force: true });
    return { activeConfigVersion: stagedConfigVersion };
  }

  async rollbackSkillsConfig(
    agent: Pick<InitializeWorkspaceInput, "workspaceName" | "workspacePath">,
    changeId: string,
    previousConfigVersion: string | null
  ): Promise<{ activeConfigVersion: string | null }> {
    const descriptor = this.descriptorFromAgent(agent);
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    if (!previousConfigVersion) {
      await writeFile(join(descriptor.workspacePath, "skills", "skills.yaml"), "skills: []\n", "utf8");
      await this.writeActiveConfig(descriptor.workspacePath, null);
      return { activeConfigVersion: null };
    }

    const previousPath = join(descriptor.workspacePath, ".skills-state", "versions", previousConfigVersion, "skills.yaml");
    await cp(previousPath, join(descriptor.workspacePath, "skills", "skills.yaml"));
    await this.writeActiveConfig(descriptor.workspacePath, previousConfigVersion);
    await rm(join(descriptor.workspacePath, ".skills-state", "staging", changeId), { recursive: true, force: true });
    return { activeConfigVersion: previousConfigVersion };
  }

  getGitStatus(agent?: Pick<InitializeWorkspaceInput, "workspacePath">): "clean" | "dirty" | "unavailable" {
    if (!this.isGitRepository() || !agent) return "unavailable";
    try {
      const output = execFileSync("git", ["status", "--porcelain", "--", agent.workspacePath], {
        cwd: this.getRepoRoot(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      return output.trim() ? "dirty" : "clean";
    } catch {
      return "unavailable";
    }
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

  async readSoul(agent: Pick<InitializeWorkspaceInput, "name" | "workspaceName" | "workspacePath">): Promise<AgentSoulRead> {
    const descriptor = this.descriptorFromAgent(agent);
    try {
      await this.assertSoulPathSafe(descriptor);
      return {
        content: await readFile(this.soulPath(descriptor), "utf8"),
        status: "loaded"
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: this.buildDefaultSoul(agent),
          status: "missing"
        };
      }
      return {
        content: null,
        status: "error",
        message: this.formatReadError(error)
      };
    }
  }

  async readSoulForRun(agent: Pick<InitializeWorkspaceInput, "name" | "workspaceName" | "workspacePath">): Promise<string> {
    const soul = await this.readSoul(agent);
    if (soul.status === "error" || soul.content === null) {
      throw new Error(soul.message || "soul read failed");
    }
    return soul.content;
  }

  async writeSoul(agent: Pick<InitializeWorkspaceInput, "name" | "workspaceName" | "workspacePath">, content: string): Promise<void> {
    const descriptor = this.descriptorFromAgent(agent);
    await this.assertWorkspaceRootChainSafe();
    await mkdir(descriptor.workspacePath, { recursive: true });
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    await this.assertSoulPathSafe(descriptor, { allowMissingFile: true });
    await writeFile(this.soulPath(descriptor), content, "utf8");
  }

  async deleteSoul(agent: Pick<InitializeWorkspaceInput, "name" | "workspaceName" | "workspacePath">): Promise<void> {
    const descriptor = this.descriptorFromAgent(agent);
    await this.assertWorkspaceRootChainSafe();
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    const soulPath = this.soulPath(descriptor);
    this.assertInsideRoot(descriptor.rootPath, soulPath);
    const stat = await this.lstatIfExists(soulPath);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error("soul path must not be a symbolic link");
    }
    if (!stat.isFile()) {
      throw new Error("soul path exists and is not a file");
    }
    await rm(soulPath);
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

  private workflowSourcePath(descriptor: Pick<AgentWorkspaceDescriptor, "workspacePath">, workflowKey: string, extension: "ts" | "js") {
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
    const previousGeneratedFiles = previousAgent && previousDescriptor ? this.buildGeneratedFiles(previousAgent, previousDescriptor) : new Map();

    for (const [relativePath, content] of generatedFiles) {
      await this.writeGeneratedFile(join(descriptor.workspacePath, relativePath), content, options, previousGeneratedFiles.get(relativePath), relativePath);
    }
  }

  private buildGeneratedFiles(agent: InitializeWorkspaceInput, descriptor: AgentWorkspaceDescriptor): Map<string, string> {
    const files = new Map<string, string>();
    files.set("agent.yaml", this.buildAgentYaml(agent, descriptor));
    files.set(SOUL_FILE_NAME, agent.soul || this.buildDefaultSoul(agent));
    files.set("skills/skills.yaml", "skills: []\n");
    files.set("workflows/workflow.yaml", "workflows: []\n");
    files.set("secrets.example.env", this.buildSecretsExample(agent));
    files.set("README.md", this.buildReadme(agent, descriptor));
    return files;
  }

  private applySkillMutation(mutation: AgentSkillMutation): SkillConfigEntry[] {
    const existing = mutation.currentSkills.filter((skill) => skill.name !== mutation.skillName);
    if (mutation.operation === "remove") {
      return existing;
    }
    return [
      ...existing,
      {
        name: mutation.skillName,
        version: mutation.resolvedVersion ?? mutation.version ?? "",
        sourceType: mutation.sourceType,
        sourceId: mutation.sourceId,
        enabled: true,
        systemRequired: false,
        selfUpdateAllowed: false
      }
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  private serializeSkills(skills: SkillConfigEntry[]): string {
    if (skills.length === 0) {
      return "skills: []\n";
    }
    return [
      "skills:",
      ...skills.flatMap((skill) => [
        `  - name: ${this.quoteYaml(skill.name)}`,
        `    version: ${this.quoteYaml(skill.version)}`,
        `    sourceType: ${skill.sourceType}`,
        `    sourceId: ${this.quoteYaml(skill.sourceId)}`,
        `    enabled: ${skill.enabled}`,
        `    systemRequired: ${skill.systemRequired}`,
        `    selfUpdateAllowed: ${skill.selfUpdateAllowed}`
      ]),
      ""
    ].join("\n");
  }

  private parseManagedSkills(content: string): SkillConfigEntry[] {
    if (content.trim() === "skills: []") {
      return [];
    }
    const skills: SkillConfigEntry[] = [];
    let current: Partial<SkillConfigEntry> | null = null;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("- name:")) {
        if (current?.name && current.version && current.sourceId && current.sourceType) {
          skills.push(current as SkillConfigEntry);
        }
        current = {
          name: this.unquoteYaml(line.slice("- name:".length).trim()),
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false
        };
      } else if (current && line.includes(":")) {
        const [key, ...valueParts] = line.split(":");
        const value = this.unquoteYaml(valueParts.join(":").trim());
        if (key === "version") current.version = value;
        if (key === "sourceType" && (value === "registry" || value === "git")) current.sourceType = value;
        if (key === "sourceId") current.sourceId = value;
        if (key === "enabled") current.enabled = value === "true";
        if (key === "systemRequired") current.systemRequired = value === "true";
        if (key === "selfUpdateAllowed") current.selfUpdateAllowed = value === "true";
      }
    }
    if (current?.name && current.version && current.sourceId && current.sourceType) {
      skills.push(current as SkillConfigEntry);
    }
    return skills;
  }

  private buildConfigVersion(content: string): string {
    return `cfg_${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  }

  private async readActiveConfigVersion(workspacePath: string): Promise<string | null> {
    const activePath = join(workspacePath, ".skills-state", "active.json");
    if (!(await this.pathExists(activePath))) {
      return null;
    }
    const active = JSON.parse(await readFile(activePath, "utf8")) as {
      activeConfigVersion?: string | null;
    };
    return active.activeConfigVersion ?? null;
  }

  private async writeActiveConfig(workspacePath: string, activeConfigVersion: string | null): Promise<void> {
    const stateDir = join(workspacePath, ".skills-state");
    const nextPath = join(stateDir, "active.next.json");
    const activePath = join(stateDir, "active.json");
    await mkdir(stateDir, { recursive: true });
    await writeFile(nextPath, `${JSON.stringify({ activeConfigVersion }, null, 2)}\n`, "utf8");
    await rename(nextPath, activePath);
  }

  private buildAgentYaml(agent: InitializeWorkspaceInput, descriptor: AgentWorkspaceDescriptor): string {
    return [
      `id: ${agent.id}`,
      `name: ${this.quoteYaml(agent.name)}`,
      `slug: ${agent.slug}`,
      `workspacePath: ${descriptor.relativeWorkspacePath}`,
      "model:",
      `  providerId: ${(agent.modelProviderId ?? agent.modelProvider) ? this.quoteYaml(agent.modelProviderId ?? agent.modelProvider ?? "") : "null"}`,
      ""
    ].join("\n");
  }

  private async writeGeneratedFile(path: string, content: string, options: InitializeWorkspaceOptions, previousContent?: string, relativePath = path) {
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

    if (relativePath === SOUL_FILE_NAME) {
      const stat = await this.lstatIfExists(path);
      if (stat?.isSymbolicLink()) {
        throw new Error("soul path must not be a symbolic link");
      }
      await writeFile(path, content, "utf8");
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

  private buildSecretsExample(_agent: InitializeWorkspaceInput): string {
    return ["# Provider credentials are managed only by the backend Provider store.", ""].join("\n");
  }

  private buildReadme(agent: InitializeWorkspaceInput, descriptor: AgentWorkspaceDescriptor): string {
    return [
      `# ${agent.name}`,
      "",
      `Workspace: \`${descriptor.relativeWorkspacePath}/\``,
      "",
      "This directory stores Git-trackable Agent configuration only.",
      "Do not write API keys, tokens, private keys, cookies, passwords, or other real secrets here.",
      "Provider credentials are resolved by the backend and must never be copied into this workspace.",
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

  private buildDefaultSoul(agent: Pick<InitializeWorkspaceInput, "name">): string {
    return `# ${agent.name}\n`;
  }

  private soulPath(descriptor: AgentWorkspaceDescriptor): string {
    return join(descriptor.workspacePath, SOUL_FILE_NAME);
  }

  private async assertSoulPathSafe(descriptor: AgentWorkspaceDescriptor, options: { allowMissingFile?: boolean } = {}): Promise<void> {
    await this.assertWorkspaceRootChainSafe();
    await this.assertNoSymlinkEscape(descriptor.rootPath, descriptor.workspacePath);
    const soulPath = this.soulPath(descriptor);
    this.assertInsideRoot(descriptor.rootPath, soulPath);
    const stat = await this.lstatIfExists(soulPath);
    if (!stat) {
      if (options.allowMissingFile) {
        return;
      }
      const error = new Error(`${SOUL_FILE_NAME} not found`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error("soul path must not be a symbolic link");
    }
    if (!stat.isFile()) {
      throw new Error("soul path exists and is not a file");
    }
    await this.assertNoSymlinkEscape(descriptor.rootPath, soulPath);
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

  private unquoteYaml(value: string): string {
    if (value.startsWith('"')) {
      return JSON.parse(value) as string;
    }
    return value;
  }

  private formatReadError(error: unknown): string {
    return error instanceof Error ? error.message : "soul read failed";
  }
}
