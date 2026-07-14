import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { relative, resolve, sep } from "path";
import { AgentWorkflowReloader, ReloadWorkflowRequest, ReloadWorkflowResult } from "./agent-workflow-reloader";

@Injectable()
export class LocalMastraWorkflowReloadHook implements AgentWorkflowReloader {
  constructor(private readonly config: ConfigService) {}

  async reloadWorkflow(request: ReloadWorkflowRequest): Promise<ReloadWorkflowResult> {
    try {
      const sourcePath = this.resolveWorkflowPath(request.relativePath);
      if (!sourcePath.endsWith(`.${request.extension}`)) {
        return {
          status: "failed",
          error: "workflow reload path extension does not match request"
        };
      }
      const source = await readFile(sourcePath, "utf8");
      if (this.hash(source) !== request.sourceHash) {
        return {
          status: "failed",
          error: "workflow reload source hash does not match requested hash"
        };
      }
      return {
        status: "succeeded",
        loadedAt: new Date()
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "in-process Mastra workflow reload failed"
      };
    }
  }

  private resolveWorkflowPath(relativePath: string): string {
    if (relativePath.startsWith("/") || relativePath.includes(`..${sep}`) || relativePath === "..") {
      throw new Error("workflow reload path must stay inside repository");
    }
    const repoRoot = resolve(String(this.config.get<string>("HOMELAB_REPO_ROOT") ?? process.cwd()));
    const sourcePath = resolve(repoRoot, relativePath);
    const rel = relative(repoRoot, sourcePath);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new Error("workflow reload path must stay inside repository");
    }
    if (!rel.split(sep).includes("workflows")) {
      throw new Error("workflow reload path must target a workflows directory");
    }
    return sourcePath;
  }

  private hash(source: string): string {
    return createHash("sha256").update(source, "utf8").digest("hex");
  }
}
