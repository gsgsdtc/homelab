import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../src/common/guards/roles.guard";
import { AgentWorkflowsController } from "../src/modules/agents/agent-workflows.controller";

describe("AgentWorkflowsController permissions", () => {
  it("denies non-admin workflow source reads before service can return source", () => {
    const workflows = {
      get: jest.fn()
    };
    const controller = new AgentWorkflowsController(workflows as never);
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => controller.get,
      getClass: () => AgentWorkflowsController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "user_1", username: "user", role: UserRole.USER }
        })
      })
    } as unknown as ExecutionContext;

    const allowed = guard.canActivate(context);
    if (allowed) {
      void controller.get("agent-1", "support-triage", "draft");
    }

    expect(allowed).toBe(false);
    expect(workflows.get).not.toHaveBeenCalled();
  });

  it("allows admin workflow source reads through the guard", () => {
    const workflows = {
      get: jest.fn().mockResolvedValue({ source: "secret workflow source" })
    };
    const controller = new AgentWorkflowsController(workflows as never);
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => controller.get,
      getClass: () => AgentWorkflowsController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "admin_1", username: "admin", role: UserRole.ADMIN }
        })
      })
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
  });
});
