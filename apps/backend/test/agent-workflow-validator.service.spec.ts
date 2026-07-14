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

  it("enforces workflowKey boundaries explicitly", () => {
    const valid63 = "a".repeat(63);
    expect(() =>
      validator.validateSource({
        workflowKey: valid63,
        extension: "ts",
        source: sourceFor(valid63)
      })
    ).not.toThrow();

    for (const workflowKey of ["", "Aaa", "a_b", "a".repeat(64)]) {
      expect(() =>
        validator.validateSource({
          workflowKey,
          extension: "ts",
          source: sourceFor("support-triage")
        })
      ).toThrow(BadRequestException);
    }
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

  it("rejects absolute imports, dynamic nonliteral imports, unknown packages, unregistered tools, and dynamic install attempts", () => {
    const cases = [
      'import x from "/etc/passwd";',
      "const name = '@mastra/core/workflows';\nawait import(name);",
      'import leftPad from "left-pad";',
      'import tool from "@unknown/tools/weather";',
      'import installer from "npm";'
    ];

    for (const prefix of cases) {
      expect(() =>
        validator.validateSource({
          workflowKey: "support-triage",
          extension: "ts",
          source: `${prefix}\n${sourceFor("support-triage")}`
        })
      ).toThrow(BadRequestException);
    }
  });

  it("allows secretRef identifiers but rejects common raw secret shapes", () => {
    expect(() =>
      validator.validateSource({
        workflowKey: "support-triage",
        extension: "ts",
        source: `const secretRef = "OPENAI_API_KEY";\n${sourceFor("support-triage")}`
      })
    ).not.toThrow();

    for (const rawSecret of [
      "sk-secret1234567890",
      "ghp_secret1234567890",
      "xoxb-secret1234567890",
      "AKIA1234567890ABCDEF",
      "AIzaabcdefghijklmnopqrstuvwxyz",
      "eyJsecretpayload.eyJsecretpayload",
      "-----BEGIN PRIVATE KEY-----"
    ]) {
      expect(() =>
        validator.validateSource({
          workflowKey: "support-triage",
          extension: "ts",
          source: `const leaked = "${rawSecret}";\n${sourceFor("support-triage")}`
        })
      ).toThrow("workflow source must not contain real secret values");
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
    expect(() =>
      validator.validateSource({
        workflowKey: "support-triage",
        extension: "ts",
        source: 'const workflow = createWorkflow({ id: "support-triage" });\nworkflow.commit();\nexport default {}'
      })
    ).toThrow("workflow source must default export a Mastra workflow");
    expect(() =>
      validator.validateSource({
        workflowKey: "support-triage",
        extension: "ts",
        source: 'const workflow = createWorkflow({ id: "support-triage" });\nworkflow.commit();\nexport default workflow;\nconst broken: = ;'
      })
    ).toThrow("workflow source contains invalid TypeScript");
  });
});

function sourceFor(workflowKey: string) {
  return [
    'import { createWorkflow } from "@mastra/core/workflows";',
    `const workflow = createWorkflow({ id: "${workflowKey}" });`,
    "workflow.commit();",
    "export default workflow;"
  ].join("\n");
}
