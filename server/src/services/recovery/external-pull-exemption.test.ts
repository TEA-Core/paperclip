import { describe, expect, it } from "vitest";
import {
  decideExternalPullRecoveryExemption,
  EXTERNAL_PULL_RECOVERY_EXEMPTION_MAX_AGE_MS,
  type ExternalPullRecoveryExemptionFacts,
} from "./external-pull-exemption.js";

const now = new Date("2026-11-27T00:00:00.000Z");

function facts(overrides: Partial<ExternalPullRecoveryExemptionFacts> = {}): ExternalPullRecoveryExemptionFacts {
  return {
    ownerIsExternalPull: true,
    ownerStatusInvokable: true,
    issueStatus: "blocked",
    lastActivityAt: new Date(now.getTime() - 60 * 60_000),
    boardCleared: false,
    now,
    ...overrides,
  };
}

describe("decideExternalPullRecoveryExemption", () => {
  it.each(["backlog", "blocked", "in_review"])("exempts a fresh parked %s card of a live pull owner", (issueStatus) => {
    expect(decideExternalPullRecoveryExemption(facts({ issueStatus }))).toEqual({ kind: "exempt" });
  });

  it.each(["todo", "in_progress"])("sends a live pull owner's %s card to the board", (issueStatus) => {
    expect(decideExternalPullRecoveryExemption(facts({ issueStatus }))).toEqual({
      kind: "board_only",
      reason: "active_card",
    });
  });

  it("keeps normal recovery for an owner that is not a pull agent", () => {
    expect(decideExternalPullRecoveryExemption(facts({ ownerIsExternalPull: false }))).toEqual({ kind: "none" });
  });

  it("sends a dead pull owner's parked card to the board", () => {
    expect(decideExternalPullRecoveryExemption(facts({ ownerStatusInvokable: false }))).toEqual({
      kind: "board_only",
      reason: "owner_not_invokable",
    });
  });

  it("sends a board-cleared card to the board", () => {
    expect(decideExternalPullRecoveryExemption(facts({ boardCleared: true }))).toEqual({
      kind: "board_only",
      reason: "board_cleared",
    });
  });

  it("expires the exemption exactly at the age bound", () => {
    const justInside = new Date(now.getTime() - EXTERNAL_PULL_RECOVERY_EXEMPTION_MAX_AGE_MS + 1);
    const atBound = new Date(now.getTime() - EXTERNAL_PULL_RECOVERY_EXEMPTION_MAX_AGE_MS);
    expect(decideExternalPullRecoveryExemption(facts({ lastActivityAt: justInside }))).toEqual({ kind: "exempt" });
    expect(decideExternalPullRecoveryExemption(facts({ lastActivityAt: atBound }))).toEqual({
      kind: "board_only",
      reason: "exemption_expired",
    });
  });

  it("uses a 72 hour bound", () => {
    expect(EXTERNAL_PULL_RECOVERY_EXEMPTION_MAX_AGE_MS).toBe(72 * 60 * 60 * 1000);
  });
});
