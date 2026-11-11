import { describe, expect, it } from "vitest";
import {
  buildIssueBlockersResolvedRestoredWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
} from "../issue-dependency-wakeups.js";

describe("buildIssueBlockersResolvedRestoredWakeIdempotencyKey", () => {
  const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("is stable for the same dependent and blocker set", () => {
    const first = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });
    const second = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });
    expect(second).toBe(first);
  });

  it("ignores blocker order and duplicates", () => {
    const first = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: [
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ],
    });
    const second = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: [
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
    });
    expect(second).toBe(first);
  });

  it("separates dependents and blocker sets", () => {
    const base = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });
    const otherDependent = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      blockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });
    const otherSet = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    });
    const emptySet = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds: [],
    });
    expect(otherDependent).not.toBe(base);
    expect(otherSet).not.toBe(base);
    expect(emptySet).not.toBe(base);
  });

  it("is the canonical stable ready-state key", () => {
    const blockerIssueIds = ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    const blockedTransitionAt = new Date("2026-08-03T18:00:00.000Z");
    const restoredKey = buildIssueBlockersResolvedRestoredWakeIdempotencyKey({
      dependentIssueId: dependentId,
      blockerIssueIds,
    });
    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: dependentId,
      blockerIssueIds,
      blockedTransitionAt,
    });
    expect(restoredKey).toBe(stateKey);
    expect(restoredKey).toContain(":state:");
    expect(stateKey).toContain(":state:");
  });
});
