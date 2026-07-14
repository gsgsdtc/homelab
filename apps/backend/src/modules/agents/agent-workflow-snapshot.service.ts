import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Gfu29TestControlService } from "./gfu29-test-control.service";

export interface AgentWorkflowClaimSnapshot {
  agentWorkflowId: string;
  workflowKey: string;
  workflowHash: string;
  workflowVersionId: string;
}

@Injectable()
export class AgentWorkflowSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly testControl?: Gfu29TestControlService
  ) {}

  async getClaimSnapshot(agentId: string, workflowKey = "default"): Promise<AgentWorkflowClaimSnapshot> {
    const workflow = await this.prisma.agentWorkflow.findFirst({
      where: {
        agentId,
        workflowKey
      }
    });
    if (!workflow?.activeHash) {
      throw new BadRequestException("current Agent has no active workflow for claim");
    }
    const version = await this.prisma.agentWorkflowVersion.findFirst({
      where: {
        workflowId: workflow.id,
        sourceHash: workflow.activeHash
      },
      orderBy: { promotedAt: "desc" }
    });
    if (!version) {
      throw new BadRequestException("active workflow version is unavailable");
    }
    const snapshot = {
      agentWorkflowId: workflow.id,
      workflowKey: workflow.workflowKey,
      workflowHash: workflow.activeHash,
      workflowVersionId: version.id
    };
    await this.testControl?.holdWorkflowClaim(snapshot);
    return snapshot;
  }
}
