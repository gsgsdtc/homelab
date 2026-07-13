import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { join, resolve } from "path";

interface AgentWorkspaceLike {
  id: string;
  workspacePath: string;
}

export interface SkillConfigEntry {
  skillName: string;
  sourceType: string;
  sourceId: string | null;
  requestedVersion: string;
  resolvedVersion: string;
  commitSha: string | null;
  enabled: boolean;
  systemRequired: boolean;
}

export interface WorkspaceApplyResult {
  previousConfigVersion: string | null;
  activeConfigVersion: string;
  stagedConfigVersion: string;
}

@Injectable()
export class AgentSkillWorkspaceStore {
  constructor(private readonly config: ConfigService) {}

  async applySkillsConfig(
    agent: AgentWorkspaceLike,
    nextConfig: SkillConfigEntry | SkillConfigEntry[],
    changeId: string
  ): Promise<WorkspaceApplyResult> {
    const workspacePath = this.workspacePath(agent);
    const statePath = join(workspacePath, ".skills-state");
    const versionsPath = join(statePath, "versions");
    const stagingPath = join(statePath, "staging", changeId);
    const skillsPath = join(workspacePath, "skills");
    await mkdir(stagingPath, { recursive: true });
    await mkdir(versionsPath, { recursive: true });
    await mkdir(skillsPath, { recursive: true });

    const previousConfigVersion = await this.readActiveVersion(statePath);
    const activeConfigVersion = `cfg-${Date.now()}-${changeId}`;
    const stagedConfigVersion = `stg-${changeId}`;
    const content = this.buildSkillsYaml(Array.isArray(nextConfig) ? nextConfig : [nextConfig]);
    const stagedFile = join(stagingPath, "skills.yaml");
    const versionDir = join(versionsPath, activeConfigVersion);
    await writeFile(stagedFile, content, "utf8");
    await mkdir(versionDir, { recursive: true });
    await copyFile(stagedFile, join(versionDir, "skills.yaml"));
    await rename(stagedFile, join(skillsPath, "skills.yaml"));
    await writeFile(
      join(statePath, "active.json"),
      `${JSON.stringify({ activeConfigVersion, changeId }, null, 2)}\n`,
      "utf8"
    );
    await rm(stagingPath, { recursive: true, force: true });
    return { previousConfigVersion, activeConfigVersion, stagedConfigVersion };
  }

  async restoreSkillsConfig(agent: AgentWorkspaceLike, configVersion: string | null): Promise<void> {
    if (!configVersion) {
      return;
    }
    const workspacePath = this.workspacePath(agent);
    const statePath = join(workspacePath, ".skills-state");
    const versionFile = join(statePath, "versions", configVersion, "skills.yaml");
    const skillsPath = join(workspacePath, "skills");
    await mkdir(skillsPath, { recursive: true });
    await copyFile(versionFile, join(skillsPath, "skills.yaml"));
    await writeFile(join(statePath, "active.json"), `${JSON.stringify({ activeConfigVersion: configVersion }, null, 2)}\n`, "utf8");
  }

  private workspacePath(agent: AgentWorkspaceLike): string {
    return resolve(String(this.config.get<string>("HOMELAB_REPO_ROOT") ?? process.cwd()), agent.workspacePath);
  }

  private async readActiveVersion(statePath: string): Promise<string | null> {
    try {
      await access(join(statePath, "active.json"));
      const parsed = JSON.parse(await readFile(join(statePath, "active.json"), "utf8")) as {
        activeConfigVersion?: string;
      };
      return parsed.activeConfigVersion ?? null;
    } catch {
      return null;
    }
  }

  private buildSkillsYaml(skills: SkillConfigEntry[]): string {
    const lines = ["skills:"];
    for (const skill of skills) {
      lines.push(`  - name: ${JSON.stringify(skill.skillName)}`);
      lines.push(`    version: ${JSON.stringify(skill.resolvedVersion)}`);
      lines.push(`    sourceType: ${skill.sourceType}`);
      if (skill.sourceId) {
        lines.push(`    sourceId: ${JSON.stringify(skill.sourceId)}`);
      }
      if (skill.commitSha) {
        lines.push(`    commitSha: ${JSON.stringify(skill.commitSha)}`);
      }
      lines.push(`    enabled: ${skill.enabled ? "true" : "false"}`);
      lines.push(`    systemRequired: ${skill.systemRequired ? "true" : "false"}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
