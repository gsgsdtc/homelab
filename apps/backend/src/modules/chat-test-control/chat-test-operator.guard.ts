import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { JwtUser } from "../../common/types/jwt-user";

@Injectable()
export class ChatTestOperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtUser }>();
    return String(request.user?.role) === "TEST_OPERATOR";
  }
}
