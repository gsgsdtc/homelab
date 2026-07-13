import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class CreateAgentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  slug?: string;

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
