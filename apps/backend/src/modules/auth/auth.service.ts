import { UnauthorizedException } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { User } from "@prisma/client";
import { JwtUser } from "../../common/types/jwt-user";
import { PasswordService } from "../users/password.service";
import { UsersService } from "../users/users.service";
import { LoginDto } from "./dto/login.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService
  ) {}

  async login(dto: LoginDto) {
    const user = await this.validateCredentials(dto.username, dto.password);
    const payload: JwtUser = {
      sub: user.id,
      username: user.username,
      role: user.role
    };

    return {
      accessToken: await this.jwt.signAsync(payload, {
        secret: this.config.get<string>("JWT_SECRET"),
        expiresIn: this.config.get<string>("JWT_EXPIRES_IN", "1h")
      }),
      tokenType: "Bearer",
      user: this.users.toPublic(user)
    };
  }

  async validateCredentials(username: string, password: string): Promise<User> {
    const user = await this.users.findByUsername(username);
    if (!user || !user.isActive) {
      throw new UnauthorizedException("invalid username or password");
    }

    const matches = await this.passwords.compare(password, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException("invalid username or password");
    }

    return user;
  }
}
