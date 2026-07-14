import { ExecutionContext, INestApplication, UnauthorizedException, ValidationPipe } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { RolesGuard } from "../src/common/guards/roles.guard";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { ChatTestControlController } from "../src/modules/chat-test-control/chat-test-control.controller";
import { ChatTestOperatorGuard } from "../src/modules/chat-test-control/chat-test-operator.guard";
import { ChatTestControlService } from "../src/modules/chat-test-control/chat-test-control.service";
import { ChatController } from "../src/modules/chat/chat.controller";
import { ChatConfigSnapshotService } from "../src/modules/chat/chat-config-snapshot.service";
import { CHAT_RUNTIME, ChatSessionService } from "../src/modules/chat/chat-session.service";
import { MASTRA_CHAT_ADAPTER } from "../src/modules/chat/mastra-chat.adapter";

describe("chat HTTP authorization and route isolation", () => {
  const sessions = {
    getEligibility: jest.fn().mockResolvedValue({ agentId: "agent-1", eligible: true }),
    createSession: jest.fn().mockResolvedValue({ sessionId: "session-1" }),
    sendMessage: jest.fn()
  };
  const control = {
    validateBusinessNamespace: jest.fn((value?: string) => value),
    createNamespace: jest.fn().mockReturnValue({ id: "namespace-1", now: 0 })
  };

  const authGuard = {
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
      const token = request.headers.authorization;
      if (!token || token === "Bearer invalid") throw new UnauthorizedException();
      const role = token === "Bearer operator" ? "TEST_OPERATOR" : token.startsWith("Bearer admin") ? UserRole.ADMIN : UserRole.USER;
      const sub = token === "Bearer admin-other" ? "admin-other" : `${String(role).toLowerCase()}-1`;
      request.user = { sub, username: String(role).toLowerCase(), role };
      return true;
    }
  };

  async function start(includeF5: boolean): Promise<{ app: INestApplication; baseUrl: string }> {
    const moduleRef = await Test.createTestingModule({
      controllers: includeF5 ? [ChatController, ChatTestControlController] : [ChatController],
      providers: [
        JwtAuthGuard,
        RolesGuard,
        ChatTestOperatorGuard,
        { provide: ChatSessionService, useValue: sessions },
        { provide: ChatTestControlService, useValue: control }
      ]
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    return { app, baseUrl: await app.getUrl() };
  }

  it.each([undefined, "Bearer invalid"])("returns 401 for absent or invalid business authentication (%s)", async (authorization) => {
    const { app, baseUrl } = await start(true);
    try {
      const response = await fetch(`${baseUrl}/agents/agent-1/chat/eligibility`, {
        headers: authorization ? { authorization } : undefined
      });
      expect(response.status).toBe(401);
      expect(sessions.getEligibility).not.toHaveBeenCalled();
    } finally {
      await app.close();
      jest.clearAllMocks();
    }
  });

  it("returns 403 when a non-admin reaches the business chat API", async () => {
    const { app, baseUrl } = await start(true);
    try {
      const response = await fetch(`${baseUrl}/agents/agent-1/chat/eligibility`, {
        headers: { authorization: "Bearer user" }
      });
      expect(response.status).toBe(403);
      expect(sessions.getEligibility).not.toHaveBeenCalled();
    } finally {
      await app.close();
      jest.clearAllMocks();
    }
  });

  it("keeps F5 control isolated from ADMIN and permits only TEST_OPERATOR", async () => {
    const { app, baseUrl } = await start(true);
    try {
      const denied = await fetch(`${baseUrl}/test/chat-control/namespaces`, {
        method: "POST",
        headers: { authorization: "Bearer admin" }
      });
      expect(denied.status).toBe(403);
      expect(control.createNamespace).not.toHaveBeenCalled();

      const allowed = await fetch(`${baseUrl}/test/chat-control/namespaces`, {
        method: "POST",
        headers: { authorization: "Bearer operator" }
      });
      expect(allowed.status).toBe(201);
      expect(control.createNamespace).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      jest.clearAllMocks();
    }
  });

  it("returns production 404 because the F5 controller is not registered", async () => {
    const { app, baseUrl } = await start(false);
    try {
      const response = await fetch(`${baseUrl}/test/chat-control/namespaces`, {
        method: "POST",
        headers: { authorization: "Bearer operator" }
      });
      expect(response.status).toBe(404);
      expect(control.createNamespace).not.toHaveBeenCalled();
    } finally {
      await app.close();
      jest.clearAllMocks();
    }
  });

  it("returns the same HTTP 404 before validating malformed payloads for unknown, cross-user, and cross-agent sessions", async () => {
    const snapshots = {
      getEligibility: jest.fn().mockResolvedValue({
        agentId: "agent-1",
        eligible: true,
        code: null,
        message: null,
        agent: { name: "Agent", status: "ready" },
        providerSummary: { id: "provider-1", name: "Provider", model: "model" }
      }),
      capture: jest.fn()
    };
    const adapter = { execute: jest.fn(), countTokens: jest.fn() };
    const runtime = {
      now: jest.fn(() => Date.parse("2026-07-14T00:00:00.000Z")),
      randomId: jest.fn((prefix: string) => `${prefix}_00000000000000000001`),
      increment: jest.fn()
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        JwtAuthGuard,
        RolesGuard,
        ChatSessionService,
        { provide: ChatConfigSnapshotService, useValue: snapshots },
        { provide: MASTRA_CHAT_ADAPTER, useValue: adapter },
        { provide: CHAT_RUNTIME, useValue: runtime },
        { provide: ChatTestControlService, useValue: control }
      ]
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    try {
      const created = await fetch(`${baseUrl}/agents/agent-1/chat/sessions`, {
        method: "POST",
        headers: { authorization: "Bearer admin" }
      });
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };
      const malformed = { clientMessageId: "short", content: "\u0085", retryOfClientMessageId: "bad" };
      const cases = [
        [`${baseUrl}/agents/agent-1/chat/sessions/missing/messages`, "Bearer admin"],
        [`${baseUrl}/agents/agent-1/chat/sessions/${sessionId}/messages`, "Bearer admin-other"],
        [`${baseUrl}/agents/agent-2/chat/sessions/${sessionId}/messages`, "Bearer admin"]
      ];
      for (const [url, authorization] of cases) {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(malformed)
        });
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ code: "CHAT_SESSION_NOT_FOUND" });
      }
      expect(snapshots.capture).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(runtime.increment).not.toHaveBeenCalled();
    } finally {
      await app.close();
      jest.clearAllMocks();
    }
  });
});
