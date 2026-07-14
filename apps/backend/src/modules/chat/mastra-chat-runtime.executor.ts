import { Injectable } from "@nestjs/common";
import ts from "typescript";
import { executionError } from "./chat.errors";
import { ChatTranscriptEntry } from "./chat.types";

interface MastraRun {
  start(input: { inputData: Record<string, unknown> }): Promise<Record<string, unknown>>;
  cancel?(): Promise<void>;
}

export interface MastraWorkflowExecutable {
  id?: string;
  committed?: boolean;
  steps?: Record<string, MastraWorkflowStep>;
  createRun(options: { runId: string }): Promise<MastraRun>;
}

interface MastraWorkflowStep {
  component?: string;
  [key: string]: unknown;
}

export interface MastraRuntimeChatInput {
  executionId: string;
  workflowSource: string;
  soul: string;
  skills: Record<string, unknown>;
  transcript: ChatTranscriptEntry[];
  message: string;
  signal: AbortSignal;
}

@Injectable()
export class MastraChatRuntimeExecutor {
  async execute(
    executable: MastraWorkflowExecutable,
    input: MastraRuntimeChatInput,
    invokeModel: () => Promise<{ text: string }>
  ): Promise<{ text: string }> {
    this.assertModelOnlySource(input.workflowSource);
    this.assertModelOnlySteps(executable.steps ?? {});
    if (executable.committed !== true || typeof executable.createRun !== "function") {
      throw this.failure(503, "RUNTIME_UNAVAILABLE", "Chat runtime is unavailable", true);
    }
    const run = await executable.createRun({ runId: input.executionId });
    const onAbort = () => void run.cancel?.();
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await run.start({
        inputData: {
          executionId: input.executionId,
          soul: input.soul,
          skills: input.skills,
          transcript: input.transcript.map((entry) => ({ ...entry })),
          message: input.message,
          tools: Object.freeze({}),
          model: Object.freeze({ generate: invokeModel })
        }
      });
      if (result.status !== "success") {
        throw this.failure(500, "INTERNAL_ERROR", "Chat execution failed", true);
      }
      const output = result.result;
      if (!output || typeof output !== "object" || typeof (output as Record<string, unknown>).text !== "string") {
        throw this.failure(502, "MODEL_INVALID_OUTPUT", "Model returned invalid output", false);
      }
      return { text: (output as { text: string }).text };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  }

  private assertModelOnlySteps(value: unknown, seen = new Set<object>()): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value) && "component" in value) {
      const component = (value as MastraWorkflowStep).component;
      if (typeof component === "string" && component.toLowerCase().includes("tool")) {
        throw this.failure(422, "TOOL_NOT_ALLOWED", "Tools are not allowed in P0 chat", false);
      }
    }
    for (const child of Object.values(value)) this.assertModelOnlySteps(child, seen);
  }

  private assertModelOnlySource(source: string): void {
    const sourceFile = ts.createSourceFile("default-chat-workflow.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    let prohibited = false;
    const inspectModule = (moduleName: string) => {
      if (moduleName !== "@mastra/core/workflows" && moduleName !== "zod") prohibited = true;
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        inspectModule(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword)
      ) {
        const [moduleSpecifier] = node.arguments;
        if (moduleSpecifier && (ts.isStringLiteral(moduleSpecifier) || ts.isNoSubstitutionTemplateLiteral(moduleSpecifier))) {
          inspectModule(moduleSpecifier.text);
        } else {
          prohibited = true;
        }
      }
      if (
        ts.isIdentifier(node) &&
        node.text === "require" &&
        !(
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node
        )
      ) {
        prohibited = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (prohibited) throw this.failure(422, "TOOL_NOT_ALLOWED", "Tools are not allowed in P0 chat", false);
  }

  private failure(httpStatus: number, code: string, message: string, retryable: boolean) {
    return executionError({ httpStatus, code, message, retryable });
  }
}
