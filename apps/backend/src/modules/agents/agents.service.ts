import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  Optional,
  UnprocessableEntityException
} from "@nestjs/common";
import { Agent, AgentStatus, Prisma } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { ModelProvidersService } from "../model-providers/model-providers.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentSoulRead, AgentWorkspaceService } from "./agent-workspace.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
import { SaveAgentSoulDto } from "./dto/save-agent-soul.dto";
import { UpdateAgentDto } from "./dto/update-agent.dto";
import { PostgresCommitCoordinator } from "./postgres-commit-coordinator";
import { Gfu29TestControlService } from "./gfu29-test-control.service";

const SOUL_MAX_BYTES = 65_536;

export interface AgentListQuery {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface AgentProviderSummary {
  id: string | null;
  name: string | null;
  source: "explicit" | "default" | "invalid";
}

export interface AgentInitError {
  code: "WORKSPACE_INITIALIZATION_FAILED";
  message: string;
}

type AgentRecord = Agent & {
  provider?: { id: string; name: string; isActive: boolean } | null;
};

export interface PublicAgent {
  id: string;
  name: string;
  slug: string;
  status: AgentStatus;
  providerSummary: AgentProviderSummary;
  modelProviderId: string | null;
  workspacePath: string;
  workspaceName: string;
  gitStatus: "clean" | "dirty" | "unavailable" | "available";
  updatedAt: Date;
  revision: number;
  initError: AgentInitError | null;
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: AgentWorkspaceService,
    @Optional()
    @Inject(ModelProvidersService)
    private readonly providers?: ModelProvidersService,
    @Optional()
    private readonly commits?: PostgresCommitCoordinator,
    @Optional()
    private readonly testControl?: Gfu29TestControlService
  ) {}

