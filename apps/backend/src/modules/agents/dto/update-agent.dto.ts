import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelProvider?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,127}$/)
  modelSecretRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  soul?: string;
}
