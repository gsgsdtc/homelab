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
    const sourcePath = join(repoRoot, ".homelab", "agents", "ops-agent--agent123", "src", "mastra", "workflows", "support-triage.ts");
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
      sourceHash: "hash-v2",
      relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
      sourcePath,
      extension: "ts"
    });

    expect(result).toEqual({ status: "succeeded", loadedAt: expect.any(Date) });
    expect(registry.getWorkflow("agent-1", "support-triage")).toEqual({ id: "support-triage", committed: true });
  });
});
