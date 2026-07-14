import { readFileSync } from "fs";
import { resolve } from "path";

describe("GFU-29 backend CI release gate", () => {
  it("runs PostgreSQL integration tests, lint and build on pull requests", () => {
    const workflow = readFileSync(
      resolve(__dirname, "../../../.github/workflows/backend-gfu29.yml"),
      "utf8",
    );

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("postgres:");
    expect(workflow).toContain("GFU29_POSTGRES_ADMIN_URL");
    expect(workflow).toContain("pnpm --filter @homelab/backend test");
    expect(workflow).toContain("pnpm --filter @homelab/backend lint");
    expect(workflow).toContain("pnpm --filter @homelab/backend build");
  });
});
