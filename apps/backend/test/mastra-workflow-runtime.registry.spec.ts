import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DynamicImportMastraWorkflowRuntimeRegistry } from "../src/modules/agents/mastra-workflow-runtime.registry";

describe("DynamicImportMastraWorkflowRuntimeRegistry", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "homelab-mastra-registry-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("transpiles and loads a TypeScript workflow source without a runtime TS loader", async () => {
    const sourcePath = workflowPath("support-triage.ts");
    const source = [
      "type Workflow = { id: string; committed: boolean };",
      'const workflow: Workflow = { id: "support-triage", committed: true };',
      "export default workflow;",
      ""
    ].join("\n");
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await writeFile(sourcePath, source, "utf8");
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();

    const result = await registry.reloadWorkflow({
      agentId: "agent-1",
      workflowKey: "support-triage",
      sourceHash: "hash-basic-v2",
      relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
      sourcePath,
      extension: "ts"
    });

    expect(result).toEqual({ status: "succeeded", loadedAt: expect.any(Date) });
    expect(registry.getWorkflow("agent-1", "support-triage")).toEqual({ id: "support-triage", committed: true });
  });

  it("loads a TypeScript workflow with an allowed same-directory helper import", async () => {
    const sourcePath = workflowPath("support-triage.ts");
    await writeWorkflow(
      "helper.ts",
      [
        "export function buildWorkflow() {",
        '  return { id: "support-triage", helperLoaded: true };',
        "}",
        ""
      ].join("\n")
    );
    await writeWorkflow(
      "support-triage.ts",
      [
        'import { buildWorkflow } from "./helper";',
        "const workflow = buildWorkflow();",
        "export default workflow;",
        ""
      ].join("\n")
    );
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();

    const result = await registry.reloadWorkflow({
      agentId: "agent-1",
      workflowKey: "support-triage",
      sourceHash: "hash-helper",
      relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
      sourcePath,
      extension: "ts"
    });

    expect(result).toEqual({ status: "succeeded", loadedAt: expect.any(Date) });
    expect(registry.getWorkflow("agent-1", "support-triage")).toEqual({ id: "support-triage", helperLoaded: true });
  });

  it("loads a committed Mastra workflow from @mastra/core/workflows", async () => {
    const sourcePath = workflowPath("support-triage.ts");
    await writeWorkflow(
      "support-triage.ts",
      [
        'import { createWorkflow } from "@mastra/core/workflows";',
        'const workflow = createWorkflow({ id: "support-triage" });',
        "workflow.commit();",
        "export default workflow;",
        ""
      ].join("\n")
    );
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();

    const result = await registry.reloadWorkflow({
      agentId: "agent-1",
      workflowKey: "support-triage",
      sourceHash: "hash-mastra",
      relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
      sourcePath,
      extension: "ts"
    });

    expect(result).toEqual({ status: "succeeded", loadedAt: expect.any(Date) });
    expect(registry.getWorkflow("agent-1", "support-triage")).toBeDefined();
  });

  it("retains immutable executables by source hash after a newer reload", async () => {
    await writeWorkflow("support-triage.ts", 'export default { id: "v1" };\n');
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();
    await registry.reloadWorkflow({
      agentId: "agent-1",
      workflowKey: "support-triage",
      sourceHash: "hash-v1",
      relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
      sourcePath: workflowPath("support-triage.ts"),
      extension: "ts"
    });
    await writeWorkflow("support-triage.ts", 'export default { id: "v2" };\n');
    await registry.reloadWorkflow({
      agentId: "agent-1",
      workflowKey: "support-triage",
      sourceHash: "hash-retained-v2",
      relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
      sourcePath: workflowPath("support-triage.ts"),
      extension: "ts"
    });

    expect(registry.getWorkflow("agent-1", "support-triage", "hash-v1")).toEqual({ id: "v1" });
    expect(registry.getWorkflow("agent-1", "support-triage", "hash-retained-v2")).toEqual({ id: "v2" });
    expect(registry.getWorkflow("agent-1", "support-triage")).toEqual({ id: "v2" });
  });

  /**
   * @doc GFU-27 F1 R13
   * @purpose Verify immutable activeHash loads return an explicit executable envelope.
   * @context A direct executable return can be assimilated as a thenable and hang snapshot capture.
   */
  it("loads an immutable DB workflow source by active hash when the runtime cache is cold", async () => {
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();

    const loaded = await registry.loadWorkflowVersion({
      agentId: "agent-1",
      workflowKey: "default",
      sourceHash: "hash-db-v1",
      source: 'export default { id: "default", committed: true };\n',
      extension: "ts"
    });

    const executable = loaded.executable;
    expect(executable).toEqual({ id: "default", committed: true });
    expect(registry.getWorkflow("agent-1", "default", "hash-db-v1")).toBe(executable);
  });

  /**
   * @doc GFU-27 F1 R13 / second-round PR #36 blocker 1
   * @purpose Verify the real Mastra builder `.then` never participates in Promise resolution during cold load.
   * @context A regression makes every cold-cache chat request remain pending after process restart.
   */
  it("returns a real committed Mastra workflow in a non-thenable envelope on a cold load", async () => {
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();
    const source = [
      'import { createWorkflow } from "@mastra/core/workflows";',
      'const workflow = createWorkflow({ id: "default" });',
      "workflow.commit();",
      "export default workflow;",
      ""
    ].join("\n");

    const result = await Promise.race([
      registry
        .loadWorkflowVersion({
          agentId: "agent-real-mastra",
          workflowKey: "default",
          sourceHash: "hash-real-mastra-cold",
          source,
          extension: "ts"
        })
        .then((loaded) => ({ status: "loaded" as const, loaded })),
      new Promise<{ status: "still-pending" }>((resolve) =>
        setTimeout(() => resolve({ status: "still-pending" }), 100)
      )
    ]);

    expect(result.status).toBe("loaded");
    expect((result as any).loaded).toEqual({ executable: expect.objectContaining({ committed: true }) });
    expect(typeof (result as any).loaded.executable.then).toBe("function");
  });

  /**
   * @doc GFU-27 F3 R4a / second-round PR #36 blocker 2
   * @purpose Verify top-level and aliased handlers are rejected before the default chat module executes.
   * @context A regression permits module-load side effects before the runtime model-only guard runs.
   */
  it.each([
    ["top-level side effect", 'globalThis.__chatWorkflowSideEffects += 1;'],
    [
      "aliased handler invocation",
      'const ordinaryHandler = () => { globalThis.__chatWorkflowSideEffects += 1; };\nordinaryHandler();'
    ],
    [
      "tagged template handler invocation",
      'const ordinaryTag = () => { globalThis.__chatWorkflowSideEffects += 1; return ""; };\nordinaryTag`payload`;'
    ]
  ])("rejects a %s before loading the default chat module", async (_name, sideEffectSource) => {
    (globalThis as any).__chatWorkflowSideEffects = 0;
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();
    const source = [
      'import { createWorkflow } from "@mastra/core/workflows";',
      sideEffectSource,
      'const workflow = createWorkflow({ id: "default" });',
      "workflow.commit();",
      "export default workflow;",
      ""
    ].join("\n");

    const result = await Promise.race([
      registry
        .loadWorkflowVersion({
          agentId: `agent-side-effect-${_name}`,
          workflowKey: "default",
          sourceHash: `hash-side-effect-${_name}`,
          source,
          extension: "ts"
        })
        .then(
          () => ({ status: "loaded" as const }),
          () => ({ status: "rejected" as const })
        ),
      new Promise<{ status: "still-pending" }>((resolve) =>
        setTimeout(() => resolve({ status: "still-pending" }), 100)
      )
    ]);

    expect(result.status).toBe("rejected");
    expect((globalThis as any).__chatWorkflowSideEffects).toBe(0);
    delete (globalThis as any).__chatWorkflowSideEffects;
  });

  function workflowPath(fileName: string): string {
    return join(repoRoot, ".homelab", "agents", "ops-agent--agent123", "src", "mastra", "workflows", fileName);
  }

  async function writeWorkflow(fileName: string, source: string): Promise<void> {
    const filePath = workflowPath(fileName);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, source, "utf8");
  }
});
