import { BadRequestException } from "@nestjs/common";
import { AgentWorkflowValidator } from "../src/modules/agents/agent-workflow-validator.service";

describe("AgentWorkflowValidator", () => {
  const validator = new AgentWorkflowValidator({
    get: jest.fn((key: string, defaultValue: unknown) =>
      key === "HOMELAB_WORKFLOW_MAX_SOURCE_BYTES" ? 1024 : defaultValue
    )
  } as any);

  it("accepts a Mastra workflow with allowlisted imports", () => {
    expect(() =>
      validator.validateSource({
        workflowKey: "support-triage",
        extension: "ts",
        source: [
          'import { createWorkflow } from "@mastra/core/workflows";',
          'import { z } from "zod";',
          'import { helper } from "./helper";',
          'const workflow = createWorkflow({ id: "support-triage" });',
          "workflow.commit();",
          "export default workflow;"
        ].join("\n")
      })
    ).not.toThrow();
  });

  it("rejects path escape imports, blocked modules, and raw secrets", () => {
    const cases = [
      'import x from "../escape";\nconst workflow = createWorkflow({ id: "support-triage" });\nworkflow.commit();\nexport default workflow;',
      'import { exec } from "child_process";\nconst workflow = createWorkflow({ id: "support-triage" });\nworkflow.commit();\nexport default workflow;',
      'const key = "sk-secret1234567890";\nconst workflow = createWorkflow({ id: "support-triage" });\nworkflow.commit();\nexport default workflow;'
    ];

    for (const source of cases) {
      expect(() =>
        validator.validateSource({
          workflowKey: "support-triage",
          extension: "ts",
          source
        })
      ).toThrow(BadRequestException);
    }
  });

  it("requires default exported committed Mastra workflow with matching id", () => {
    expect(() =>
      validator.validateSource({
        workflowKey: "support-triage",
        extension: "ts",
        source: 'const workflow = createWorkflow({ id: "other-key" });\nworkflow.commit();\nexport default workflow;'
      })
    ).toThrow("workflow id must match workflowKey");
    expect(() =>
      validator.validateSource({
        workflowKey: "support-triage",
        extension: "ts",
        source: 'const workflow = createWorkflow({ id: "support-triage" });\nexport default workflow;'
      })
    ).toThrow("workflow source must commit");
  });
});
