import { UserRole } from "@prisma/client";

export interface JwtUser {
  sub: string;
  username: string;
  role: UserRole;
}
