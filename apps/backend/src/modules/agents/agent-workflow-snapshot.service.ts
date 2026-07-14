import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface AgentWorkflowClaimSnapshot {
  agentWorkflowId: string;
  workflowKey: string;
  workflowHash: string;
  workflowVersionId: string;
}

@Injectable()
export class AgentWorkflowSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

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
    return {
      agentWorkflowId: workflow.id,
      workflowKey: workflow.workflowKey,
      workflowHash: workflow.activeHash,
      workflowVersionId: version.id
    };
  }
}
