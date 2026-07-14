import { IsIn, IsOptional, IsString, Matches, MinLength } from "class-validator";

export const AGENT_SKILL_SOURCE_TYPES = ["registry", "git"] as const;
export const AGENT_SKILL_OPERATIONS = ["install", "update", "remove"] as const;

export type AgentSkillSourceTypeValue = (typeof AGENT_SKILL_SOURCE_TYPES)[number];
export type AgentSkillOperationValue = (typeof AGENT_SKILL_OPERATIONS)[number];

export class AgentSkillInstallDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]*$/)
  skillName!: string;

  @IsString()
  sourceId!: string;

  @IsIn(AGENT_SKILL_SOURCE_TYPES)
  sourceType!: AgentSkillSourceTypeValue;

  @IsString()
  @MinLength(1)
  version!: string;
}

export class AgentSkillUpdateDto extends AgentSkillInstallDto {}

export class AgentSkillRemoveDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]*$/)
  skillName!: string;
}

export class AgentSkillSelfUpdateDto {
  @IsString()
  agentId!: string;

  @IsIn(AGENT_SKILL_OPERATIONS)
  operation!: AgentSkillOperationValue;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]*$/)
  skillName!: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsIn(AGENT_SKILL_SOURCE_TYPES)
  sourceType?: AgentSkillSourceTypeValue;

  @IsOptional()
  @IsString()
  version?: string;
}
