import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { PasswordService } from "./password.service";
import { UsersService } from "./users.service";

@Module({
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
  exports: [UsersService, PasswordService]
})
export class UsersModule {}
