import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { AgentSkillsService } from "../src/modules/agents/agent-skills.service";
import { AgentsModule } from "../src/modules/agents/agents.module";
import { RuntimeReloadClient } from "../src/modules/agents/runtime-reload-client.service";
import { SkillPackageValidator } from "../src/modules/agents/skill-package-validator.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

describe("AgentsModule", () => {
  it("resolves agent skills providers from Nest runtime metadata", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }), AgentsModule]
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(AgentSkillsService)).toBeInstanceOf(AgentSkillsService);
    expect(moduleRef.get(SkillPackageValidator)).toBeInstanceOf(SkillPackageValidator);
    expect(moduleRef.get(RuntimeReloadClient)).toBeInstanceOf(RuntimeReloadClient);

    await moduleRef.close();
  });
});