  async list(input?: AgentListQuery) {
    const legacyArrayResponse = input === undefined;
    input ??= {};
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    if (!Number.isInteger(page) || page < 1 || ![20, 50, 100].includes(pageSize)) {
      throw new BadRequestException({
        code: "INVALID_PAGINATION",
        message: "invalid Agent pagination"
      });
    }
    const query = input.query?.trim();
    const where: Prisma.AgentWhereInput = query
      ? {
          OR: [{ name: { contains: query, mode: "insensitive" } }, { slug: { contains: query, mode: "insensitive" } }]
        }
      : {};
    const [agents, total, defaultProvider] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        include: {
          provider: { select: { id: true, name: true, isActive: true } }
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.agent.count({ where }),
      this.prisma.modelProvider.findFirst({
        where: { isDefault: true, isActive: true },
        select: { id: true, name: true, isActive: true }
      })
    ]);
    const response = {
      items: agents.map((agent) => this.toPublic(agent, defaultProvider)),
      total,
      page,
      pageSize
    };
    return legacyArrayResponse ? response.items : response;
  }

  async get(id: string): Promise<PublicAgent> {
    const agent = await this.findAgent(id);
    const [defaultProvider, soul] = await Promise.all([this.findDefaultProvider(), this.workspaces.readSoul(agent)]);
    return {
      ...this.toPublic(agent, defaultProvider),
      soul: soul.content,
      soulFileStatus: soul.status,
      ...(soul.message ? { soulFileError: soul.message } : {})
    } as PublicAgent;
  }

  async create(dto: CreateAgentDto, idempotencyKey?: string): Promise<PublicAgent> {
    const payloadHash = this.payloadHash(dto);
    if (idempotencyKey) {
      const replay = await this.findCreateReplay(idempotencyKey, payloadHash);
      if (replay) return replay;
    }

    const providerId = dto.modelProviderId ?? dto.modelProvider ?? null;
    await this.resolveProvider(providerId);
    for (const [field, value] of [
      ["name", dto.name],
      ["slug", dto.slug],
      ["modelProviderId", providerId],
      ["modelSecretRef", dto.modelSecretRef],
      ["soul", dto.soul]
    ] as Array<[string, string | null | undefined]>) {
      if (value) this.assertNoSecretLeak(value, field);
    }
    const slug = this.buildSlug(dto.slug ?? dto.name);
    const id = randomUUID();
    const descriptor = this.workspaces.buildDescriptor(slug, id);
    const soul = dto.soul ?? `# ${dto.name}\n`;

    let created: AgentRecord;
    try {
      created = await this.transaction(async (tx) => {
        const agent = await tx.agent.create({
          data: {
            id,
            name: dto.name.trim(),
            slug,
            status: AgentStatus.initializing,
            workspaceName: descriptor.workspaceName,
            workspacePath: descriptor.relativeWorkspacePath,
            modelProviderId: providerId,
            modelProvider: providerId,
            modelSecretRef: dto.modelSecretRef ?? null,
            soul
          }
        });
        if (idempotencyKey) {
          await tx.agentCreateRequest.create({
            data: { key: idempotencyKey, payloadHash, agentId: id }
          });
        }
        return agent;
      });
    } catch (error) {
      if (idempotencyKey && this.isUniqueError(error)) {
        const replay = await this.findCreateReplay(idempotencyKey, payloadHash);
        if (replay) return replay;
      }
      throw error;
    }

    const initialized = await this.initializeAgent(created, false);
    return this.toPublic(initialized, await this.findDefaultProvider());
  }

  async update(id: string, dto: UpdateAgentDto): Promise<PublicAgent> {
    if (dto.expectedRevision === undefined) {
      throw new BadRequestException({
        code: "REVISION_REQUIRED",
        message: "expectedRevision is required"
      });
    }
    return this.withCommit(`agent:${id}`, (tx) => this.updateLocked(tx, id, dto));
  }

  private async updateLocked(tx: Prisma.TransactionClient, id: string, dto: UpdateAgentDto): Promise<PublicAgent> {
    for (const [field, value] of [
      ["name", dto.name],
      ["modelProviderId", dto.modelProviderId ?? dto.modelProvider],
      ["modelSecretRef", dto.modelSecretRef],
      ["soul", dto.soul]
    ] as Array<[string, string | null | undefined]>) {
      if (value) this.assertNoSecretLeak(value, field);
    }
    const previous = await this.findAgentWith(tx, id);
    const expectedRevision = dto.expectedRevision;
    if (previous.revision !== expectedRevision) {
      throw this.revisionConflict(previous.revision);
    }
    const providerId =
      dto.modelProviderId === undefined && dto.modelProvider === undefined ? previous.modelProviderId : (dto.modelProviderId ?? dto.modelProvider ?? null);
    await this.resolveProvider(providerId);
    const candidate: Agent = {
      ...previous,
      name: dto.name?.trim() ?? previous.name,
      modelProviderId: providerId,
      modelProvider: providerId,
      modelSecretRef: dto.modelSecretRef === undefined ? previous.modelSecretRef : dto.modelSecretRef,
      soul: dto.soul === undefined ? previous.soul : dto.soul,
      revision: expectedRevision + 1
    };
    try {
      await this.workspaces.syncWorkspace(candidate, previous);
    } catch (error) {
      throw new ConflictException({
        code: "AGENT_UPDATE_FAILED",
        message: this.safeError(error)
      });
    }

    try {
      const result = await this.updateManyOn(tx, {
        where: { id, revision: expectedRevision },
        data: {
          name: candidate.name,
          modelProviderId: providerId,
          modelProvider: providerId,
          modelSecretRef: candidate.modelSecretRef,
          soul: candidate.soul,
          revision: { increment: 1 }
        }
      });
      if (result.count !== 1) {
        const current = await this.findAgentWith(tx, id);
        throw this.revisionConflict(current.revision);
      }
    } catch (error) {
      await Promise.resolve(this.workspaces.syncWorkspace(previous, candidate)).catch(() => undefined);
      throw error;
    }

    const updated = await this.findAgentWith(tx, id);
    return this.toPublic(updated, await this.findDefaultProvider());
  }

  async getSoul(id: string) {
    const agent = await this.findAgent(id);
    const soul = await this.workspaces.readSoul(agent);
    if (soul.status === "error" || soul.content === null) {
      throw new ConflictException({
        code: "SOUL_READ_FAILED",
        message: soul.message ?? "Soul read failed"
      });
    }
    return {
      content: soul.content,
      missing: soul.status === "missing",
      revision: agent.soulRevision,
      maxBytes: SOUL_MAX_BYTES
    };
  }

  async saveSoul(id: string, dto: SaveAgentSoulDto) {
    if (dto.expectedRevision === undefined) {
      throw new BadRequestException({
        code: "SOUL_REVISION_REQUIRED",
        message: "expectedRevision is required"
      });
    }
    return this.withCommit(`soul:${id}`, (tx) => this.saveSoulLocked(tx, id, dto));
  }

  private async saveSoulLocked(tx: Prisma.TransactionClient, id: string, dto: SaveAgentSoulDto) {
    const content = dto.content ?? dto.soul ?? "";
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > SOUL_MAX_BYTES) {
      throw new PayloadTooLargeException({
        code: "SOUL_TOO_LARGE",
        message: "Soul exceeds 65536 UTF-8 bytes"
      });
    }
    if (!content.trim()) {
      throw new BadRequestException({
        code: "SOUL_BLANK",
        message: "Soul content must not be blank"
      });
    }
    this.assertNoSecretLeak(content, "content");
    const agent = await this.findAgentWith(tx, id);
    this.assertReady(agent);
    const expectedRevision = dto.expectedRevision;
    if (agent.soulRevision !== expectedRevision) {
      throw new ConflictException({
        code: "SOUL_REVISION_CONFLICT",
        message: "Soul revision conflict",
        currentRevision: agent.soulRevision
      });
    }
    const previousSoul = await this.workspaces.readSoul(agent);
    if (previousSoul.status === "error" || previousSoul.content === null) {
      throw new ConflictException({
        code: "SOUL_READ_FAILED",
        message: "Soul read failed"
      });
    }
    await this.workspaces.writeSoul(agent, content);
    try {
      const updated = await this.updateManyOn(tx, {
        where: {
          id,
          status: AgentStatus.ready,
          soulRevision: expectedRevision
        },
        data: { soul: content, soulRevision: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new ConflictException({
          code: "SOUL_REVISION_CONFLICT",
          message: "Soul revision conflict"
        });
      }
    } catch (error) {
      await this.rollbackSoulWrite(agent, previousSoul);
      throw error;
    }
    const updated = await this.findAgentWith(tx, id);
    return {
      content,
      missing: false,
      revision: updated.soulRevision,
      maxBytes: SOUL_MAX_BYTES
    };
  }

  async loadSoulForRun(id: string): Promise<string> {
    const agent = await this.findAgent(id);
    const content = await this.workspaces.readSoulForRun(agent);
    await this.testControl?.holdSoulRun(content);
    return content;
  }

  async retryInitialization(id: string): Promise<PublicAgent> {
    return this.withCommit(`initialization:${id}`, () => this.retryInitializationLocked(id));
  }

  private async retryInitializationLocked(id: string): Promise<PublicAgent> {
    const existing = await this.findAgent(id);
    if (existing.status === AgentStatus.initializing) {
      throw new ConflictException({
        code: "INITIALIZATION_IN_PROGRESS",
        message: "Agent initialization is already in progress"
      });
    }
    if (existing.status !== AgentStatus.init_failed) {
      throw new ConflictException({
        code: "INITIALIZATION_NOT_RETRYABLE",
        message: "Only failed Agent initialization can be retried"
      });
    }
    const acquired = await this.updateMany({
      where: { id, status: { not: AgentStatus.initializing } },
      data: { status: AgentStatus.initializing, initializationError: null }
    });
    if (acquired.count !== 1) {
      throw new ConflictException({
        code: "INITIALIZATION_IN_PROGRESS",
        message: "Agent initialization is already in progress"
      });
    }
    const retried = this.hasWorkspaceUserEditConflict(existing)
      ? await this.syncAgentWorkspace(existing, existing)
      : await this.initializeAgent(existing, true, true);
    return this.toPublic(retried, await this.findDefaultProvider());
  }

  assertReady(agent: Pick<Agent, "status">): void {
    if (agent.status !== AgentStatus.ready) {
      throw new ConflictException({
        code: "AGENT_NOT_READY",
        message: "Agent is not ready"
      });
    }
  }

  private async initializeAgent(agent: Agent, allowExistingWorkspace: boolean, alreadyInitializing = false): Promise<Agent> {
    if (!alreadyInitializing) {
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: { status: AgentStatus.initializing, initializationError: null }
      });
    }
    try {
      await this.workspaces.initializeWorkspace(agent, {
        allowExistingWorkspace
      });
      return await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.ready,
          initializationError: null,
          initializedAt: new Date()
        }
      });
    } catch (error) {
      return this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.init_failed,
          initializationError: this.safeError(error)
        }
      });
    }
  }

  private async syncAgentWorkspace(agent: Agent, previousAgent: Agent): Promise<Agent> {
    try {
      await this.workspaces.syncWorkspace(agent, previousAgent);
      return await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.ready,
          initializationError: null,
          initializedAt: new Date()
        }
      });
    } catch (error) {
      return this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: AgentStatus.init_failed,
          initializationError: this.safeError(error)
        }
      });
    }
  }

  private async findAgent(id: string): Promise<AgentRecord> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: {
        provider: { select: { id: true, name: true, isActive: true } }
      }
    });
    if (!agent)
      throw new NotFoundException({
        code: "AGENT_NOT_FOUND",
        message: "Agent not found"
      });
    return agent;
  }

  private async findAgentWith(tx: Prisma.TransactionClient, id: string): Promise<AgentRecord> {
    const agent = await tx.agent.findUnique({
      where: { id },
      include: {
        provider: { select: { id: true, name: true, isActive: true } }
      }
    });
    if (!agent)
      throw new NotFoundException({
        code: "AGENT_NOT_FOUND",
        message: "Agent not found"
      });
    return agent;
  }

  private async findDefaultProvider() {
    if (!(this.prisma as any).modelProvider?.findFirst) return null;
    return this.prisma.modelProvider.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true, name: true, isActive: true }
    });
  }

  private async resolveProvider(providerId: string | null): Promise<void> {
    if (!this.providers) return;
    try {
      await this.providers.resolveProviderForAgent(providerId ?? undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const code = providerId ? (message.includes("disabled") ? "PROVIDER_DISABLED" : "PROVIDER_NOT_FOUND") : "PROVIDER_REQUIRED";
      throw new UnprocessableEntityException({
        code,
        message: this.providerErrorMessage(code)
      });
    }
  }

  private async findCreateReplay(key: string, payloadHash: string): Promise<PublicAgent | null> {
    const request = await this.prisma.agentCreateRequest.findUnique({
      where: { key },
      include: {
        agent: {
          include: {
            provider: { select: { id: true, name: true, isActive: true } }
          }
        }
      }
    });
    if (!request) return null;
    if (request.payloadHash !== payloadHash) {
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key was already used with a different payload"
      });
    }
    return this.toPublic(request.agent, await this.findDefaultProvider());
  }

  private toPublic(agent: AgentRecord, defaultProvider: { id: string; name: string; isActive: boolean } | null): PublicAgent {
    return {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      status: agent.status,
      providerSummary: this.providerSummary(agent, defaultProvider),
      modelProviderId: agent.modelProviderId,
      workspacePath: agent.workspacePath,
      workspaceName: agent.workspaceName,
      gitStatus: this.workspaces.getGitStatus(agent),
      updatedAt: agent.updatedAt,
      revision: agent.revision,
      initError: this.toInitError(agent)
    };
  }

  private providerSummary(agent: AgentRecord, defaultProvider: { id: string; name: string; isActive: boolean } | null): AgentProviderSummary {
    if (agent.modelProviderId) {
      if (agent.provider?.isActive) {
        return {
          id: agent.provider.id,
          name: agent.provider.name,
          source: "explicit"
        };
      }
      return {
        id: agent.modelProviderId,
        name: agent.provider?.name ?? null,
        source: "invalid"
      };
    }
    return defaultProvider
      ? {
          id: defaultProvider.id,
          name: defaultProvider.name,
          source: "default"
        }
      : { id: null, name: null, source: "invalid" };
  }

  private payloadHash(dto: CreateAgentDto): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          name: dto.name.trim(),
          slug: dto.slug?.trim() ?? null,
          modelProviderId: dto.modelProviderId ?? null
        })
      )
      .digest("hex");
  }

  private buildSlug(input: string): string {
    const slug = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug)
      throw new BadRequestException({
        code: "INVALID_AGENT_SLUG",
        message: "Agent slug is invalid"
      });
    return slug;
  }

  private assertNoSecretLeak(value: string, field: string): void {
    if (this.looksLikeSecret(value)) {
      throw new BadRequestException({
        code: "SECRET_VALUE_REJECTED",
        message: `${field} must not contain secrets`
      });
    }
  }

  private looksLikeSecret(value: string): boolean {
    return [
      /sk-[A-Za-z0-9_-]{8,}/,
      /xox[baprs]-[A-Za-z0-9-]{8,}/,
      /gh[pousr]_[A-Za-z0-9_]{8,}/,
      /AKIA[0-9A-Z]{16}/,
      /AIza[0-9A-Za-z_-]{20,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
    ].some((pattern) => pattern.test(value));
  }

  private revisionConflict(currentRevision: number) {
    return new ConflictException({
      code: "REVISION_CONFLICT",
      message: "Agent revision conflict",
      currentRevision
    });
  }

  private hasWorkspaceUserEditConflict(agent: Agent): boolean {
    return agent.status === AgentStatus.init_failed && (agent.initializationError ?? "").startsWith("workspace file has user edits:");
  }

  private async rollbackSoulWrite(agent: Agent, previousSoul: AgentSoulRead): Promise<void> {
    if (previousSoul.status === "missing") {
      await this.workspaces.deleteSoul(agent);
    } else {
      await this.workspaces.writeSoul(agent, previousSoul.content ?? "");
    }
  }

  private toInitError(agent: Agent): AgentInitError | null {
    if (agent.status !== AgentStatus.init_failed) return null;
    return {
      code: "WORKSPACE_INITIALIZATION_FAILED",
      message: agent.initializationError || "Workspace initialization failed"
    };
  }

  private safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : "Operation failed";
    return raw
      .replace(/(?:\/[\w.@+-]+){2,}/g, "[path]")
      .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g, "[path]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[secret]")
      .slice(0, 240);
  }

  private providerErrorMessage(code: string): string {
    if (code === "PROVIDER_DISABLED") return "Selected Provider is disabled";
    if (code === "PROVIDER_REQUIRED") return "An enabled default Provider is required";
    return "Selected Provider was not found";
  }

  private isUniqueError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const transaction = (this.prisma as any).$transaction;
    return transaction ? transaction.call(this.prisma, callback) : callback(this.prisma as unknown as Prisma.TransactionClient);
  }

  private withCommit<T>(resource: string, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.commits ? this.commits.run(resource, callback) : callback(this.prisma as unknown as Prisma.TransactionClient);
  }

  private async updateManyOn(db: Prisma.TransactionClient, args: Prisma.AgentUpdateManyArgs): Promise<{ count: number }> {
    if (typeof (db.agent as any).updateMany === "function") return (db.agent as any).updateMany(args);
    const where = args.where as { id?: string } | undefined;
    await db.agent.update({
      where: { id: where?.id ?? "" },
      data: args.data as Prisma.AgentUpdateInput
    });
    return { count: 1 };
  }

  private async updateMany(args: Prisma.AgentUpdateManyArgs): Promise<{ count: number }> {
    if (typeof (this.prisma.agent as any).updateMany === "function") {
      return (this.prisma.agent as any).updateMany(args);
    }
    const where = args.where as { id?: string } | undefined;
    await this.prisma.agent.update({
      where: { id: where?.id ?? "" },
      data: args.data as Prisma.AgentUpdateInput
    });
    return { count: 1 };
  }
}
