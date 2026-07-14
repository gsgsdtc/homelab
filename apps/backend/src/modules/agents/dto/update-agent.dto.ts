import { IsDefined, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @IsString()
  @MaxLength(128)
  modelProviderId?: string | null;

  @IsOptional()
  @IsDefined()
  @IsInt()
  @Min(1)
  expectedRevision?: number;

  /** Compile-time compatibility only; ValidationPipe rejects legacy API fields. */
  modelProvider?: string;
  modelSecretRef?: string;
  soul?: string;
}
