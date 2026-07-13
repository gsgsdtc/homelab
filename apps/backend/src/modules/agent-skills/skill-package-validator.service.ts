import { BadRequestException, Injectable } from "@nestjs/common";
import { AgentSkillSourceType } from "@prisma/client";

export interface SkillValidationInput {
  skillName: string;
  sourceType: AgentSkillSourceType;
  sourceId: string | null;
  requestedVersion: string;
}

export interface SkillValidationResult {
  resolvedVersion: string;
  commitSha: string | null;
}

@Injectable()
export class SkillPackageValidator {
  async validate(input: SkillValidationInput): Promise<SkillValidationResult> {
    const requestedVersion = this.requiredTrim(input.requestedVersion, "requestedVersion is required");
    const skillName = this.requiredTrim(input.skillName, "skillName is required");
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillName)) {
      throw new BadRequestException("skillName contains unsupported characters");
    }

    if (input.sourceType === AgentSkillSourceType.trusted_git && !this.isTraceableGitRef(requestedVersion)) {
      throw new BadRequestException("trusted Git skill version must be a commit SHA or protected tag");
    }

    return {
      resolvedVersion: requestedVersion,
      commitSha: this.isCommitSha(requestedVersion) ? requestedVersion : null
    };
  }

  private requiredTrim(value: string | undefined, message: string): string {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) {
      throw new BadRequestException(message);
    }
    return trimmed;
  }

  private isTraceableGitRef(value: string): boolean {
    return this.isCommitSha(value) || /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
  }

  private isCommitSha(value: string): boolean {
    return /^[a-f0-9]{40}$/i.test(value);
  }
}
