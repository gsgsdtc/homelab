import { Body, Controller, Get, Headers, Param, Post, Res, UseFilters, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { RolesGuard } from "../../common/guards/roles.guard";
import { JwtUser } from "../../common/types/jwt-user";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ChatTestControlService } from "../chat-test-control/chat-test-control.service";
import { ChatApiExceptionFilter } from "./chat-api-exception.filter";
import { ChatSessionService } from "./chat-session.service";
import { ChatMessageDto } from "./dto/chat-message.dto";

@Controller("agents/:agentId/chat")
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(ChatApiExceptionFilter)
@Roles(UserRole.ADMIN)
export class ChatController {
  constructor(
    private readonly sessions: ChatSessionService,
    private readonly testControl: ChatTestControlService
  ) {}

  @Get("eligibility")
  eligibility(
    @Param("agentId") agentId: string,
    @Headers("x-chat-test-namespace") namespaceHeader?: string
  ) {
    const namespace = this.testControl.validateBusinessNamespace(namespaceHeader);
    return this.sessions.getEligibility(agentId, namespace);
  }

  @Post("sessions")
  createSession(
    @Param("agentId") agentId: string,
    @CurrentUser() user: JwtUser,
    @Headers("x-chat-test-namespace") namespaceHeader?: string
  ) {
    const namespace = this.testControl.validateBusinessNamespace(namespaceHeader);
    return this.sessions.createSession(user.sub, agentId, namespace);
  }

  @Post("sessions/:sessionId/messages")
  async sendMessage(
    @Param("agentId") agentId: string,
    @Param("sessionId") sessionId: string,
    @Body() dto: ChatMessageDto,
    @CurrentUser() user: JwtUser,
    @Res({ passthrough: true }) response: Pick<Response, "status">,
    @Headers("x-chat-test-namespace") namespaceHeader?: string
  ) {
    const namespace = this.testControl.validateBusinessNamespace(namespaceHeader);
    const result = await this.sessions.sendMessage(user.sub, agentId, sessionId, dto, namespace);
    response.status(result.httpStatus);
    return result.body;
  }
}
