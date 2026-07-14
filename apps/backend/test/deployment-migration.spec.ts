import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("production deployment migrations", () => {
  const backendPackage = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { scripts: Record<string, string> };
  const deployScript = readFileSync(resolve(__dirname, "../../../ops-deploy.sh"), "utf8");

  it("runs Prisma migrations after installing dependencies and before building or restarting", () => {
    expect(backendPackage.scripts["prisma:migrate:deploy"]).toBe("prisma migrate deploy");

    const main = deployScript.slice(deployScript.indexOf("main() {"));
    const installIndex = main.indexOf("\n  install_dependencies\n");
    const migrationIndex = main.indexOf("\n  run_database_migrations\n");
    const buildIndex = main.indexOf("\n  build_apps\n");
    const restartIndex = main.indexOf("\n  restart_services\n");

    expect(installIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(installIndex);
    expect(buildIndex).toBeGreaterThan(migrationIndex);
    expect(restartIndex).toBeGreaterThan(buildIndex);
    expect(deployScript).toContain("pnpm --filter @homelab/backend prisma:migrate:deploy");
    const databaseStage = deployScript.slice(deployScript.indexOf("run_database_migrations()"), deployScript.indexOf("build_apps()"));
    expect(databaseStage.indexOf("provider:migration:preflight")).toBeLessThan(databaseStage.indexOf("prisma:migrate:deploy"));
    expect(databaseStage.indexOf("prisma:migrate:deploy")).toBeLessThan(databaseStage.indexOf("provider:migration:validate"));
  });
});
