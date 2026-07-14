import { Inject, Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export const GFU29_COMMIT_BARRIER = Symbol("GFU29_COMMIT_BARRIER");

export interface CommitBarrier {
  beforeLock?(resource: string): Promise<void>;
  afterLock(resource: string): Promise<void>;
}

@Injectable()
export class PostgresCommitCoordinator {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(GFU29_COMMIT_BARRIER)
    private readonly barrier?: CommitBarrier
  ) {}

  run<T>(resource: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.barrier?.beforeLock?.(resource);
        await tx.$queryRaw(Prisma.sql`SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${resource}, 0))`);
        await this.barrier?.afterLock(resource);
        return work(tx);
      },
      { maxWait: 10_000, timeout: 30_000 }
    );
  }
}
