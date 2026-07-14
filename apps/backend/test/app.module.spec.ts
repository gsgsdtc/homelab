import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AgentSkillsService } from "../src/modules/agents/agent-skills.service";
import { RuntimeReloadClient } from "../src/modules/agents/runtime-reload-client.service";
import { SkillPackageValidator } from "../src/modules/agents/skill-package-validator.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("AppModule", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");

    const { AppModule } = await import("../src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("starts with the agent skills providers resolved by Nest", () => {
    expect(app.get(AgentSkillsService)).toBeInstanceOf(AgentSkillsService);
    expect(app.get(SkillPackageValidator)).toBeInstanceOf(SkillPackageValidator);
    expect(app.get(RuntimeReloadClient)).toBeInstanceOf(RuntimeReloadClient);
  });
});
