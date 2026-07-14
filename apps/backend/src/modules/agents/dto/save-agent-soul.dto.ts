import { IsDefined, IsInt, IsString, Min } from "class-validator";

export class SaveAgentSoulDto {
  @IsDefined()
  @IsString()
  content?: string;

  @IsDefined()
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  /** Compile-time compatibility only; ValidationPipe rejects the legacy API field. */
  soul?: string;
}
