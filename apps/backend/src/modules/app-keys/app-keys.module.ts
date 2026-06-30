import { Module } from "@nestjs/common";
import { AppIdentityController } from "./app-identity.controller";
import { AppKeysController } from "./app-keys.controller";
import { AppKeyGuard } from "./app-key.guard";
import { AppKeysService } from "./app-keys.service";

@Module({
  controllers: [AppKeysController, AppIdentityController],
  providers: [AppKeysService, AppKeyGuard],
  exports: [AppKeysService, AppKeyGuard]
})
export class AppKeysModule {}
