import { IsString, MaxLength } from "class-validator";

export class SaveAgentSoulDto {
  @IsString()
  @MaxLength(20000)
  soul!: string;
}
