import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigCalls = vi.fn();

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    loadConfig: (..._args: Parameters<typeof actual.loadConfig>) => {
      loadConfigCalls();
      return {
        resolvedDependencyWakeRearmWindowMs: 1000,
        resolvedDependencyWakeRearmMaxCount: 3,
      } as ReturnType<typeof actual.loadConfig>;
    },
  };
});

const { recoveryService } = await import("./service.js");

// Any db access from the reconcile pass is a hard stop: this suite only cares about
// whether config was read, and the read happens before the first query.
const DB_STUB_ERROR = "db-stub: query attempted";

function dbStub() {
  return {
    select: () => {
      throw new Error(DB_STUB_ERROR);
    },
  } as unknown as Parameters<typeof recoveryService>[0];
}

describe("recoveryService config loading is deferred", () => {
  beforeEach(() => {
    loadConfigCalls.mockClear();
  });

  it("does not read config while constructing the service", () => {
    recoveryService(dbStub(), { enqueueWakeup: async () => null });
    expect(loadConfigCalls).not.toHaveBeenCalled();
  });

  it("reads config when reconcileResolvedDependencyWakeBackstop runs", async () => {
    const svc = recoveryService(dbStub(), { enqueueWakeup: async () => null });
    expect(loadConfigCalls).not.toHaveBeenCalled();

    await expect(svc.reconcileResolvedDependencyWakeBackstop()).rejects.toThrow(DB_STUB_ERROR);
    expect(loadConfigCalls).toHaveBeenCalledTimes(1);
  });
});
