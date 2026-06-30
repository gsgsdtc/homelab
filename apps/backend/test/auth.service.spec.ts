import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { UserRole } from "@prisma/client";
import { AuthService } from "../src/modules/auth/auth.service";
import { PasswordService } from "../src/modules/users/password.service";
import { UsersService } from "../src/modules/users/users.service";

describe("AuthService", () => {
  const user = {
    id: "user_1",
    username: "admin",
    passwordHash: "hashed",
    role: UserRole.ADMIN,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const users = {
    findByUsername: jest.fn(),
    toPublic: jest.fn(({ passwordHash: _passwordHash, ...publicUser }) => publicUser)
  } as unknown as jest.Mocked<UsersService>;

  const passwords = {
    compare: jest.fn()
  } as unknown as jest.Mocked<PasswordService>;

  const jwt = {
    signAsync: jest.fn()
  } as unknown as jest.Mocked<JwtService>;

  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      const values: Record<string, string> = {
        JWT_SECRET: "test-secret",
        JWT_EXPIRES_IN: "1h"
      };
      return values[key] ?? fallback;
    })
  } as unknown as jest.Mocked<ConfigService>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a JWT for active users with valid credentials", async () => {
    users.findByUsername.mockResolvedValue(user);
    passwords.compare.mockResolvedValue(true);
    jwt.signAsync.mockResolvedValue("signed.jwt");

    const service = new AuthService(users, passwords, jwt, config);

    await expect(service.login({ username: "admin", password: "password" })).resolves.toMatchObject({
      accessToken: "signed.jwt",
      tokenType: "Bearer",
      user: {
        id: "user_1",
        username: "admin",
        role: UserRole.ADMIN
      }
    });
  });

  it("rejects invalid credentials without exposing which field failed", async () => {
    users.findByUsername.mockResolvedValue(user);
    passwords.compare.mockResolvedValue(false);

    const service = new AuthService(users, passwords, jwt, config);

    await expect(service.login({ username: "admin", password: "wrong" })).rejects.toThrow(UnauthorizedException);
  });

  it("rejects disabled users", async () => {
    users.findByUsername.mockResolvedValue({ ...user, isActive: false });

    const service = new AuthService(users, passwords, jwt, config);

    await expect(service.login({ username: "admin", password: "password" })).rejects.toThrow(UnauthorizedException);
    expect(passwords.compare).not.toHaveBeenCalled();
  });
});
