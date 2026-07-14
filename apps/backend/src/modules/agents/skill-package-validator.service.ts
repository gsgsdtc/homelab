import { BadRequestException, Injectable } from "@nestjs/common";
import { AgentSkillMutation } from "./agent-skill-types";

export interface SkillValidationResult {
  resolvedVersion: string;
  manifest: {
    name: string;
  };
}

@Injectable()
export class SkillPackageValidator {
  async validate(mutation: AgentSkillMutation): Promise<SkillValidationResult> {
    if (!mutation.version || mutation.version.trim() === "") {
      throw new BadRequestException("skill version is required");
    }
    if (mutation.sourceType === "git" && !this.isTraceableGitRef(mutation.version)) {
      throw new BadRequestException("git skill version must be a commit SHA or protected tag");
    }
    return {
      resolvedVersion: mutation.version,
      manifest: {
        name: mutation.skillName
      }
    };
  }

  private isTraceableGitRef(version: string): boolean {
    return /^[a-f0-9]{40}$/i.test(version) || /^v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(version);
  }
}
