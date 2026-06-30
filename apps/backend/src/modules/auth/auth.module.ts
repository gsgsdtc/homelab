import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AdminSeedService } from "./admin-seed.service";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { UsersModule } from "../users/users.module";

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.register({})
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AdminSeedService],
  exports: [AuthService]
})
export class AuthModule {}
