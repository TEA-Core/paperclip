import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "./issue-dependency-wakeups.js";

const dependentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockerIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const firstCycle = new Date("2026-04-01T12:00:00.000Z");
const secondCycle = new Date("2026-08-01T09:30:00.000Z");

type WakeRow = {
  id: string;
  status: string;
  idempotencyKey: string | null;
  requestedAt: Date;
  updatedAt?: Date;
};

function dbWithWakes(rows: WakeRow[]): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

describe("buildIssueBlockersResolvedWakeStateKey", () => {
  it("is identical for the same dependent, blockers, and blockedTransitionAt", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle.toISOString(),
    });
    expect(first).toBe(second);
    expect(first).toContain(dependentIssueId);
  });

  it("ignores blockedTransitionAt so every producer keys the same ready state", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: secondCycle,
    });
    expect(first).toBe(second);
  });

  it("uses the same stable key for null, omitted, and dated transition stamps", () => {
    const noneKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: null,
    });
    const omittedKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const datedKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    expect(noneKey).toBe(omittedKey);
    expect(noneKey).toBe(datedKey);
    expect(noneKey).not.toBe(
      buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
  });
});

describe("findExistingIssueBlockersResolvedWakeForReadyState", () => {
  const readyState = {
    companyId,
    dependentIssueId,
    blockerIssueIds: [blockerIssueId],
    blockedTransitionAt: secondCycle,
  };

  it("suppresses a completed wake on the stable state key", async () => {
    const stateKey = buildIssueBlockersResolvedWakeStateKey(readyState);
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-stable-state",
          status: "completed",
          idempotencyKey: stateKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-stable-state");
  });

  it("suppresses a later producer after an earlier producer completed the same blocker-set wake in the same generation", async () => {
    const producerKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-earlier-producer",
          status: "completed",
          idempotencyKey: producerKey,
          requestedAt: secondCycle,
          updatedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-earlier-producer");
  });

  describe("blocked generation and re-arm window", () => {
    // Timeline: generation 1 blocked at 09:00, generation 2 blocked at 11:00,
    // the sweep runs at 12:00 with a 6 h re-arm window (age cutoff 06:00).
    const generationOneAt = new Date("2026-11-12T09:00:00.000Z");
    const generationTwoAt = new Date("2026-11-12T11:00:00.000Z");
    const ageCutoff = new Date("2026-11-12T06:00:00.000Z");
    const generationTwo = { ...readyState, blockedTransitionAt: generationTwoAt };
    const stateKey = buildIssueBlockersResolvedWakeStateKey(generationTwo);

    it("does not let an earlier-generation wake completed inside the re-arm window suppress the current generation", async () => {
      const wakes = dbWithWakes([
        {
          id: "wake-generation-one",
          status: "completed",
          idempotencyKey: stateKey,
          requestedAt: generationOneAt,
          updatedAt: new Date("2026-11-12T09:30:00.000Z"),
        },
      ]);
      expect(
        await findExistingIssueBlockersResolvedWakeForReadyState(wakes, {
          ...generationTwo,
          completedRearmCutoff: ageCutoff,
        }),
      ).toBeNull();
      expect(await findExistingIssueBlockersResolvedWakeForReadyState(wakes, generationTwo)).toBeNull();
    });

    it("does not let a wake requested in generation 1 and completed after generation 2 began suppress generation 2", async () => {
      const wakes = dbWithWakes([
        {
          id: "wake-straddling",
          status: "completed",
          idempotencyKey: stateKey,
          requestedAt: new Date("2026-11-12T10:00:00.000Z"),
          updatedAt: new Date("2026-11-12T11:30:00.000Z"),
        },
      ]);
      expect(
        await findExistingIssueBlockersResolvedWakeForReadyState(wakes, {
          ...generationTwo,
          completedRearmCutoff: ageCutoff,
        }),
      ).toBeNull();
      expect(await findExistingIssueBlockersResolvedWakeForReadyState(wakes, generationTwo)).toBeNull();
    });

    it("suppresses a same-generation completed wake inside the re-arm window, including one requested at the transition instant", async () => {
      const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
        dbWithWakes([
          {
            id: "wake-generation-two",
            status: "completed",
            idempotencyKey: stateKey,
            requestedAt: generationTwoAt,
            updatedAt: new Date("2026-11-12T11:05:00.000Z"),
          },
        ]),
        { ...generationTwo, completedRearmCutoff: ageCutoff },
      );
      expect(existing?.id).toBe("wake-generation-two");
    });

    it("re-arms a same-generation completed wake once it ages past the re-arm window", async () => {
      const longBlockedAt = new Date("2026-11-12T03:00:00.000Z");
      const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
        dbWithWakes([
          {
            id: "wake-aged-out",
            status: "completed",
            idempotencyKey: stateKey,
            requestedAt: new Date("2026-11-12T04:00:00.000Z"),
            updatedAt: new Date("2026-11-12T05:59:59.999Z"),
          },
        ]),
        { ...readyState, blockedTransitionAt: longBlockedAt, completedRearmCutoff: ageCutoff },
      );
      expect(existing).toBeNull();
    });

    it("keeps an in-flight canonical wake from an earlier generation covering the current one", async () => {
      const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
        dbWithWakes([
          {
            id: "wake-generation-one-queued",
            status: "queued",
            idempotencyKey: stateKey,
            requestedAt: generationOneAt,
            updatedAt: generationOneAt,
          },
        ]),
        { ...generationTwo, completedRearmCutoff: ageCutoff },
      );
      expect(existing?.id).toBe("wake-generation-one-queued");
    });
  });

  it("does not let a completed old-key wake from a previous blocked cycle suppress", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-previous-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing).toBeNull();
  });

  it("suppresses a completed old-key wake requested at or after blockedTransitionAt", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-same-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-same-cycle");
  });

  it("suppresses a completed old-key wake when blockedTransitionAt is null", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-no-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      {
        companyId,
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
        blockedTransitionAt: null,
      },
    );
    expect(existing?.id).toBe("wake-old-no-cycle");
  });

  it("suppresses an in-flight old-key wake across a later blocked cycle", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-queued",
          status: "queued",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-queued");
  });

  it("keeps legacy per-edge matching in-flight only", async () => {
    const legacyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
      dependentIssueId,
      resolvedBlockerIssueId: blockerIssueId,
    });
    const inFlight = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-claimed",
          status: "claimed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(inFlight?.id).toBe("wake-legacy-claimed");

    const completed = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-completed",
          status: "completed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(completed).toBeNull();
  });
});
