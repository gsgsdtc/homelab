import { Injectable } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "fs/promises";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import ts from "typescript";
import { ReloadWorkflowResult } from "./agent-workflow-reloader";

export interface MastraWorkflowRuntimeReloadRequest {
  agentId: string;
  workflowKey: string;
  sourceHash: string;
  relativePath: string;
  sourcePath: string;
  extension: "ts" | "js";
}

export interface MastraWorkflowRuntimeRegistry {
  reloadWorkflow(request: MastraWorkflowRuntimeReloadRequest): Promise<ReloadWorkflowResult>;
}

export const MASTRA_WORKFLOW_RUNTIME_REGISTRY = Symbol("MASTRA_WORKFLOW_RUNTIME_REGISTRY");

@Injectable()
export class DynamicImportMastraWorkflowRuntimeRegistry implements MastraWorkflowRuntimeRegistry {
  private readonly workflows = new Map<string, unknown>();
  private readonly requireModule = createRequire(__filename);

  async reloadWorkflow(request: MastraWorkflowRuntimeReloadRequest): Promise<ReloadWorkflowResult> {
    try {
      const importPath = await this.transpileWorkflowToCommonJs(request);
      delete this.requireModule.cache[this.requireModule.resolve(importPath)];
      const workflowModule = this.requireModule(importPath) as Record<string, unknown>;
      if (!workflowModule.default) {
        return {
          status: "failed",
          error: "Mastra workflow module must default export a workflow"
        };
      }
      this.workflows.set(this.key(request.agentId, request.workflowKey), workflowModule.default);
      return {
        status: "succeeded",
        loadedAt: new Date()
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error || "Mastra workflow runtime reload failed")
      };
    }
  }

  getWorkflow(agentId: string, workflowKey: string): unknown {
    return this.workflows.get(this.key(agentId, workflowKey));
  }

  private key(agentId: string, workflowKey: string): string {
    return `${agentId}:${workflowKey}`;
  }

  private async transpileWorkflowToCommonJs(request: MastraWorkflowRuntimeReloadRequest): Promise<string> {
    const source = await readFile(request.sourcePath, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2022
      },
      fileName: request.sourcePath,
      reportDiagnostics: true
    });
    const errors = output.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length > 0) {
      throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, "\n"));
    }
    const cachePath = this.compiledWorkflowPath(request);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, output.outputText, "utf8");
    return cachePath;
  }

  private compiledWorkflowPath(request: MastraWorkflowRuntimeReloadRequest): string {
    const safeAgentId = this.safeCacheSegment(request.agentId);
    const safeWorkflowKey = this.safeCacheSegment(request.workflowKey);
    const safeHash = this.safeCacheSegment(request.sourceHash);
    return resolve(dirname(request.sourcePath), "..", "..", ".compiled-workflows", `${safeAgentId}-${safeWorkflowKey}-${safeHash}.cjs`);
  }

  private safeCacheSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  }
}
