import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class WorkflowSourceDto {
  @IsString()
  source!: string;

  @IsOptional()
  @IsIn(["ts", "js"])
  extension?: "ts" | "js";

  @IsOptional()
  @IsString()
  expectedRevision?: string;
}

export class CreateWorkflowDto extends WorkflowSourceDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/)
  workflowKey!: string;
}

export class ReloadWorkflowDto {
  @IsOptional()
  @IsString()
  expectedDraftHash?: string;
}

export class RollbackWorkflowDto {
  @IsString()
  @MaxLength(128)
  versionId!: string;
}
