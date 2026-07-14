import { AgentSkillOperationValue, AgentSkillSourceTypeValue } from "./dto/agent-skill-change.dto";

export type AgentSkillChangeStatusValue =
  | "pending"
  | "validating"
  | "applying"
  | "reloading"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "rollback_failed";

export type AgentSkillReloadStatusValue = "loaded" | "failed" | "pending_restart" | "runtime_offline" | "unknown";
export type AgentSkillAuditStatusValue = "audit_written" | "audit_pending" | "audit_failed";
export type AgentSkillRollbackResultValue = "not_required" | "succeeded" | "failed" | "skipped";
export type AgentSkillFailedStageValue =
  | "permission"
  | "audit_init"
  | "source_validation"
  | "version_resolution"
  | "manifest_validation"
  | "staging_write"
  | "atomic_switch"
  | "reload"
  | "rollback"
  | "audit_write"
  | "concurrency_lock";

export interface SkillConfigEntry {
  name: string;
  version: string;
  sourceType: AgentSkillSourceTypeValue;
  sourceId: string;
  enabled: boolean;
  systemRequired: boolean;
  selfUpdateAllowed: boolean;
}

export interface AgentSkillMutation {
  operation: AgentSkillOperationValue;
  skillName: string;
  sourceType: AgentSkillSourceTypeValue;
  sourceId: string;
  version?: string;
  changeId: string;
  resolvedVersion?: string;
  currentSkills: SkillConfigEntry[];
}

export interface AgentSkillChangeResult {
  changeId: string;
  skillName: string;
  operation: AgentSkillOperationValue;
  changeStatus: AgentSkillChangeStatusValue;
  reloadStatus: AgentSkillReloadStatusValue;
  auditStatus: AgentSkillAuditStatusValue;
  rollbackResult: AgentSkillRollbackResultValue;
  failedStage: AgentSkillFailedStageValue | null;
  errorCode: string | null;
  safeErrorSummary: string | null;
  previousConfigVersion: string | null;
  activeConfigVersion: string | null;
  stagedConfigVersion: string | null;
  sequenceIndex: number;
  terminal: boolean;
  finishedAt: Date | null;
  persistedConfigVersion: string | null;
  runtimeLoadedVersion: string | null;
  effectiveFor: "next_task";
}
