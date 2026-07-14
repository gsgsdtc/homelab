import { HttpException } from "@nestjs/common";
import { ChatExecutionError, ChatFailure } from "./chat.types";

export class ChatApiException extends HttpException {
  constructor(status: number, code: string, message: string, options: Record<string, unknown> = {}) {
    super(
      {
        requestId: options.requestId ?? null,
        executionId: options.executionId ?? null,
        clientMessageId: options.clientMessageId ?? null,
        status: "rejected",
        code,
        message,
        retryable: false
      },
      status
    );
  }
}

export function executionError(failure: ChatFailure): ChatExecutionError {
  return Object.assign(new Error(failure.message), { chatFailure: failure });
}

export function failureFrom(error: unknown): ChatFailure {
  const failure = (error as Partial<ChatExecutionError> | undefined)?.chatFailure;
  if (failure) {
    return failure;
  }
  return {
    httpStatus: 500,
    code: "INTERNAL_ERROR",
    message: "Chat execution failed",
    retryable: true
  };
}
