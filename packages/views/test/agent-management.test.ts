import { describe, expect, it } from "vitest";
import {
  formatAgentGitStatus,
  formatAgentStatus,
  formatSkillChangeStatus,
  formatSkillReloadStatus,
  formatWorkflowReloadStatus,
  getAgentOperationPollDelay,
  getSoulByteLength,
  isSkillChangeTerminal,
  isSoulDraftValid,
  selectEnabledProviders,
  validateWorkflowKey,
} from "../src/admin/agent-management";

describe("agent management view contract", () => {
  it("falls back safely for unknown agent and git statuses", () => {
    expect(formatAgentStatus("ready")).toBe("可用");
    expect(formatAgentStatus("future_status")).toBe("状态异常");
    expect(formatAgentGitStatus("dirty")).toBe("有未提交变更");
    expect(formatAgentGitStatus("future_status")).toBe("Git 状态异常");
  });

  it("keeps only enabled providers and sorts the default first", () => {
    const providers = selectEnabledProviders([
      { id: "disabled", name: "Disabled", isActive: false, isDefault: false },
      { id: "specific", name: "Specific", isActive: true, isDefault: false },
      { id: "default", name: "Default", isActive: true, isDefault: true },
    ]);

    expect(providers.map((provider) => provider.id)).toEqual([
      "default",
      "specific",
    ]);
  });

  it("validates soul size by UTF-8 bytes", () => {
    expect(getSoulByteLength("你")).toBe(3);
    expect(isSoulDraftValid("  ", 65_536)).toEqual({
      valid: false,
      message: "soul 内容不能为空",
    });
    expect(isSoulDraftValid("你".repeat(21_846), 65_536)).toEqual({
      valid: false,
      message: "soul 内容不能超过 65536 字节",
    });
    expect(isSoulDraftValid("你".repeat(21_845), 65_536)).toEqual({
      valid: true,
      message: null,
    });
  });

  it("validates the workflow key contract", () => {
    expect(validateWorkflowKey("support-flow")).toBeNull();
    expect(validateWorkflowKey("Uppercase")).toBe(
      "Workflow key 仅支持小写字母、数字和连字符",
    );
    expect(validateWorkflowKey("a".repeat(64))).toBe(
      "Workflow key 不能超过 63 个字符",
    );
  });

  it("uses domain-specific labels for skill and workflow state", () => {
    expect(formatSkillChangeStatus("rolled_back")).toBe("已回滚");
    expect(formatSkillReloadStatus("pending_restart")).toBe("等待重启");
    expect(formatSkillReloadStatus("pending")).toBe("未知状态");
    expect(formatWorkflowReloadStatus("draft")).toBe("草稿未生效");
    expect(formatWorkflowReloadStatus("pending")).toBe("状态异常");
  });

  it("uses the specified polling cadence and terminal skill states", () => {
    expect(getAgentOperationPollDelay(0)).toBe(1_000);
    expect(getAgentOperationPollDelay(9_999)).toBe(1_000);
    expect(getAgentOperationPollDelay(10_000)).toBe(2_000);
    expect(
      isSkillChangeTerminal({ changeStatus: "reloading", terminal: false }),
    ).toBe(false);
    expect(isSkillChangeTerminal({ changeStatus: "rolled_back" })).toBe(true);
  });
});
