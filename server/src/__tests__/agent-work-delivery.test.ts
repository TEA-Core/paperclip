import { describe, expect, it } from "vitest";
import {
  hasNoPlatformDispatchPath,
  isExternalPullAgent,
  parseAgentWorkDelivery,
} from "../services/agent-work-delivery.ts";

describe("hasNoPlatformDispatchPath", () => {
  it("flags an external_pull seat", () => {
    expect(hasNoPlatformDispatchPath({ runtimeConfig: { workDelivery: "external_pull" } })).toBe(true);
    expect(hasNoPlatformDispatchPath({ runtimeConfig: { workDelivery: "External-Pull" } })).toBe(true);
  });

  it("flags a seat whose heartbeat is fully off (no timer and no on-demand wake)", () => {
    expect(
      hasNoPlatformDispatchPath({
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      }),
    ).toBe(true);
  });

  it("does not flag a seat that only has the periodic timer off but still wakes on demand", () => {
    expect(
      hasNoPlatformDispatchPath({
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      }),
    ).toBe(false);
  });

  it("does not flag a seat that has the periodic timer on", () => {
    expect(
      hasNoPlatformDispatchPath({
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: false } },
      }),
    ).toBe(false);
  });

  it("does not flag a default invoked seat with no runtime config", () => {
    expect(hasNoPlatformDispatchPath({ runtimeConfig: {} })).toBe(false);
    expect(hasNoPlatformDispatchPath({ runtimeConfig: null as unknown })).toBe(false);
  });

  it("does not flag a heartbeat-only seat that never declared external_pull", () => {
    expect(
      hasNoPlatformDispatchPath({
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      }),
    ).toBe(false);
  });
});

describe("isExternalPullAgent / parseAgentWorkDelivery", () => {
  it("is inert for any non-external_pull declaration", () => {
    expect(parseAgentWorkDelivery({ runtimeConfig: {} })).toBe("invoked");
    expect(parseAgentWorkDelivery({ runtimeConfig: { workDelivery: "invoked" } })).toBe("invoked");
    expect(isExternalPullAgent({ runtimeConfig: {} })).toBe(false);
  });
});
