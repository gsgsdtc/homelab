export interface Gfu29EndpointContract {
  method: "GET" | "POST" | "PUT" | "PATCH";
  route: string;
  path(agentId: string): string;
  ready: boolean;
  ownership: boolean;
}

const endpoint = (
  method: Gfu29EndpointContract["method"],
  route: string,
  path: (agentId: string) => string,
  ready = false,
  ownership = false
): Gfu29EndpointContract => ({ method, route: `${method} ${route}`, path, ready, ownership });

// Exact backend subset confirmed in Issue GFU-29 section 7.1. Tests derive their
// auth, ADMIN, ready, ownership and success matrices from this one contract.
export const CONFIRMED_GFU29_ENDPOINTS: readonly Gfu29EndpointContract[] = [
  endpoint("GET", "/agents", () => "/agents"),
  endpoint("POST", "/agents", () => "/agents"),
  endpoint("GET", "/agents/:id", (id) => `/agents/${id}`),
  endpoint("PATCH", "/agents/:id", (id) => `/agents/${id}`),
  endpoint("POST", "/agents/:id/retry-initialization", (id) => `/agents/${id}/retry-initialization`),
  endpoint("GET", "/agents/:id/soul", (id) => `/agents/${id}/soul`),
  endpoint("PUT", "/agents/:id/soul", (id) => `/agents/${id}/soul`, true),
  endpoint("GET", "/model-providers", () => "/model-providers"),
  endpoint("GET", "/skill-catalog/sources", () => "/skill-catalog/sources"),
  endpoint("GET", "/skill-catalog/sources/:sourceId/skills", () => "/skill-catalog/sources/source/skills"),
  endpoint("GET", "/skill-catalog/sources/:sourceId/skills/:skillId/versions", () => "/skill-catalog/sources/source/skills/skill/versions"),
  endpoint("GET", "/agents/:id/skills", (id) => `/agents/${id}/skills`),
  endpoint("POST", "/agents/:id/skills/install", (id) => `/agents/${id}/skills/install`, true),
  endpoint("POST", "/agents/:id/skills/update", (id) => `/agents/${id}/skills/update`, true),
  endpoint("POST", "/agents/:id/skills/remove", (id) => `/agents/${id}/skills/remove`, true),
  endpoint("GET", "/agents/:id/skills/changes/:changeId", (id) => `/agents/${id}/skills/changes/change`, false, true),
  endpoint("GET", "/agents/:agentId/workflows", (id) => `/agents/${id}/workflows`),
  endpoint("POST", "/agents/:agentId/workflows", (id) => `/agents/${id}/workflows`, true),
  endpoint("GET", "/agents/:agentId/workflows/:workflowKey", (id) => `/agents/${id}/workflows/flow`, false, true),
  endpoint("PUT", "/agents/:agentId/workflows/:workflowKey", (id) => `/agents/${id}/workflows/flow`, true, true),
  endpoint("POST", "/agents/:agentId/workflows/:workflowKey/validate", (id) => `/agents/${id}/workflows/flow/validate`, false, true),
  endpoint("POST", "/agents/:agentId/workflows/:workflowKey/reload", (id) => `/agents/${id}/workflows/flow/reload`, true, true),
  endpoint("POST", "/agents/:agentId/workflows/:workflowKey/save-and-reload", (id) => `/agents/${id}/workflows/flow/save-and-reload`, true, true),
  endpoint("GET", "/agents/:agentId/workflows/:workflowKey/versions", (id) => `/agents/${id}/workflows/flow/versions`, false, true),
  endpoint("POST", "/agents/:agentId/workflows/:workflowKey/rollback", (id) => `/agents/${id}/workflows/flow/rollback`, true, true),
  endpoint("GET", "/agents/:agentId/workflow-capabilities", (id) => `/agents/${id}/workflow-capabilities`)
];
