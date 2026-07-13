import { ModelProviderType } from "@prisma/client";
import { IsBoolean, IsEnum, IsOptional, IsString, IsUrl, MinLength } from "class-validator";

export class UpdateModelProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEnum(ModelProviderType)
  type?: ModelProviderType;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ["http", "https"] })
  baseUrl?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  defaultModel?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
