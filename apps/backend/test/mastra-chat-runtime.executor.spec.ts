import { MastraChatRuntimeExecutor } from "../src/modules/chat/mastra-chat-runtime.executor";

describe("MastraChatRuntimeExecutor", () => {
  const input = {
    executionId: "exec-1",
    workflowSource: 'import { createWorkflow } from "@mastra/core/workflows";\nexport default createWorkflow({ id: "default" }).commit();',
    soul: "System prompt",
    skills: { skill: { version: "1" } },
    transcript: [],
    message: "hello",
    signal: new AbortController().signal
  };

  it("executes the frozen Mastra run and exposes only an empty tool registry", async () => {
    const invokeModel = jest.fn().mockResolvedValue({ text: "complete reply" });
    const start = jest.fn(async ({ inputData }: any) => ({
      status: "success",
      result: await inputData.model.generate(),
      input: inputData,
      steps: {}
    }));
    const createRun = jest.fn().mockResolvedValue({ start, cancel: jest.fn() });
    const executable = { id: "default", committed: true, steps: {}, createRun };
    const executor = new MastraChatRuntimeExecutor();

    await expect(executor.execute(executable, input, invokeModel)).resolves.toEqual({ text: "complete reply" });
    expect(createRun).toHaveBeenCalledWith({ runId: "exec-1" });
    const runtimeInput = start.mock.calls[0]![0].inputData;
    expect(runtimeInput.tools).toEqual({});
    expect(Object.isFrozen(runtimeInput.tools)).toBe(true);
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("rejects structured tool steps before creating a run or invoking a handler", async () => {
    const handler = jest.fn();
    const createRun = jest.fn();
    const executable = {
      id: "default",
      committed: true,
      steps: { aliased: { id: "aliased", component: "tool", execute: handler } },
      createRun
    };
    const executor = new MastraChatRuntimeExecutor();

    await expect(executor.execute(executable, input, jest.fn())).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ httpStatus: 422, code: "TOOL_NOT_ALLOWED", retryable: false })
    });
    expect(createRun).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("finds an aliased tool handler nested inside a branch graph before execution", async () => {
    const handler = jest.fn();
    const createRun = jest.fn();
    const executable = {
      id: "default",
      committed: true,
      steps: {
        branch: {
          branches: [[{ id: "ordinary-name", component: "TOOL", execute: handler }]]
        }
      },
      createRun
    };
    const executor = new MastraChatRuntimeExecutor();

    await expect(executor.execute(executable, input, jest.fn())).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ code: "TOOL_NOT_ALLOWED" })
    });
    expect(createRun).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects indirect or aliased tool imports through AST preflight", async () => {
    const createRun = jest.fn();
    const executable = { id: "default", committed: true, steps: {}, createRun };
    const executor = new MastraChatRuntimeExecutor();

    await expect(
      executor.execute(
        executable,
        {
          ...input,
          workflowSource:
            'import { deploy as ordinaryHandler } from "@homelab/agent-tools/deploy";\nconst execute = ordinaryHandler;'
        },
        jest.fn()
      )
    ).rejects.toMatchObject({ chatFailure: expect.objectContaining({ code: "TOOL_NOT_ALLOWED" }) });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("allows only model-workflow imports and rejects aliased Mastra tool modules", async () => {
    const createRun = jest.fn();
    const executable = { id: "default", committed: true, steps: {}, createRun };
    const executor = new MastraChatRuntimeExecutor();

    await expect(
      executor.execute(
        executable,
        {
          ...input,
          workflowSource: 'import { createTool as ordinaryFactory } from "@mastra/core/tools";'
        },
        jest.fn()
      )
    ).rejects.toMatchObject({ chatFailure: expect.objectContaining({ code: "TOOL_NOT_ALLOWED" }) });
    expect(createRun).not.toHaveBeenCalled();
  });
});
