import { ModelProviderType } from "@prisma/client";
import { IsBoolean, IsEnum, IsOptional, IsString, IsUrl, MinLength } from "class-validator";

export class CreateModelProviderDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsEnum(ModelProviderType)
  type?: ModelProviderType;

  @IsUrl({ require_protocol: true, protocols: ["http", "https"] })
  baseUrl!: string;

  @IsString()
  @MinLength(1)
  apiKey!: string;

  @IsString()
  @MinLength(1)
  defaultModel!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
