import { Injectable } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "fs/promises";
import Module, { createRequire } from "module";
import { dirname, extname, join, relative, resolve, sep } from "path";
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
type ModuleWithLoad = typeof Module & {
  _load(request: string, parent: NodeJS.Module | null, isMain: boolean): unknown;
};

@Injectable()
export class DynamicImportMastraWorkflowRuntimeRegistry implements MastraWorkflowRuntimeRegistry {
  private readonly workflows = new Map<string, unknown>();
  private readonly requireModule = createRequire(__filename);

  async reloadWorkflow(request: MastraWorkflowRuntimeReloadRequest): Promise<ReloadWorkflowResult> {
    try {
      const importPath = await this.transpileWorkflowToCommonJs(request);
      delete this.requireModule.cache[this.requireModule.resolve(importPath)];
      const workflowModule = (Module as ModuleWithLoad)._load(importPath, module, false) as Record<string, unknown>;
      const workflow = this.defaultExportFromModule(workflowModule);
      if (!workflow) {
        return {
          status: "failed",
          error: "Mastra workflow module must default export a workflow"
        };
      }
      this.workflows.set(this.key(request.agentId, request.workflowKey), workflow);
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

  private defaultExportFromModule(workflowModule: Record<string, unknown>): unknown {
    const defaultExport = workflowModule.default;
    if (
      defaultExport &&
      typeof defaultExport === "object" &&
      "__esModule" in defaultExport &&
      "default" in defaultExport
    ) {
      return (defaultExport as Record<string, unknown>).default;
    }
    return defaultExport;
  }

  private async transpileWorkflowToCommonJs(request: MastraWorkflowRuntimeReloadRequest): Promise<string> {
    const entryDir = dirname(request.sourcePath);
    const cacheRoot = this.compiledWorkflowRoot(request);
    const compiledPaths = new Map<string, string>();
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(join(cacheRoot, "package.json"), '{"type":"commonjs"}\n', "utf8");
    return this.transpileSourceFile(request.sourcePath, entryDir, cacheRoot, compiledPaths);
  }

  private async transpileSourceFile(sourcePath: string, entryDir: string, cacheRoot: string, compiledPaths: Map<string, string>): Promise<string> {
    if (compiledPaths.has(sourcePath)) {
      return compiledPaths.get(sourcePath)!;
    }
    if (!this.isPathInside(sourcePath, entryDir)) {
      throw new Error("workflow local import escapes the controlled workflow source directory");
    }
    const source = await readFile(sourcePath, "utf8");
    const cachePath = this.compiledSourcePath(sourcePath, entryDir, cacheRoot);
    compiledPaths.set(sourcePath, cachePath);
    const localRequireSpecifiers = new Map<string, string>();
    const localImports = this.collectLocalImportSpecifiers(source);
    for (const moduleName of localImports) {
      const dependencySourcePath = await this.resolveLocalImport(sourcePath, moduleName);
      const dependencyCachePath = await this.transpileSourceFile(dependencySourcePath, entryDir, cacheRoot, compiledPaths);
      localRequireSpecifiers.set(moduleName, this.relativeRequireSpecifier(cachePath, dependencyCachePath));
    }
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2022
      },
      fileName: sourcePath,
      reportDiagnostics: true
    });
    const errors = output.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length > 0) {
      throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, "\n"));
    }
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, this.rewriteRequireSpecifiers(output.outputText, localRequireSpecifiers), "utf8");
    return cachePath;
  }

  private compiledWorkflowRoot(request: MastraWorkflowRuntimeReloadRequest): string {
    const safeAgentId = this.safeCacheSegment(request.agentId);
    const safeWorkflowKey = this.safeCacheSegment(request.workflowKey);
    const safeHash = this.safeCacheSegment(request.sourceHash);
    return resolve(process.cwd(), ".compiled-workflows", `${safeAgentId}-${safeWorkflowKey}-${safeHash}`);
  }

  private compiledSourcePath(sourcePath: string, entryDir: string, cacheRoot: string): string {
    const relativeSourcePath = relative(entryDir, sourcePath);
    const extension = extname(relativeSourcePath);
    const relativeOutputPath = extension ? relativeSourcePath.slice(0, -extension.length) : relativeSourcePath;
    return join(cacheRoot, `${relativeOutputPath}.cjs`);
  }

  private safeCacheSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  }

  private collectLocalImportSpecifiers(source: string): string[] {
    const sourceFile = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const moduleNames = new Set<string>();
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        moduleNames.add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [moduleSpecifier] = node.arguments;
        if (moduleSpecifier && this.isLocalLiteralModuleSpecifier(moduleSpecifier)) {
          moduleNames.add(moduleSpecifier.text);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const [moduleSpecifier] = node.arguments;
        if (moduleSpecifier && this.isLocalLiteralModuleSpecifier(moduleSpecifier)) {
          moduleNames.add(moduleSpecifier.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...moduleNames];
  }

  private isLocalLiteralModuleSpecifier(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
    return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.startsWith(".");
  }

  private async resolveLocalImport(fromPath: string, moduleName: string): Promise<string> {
    const basePath = resolve(dirname(fromPath), moduleName);
    const candidates = extname(basePath)
      ? [basePath]
      : [`${basePath}.ts`, `${basePath}.js`, join(basePath, "index.ts"), join(basePath, "index.js")];
    for (const candidate of candidates) {
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    throw new Error(`Cannot resolve workflow local import: ${moduleName}`);
  }

  private rewriteRequireSpecifiers(outputText: string, localRequireSpecifiers: Map<string, string>): string {
    return outputText.replace(/require\((["'])([^"']+)\1\)/g, (_match, quote: string, moduleName: string) => {
      if (moduleName.startsWith(".")) {
        return `require(${quote}${localRequireSpecifiers.get(moduleName) ?? this.rewriteRelativeRequireSpecifier(moduleName)}${quote})`;
      }
      return `require(${quote}${moduleName}${quote})`;
    });
  }

  private rewriteRelativeRequireSpecifier(moduleName: string): string {
    const extension = extname(moduleName);
    if (extension === ".ts" || extension === ".tsx") {
      return `${moduleName.slice(0, -extension.length)}.cjs`;
    }
    return moduleName;
  }

  private relativeRequireSpecifier(fromCompiledPath: string, toCompiledPath: string): string {
    const relativePath = relative(dirname(fromCompiledPath), toCompiledPath).split(sep).join("/");
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  }

  private isPathInside(filePath: string, rootPath: string): boolean {
    const relativePath = relative(rootPath, filePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && relativePath !== "..");
  }
}
