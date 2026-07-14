import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { AgentSkillsController } from "../src/modules/agents/agent-skills.controller";
import {
  AgentWorkflowCapabilitiesController,
  AgentWorkflowsController,
} from "../src/modules/agents/agent-workflows.controller";
import { AgentsController } from "../src/modules/agents/agents.controller";
import { SkillCatalogController } from "../src/modules/agents/skill-catalog.controller";
import { ModelProvidersController } from "../src/modules/model-providers/model-providers.controller";
import { CONFIRMED_GFU29_ENDPOINTS } from "./gfu29-endpoint-contract";

describe("GFU-29 X6 endpoint matrix", () => {
  const expected = CONFIRMED_GFU29_ENDPOINTS.map(({ route }) => route).sort();

  it("derives the complete route inventory from controller metadata without omitting collection POST", () => {
    const actual = [
      AgentsController,
      SkillCatalogController,
      AgentSkillsController,
      AgentWorkflowsController,
      AgentWorkflowCapabilitiesController,
      ModelProvidersController,
    ]
      .flatMap(routesFor)
      .filter((route) => expected.includes(route))
      .sort();

    expect(actual).toEqual(expected);
    expect(actual).toContain("POST /agents/:agentId/workflows");
    expect(actual).toContain("GET /model-providers");
  });

  it.each([
    AgentsController,
    SkillCatalogController,
    AgentSkillsController,
    AgentWorkflowsController,
    AgentWorkflowCapabilitiesController,
    ModelProvidersController,
  ])(
    "%p applies Bearer and ADMIN guards before every endpoint",
    (controller) => {
      const guards = (
        Reflect.getMetadata(GUARDS_METADATA, controller) ?? []
      ).map((guard: { name: string }) => guard.name);
      expect(guards).toEqual(
        expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]),
      );
      expect(Reflect.getMetadata("roles", controller)).toEqual(["ADMIN"]);
    },
  );

  it("marks every write with its ready and ownership observation contract", () => {
    const readyWrites = CONFIRMED_GFU29_ENDPOINTS.filter(({ ready }) => ready).map(({ route }) => route);
    const owned = CONFIRMED_GFU29_ENDPOINTS.filter(({ ownership }) => ownership).map(({ route }) => route);

    expect(readyWrites).toEqual(
      expect.arrayContaining([
        "POST /agents/:agentId/workflows",
        "PUT /agents/:agentId/workflows/:workflowKey",
        "POST /agents/:id/skills/install",
        "PUT /agents/:id/soul",
      ]),
    );
    expect(owned).toEqual(
      expect.arrayContaining([
        "GET /agents/:id/skills/changes/:changeId",
        "POST /agents/:agentId/workflows/:workflowKey/validate",
        "POST /agents/:agentId/workflows/:workflowKey/rollback",
      ]),
    );
    expect(readyWrites).not.toContain("POST /agents/:agentId/workflows/:workflowKey/validate");
  });
});

function routesFor(controller: new (...args: any[]) => unknown) {
  const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== "constructor")
    .flatMap((name) => {
      const handler = controller.prototype[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (method === undefined) return [];
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? "");
      return `${RequestMethod[method]} /${[prefix, path].filter((segment) => segment && segment !== "/").join("/")}`;
    });
}
