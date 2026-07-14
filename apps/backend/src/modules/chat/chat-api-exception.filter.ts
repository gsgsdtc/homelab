import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Response } from "express";
import { ChatApiException } from "./chat.errors";

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

@Catch(ChatApiException)
export class ChatApiExceptionFilter implements ExceptionFilter<ChatApiException> {
  catch(exception: ChatApiException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse() as Record<string, unknown>;
    const requestId =
      typeof body.requestId === "string" && body.requestId.length > 0
        ? body.requestId
        : `req_${randomUUID()}`;
    const clientMessageId =
      typeof body.clientMessageId === "string" &&
      CLIENT_MESSAGE_ID_PATTERN.test(body.clientMessageId)
        ? body.clientMessageId
        : null;

    response.status(exception.getStatus()).json({
      ...body,
      requestId,
      clientMessageId,
    });
  }
}
