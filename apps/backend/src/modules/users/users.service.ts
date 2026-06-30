import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { PasswordService } from "./password.service";

export type PublicUser = Omit<User, "passwordHash">;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService
  ) {}

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async list(query: ListUsersDto) {
    const where: Prisma.UserWhereInput = query.q
      ? { username: { contains: query.q, mode: "insensitive" } }
      : {};
    const skip = (query.page - 1) * query.pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: { createdAt: "desc" },
        select: this.publicSelect()
      }),
      this.prisma.user.count({ where })
    ]);

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize
    };
  }

  async create(dto: CreateUserDto): Promise<PublicUser> {
    const passwordHash = await this.passwords.hash(dto.password);

    try {
      return await this.prisma.user.create({
        data: {
          username: dto.username,
          passwordHash,
          role: dto.role ?? "USER",
          isActive: dto.isActive ?? true
        },
        select: this.publicSelect()
      });
    } catch (error) {
      if (this.isUniqueError(error)) {
        throw new ConflictException("username already exists");
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateUserDto): Promise<PublicUser> {
    await this.ensureExists(id);
    try {
      return await this.prisma.user.update({
        where: { id },
        data: dto,
        select: this.publicSelect()
      });
    } catch (error) {
      if (this.isUniqueError(error)) {
        throw new ConflictException("username already exists");
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await this.ensureExists(id);
    await this.prisma.user.delete({ where: { id } });
  }

  async resetPassword(id: string, dto: ResetPasswordDto): Promise<void> {
    await this.ensureExists(id);
    const passwordHash = await this.passwords.hash(dto.password);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash }
    });
  }

  toPublic(user: User): PublicUser {
    const { passwordHash: _passwordHash, ...publicUser } = user;
    return publicUser;
  }

  private async ensureExists(id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) {
      throw new NotFoundException("user not found");
    }
  }

  private publicSelect() {
    return {
      id: true,
      username: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true
    } satisfies Prisma.UserSelect;
  }

  private isUniqueError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
