import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { AppKeyGuard } from "./app-key.guard";
import { AppKeyIdentity } from "./app-keys.service";

@Controller("app-identity")
export class AppIdentityController {
  @Get("me")
  @UseGuards(AppKeyGuard)
  me(@Req() request: Request & { appIdentity?: AppKeyIdentity }) {
    return request.appIdentity;
  }
}
