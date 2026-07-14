import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

type ControlRow = { clockMillis: bigint | number; adapter: any };

@Injectable()
export class Gfu29TestControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

  enabled(): boolean {
    return (
      this.config.get<string>("NODE_ENV") === "test" &&
      this.config.get<string>("GFU29_FIXTURE_ENABLED") === "true" &&
      Boolean(this.config.get<string>("GFU29_TEST_RUN_ID"))
    );
  }

  async holdSoulRun(content: string): Promise<void> {
    if (!this.enabled()) return;
    await this.waitAtBarrier("RUN-SOUL-V1-HELD", {
      soulHash: this.hash(content),
      runId: `run-${this.runId()}`
    });
  }

  async holdWorkflowClaim(snapshot: { workflowHash: string }): Promise<void> {
    if (!this.enabled()) return;
    await this.waitAtBarrier("CLAIM-WF-V1-SUSPENDED", {
      workflowHash: snapshot.workflowHash,
      taskId: `task-${this.runId()}`,
      claimId: `claim-${this.runId()}`
    });
  }

  async waitForClockAdvance(milliseconds: number): Promise<number> {
    if (!this.enabled()) return Date.now() + milliseconds;
    const initial = await this.read();
    const target = Number(initial.clockMillis) + milliseconds;
    initial.adapter.clockWaiters ??= {};
    initial.adapter.clockWaiters[this.config.get<string>("GFU29_TEST_CLOCK_ID", "runtime")] = {
      acknowledged: true,
      targetMillis: target
    };
    await this.write(initial.adapter);
    while (true) {
      const current = await this.read();
      if (Number(current.clockMillis) >= target) return Number(current.clockMillis);
      await this.pollTurn();
    }
  }

  async reloadSkills(activeConfigVersion?: string): Promise<{
    reloadStatus: "loaded" | "failed" | "pending_restart" | "runtime_offline";
    effectiveFor: "next_task";
  }> {
    if (!this.enabled()) return { reloadStatus: "pending_restart", effectiveFor: "next_task" };
    await this.waitForClockAdvance(1_000);
    const row = await this.read();
    const scenario = this.skillScenarioFrom(row.adapter);
    if (scenario.reloadStatus === "loaded") {
      row.adapter.runtimeLoadedVersion = activeConfigVersion ?? null;
      await this.write(row.adapter);
    }
    return {
      reloadStatus: scenario.reloadStatus,
      effectiveFor: "next_task"
    };
  }

  async beforeSkillRollback(): Promise<void> {
    if (!this.enabled()) return;
    if ((await this.activeSkillScenario()).rollback === "failed") {
      throw new Error("fixture skills rollback failed");
    }
  }

  async beforeSkillAuditFinalize(): Promise<void> {
    if (!this.enabled()) return;
    if ((await this.activeSkillScenario()).auditStatus === "audit_failed") {
      throw new Error("fixture skills audit finalize failed");
    }
  }

  private async waitAtBarrier(barrierId: string, observation: Record<string, unknown>): Promise<void> {
    const row = await this.read();
    const barrier = row.adapter.barriers[barrierId];
    if (!barrier) throw new Error(`GFU-29 barrier ${barrierId} is unavailable`);
    Object.assign(barrier, observation, { acknowledged: true });
    await this.write(row.adapter);
    while (true) {
      const current = await this.read();
      if (current.adapter.barriers[barrierId]?.barrierState === "released") return;
      await this.pollTurn();
    }
  }

  private async activeSkillScenario(): Promise<any> {
    const adapter = (await this.read()).adapter;
    return this.skillScenarioFrom(adapter);
  }

  private skillScenarioFrom(adapter: any): any {
    const name = adapter.activeSkillScenario ?? "pending_restart";
    const scenario = adapter.skillScenarios[name];
    if (!scenario) throw new Error("unknown GFU-29 skill scenario");
    return scenario;
  }

  private async read(): Promise<ControlRow> {
    const rows = await this.prisma.$queryRawUnsafe<ControlRow[]>(
      `SELECT "clockMillis", "adapter" FROM ${this.table()} WHERE "testRunId" = $1`,
      this.runId()
    );
    if (!rows[0]) throw new Error("GFU-29 test control row is unavailable");
    return rows[0];
  }

  private async write(adapter: any): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE ${this.table()} SET "adapter" = $1::jsonb, "updatedAt" = NOW() WHERE "testRunId" = $2`,
      JSON.stringify(adapter),
      this.runId()
    );
  }

  private runId(): string {
    return this.config.get<string>("GFU29_TEST_RUN_ID")!;
  }

  private table(): string {
    const namespace = this.config.get<string>("GFU29_DATABASE_NAMESPACE");
    if (!namespace || !/^[a-zA-Z0-9_]+$/.test(namespace)) throw new Error("GFU-29 database namespace is invalid");
    return `"${namespace}"."Gfu29TestControl"`;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  private pollTurn(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
  }
}
