import { IsOptional, IsString, IsUrl, MinLength, ValidateIf } from "class-validator";

export class TestModelProviderConnectionDto {
  @IsOptional()
  @IsString()
  providerId?: string;

  @ValidateIf((dto: TestModelProviderConnectionDto) => !dto.providerId)
  @IsUrl({ require_protocol: true, protocols: ["http", "https"] })
  baseUrl?: string;

  @ValidateIf((dto: TestModelProviderConnectionDto) => !dto.providerId)
  @IsString()
  @MinLength(1)
  apiKey?: string;

  @ValidateIf((dto: TestModelProviderConnectionDto) => !dto.providerId)
  @IsString()
  @MinLength(1)
  defaultModel?: string;
}
