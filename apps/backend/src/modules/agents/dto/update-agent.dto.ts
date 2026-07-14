import { IsOptional, IsString, Matches, MaxLength, ValidateIf } from "class-validator";

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelProvider?: string;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(128)
  modelProviderId?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,127}$/)
  modelSecretRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  soul?: string;
}
