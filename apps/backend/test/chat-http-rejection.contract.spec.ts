import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../src/common/guards/roles.guard";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { ChatTestControlService } from "../src/modules/chat-test-control/chat-test-control.service";
import { ChatConfigSnapshotService } from "../src/modules/chat/chat-config-snapshot.service";
import { ChatController } from "../src/modules/chat/chat.controller";
import {
  CHAT_RUNTIME,
  ChatSessionService,
} from "../src/modules/chat/chat-session.service";
import { MASTRA_CHAT_ADAPTER } from "../src/modules/chat/mastra-chat.adapter";

describe("chat HTTP rejection DTO", () => {
  const snapshots = {
    getEligibility: jest.fn(),
    capture: jest.fn(),
  };
  const adapter = { execute: jest.fn(), countTokens: jest.fn() };
  const runtime = {
    now: jest.fn(() => Date.parse("2026-07-14T00:00:00.000Z")),
    randomId: jest.fn((prefix: string) => `${prefix}_00000000000000000001`),
    increment: jest.fn(),
  };
  const control = {
    validateBusinessNamespace: jest.fn((value?: string) => value),
  };
  const authGuard = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = {
        sub: "admin-1",
        username: "admin",
        role: UserRole.ADMIN,
      };
      return true;
    },
  };

  async function start(): Promise<{ app: INestApplication; baseUrl: string }> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        JwtAuthGuard,
        RolesGuard,
        ChatSessionService,
        { provide: ChatConfigSnapshotService, useValue: snapshots },
        { provide: MASTRA_CHAT_ADAPTER, useValue: adapter },
        { provide: CHAT_RUNTIME, useValue: runtime },
        { provide: ChatTestControlService, useValue: control },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
    return { app, baseUrl: await app.getUrl() };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns a required string requestId for a create-session configuration rejection", async () => {
    snapshots.getEligibility.mockResolvedValue({
      agentId: "agent-1",
      eligible: false,
      code: "PROVIDER_DISABLED",
      message: "Agent model provider is disabled",
      agent: { name: "Agent", status: "ready" },
      providerSummary: null,
    });
    const { app, baseUrl } = await start();
    try {
      const response = await fetch(`${baseUrl}/agents/agent-1/chat/sessions`, {
        method: "POST",
        headers: { authorization: "Bearer admin" },
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        requestId: expect.any(String),
        executionId: null,
        clientMessageId: null,
        status: "rejected",
        code: "PROVIDER_DISABLED",
        retryable: false,
      });
      expect(body.requestId).not.toBe("");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["non-string", 123, null, "INVALID_CLIENT_MESSAGE_ID"],
    ["malformed string", "short", null, "INVALID_CLIENT_MESSAGE_ID"],
    [
      "valid string",
      "Message_123456789",
      "Message_123456789",
      "INVALID_MESSAGE_CONTENT",
    ],
  ])(
    "normalizes a %s clientMessageId at the HTTP boundary",
    async (_case, clientMessageId, expected, code) => {
      snapshots.getEligibility.mockResolvedValue({
        agentId: "agent-1",
        eligible: true,
        code: null,
        message: null,
        agent: { name: "Agent", status: "ready" },
        providerSummary: { id: "provider-1", name: "Provider", model: "model" },
      });
      const { app, baseUrl } = await start();
      try {
        const created = await fetch(`${baseUrl}/agents/agent-1/chat/sessions`, {
          method: "POST",
          headers: { authorization: "Bearer admin" },
        });
        const { sessionId } = (await created.json()) as { sessionId: string };
        const response = await fetch(
          `${baseUrl}/agents/agent-1/chat/sessions/${sessionId}/messages`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer admin",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              clientMessageId,
              content: "\u0085",
              retryOfClientMessageId: null,
            }),
          },
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          requestId: expect.any(String),
          clientMessageId: expected,
          status: "rejected",
          code,
        });
      } finally {
        await app.close();
      }
    },
  );
});
