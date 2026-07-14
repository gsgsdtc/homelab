import { AgentWorkflowRuntimeClient } from "../src/modules/agents/agent-workflow-runtime.client";

describe("AgentWorkflowRuntimeClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("maps runtime success responses to succeeded reload results", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: "succeeded", loadedAt: "2026-07-13T12:00:00.000Z" })
    } as any);
    const client = new AgentWorkflowRuntimeClient(config("https://runtime.local"));

    const result = await client.reloadWorkflow(request());

    expect(global.fetch).toHaveBeenCalledWith(
      "https://runtime.local/runtime/agents/agent-1/workflows/support-triage/reload",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sourceHash: "hash-v2",
          relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
          extension: "ts"
        })
      })
    );
    expect(result).toEqual({ status: "succeeded", loadedAt: new Date("2026-07-13T12:00:00.000Z") });
  });

  it("returns failed when runtime is unavailable or not configured", async () => {
    const unconfigured = new AgentWorkflowRuntimeClient(config(undefined));
    await expect(unconfigured.reloadWorkflow(request())).resolves.toEqual({
      status: "failed",
      error: "workflow runtime URL is not configured"
    });

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 } as any);
    const unavailable = new AgentWorkflowRuntimeClient(config("https://runtime.local"));
    await expect(unavailable.reloadWorkflow(request())).resolves.toEqual({
      status: "failed",
      error: "workflow runtime returned HTTP 503"
    });
  });
});

function config(runtimeUrl?: string) {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === "HOMELAB_WORKFLOW_RUNTIME_URL") {
        return runtimeUrl;
      }
      if (key === "HOMELAB_WORKFLOW_RELOAD_TIMEOUT_MS") {
        return 30_000;
      }
      return defaultValue;
    })
  } as any;
}

function request() {
  return {
    agentId: "agent-1",
    workflowKey: "support-triage",
    sourceHash: "hash-v2",
    relativePath: ".homelab/agents/ops-agent--agent123/src/mastra/workflows/support-triage.ts",
    extension: "ts" as const
  };
}
