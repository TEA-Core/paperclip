import { describe, expect, it } from "vitest";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import { eventTypeForActivityAction } from "../services/activity-log.js";

describe("eventTypeForActivityAction", () => {
  it("forwards the dependency wake re-arm cap activity action to plugins", () => {
    expect(eventTypeForActivityAction("issue.dependency_wake_rearm_cap_reached")).toBe(
      "issue.dependency_wake_rearm_cap_reached",
    );
  });

  it("maps the underscore form of the re-arm cap action to the plugin event", () => {
    expect(eventTypeForActivityAction("issue_dependency_wake_rearm_cap_reached")).toBe(
      "issue.dependency_wake_rearm_cap_reached",
    );
  });

  it("keeps the re-arm cap event in the shared plugin event catalog", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("issue.dependency_wake_rearm_cap_reached");
  });

  it("returns null for actions with no plugin-facing event", () => {
    expect(eventTypeForActivityAction("issue.dependency_wake_requested_but_capped")).toBeNull();
  });
});
