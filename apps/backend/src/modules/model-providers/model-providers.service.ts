import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ModelProvider, ModelProviderType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateModelProviderDto } from "./dto/create-model-provider.dto";
import { TestModelProviderConnectionDto } from "./dto/test-model-provider-connection.dto";
import { UpdateModelProviderDto } from "./dto/update-model-provider.dto";
import { ModelProviderConnectionTester, TestProviderConnectionResult } from "./model-provider-connection-tester.service";
import { ModelProviderCredentialsService } from "./model-provider-credentials.service";

export type PublicModelProvider = Omit<ModelProvider, "encryptedApiKey"> & { hasApiKey: boolean };

export interface ResolvedModelProvider {
  id: string;
  name: string;
  type: ModelProviderType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

@Injectable()
export class ModelProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: Pick<ModelProviderCredentialsService, "encrypt" | "decrypt">,
    private readonly connectionTester: Pick<ModelProviderConnectionTester, "test">
  ) {}

  list(): Promise<PublicModelProvider[]> {
    return this.prisma.modelProvider
      .findMany({
        orderBy: { createdAt: "desc" },
        select: this.privateSelect()
      })
      .then((providers) => providers.map((provider) => this.toPublic(provider)));
  }

  async create(dto: CreateModelProviderDto): Promise<PublicModelProvider> {
    const name = this.requiredTrim(dto.name, "name is required");
    const defaultModel = this.requiredTrim(dto.defaultModel, "default model is required");
    const apiKey = this.requiredTrim(dto.apiKey, "api key is required");
    const data = {
      name,
      nameKey: this.nameKey(name),
      type: dto.type ?? ModelProviderType.OPENAI_COMPATIBLE,
      baseUrl: this.normalizeBaseUrl(dto.baseUrl),
      encryptedApiKey: this.credentials.encrypt(apiKey),
      defaultModel,
      isActive: dto.isActive ?? true
    };

    try {
      const provider = await this.prisma.modelProvider.create({
        data,
        select: this.privateSelect()
      });
      return this.toPublic(provider);
    } catch (error) {
      if (this.isUniqueError(error)) {
        throw new ConflictException("provider name already exists");
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateModelProviderDto): Promise<PublicModelProvider> {
    await this.ensureExists(id);
    if (dto.isActive === false) {
      await this.ensureCanDisable(id);
    }

    const data: Prisma.ModelProviderUpdateInput = {};
    if (dto.name !== undefined) {
      const name = this.requiredTrim(dto.name, "name is required");
      data.name = name;
      data.nameKey = this.nameKey(name);
    }
    if (dto.type !== undefined) {
      data.type = dto.type;
    }
    if (dto.baseUrl !== undefined) {
      data.baseUrl = this.normalizeBaseUrl(dto.baseUrl);
    }
    if (dto.defaultModel !== undefined) {
      data.defaultModel = this.requiredTrim(dto.defaultModel, "default model is required");
    }
    if (dto.apiKey !== undefined && dto.apiKey.trim()) {
      data.encryptedApiKey = this.credentials.encrypt(dto.apiKey.trim());
    }
    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }

    try {
      const provider = await this.prisma.modelProvider.update({
        where: { id },
        data,
        select: this.privateSelect()
      });
      return this.toPublic(provider);
    } catch (error) {
      if (this.isUniqueError(error)) {
        throw new ConflictException("provider name already exists");
      }
      throw error;
    }
  }

  async setActive(id: string, isActive: boolean): Promise<PublicModelProvider> {
    await this.ensureExists(id);
    if (!isActive) {
      await this.ensureCanDisable(id);
    }

    const provider = await this.prisma.modelProvider.update({
      where: { id },
      data: { isActive },
      select: this.privateSelect()
    });
    return this.toPublic(provider);
  }

  async setDefault(id: string): Promise<PublicModelProvider> {
    return this.prisma.$transaction(async (tx) => {
      const existingProvider = await tx.modelProvider.findUnique({ where: { id }, select: { id: true, isActive: true } });
      if (!existingProvider) {
        throw new NotFoundException("provider not found");
      }
      if (!existingProvider.isActive) {
        throw new BadRequestException("disabled provider cannot be default");
      }

      await tx.modelProvider.updateMany({ data: { isDefault: false } });
      const provider = await tx.modelProvider.update({
        where: { id },
        data: { isDefault: true },
        select: this.privateSelect()
      });
      return this.toPublic(provider);
    });
  }

  async resolveProviderForAgent(agentProviderId?: string): Promise<ResolvedModelProvider> {
    if (agentProviderId) {
      const provider = await this.prisma.modelProvider.findUnique({ where: { id: agentProviderId } });
      if (!provider) {
        throw new NotFoundException("agent model provider not found");
      }
      if (!provider.isActive) {
        throw new BadRequestException("agent model provider is disabled");
      }
      return this.toResolved(provider);
    }

    const provider = await this.prisma.modelProvider.findFirst({
      where: { isDefault: true, isActive: true }
    });
    if (!provider) {
      throw new NotFoundException("enabled default model provider is not configured");
    }
    return this.toResolved(provider);
  }

  async testConnection(dto: TestModelProviderConnectionDto): Promise<TestProviderConnectionResult> {
    const input = dto.providerId ? await this.connectionInputFromSavedProvider(dto.providerId) : this.connectionInputFromDto(dto);
    const result = await this.connectionTester.test(input);
    return result.ok ? result : { ok: false, error: this.sanitizeError(result.error ?? "connection test failed") };
  }

  private async connectionInputFromSavedProvider(providerId: string) {
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        baseUrl: true,
        encryptedApiKey: true,
        defaultModel: true
      }
    });
    if (!provider) {
      throw new NotFoundException("provider not found");
    }

    return {
      baseUrl: provider.baseUrl,
      apiKey: this.credentials.decrypt(provider.encryptedApiKey),
      model: provider.defaultModel
    };
  }

  private connectionInputFromDto(dto: TestModelProviderConnectionDto) {
    return {
      baseUrl: this.normalizeBaseUrl(this.requiredTrim(dto.baseUrl, "base url is required")),
      apiKey: this.requiredTrim(dto.apiKey, "api key is required"),
      model: this.requiredTrim(dto.defaultModel, "default model is required")
    };
  }

  private toResolved(provider: ModelProvider): ResolvedModelProvider {
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: this.credentials.decrypt(provider.encryptedApiKey),
      defaultModel: provider.defaultModel
    };
  }

  private async ensureExists(id: string) {
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id },
      select: { id: true }
    });
    if (!provider) {
      throw new NotFoundException("provider not found");
    }
  }

  private async ensureCanDisable(id: string) {
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id },
      select: { id: true, isDefault: true }
    });
    if (!provider) {
      throw new NotFoundException("provider not found");
    }
    if (provider.isDefault) {
      throw new BadRequestException("default provider cannot be disabled");
    }
  }

  private privateSelect() {
    return {
      id: true,
      name: true,
      nameKey: true,
      type: true,
      baseUrl: true,
      defaultModel: true,
      isActive: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true,
      encryptedApiKey: true
    } satisfies Prisma.ModelProviderSelect;
  }

  private toPublic(provider: ModelProvider): PublicModelProvider {
    const { encryptedApiKey: _encryptedApiKey, ...publicProvider } = provider;
    return {
      ...publicProvider,
      hasApiKey: Boolean(_encryptedApiKey)
    };
  }

  private normalizeBaseUrl(value: string): string {
    const parsed = new URL(this.requiredTrim(value, "base url is required"));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BadRequestException("base url must use HTTP or HTTPS");
    }
    return parsed.toString().replace(/\/+$/, "");
  }

  private requiredTrim(value: string | undefined, message: string): string {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) {
      throw new BadRequestException(message);
    }
    return trimmed;
  }

  private nameKey(name: string): string {
    return name.trim().toLocaleLowerCase("en-US");
  }

  private sanitizeError(value: string): string {
    return value
      .replace(/Bearer\s+[^\s,;]+/gi, "[redacted authorization]")
      .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted api key]")
      .replace(/v1:[A-Za-z0-9+/=_-]+:[A-Za-z0-9+/=_-]+:[A-Za-z0-9+/=_-]+/g, "[redacted credential]");
  }

  private isUniqueError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
