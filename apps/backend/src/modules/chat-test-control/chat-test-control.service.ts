import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { ChatApiException } from "../chat/chat.errors";

export const CHAT_TEST_EPOCH = Date.parse("2020-01-01T00:00:00.000Z");
export const CHAT_TEST_COUNTERS = [
  "snapshotAttempts",
  "adapterCalls",
  "runtimeCalls",
  "modelCalls",
  "idempotentReplays"
] as const;
export type ChatTestCounter = (typeof CHAT_TEST_COUNTERS)[number];

export const CHAT_TEST_BARRIERS = [
  "afterInitialVector",
  "afterProviderLoad",
  "afterSoulLoad",
  "afterSkillsLoad",
  "afterWorkflowLoad",
  "beforeFinalVector",
  "beforeExecute",
  "afterExecuteBeforeCommit",
  "afterTimeoutBeforeLateResult"
] as const;
export type ChatTestBarrierKey = (typeof CHAT_TEST_BARRIERS)[number];
export const CHAT_TEST_FAULTS = [
  "config_read_error",
  "runtime_unavailable",
  "provider_401",
  "model_not_found",
  "provider_429",
  "provider_5xx",
  "transport_error",
  "provider_4xx",
  "invalid_json",
  "empty_output",
  "oversized_body",
  "oversized_reply",
  "timeout",
  "late_success"
] as const;

interface BarrierState {
  enabled: boolean;
  waiters: Array<() => void>;
}

interface ClockWaiter {
  target: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface NamespaceState {
  id: string;
  now: number;
  lastTouchedAt: number;
  faults: Record<string, boolean>;
  counters: Record<ChatTestCounter, number>;
  observations: Array<Record<string, unknown>>;
  barriers: Map<ChatTestBarrierKey, BarrierState>;
  clockWaiters: Map<symbol, ClockWaiter>;
  generation: number;
}

@Injectable()
export class ChatTestControlService {
  private readonly namespaces = new Map<string, NamespaceState>();
  private readonly resetHandlers = new Set<(namespace: string, nextGeneration: number) => void>();
  private readonly enabled: boolean;

  constructor(options: { enabled?: boolean } = {}) {
    this.enabled = options.enabled ?? false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  createNamespace() {
    this.assertEnabled();
    this.cleanup();
    const id = randomUUID();
    const state = this.freshState(id);
    this.namespaces.set(id, state);
    return { id, now: state.now };
  }

  reset(id: string) {
    const current = this.requireNamespace(id);
    for (const barrier of current.barriers.values()) {
      barrier.waiters.splice(0).forEach((release) => release());
    }
    for (const waiter of current.clockWaiters.values()) waiter.reject(this.resetError());
    current.clockWaiters.clear();
    const reset = this.freshState(id, current.generation + 1);
    this.namespaces.set(id, reset);
    for (const handler of this.resetHandlers) handler(id, reset.generation);
    return this.publicState(reset);
  }

  registerResetHandler(handler: (namespace: string, nextGeneration: number) => void): () => void {
    this.resetHandlers.add(handler);
    return () => this.resetHandlers.delete(handler);
  }

  delete(id: string): void {
    const state = this.requireNamespace(id);
    for (const barrier of state.barriers.values()) {
      barrier.waiters.splice(0).forEach((release) => release());
    }
    for (const waiter of state.clockWaiters.values()) waiter.resolve();
    state.clockWaiters.clear();
    this.namespaces.delete(id);
  }

  getNamespace(id: string) {
    return this.publicState(this.requireNamespace(id));
  }

  listActiveNamespaces(): string[] {
    this.cleanup();
    return [...this.namespaces.keys()].sort();
  }

  now(id?: string, expectedGeneration?: number): number {
    return id ? this.requireNamespace(id, expectedGeneration).now : Date.now();
  }

  generation(id?: string): number {
    return id ? this.requireNamespace(id).generation : 0;
  }

  advanceClock(id: string, milliseconds: number) {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) {
      throw new ChatApiException(400, "INVALID_CLOCK_ADVANCE", "Clock advance must be a non-negative integer");
    }
    const state = this.requireNamespace(id);
    state.now += milliseconds;
    for (const [key, waiter] of state.clockWaiters) {
      if (waiter.target <= state.now) {
        state.clockWaiters.delete(key);
        waiter.resolve();
      }
    }
    this.touch(state);
    return { now: state.now };
  }

  waitForClock(id: string, target: number, expectedGeneration?: number): { promise: Promise<void>; cancel: () => void } {
    const state = this.requireNamespace(id, expectedGeneration);
    if (!Number.isFinite(target) || target <= state.now) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }
    const key = Symbol("chat-clock-waiter");
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    state.clockWaiters.set(key, { target, resolve, reject });
    this.touch(state);
    return {
      promise,
      cancel: () => {
        state.clockWaiters.delete(key);
      }
    };
  }

  setFaults(id: string, faults: Record<string, boolean>) {
    const unsupported = Object.keys(faults).find((fault) => !(CHAT_TEST_FAULTS as readonly string[]).includes(fault));
    if (unsupported) {
      throw new ChatApiException(400, "INVALID_FAULT", "Unsupported chat test fault");
    }
    const state = this.requireNamespace(id);
    state.faults = Object.fromEntries(Object.entries(faults).filter(([, enabled]) => enabled === true));
    this.touch(state);
    return { faults: { ...state.faults } };
  }

