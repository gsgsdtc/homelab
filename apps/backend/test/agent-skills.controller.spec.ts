import { ExecutionContext, INestApplication, ValidationPipe } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { RolesGuard } from "../src/common/guards/roles.guard";
import { AgentSkillsController } from "../src/modules/agents/agent-skills.controller";
import { AgentSkillsService } from "../src/modules/agents/agent-skills.service";
import { AgentWorkspaceService } from "../src/modules/agents/agent-workspace.service";
import { RuntimeReloadClient } from "../src/modules/agents/runtime-reload-client.service";
import { SkillPackageValidator } from "../src/modules/agents/skill-package-validator.service";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("Agent skills API", () => {
  const prisma = {
    agent: {
      findUnique: jest.fn()
    },
    agentSkillChange: {
      findUnique: jest.fn()
    },
    agentSkillSource: {
      findUnique: jest.fn()
    }
  };

  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const adminGuard = {
      canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest().user = {
          sub: "admin-1",
          username: "admin",
          role: UserRole.ADMIN
        };
        return true;
      }
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AgentSkillsController],
      providers: [
        AgentSkillsService,
        JwtAuthGuard,
        RolesGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: AgentWorkspaceService, useValue: {} },
        { provide: SkillPackageValidator, useValue: {} },
        { provide: RuntimeReloadClient, useValue: {} }
      ]
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(adminGuard)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true
      })
    );
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agent.findUnique.mockResolvedValue({
      id: "agent-1",
      name: "Agent One",
      workspacePath: ".homelab/agents/agent-one",
      workspaceName: "agent-one"
    });
    prisma.agentSkillSource.findUnique.mockResolvedValue(null);
    prisma.agentSkillChange.findUnique.mockResolvedValue(null);
  });

  it("returns 422 when an install references an unknown source", async () => {
    const response = await fetch(`${baseUrl}/agents/agent-1/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillName: "skill-a",
        sourceId: "missing-source",
        sourceType: "registry",
        version: "1.0.0"
      })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "SKILL_SOURCE_INVALID",
      message: "skill source is not trusted or does not exist"
    });
  });

  it("returns 404 when a change does not exist", async () => {
    const response = await fetch(`${baseUrl}/agents/agent-1/skills/changes/missing-change`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      statusCode: 404,
      message: "skill change not found"
    });
  });
});
