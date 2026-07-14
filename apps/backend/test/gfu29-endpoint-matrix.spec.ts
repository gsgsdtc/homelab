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

describe("GFU-29 X6 endpoint matrix", () => {
  const expected = [
    "GET /agents",
    "POST /agents",
    "GET /agents/:id",
    "PATCH /agents/:id",
    "GET /agents/:id/soul",
    "PUT /agents/:id/soul",
    "POST /agents/:id/retry-initialization",
    "GET /skill-catalog/sources",
    "GET /skill-catalog/sources/:sourceId/skills",
    "GET /skill-catalog/sources/:sourceId/skills/:skillId/versions",
    "GET /agents/:id/skills",
    "GET /agents/:id/skills/changes/:changeId",
    "POST /agents/:id/skills/install",
    "POST /agents/:id/skills/update",
    "POST /agents/:id/skills/remove",
    "GET /agents/:agentId/workflows",
    "POST /agents/:agentId/workflows",
    "GET /agents/:agentId/workflows/:workflowKey",
    "PUT /agents/:agentId/workflows/:workflowKey",
    "POST /agents/:agentId/workflows/:workflowKey/validate",
    "POST /agents/:agentId/workflows/:workflowKey/reload",
    "POST /agents/:agentId/workflows/:workflowKey/save-and-reload",
    "GET /agents/:agentId/workflows/:workflowKey/versions",
    "POST /agents/:agentId/workflows/:workflowKey/rollback",
    "GET /agents/:agentId/workflow-capabilities",
  ].sort();

  it("derives the complete route inventory from controller metadata without omitting collection POST", () => {
    const actual = [
      AgentsController,
      SkillCatalogController,
      AgentSkillsController,
      AgentWorkflowsController,
      AgentWorkflowCapabilitiesController,
    ]
      .flatMap(routesFor)
      .sort();

    expect(actual).toEqual(expected);
    expect(actual).toContain("POST /agents/:agentId/workflows");
  });

  it.each([
    AgentsController,
    SkillCatalogController,
    AgentSkillsController,
    AgentWorkflowsController,
    AgentWorkflowCapabilitiesController,
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
    const writes = expected.filter((route) => /^(POST|PUT|PATCH) /.test(route));
    const readyWrites = writes.filter((route) =>
      /\/soul|\/skills\/(install|update|remove)|\/workflows(?:\/|$)|retry-initialization/.test(
        route,
      ),
    );
    const owned = expected.filter((route) =>
      /changes\/:changeId|workflows\/:workflowKey/.test(route),
    );

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
