import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { JwtStrategy } from "../src/modules/auth/jwt.strategy";
import { UsersService } from "../src/modules/users/users.service";

describe("JwtStrategy", () => {
  const config = {
    get: jest.fn(() => "test-secret")
  } as unknown as ConfigService;

  const users = {
    findById: jest.fn()
  } as unknown as UsersService & {
    findById: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns current user role from storage instead of trusting stale token role", async () => {
    users.findById.mockResolvedValue({
      id: "user_1",
      username: "admin",
      passwordHash: "hashed",
      role: UserRole.USER,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const strategy = new JwtStrategy(config, users);

    await expect(
      strategy.validate({
        sub: "user_1",
        username: "admin",
        role: UserRole.ADMIN
      })
    ).resolves.toEqual({
      sub: "user_1",
      username: "admin",
      role: UserRole.USER
    });
  });

  it("rejects tokens for deleted or disabled users", async () => {
    users.findById.mockResolvedValue(null);
    const strategy = new JwtStrategy(config, users);

    await expect(
      strategy.validate({
        sub: "missing_user",
        username: "admin",
        role: UserRole.ADMIN
      })
    ).rejects.toThrow(UnauthorizedException);
  });
});
