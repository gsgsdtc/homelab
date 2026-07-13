import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../src/common/guards/roles.guard";
import { ModelProvidersController } from "../src/modules/model-providers/model-providers.controller";

describe("ModelProvidersController permissions", () => {
  it("denies non-admin connection tests before the provider service can make external calls", () => {
    const providers = {
      testConnection: jest.fn()
    };
    const controller = new ModelProvidersController(providers as never);
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => controller.testConnection,
      getClass: () => ModelProvidersController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "user_1", username: "user", role: UserRole.USER }
        })
      })
    } as unknown as ExecutionContext;

    const allowed = guard.canActivate(context);
    if (allowed) {
      void controller.testConnection({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-live-secret",
        defaultModel: "gpt-4.1-mini"
      });
    }

    expect(allowed).toBe(false);
    expect(providers.testConnection).not.toHaveBeenCalled();
  });
});
