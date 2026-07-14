import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ChatTestControlService } from "./chat-test-control.service";
import { ChatTestOperatorGuard } from "./chat-test-operator.guard";

@Controller("test/chat-control/namespaces")
@UseGuards(JwtAuthGuard, ChatTestOperatorGuard)
export class ChatTestControlController {
  constructor(private readonly control: ChatTestControlService) {}

  @Post()
  create() {
    return this.control.createNamespace();
  }

  @Post(":id/reset")
  reset(@Param("id") id: string) {
    return this.control.reset(id);
  }

  @Put(":id/faults")
  setFaults(@Param("id") id: string, @Body() body: { faults?: Record<string, boolean> } & Record<string, unknown>) {
    return this.control.setFaults(id, (body.faults ?? body) as Record<string, boolean>);
  }

  @Put(":id/barriers/:key")
  enableBarrier(@Param("id") id: string, @Param("key") key: string) {
    return this.control.enableBarrier(id, key);
  }

  @Post(":id/barriers/:key/release")
  releaseBarrier(@Param("id") id: string, @Param("key") key: string) {
    return this.control.releaseBarrier(id, key);
  }

  @Post(":id/clock/advance")
  advanceClock(@Param("id") id: string, @Body() body: { milliseconds: number }) {
    return this.control.advanceClock(id, body.milliseconds);
  }

  @Get(":id/observations")
  observations(
    @Param("id") id: string,
    @Query("requestId") requestId?: string,
    @Query("executionId") executionId?: string
  ) {
    return { observations: this.control.observations(id, { requestId, executionId }) };
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    this.control.delete(id);
    return { deleted: true };
  }
}
