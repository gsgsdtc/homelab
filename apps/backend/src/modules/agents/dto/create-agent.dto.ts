import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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
  @IsString()
  @MaxLength(128)
  modelProviderId?: string;

  /** Compile-time compatibility only; ValidationPipe rejects legacy API fields. */
  modelProvider?: string;
  modelSecretRef?: string;
  soul?: string;
}
