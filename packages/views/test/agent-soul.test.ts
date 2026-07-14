import { describe, expect, it } from "vitest";
import {
  getAgentSoulNotice,
  isAgentSoulSaveDisabled,
  validateAgentSoulDraft,
} from "../src/admin/agent-soul";

describe("agent soul editor rules", () => {
  it("rejects blank soul drafts before saving", () => {
    expect(validateAgentSoulDraft("   \n\t ")).toEqual("soul 内容不能为空");
    expect(validateAgentSoulDraft("Use the homelab runbook")).toBeNull();
  });

  it("disables saving when readonly, busy, errored, unchanged, or blank", () => {
    expect(
      isAgentSoulSaveDisabled({
        canEdit: false,
        busy: false,
        fileStatus: "loaded",
        draft: "new soul",
        saved: "old soul",
      }),
    ).toBe(true);
    expect(
      isAgentSoulSaveDisabled({
        canEdit: true,
        busy: true,
        fileStatus: "loaded",
        draft: "new soul",
        saved: "old soul",
      }),
    ).toBe(true);
    expect(
      isAgentSoulSaveDisabled({
        canEdit: true,
        busy: false,
        fileStatus: "error",
        draft: "new soul",
        saved: "old soul",
      }),
    ).toBe(true);
    expect(
      isAgentSoulSaveDisabled({
        canEdit: true,
        busy: false,
        fileStatus: "loaded",
        draft: "old soul",
        saved: "old soul",
      }),
    ).toBe(true);
    expect(
      isAgentSoulSaveDisabled({
        canEdit: true,
        busy: false,
        fileStatus: "missing",
        draft: "restored soul",
        saved: "default soul",
      }),
    ).toBe(false);
  });

  it("surfaces missing, read failure, and readonly notices", () => {
    expect(
      getAgentSoulNotice({
        canEdit: true,
        fileStatus: "missing",
        fileError: undefined,
      }),
    ).toBe("当前 soul 文件缺失，保存后将重新创建 soul.md");
    expect(
      getAgentSoulNotice({
        canEdit: true,
        fileStatus: "error",
        fileError: "permission denied",
      }),
    ).toBe("soul 读取失败，请重试：permission denied");
    expect(
      getAgentSoulNotice({
        canEdit: false,
        fileStatus: "loaded",
        fileError: undefined,
      }),
    ).toBe("你没有权限编辑该 Agent 的 soul");
  });
});
