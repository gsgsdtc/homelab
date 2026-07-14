type LoadedControlModule = Record<string, any>;

function loadControlModule(): LoadedControlModule | null {
  try {
    return require("../src/modules/chat-test-control/chat-test-control.service") as LoadedControlModule;
  } catch {
    return null;
  }
}

const controlModule = loadControlModule();

describe("F5 chat test control", () => {
  it("provides isolated deterministic namespaces", () => {
    expect(controlModule?.ChatTestControlService).toBeDefined();
  });

  if (!controlModule) {
    return;
  }

  it("isolates clock, faults, counters and observations per namespace", () => {
    const service = new controlModule.ChatTestControlService({ enabled: true });
    const first = service.createNamespace();
    const second = service.createNamespace();

    service.advanceClock(first.id, 1000);
    service.setFaults(first.id, { timeout: true });
    service.increment(first.id, "adapterCalls");
    service.observe(first.id, { requestId: "req-1", stage: "adapter", code: "MODEL_TIMEOUT" });

    expect(service.getNamespace(first.id)).toEqual(
      expect.objectContaining({
        now: Date.parse("2020-01-01T00:00:01.000Z"),
        faults: { timeout: true },
        counters: expect.objectContaining({ adapterCalls: 1 })
      })
    );
    expect(service.getNamespace(second.id)).toEqual(
      expect.objectContaining({
        now: Date.parse("2020-01-01T00:00:00.000Z"),
        faults: {},
        counters: expect.objectContaining({ adapterCalls: 0 }),
        observations: []
      })
    );
  });

  it("atomically resets and deletes all namespace state", () => {
    const service = new controlModule.ChatTestControlService({ enabled: true });
    const namespace = service.createNamespace();
    service.advanceClock(namespace.id, 1234);
    service.setFaults(namespace.id, { provider_5xx: true });
    service.increment(namespace.id, "modelCalls");

    service.reset(namespace.id);
    expect(service.getNamespace(namespace.id)).toEqual(
      expect.objectContaining({
        now: Date.parse("2020-01-01T00:00:00.000Z"),
        faults: {},
        counters: expect.objectContaining({ modelCalls: 0 }),
        observations: []
      })
    );
    service.delete(namespace.id);
    expect(() => service.getNamespace(namespace.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("rejects invalid clock advances, unsupported barriers and sensitive observations", () => {
    const service = new controlModule.ChatTestControlService({ enabled: true });
    const namespace = service.createNamespace();

    expect(() => service.advanceClock(namespace.id, -1)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.enableBarrier(namespace.id, "not-a-checkpoint")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.setFaults(namespace.id, { unknown_fault: true })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() =>
      service.observe(namespace.id, { requestId: "req-1", stage: "adapter", secret: "sk-canary-secret" })
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("wakes deterministic clock waiters exactly at their deadline", async () => {
    const service = new controlModule.ChatTestControlService({ enabled: true });
    const namespace = service.createNamespace();
    const waiter = service.waitForClock(namespace.id, namespace.now + 60_000);
    let settled = false;
    void waiter.promise.then(() => {
      settled = true;
    });

    service.advanceClock(namespace.id, 59_999);
    await Promise.resolve();
    expect(settled).toBe(false);

    service.advanceClock(namespace.id, 1);
    await waiter.promise;
    expect(settled).toBe(true);
  });

  it("rejects every old-generation continuation after an atomic reset", async () => {
    const service = new controlModule.ChatTestControlService({ enabled: true });
    const namespace = service.createNamespace();
    const generation = service.generation(namespace.id);
    service.enableBarrier(namespace.id, "beforeExecute");
    const checkpoint = service.checkpoint(namespace.id, "beforeExecute", generation);
    await Promise.resolve();

    const reset = service.reset(namespace.id);

    await expect(checkpoint).rejects.toMatchObject({
      chatFailure: expect.objectContaining({ code: "TEST_NAMESPACE_RESET", retryable: false })
    });
    expect(() => service.increment(namespace.id, "modelCalls", generation)).toThrow(
      expect.objectContaining({ chatFailure: expect.objectContaining({ code: "TEST_NAMESPACE_RESET" }) })
    );
    expect(() => service.observe(namespace.id, { stage: "old" }, generation)).toThrow(
      expect.objectContaining({ chatFailure: expect.objectContaining({ code: "TEST_NAMESPACE_RESET" }) })
    );
    expect(reset).toEqual(expect.objectContaining({ generation: generation + 1 }));
    expect(service.getNamespace(namespace.id)).toEqual(
      expect.objectContaining({ counters: expect.objectContaining({ modelCalls: 0 }), observations: [] })
    );
  });
});
