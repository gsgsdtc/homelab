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

  it("loads an immutable DB workflow source by active hash when the runtime cache is cold", async () => {
    const registry = new DynamicImportMastraWorkflowRuntimeRegistry();

    const executable = await registry.loadWorkflowVersion({
      agentId: "agent-1",
      workflowKey: "default",
      sourceHash: "hash-db-v1",
      source: 'export default { id: "default", committed: true };\n',
      extension: "ts"
    });

    expect(executable).toEqual({ id: "default", committed: true });
    expect(registry.getWorkflow("agent-1", "default", "hash-db-v1")).toBe(executable);
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
