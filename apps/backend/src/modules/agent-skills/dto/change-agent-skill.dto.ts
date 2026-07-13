import { AgentSkillSourceType } from "@prisma/client";

export class ChangeAgentSkillDto {
  skillName?: string;
  sourceType?: AgentSkillSourceType;
  sourceId?: string;
  requestedVersion?: string;
}
