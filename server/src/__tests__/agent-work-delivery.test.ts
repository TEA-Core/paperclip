import { describe, expect, it } from "vitest";
import {
  isExternalPullAgent,
  parseAgentWorkDelivery,
} from "../services/agent-work-delivery.ts";

describe("isExternalPullAgent / parseAgentWorkDelivery", () => {
  it("is inert for any non-external_pull declaration", () => {
    expect(parseAgentWorkDelivery({ runtimeConfig: {} })).toBe("invoked");
    expect(parseAgentWorkDelivery({ runtimeConfig: { workDelivery: "invoked" } })).toBe("invoked");
    expect(isExternalPullAgent({ runtimeConfig: {} })).toBe(false);
  });
});
