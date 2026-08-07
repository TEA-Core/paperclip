import { describe, expect, it } from "vitest";
import { isExternalPullAgent, parseAgentWorkDelivery } from "./agent-work-delivery.js";

function agent(runtimeConfig: unknown) {
  return { runtimeConfig } as any;
}

describe("agent work delivery", () => {
  it("treats an agent with no declaration as ordinarily invoked", () => {
    expect(parseAgentWorkDelivery(agent({}))).toBe("invoked");
    expect(parseAgentWorkDelivery(agent(null))).toBe("invoked");
    expect(parseAgentWorkDelivery(agent({ heartbeat: { enabled: true } }))).toBe("invoked");
    expect(isExternalPullAgent(agent({}))).toBe(false);
  });

  it("recognizes an explicit external pull declaration", () => {
    expect(parseAgentWorkDelivery(agent({ workDelivery: "external_pull" }))).toBe("external_pull");
    expect(isExternalPullAgent(agent({ workDelivery: "external_pull" }))).toBe(true);
  });

  it("accepts the shorthand spellings an operator is likely to type", () => {
    expect(parseAgentWorkDelivery(agent({ workDelivery: "pull" }))).toBe("external_pull");
    expect(parseAgentWorkDelivery(agent({ workDelivery: "  External_Pull  " }))).toBe("external_pull");
    expect(parseAgentWorkDelivery(agent({ workDelivery: "externalPull" }))).toBe("external_pull");
  });

  it("falls back to invoked for anything it does not understand", () => {
    // An unreadable declaration must not silently disable disposition recovery.
    expect(parseAgentWorkDelivery(agent({ workDelivery: "push" }))).toBe("invoked");
    expect(parseAgentWorkDelivery(agent({ workDelivery: true }))).toBe("invoked");
    expect(parseAgentWorkDelivery(agent({ workDelivery: "" }))).toBe("invoked");
    expect(parseAgentWorkDelivery(agent({ workDelivery: { mode: "external_pull" } }))).toBe("invoked");
  });

  it("never infers pull delivery from the adapter command", () => {
    // The `/bin/echo` no-op wake is exactly the inference this signal replaces.
    expect(isExternalPullAgent({
      adapterType: "process",
      adapterConfig: { command: "/bin/echo" },
      runtimeConfig: {},
    } as any)).toBe(false);
  });
});
