import type {
  AgentGitStatus,
  AgentSkillChangeStatus,
  AgentSkillReloadStatus,
  AgentStatus,
  ModelProvider,
  WorkflowReloadStatus,
} from "./api";

export const AGENT_OPERATION_POLL_TIMEOUT_MS = 30_000;

export function getAgentOperationPollDelay(elapsedMs: number) {
  return elapsedMs < 10_000 ? 1_000 : 2_000;
}

export function isSkillChangeTerminal(change: {
  changeStatus: string;
  terminal?: boolean;
}) {
  return (
    change.terminal === true ||
    ["succeeded", "failed", "rolled_back", "rollback_failed"].includes(
      change.changeStatus,
    )
  );
}

const agentStatusLabels: Record<AgentStatus, string> = {
  initializing: "初始化中",
  ready: "可用",
  init_failed: "初始化失败",
};

const gitStatusLabels: Record<AgentGitStatus, string> = {
  unavailable: "不可用",
  dirty: "有未提交变更",
  clean: "无未提交变更",
};

const skillChangeLabels: Record<AgentSkillChangeStatus, string> = {
  pending: "等待处理",
  validating: "正在校验",
  applying: "正在应用",
  reloading: "正在加载",
  succeeded: "已完成",
  failed: "失败",
  rolled_back: "已回滚",
  rollback_failed: "回滚失败",
};

const skillReloadLabels: Record<AgentSkillReloadStatus, string> = {
  loaded: "已加载",
  failed: "加载失败",
  pending_restart: "等待重启",
  runtime_offline: "Runtime 离线",
  unknown: "未知状态",
};

const workflowReloadLabels: Record<WorkflowReloadStatus, string> = {
  draft: "草稿未生效",
  loading: "正在加载",
  succeeded: "已生效",
  failed: "加载失败",
};

export function formatAgentStatus(status: string) {
  return agentStatusLabels[status as AgentStatus] ?? "状态异常";
}

export function formatAgentGitStatus(status: string) {
  return gitStatusLabels[status as AgentGitStatus] ?? "Git 状态异常";
}

export function formatSkillChangeStatus(status: string) {
  return skillChangeLabels[status as AgentSkillChangeStatus] ?? "未知状态";
}

export function formatSkillReloadStatus(status: string) {
  return skillReloadLabels[status as AgentSkillReloadStatus] ?? "未知状态";
}

export function formatWorkflowReloadStatus(status: string) {
  return workflowReloadLabels[status as WorkflowReloadStatus] ?? "状态异常";
}

export function selectEnabledProviders<
  T extends Pick<ModelProvider, "id" | "name" | "isActive" | "isDefault">,
>(providers: T[]) {
  return providers
    .filter((provider) => provider.isActive)
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
}

export function getSoulByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function isSoulDraftValid(value: string, maxBytes: number) {
  if (!value.trim()) {
    return { valid: false as const, message: "soul 内容不能为空" };
  }
  if (getSoulByteLength(value) > maxBytes) {
    return {
      valid: false as const,
      message: `soul 内容不能超过 ${maxBytes} 字节`,
    };
  }
  return { valid: true as const, message: null };
}

export function validateWorkflowKey(value: string) {
  if (!value) {
    return "请输入 Workflow key";
  }
  if (value.length > 63) {
    return "Workflow key 不能超过 63 个字符";
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    return "Workflow key 仅支持小写字母、数字和连字符";
  }
  return null;
}
