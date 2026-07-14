import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import ts from "typescript";

export interface ValidateWorkflowSourceInput {
  workflowKey: string;
  extension: "ts" | "js";
  source: string;
}

const WORKFLOW_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ALLOWED_BARE_IMPORTS = new Set(["zod"]);
const ALLOWED_NODE_IMPORTS = new Set(["node:crypto", "crypto"]);
const BLOCKED_IMPORTS = new Set(["child_process", "node:child_process", "fs", "node:fs", "net", "node:net", "http", "https", "node:http", "node:https"]);
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /xox[baprs]-[A-Za-z0-9-]{8,}/,
  /gh[pousr]_[A-Za-z0-9_]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
];

@Injectable()
export class AgentWorkflowValidator {
  constructor(private readonly config: ConfigService) {}

  validateSource(input: ValidateWorkflowSourceInput): void {
    if (!WORKFLOW_KEY_PATTERN.test(input.workflowKey)) {
      throw new BadRequestException("workflowKey must contain only lowercase letters, numbers, and dashes");
    }
    if (input.extension !== "ts" && input.extension !== "js") {
      throw new BadRequestException("workflow extension must be ts or js");
    }
    const maxBytes = this.config.get<number>("HOMELAB_WORKFLOW_MAX_SOURCE_BYTES", 256 * 1024);
    if (Buffer.byteLength(input.source, "utf8") > maxBytes) {
      throw new BadRequestException(`workflow source exceeds ${maxBytes} bytes`);
    }
    if (input.source.includes("\u0000")) {
      throw new BadRequestException("workflow source must be valid text");
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(input.source))) {
      throw new BadRequestException("workflow source must not contain real secret values; use secretRef");
    }
    this.validateImports(input.source);
    this.validateEnvironmentAccess(input.source);
    this.validateMastraShape(input);
    this.validateSyntax(input);
  }

  private validateImports(source: string): void {
    const moduleNames = this.collectImportSpecifiers(source);
    const allowedToolImports = new Set(this.configList("HOMELAB_WORKFLOW_ALLOWED_TOOL_IMPORTS"));
    for (const moduleName of moduleNames) {
      if (moduleName.startsWith(".")) {
        if (moduleName.includes("..")) {
          throw new BadRequestException("workflow source cannot import files outside the controlled workspace source directory");
        }
        continue;
      }
      if (moduleName.startsWith("@mastra/") || moduleName.startsWith("@homelab/agent-tools/")) {
        if (moduleName.startsWith("@homelab/agent-tools/") && !allowedToolImports.has(moduleName)) {
          throw new BadRequestException(`workflow tool import is not authorized: ${moduleName}`);
        }
        continue;
      }
      if (ALLOWED_BARE_IMPORTS.has(moduleName) || ALLOWED_NODE_IMPORTS.has(moduleName)) {
        continue;
      }
      if (BLOCKED_IMPORTS.has(moduleName)) {
        throw new BadRequestException(`workflow import is not allowed: ${moduleName}`);
      }
      throw new BadRequestException(`workflow import is not allowlisted: ${moduleName}`);
    }
  }

  private collectImportSpecifiers(source: string): string[] {
    const sourceFile = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const moduleNames = new Set<string>();
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        moduleNames.add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [moduleSpecifier] = node.arguments;
        if (moduleSpecifier && (ts.isStringLiteral(moduleSpecifier) || ts.isNoSubstitutionTemplateLiteral(moduleSpecifier))) {
          moduleNames.add(moduleSpecifier.text);
        } else {
          throw new BadRequestException("dynamic import must use a literal allowlisted module");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...moduleNames];
  }

  private validateEnvironmentAccess(source: string): void {
    const allowedEnvNames = new Set(this.configList("HOMELAB_WORKFLOW_ALLOWED_ENV"));
    const sourceFile = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && this.isProcessEnvDotAccess(node.expression)) {
        this.assertAllowedEnvName(node.name.text, allowedEnvNames);
        return;
      }
      if (ts.isElementAccessExpression(node) && this.isProcessEnvDotAccess(node.expression)) {
        const envName = this.literalText(node.argumentExpression);
        if (!envName) {
          throw new BadRequestException("workflow env access must use a literal env name");
        }
        this.assertAllowedEnvName(envName, allowedEnvNames);
        return;
      }
      if (this.isProcessEnvDotAccess(node) || this.isProcessEnvElementAccess(node)) {
        throw new BadRequestException("workflow env access must directly read an allowlisted env name");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private isProcessEnvDotAccess(node: ts.Node): node is ts.PropertyAccessExpression {
    return (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    );
  }

  private isProcessEnvElementAccess(node: ts.Node): node is ts.ElementAccessExpression {
    return (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      this.literalText(node.argumentExpression) === "env"
    );
  }

  private literalText(node: ts.Expression | undefined): string | null {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      return node.text;
    }
    return null;
  }

  private assertAllowedEnvName(envName: string, allowedEnvNames: Set<string>): void {
    if (!allowedEnvNames.has(envName)) {
      throw new BadRequestException(`workflow env variable is not allowlisted: ${envName}`);
    }
  }

  private configList(key: string): string[] {
    const value = this.config.get<string | string[]>(key, []);
    if (Array.isArray(value)) {
      return value.map((item) => item.trim()).filter(Boolean);
    }
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private validateMastraShape(input: ValidateWorkflowSourceInput): void {
    const workflowDeclaration = input.source.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createWorkflow\s*\(/);
    if (!workflowDeclaration) {
      throw new BadRequestException("workflow source must call createWorkflow()");
    }
    if (!/\.commit\s*\(/.test(input.source)) {
      throw new BadRequestException("workflow source must commit the Mastra workflow");
    }
    const workflowVariable = workflowDeclaration[1];
    const defaultExport = input.source.match(/export\s+default\s+([A-Za-z_$][\w$]*)\b/);
    if (!defaultExport || defaultExport[1] !== workflowVariable) {
      throw new BadRequestException("workflow source must default export a Mastra workflow");
    }
    const idMatch = input.source.match(/id\s*:\s*["']([^"']+)["']/);
    if (idMatch && idMatch[1] !== input.workflowKey) {
      throw new BadRequestException("workflow id must match workflowKey");
    }
  }

  private validateSyntax(input: ValidateWorkflowSourceInput): void {
    const result = ts.transpileModule(input.source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        allowJs: input.extension === "js"
      },
      reportDiagnostics: true
    });
    if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
      throw new BadRequestException("workflow source contains invalid TypeScript");
    }
  }
}
