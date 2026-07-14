type LoadedControlHttpModule = Record<string, any>;

function loadControlHttpModule(): LoadedControlHttpModule | null {
  try {
    return require("../src/modules/chat-test-control/chat-test-control.module") as LoadedControlHttpModule;
  } catch {
    return null;
  }
}

const httpModule = loadControlHttpModule();

describe("F5 test control HTTP surface", () => {
  it("provides an environment-gated dynamic module", () => {
    expect(httpModule?.ChatTestControlModule).toBeDefined();
  });

  if (!httpModule) return;

  it("does not register production routes and only registers explicitly enabled test routes", () => {
    const production = httpModule.ChatTestControlModule.register({ nodeEnv: "production", enabled: true });
    const disabledTest = httpModule.ChatTestControlModule.register({ nodeEnv: "test", enabled: false });
    const enabledTest = httpModule.ChatTestControlModule.register({ nodeEnv: "test", enabled: true });

    expect(production.controllers).toEqual([]);
    expect(disabledTest.controllers).toEqual([]);
    expect(enabledTest.controllers).toHaveLength(1);
  });

  it("requires the distinct TEST_OPERATOR role", () => {
    const guard = new httpModule.ChatTestOperatorGuard();
    const context = (role: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) })
      }) as any;

    expect(guard.canActivate(context("TEST_OPERATOR"))).toBe(true);
    expect(guard.canActivate(context("ADMIN"))).toBe(false);
  });
});
