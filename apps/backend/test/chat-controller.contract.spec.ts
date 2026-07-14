type LoadedControllerModule = Record<string, any>;

function loadControllerModule(): LoadedControllerModule | null {
  try {
    return require("../src/modules/chat/chat.controller") as LoadedControllerModule;
  } catch {
    return null;
  }
}

const controllerModule = loadControllerModule();

describe("ChatController frozen DTO contract", () => {
  it("provides the administrator chat endpoints", () => {
    expect(controllerModule?.ChatController).toBeDefined();
  });

  if (!controllerModule) return;

  it("binds the authenticated user and URL agent/session IDs", async () => {
    const service = {
      getEligibility: jest.fn().mockResolvedValue({ agentId: "agent-1", eligible: true }),
      createSession: jest.fn().mockResolvedValue({ sessionId: "session-1" }),
      sendMessage: jest.fn().mockResolvedValue({ httpStatus: 200, body: { status: "succeeded" } })
    };
    const control = { validateBusinessNamespace: jest.fn((value?: string) => value) };
    const controller = new controllerModule.ChatController(service, control);
    const user = { sub: "admin-1", username: "admin", role: "ADMIN" };
    const response = { status: jest.fn() };

    await expect(controller.eligibility("agent-1", undefined)).resolves.toEqual({ agentId: "agent-1", eligible: true });
    await expect(controller.createSession("agent-1", user, undefined)).resolves.toEqual({ sessionId: "session-1" });
    await expect(
      controller.sendMessage(
        "agent-1",
        "session-1",
        { clientMessageId: "Message_123456789", content: "hello", retryOfClientMessageId: null },
        user,
        response,
        undefined
      )
    ).resolves.toEqual({ status: "succeeded" });

    expect(service.createSession).toHaveBeenCalledWith("admin-1", "agent-1", undefined);
    expect(service.sendMessage).toHaveBeenCalledWith(
      "admin-1",
      "agent-1",
      "session-1",
      expect.objectContaining({ clientMessageId: "Message_123456789" }),
      undefined
    );
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