  fault(id: string | undefined, key: string, expectedGeneration?: number): boolean {
    return id ? Boolean(this.requireNamespace(id, expectedGeneration).faults[key]) : false;
  }

  increment(id: string | undefined, counter: ChatTestCounter, expectedGeneration?: number): void {
    if (!id) return;
    const state = this.requireNamespace(id, expectedGeneration);
    state.counters[counter] += 1;
    this.touch(state);
  }

  enableBarrier(id: string, key: string) {
    if (!this.isBarrierKey(key)) {
      throw new ChatApiException(400, "INVALID_BARRIER_KEY", "Unsupported chat test barrier");
    }
    const state = this.requireNamespace(id);
    state.barriers.set(key, { enabled: true, waiters: [] });
    this.touch(state);
    return { key, enabled: true };
  }

  async checkpoint(id: string | undefined, key: ChatTestBarrierKey, expectedGeneration?: number): Promise<void> {
    if (!id) return;
    const state = this.requireNamespace(id, expectedGeneration);
    const barrier = state.barriers.get(key);
    if (!barrier?.enabled) return;
    this.touch(state);
    await new Promise<void>((resolve) => barrier.waiters.push(resolve));
    this.requireNamespace(id, expectedGeneration);
  }

  releaseBarrier(id: string, key: string) {
    if (!this.isBarrierKey(key)) {
      throw new ChatApiException(400, "INVALID_BARRIER_KEY", "Unsupported chat test barrier");
    }
    const state = this.requireNamespace(id);
    const barrier = state.barriers.get(key);
    if (barrier) {
      barrier.enabled = false;
      barrier.waiters.splice(0).forEach((release) => release());
    }
    this.touch(state);
    return { key, released: true };
  }

  observe(id: string | undefined, observation: Record<string, unknown>, expectedGeneration?: number): void {
    if (!id) return;
    const serialized = JSON.stringify(observation);
    if (
      /(?:authorization|api.?key|secret|prompt|reply|content|stack)/i.test(serialized) ||
      /sk-[A-Za-z0-9_-]+/.test(serialized) ||
      /\/(?:Users|home|private)\//.test(serialized)
    ) {
      throw new ChatApiException(400, "SENSITIVE_OBSERVATION", "Observation contains a prohibited field or value");
    }
    const state = this.requireNamespace(id, expectedGeneration);
    state.observations.push({ ...observation });
    this.touch(state);
  }

  observations(id: string, filters: { requestId?: string; executionId?: string } = {}) {
    const state = this.requireNamespace(id);
    return state.observations.filter(
      (item) =>
        (!filters.requestId || item.requestId === filters.requestId) &&
        (!filters.executionId || item.executionId === filters.executionId)
    );
  }

  validateBusinessNamespace(id?: string): string | undefined {
    if (!id) return undefined;
    this.assertEnabled();
    this.requireNamespace(id);
    return id;
  }

  private freshState(id: string, generation = 0): NamespaceState {
    return {
      id,
      now: CHAT_TEST_EPOCH,
      lastTouchedAt: Date.now(),
      faults: {},
      counters: Object.fromEntries(CHAT_TEST_COUNTERS.map((counter) => [counter, 0])) as Record<ChatTestCounter, number>,
      observations: [],
      barriers: new Map(),
      clockWaiters: new Map(),
      generation
    };
  }

  private publicState(state: NamespaceState) {
    return {
      id: state.id,
      now: state.now,
      faults: { ...state.faults },
      counters: { ...state.counters },
      observations: state.observations.map((item) => ({ ...item })),
      generation: state.generation
    };
  }

  private requireNamespace(id: string, expectedGeneration?: number): NamespaceState {
    this.assertEnabled();
    this.cleanup();
    const state = this.namespaces.get(id);
    if (!state) {
      throw new ChatApiException(404, "TEST_NAMESPACE_NOT_FOUND", "Chat test namespace not found");
    }
    if (expectedGeneration !== undefined && state.generation !== expectedGeneration) {
      throw this.resetError();
    }
    this.touch(state);
    return state;
  }

  private cleanup(): void {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [id, state] of this.namespaces) {
      if (state.lastTouchedAt < cutoff) {
        for (const barrier of state.barriers.values()) {
          barrier.waiters.splice(0).forEach((release) => release());
        }
        for (const waiter of state.clockWaiters.values()) waiter.resolve();
        state.clockWaiters.clear();
        this.namespaces.delete(id);
      }
    }
  }

  private touch(state: NamespaceState): void {
    state.lastTouchedAt = Date.now();
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ChatApiException(404, "NOT_FOUND", "Not found");
    }
  }

  private resetError() {
    return Object.assign(new Error("Chat test namespace was reset"), {
      chatFailure: {
        httpStatus: 409,
        code: "TEST_NAMESPACE_RESET",
        message: "Chat test namespace was reset",
        retryable: false
      }
    });
  }

  private isBarrierKey(key: string): key is ChatTestBarrierKey {
    return (CHAT_TEST_BARRIERS as readonly string[]).includes(key);
  }
}
