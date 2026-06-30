import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { AppKeysService, AppKeyIdentity } from "./app-keys.service";

@Injectable()
export class AppKeyGuard implements CanActivate {
  constructor(private readonly appKeys: AppKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { appIdentity?: AppKeyIdentity }>();
    const rawKey = request.header("x-app-key");

    if (!rawKey) {
      throw new UnauthorizedException("missing app key");
    }

    request.appIdentity = await this.appKeys.validateRawKey(rawKey);
    return true;
  }
}
