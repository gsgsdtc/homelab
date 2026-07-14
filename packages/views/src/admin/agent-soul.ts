import type { AgentSoulFileStatus } from "./api";

export interface AgentSoulSaveState {
  canEdit: boolean;
  busy: boolean;
  fileStatus: AgentSoulFileStatus;
  draft: string;
  saved: string;
}

export function validateAgentSoulDraft(draft: string) {
  return draft.trim().length === 0 ? "soul 内容不能为空" : null;
}

export function isAgentSoulSaveDisabled(state: AgentSoulSaveState) {
  return (
    !state.canEdit ||
    state.busy ||
    state.fileStatus === "error" ||
    state.draft === state.saved ||
    validateAgentSoulDraft(state.draft) !== null
  );
}

export function getAgentSoulNotice({
  canEdit,
  fileStatus,
  fileError,
}: {
  canEdit: boolean;
  fileStatus: AgentSoulFileStatus;
  fileError?: string;
}) {
  if (!canEdit) {
    return "你没有权限编辑该 Agent 的 soul";
  }
  if (fileStatus === "missing") {
    return "当前 soul 文件缺失，保存后将重新创建 soul.md";
  }
  if (fileStatus === "error") {
    return fileError
      ? `soul 读取失败，请重试：${fileError}`
      : "soul 读取失败，请重试";
  }
  return "";
}
