import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_RUN_CAP_CEILING,
  LIVE_RUN_CAP_RESERVED_SLOTS,
  LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE,
  LIVE_RUN_CAP_SIGNAL_FLOOR,
  LIVE_RUN_CAP_SIGNAL_STALE_MS,
  classifyLiveRunCapRun,
  clearLiveRunCapSignal,
  computeEffectiveLiveRunCap,
  createLiveRunCapRouterPoll,
  createLiveRunCapSettingReader,
  decideLiveRunCapAdmission,
  invalidateLiveRunCapSettingCache,
  isLiveRunCapExemptAgent,
  listLiveRunCapSignals,
  liveRunCapAdmission,
  liveRunCapFreeSlots,
} from "./live-run-cap.js";

const NOW = 1_800_000_000_000;
const router = (cap: number, ageMs = 0) => ({
  source: LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE,
  cap,
  observedAtMs: NOW - ageMs,
});

afterEach(() => {
  clearLiveRunCapSignal(LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE);
  invalidateLiveRunCapSettingCache();
});

describe("owner-ruled numbers", () => {
  it("pins ceiling 15, floor 6 in total (reading A: 4 general + 2 reserved) and 2 reserved", () => {
    expect(LIVE_RUN_CAP_CEILING).toBe(15);
    expect(LIVE_RUN_CAP_SIGNAL_FLOOR).toBe(6);
    expect(LIVE_RUN_CAP_RESERVED_SLOTS).toBe(2);
  });
});

describe("computeEffectiveLiveRunCap", () => {
  it("is off when the setting is null, whatever the router says", () => {
    expect(computeEffectiveLiveRunCap({ setting: null, signals: [router(1)], nowMs: NOW })).toBeNull();
  });

  it("uses the setting when no router sample exists", () => {
    expect(computeEffectiveLiveRunCap({ setting: 15, signals: [], nowMs: NOW })).toMatchObject({
      effectiveCap: 15,
      generalCap: 13,
    });
  });

  it("lets a fresh router value lower the cap", () => {
    expect(computeEffectiveLiveRunCap({ setting: 15, signals: [router(8)], nowMs: NOW })).toMatchObject({
      effectiveCap: 8,
      generalCap: 6,
    });
  });

  it.each([0, 1, 5])("never lets a router value of %i pin the cap below the floor", (cap) => {
    expect(computeEffectiveLiveRunCap({ setting: 15, signals: [router(cap)], nowMs: NOW })).toMatchObject({
      effectiveCap: 6,
      generalCap: 4,
    });
  });

  it("never lets the router raise the cap above the setting", () => {
    expect(computeEffectiveLiveRunCap({ setting: 12, signals: [router(40)], nowMs: NOW })).toMatchObject({
      effectiveCap: 12,
    });
  });

  it.each([
    ["stale", router(1, LIVE_RUN_CAP_SIGNAL_STALE_MS + 1)],
    ["dated in the future", router(1, -1_000)],
    ["not an integer", router(2.5)],
    ["negative", router(-3)],
  ])("falls back to the setting (15), never 1 or 0, when the router sample is %s", (_label, signal) => {
    expect(computeEffectiveLiveRunCap({ setting: 15, signals: [signal], nowMs: NOW })).toMatchObject({
      effectiveCap: 15,
      appliedSignals: [],
    });
  });

  it("keeps an explicit operator setting below the floor (the floor only bounds signals)", () => {
    expect(computeEffectiveLiveRunCap({ setting: 4, signals: [router(1)], nowMs: NOW })).toMatchObject({
      effectiveCap: 4,
      generalCap: 2,
    });
  });

  it.each([
    [1, 1],
    [2, 1],
    [3, 1],
  ])("shrinks the reserve for an operator cap of %i so general work keeps a slot", (setting, generalCap) => {
    expect(computeEffectiveLiveRunCap({ setting, signals: [], nowMs: NOW })).toMatchObject({
      effectiveCap: setting,
      generalCap,
    });
  });

  it("folds every fresh lower-only signal (phase-2 advice seam) with the same floor", () => {
    const cap = computeEffectiveLiveRunCap({
      setting: 15,
      signals: [router(12), { source: "advice", cap: 3, observedAtMs: NOW }],
      nowMs: NOW,
    });
    expect(cap).toMatchObject({ effectiveCap: 6, generalCap: 4 });
    expect(cap?.appliedSignals.map((signal) => signal.source)).toEqual(["router", "advice"]);
  });

  // RA M12c: the ceiling must hold inside the pure function too, not only in
  // the validators that keep larger values out today.
  it.each([16, 999, 1e9])("clamps a setting of %d to the ceiling of 15, also when a router sample would raise it", (setting) => {
    expect(computeEffectiveLiveRunCap({ setting, signals: [], nowMs: NOW })).toMatchObject({
      setting: LIVE_RUN_CAP_CEILING,
      effectiveCap: LIVE_RUN_CAP_CEILING,
    });
    expect(computeEffectiveLiveRunCap({ setting, signals: [router(50)], nowMs: NOW })).toMatchObject({
      setting: LIVE_RUN_CAP_CEILING,
      effectiveCap: LIVE_RUN_CAP_CEILING,
    });
  });
});

describe("decideLiveRunCapAdmission", () => {
  const cap = computeEffectiveLiveRunCap({ setting: 10, signals: [], nowMs: NOW })!;
  const live = (total: number, reservedClass = 0) => ({ total, reservedClass });

  it("stops general work at cap - 2 and keeps the 2 reserved slots for priority work", () => {
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(7), runClass: "general", aheadCount: 0 })).toEqual({ admit: true });
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(8), runClass: "general", aheadCount: 0 })).toEqual({
      admit: false,
      reason: "cap_full",
    });
    for (const runClass of ["human_board", "review_recovery"] as const) {
      expect(decideLiveRunCapAdmission({ cap, occupancy: live(8), runClass, aheadCount: 0 })).toEqual({ admit: true });
      expect(decideLiveRunCapAdmission({ cap, occupancy: live(9), runClass, aheadCount: 0 })).toEqual({ admit: true });
      expect(decideLiveRunCapAdmission({ cap, occupancy: live(10, 2), runClass, aheadCount: 0 })).toEqual({
        admit: false,
        reason: "cap_full",
      });
    }
  });

  it("counts priority runs in the reserve first, so priority work beyond the reserve does not hold general slots", () => {
    // 9 live, 2 of them priority: the reserve is used up by priority work and
    // one general slot is free.
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(9, 2), runClass: "general", aheadCount: 0 })).toEqual({ admit: true });
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(9, 5), runClass: "general", aheadCount: 0 })).toEqual({ admit: true });
    // 9 live, 1 priority: the free slot is the reserve's second slot.
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(9, 1), runClass: "general", aheadCount: 0 })).toEqual({
      admit: false,
      reason: "cap_full",
    });
    expect(liveRunCapFreeSlots(cap, live(9, 1))).toEqual({ any: 1, general: 0 });
    expect(liveRunCapFreeSlots(cap, live(9, 2))).toEqual({ any: 1, general: 1 });
    expect(liveRunCapFreeSlots(cap, live(12, 4))).toEqual({ any: 0, general: 0 });
  });

  it("starts nothing while the live count is above a lowered cap", () => {
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(14, 4), runClass: "human_board", aheadCount: 0 })).toEqual({
      admit: false,
      reason: "cap_full",
    });
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(14, 6), runClass: "general", aheadCount: 0 })).toEqual({
      admit: false,
      reason: "cap_full",
    });
  });

  it("yields free slots to waiters that are ahead in line", () => {
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(6), runClass: "general", aheadCount: 2 })).toEqual({
      admit: false,
      reason: "behind_earlier_waiters",
    });
    expect(decideLiveRunCapAdmission({ cap, occupancy: live(6), runClass: "general", aheadCount: 1 })).toEqual({ admit: true });
  });
});

describe("classifyLiveRunCapRun", () => {
  const agentId = "agent-under-test";
  const author = { type: "agent", agentId: "delivery-author" };
  const base = {
    agentId,
    requestedByActorType: "system",
    wakePluginId: null,
    issueOriginKind: "manual",
    issueExecutionState: null,
  };
  /** A stage as the engine seats it: author delivered, `seatedBy` performed the transition. */
  const pendingStage = (
    participantAgentId: string,
    opts: { currentStageType?: string; deliveryAuthor?: unknown; seatedBy?: unknown; seatParticipantAgentId?: string } = {},
  ) => {
    const participant = { type: "agent", agentId: participantAgentId };
    return {
      status: "pending",
      currentStageType: opts.currentStageType ?? "review",
      currentParticipant: participant,
      deliveryAuthor: "deliveryAuthor" in opts ? opts.deliveryAuthor : author,
      participantSeat: {
        participant: { type: "agent", agentId: opts.seatParticipantAgentId ?? participantAgentId },
        seatedBy: "seatedBy" in opts ? opts.seatedBy : author,
      },
    };
  };

  it("puts human and board wakes first, even on review work", () => {
    expect(classifyLiveRunCapRun({ ...base, requestedByActorType: "user", issueExecutionState: pendingStage(agentId) })).toBe("human_board");
  });

  it.each([
    { issueOriginKind: "stranded_issue_recovery" },
    { issueOriginKind: "harness_liveness_escalation" },
    { issueExecutionState: pendingStage(agentId) },
    { issueExecutionState: pendingStage(agentId, { currentStageType: "approval" }) },
    { issueExecutionState: pendingStage(agentId, { seatedBy: { type: "user", userId: "board-user" } }) },
    { issueExecutionState: pendingStage(agentId, { deliveryAuthor: { type: "user", userId: "board-user" } }) },
  ])("treats %j as review/recovery", (override) => {
    expect(classifyLiveRunCapRun({ ...base, ...override })).toBe("review_recovery");
  });

  it.each([
    { label: "a stage pending for another agent", issueExecutionState: pendingStage("someone-else") },
    { label: "a stage that is not pending", issueExecutionState: { ...pendingStage(agentId), status: "changes_requested" } },
    { label: "an unknown stage type", issueExecutionState: pendingStage(agentId, { currentStageType: "custom" }) },
    { label: "a user participant", issueExecutionState: { status: "pending", currentStageType: "review", currentParticipant: { type: "user", userId: "u" } } },
    { label: "a malformed state", issueExecutionState: "pending" },
    { label: "a plugin origin kind", issueOriginKind: "plugin:example:stranded_issue_recovery" },
    { label: "a stage on the participant's own delivery", issueExecutionState: pendingStage(agentId, { deliveryAuthor: { type: "agent", agentId } }) },
    { label: "a stage with no delivery author", issueExecutionState: pendingStage(agentId, { deliveryAuthor: null }) },
    { label: "a stage the participant seated itself in", issueExecutionState: pendingStage(agentId, { seatedBy: { type: "agent", agentId } }) },
    { label: "a stage seated by an agent other than the delivery author (a second agent's delivery on an unassigned card)", issueExecutionState: pendingStage(agentId, { seatedBy: { type: "agent", agentId: "second-agent" } }) },
    { label: "a stage seated with no actor", issueExecutionState: pendingStage(agentId, { seatedBy: null }) },
    { label: "a seat recorded for another participant", issueExecutionState: pendingStage(agentId, { seatParticipantAgentId: "someone-else" }) },
    { label: "a stage with no recorded seat", issueExecutionState: { ...pendingStage(agentId), participantSeat: undefined } },
  ])("treats $label as general", ({ label: _label, ...override }) => {
    expect(classifyLiveRunCapRun({ ...base, ...override })).toBe("general");
  });

  it.each(["agent", "system", null])("ignores everything a %s-requested wake could choose", (requestedByActorType) => {
    expect(classifyLiveRunCapRun({ ...base, requestedByActorType })).toBe("general");
  });

  it("treats a human wake a plugin relayed (the host stamps its plugin id on the wake row) as general", () => {
    expect(classifyLiveRunCapRun({ ...base, requestedByActorType: "user", wakePluginId: "6f0f3c1e-4c1a-4d2b-9a55-2f4a3b1c9d10" })).toBe("general");
  });
});

describe("isLiveRunCapExemptAgent", () => {
  it.each(["process", "http", "hermes_gateway", "openclaw_gateway"])("exempts the %s adapter", (adapterType) => {
    expect(isLiveRunCapExemptAgent({ adapterType, runtimeConfig: {} })).toBe(true);
  });

  it("exempts a declared external pull seat on any adapter", () => {
    expect(isLiveRunCapExemptAgent({ adapterType: "claude_local", runtimeConfig: { workDelivery: "external_pull" } })).toBe(true);
  });

  it.each(["opencode_local", "codex_local", "claude_local", "paperclip_runner"])("counts the %s adapter", (adapterType) => {
    expect(isLiveRunCapExemptAgent({ adapterType, runtimeConfig: { workDelivery: "invoked" } })).toBe(false);
  });
});

describe("router poll", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("stores a valid sample and reports a raise only when the router's contribution goes up", async () => {
    let now = NOW;
    const onRaise = vi.fn();
    const responses = [8, 10, 7].map((cap) => jsonResponse({ cap, reason: "clamped" }));
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const poll = createLiveRunCapRouterPoll({ url: "http://router/api/runcap", fetchImpl, now: () => now, onRaise });

    await expect(poll()).resolves.toBe(true);
    expect(listLiveRunCapSignals()).toEqual([router(8)]);
    expect(onRaise).not.toHaveBeenCalled();

    now += 1_000;
    await poll();
    expect(onRaise).toHaveBeenCalledTimes(1);

    now += 1_000;
    await poll();
    expect(onRaise).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a non-2xx answer", async () => jsonResponse({ cap: 1 }, 503)],
    ["an invalid body", async () => jsonResponse({ cap: "1" })],
    ["a network error", async () => { throw new Error("ECONNREFUSED"); }],
  ])("keeps the previous sample on %s and lets it go stale to the setting", async (_label, failingFetch) => {
    let now = NOW;
    const onRaise = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ cap: 1 }));
    const poll = createLiveRunCapRouterPoll({ url: "http://router/api/runcap", fetchImpl, now: () => now, onRaise });
    await poll();
    expect(computeEffectiveLiveRunCap({ setting: 15, signals: listLiveRunCapSignals(), nowMs: now })?.effectiveCap).toBe(6);

    fetchImpl.mockImplementation(failingFetch);
    now += 1_000;
    await expect(poll()).resolves.toBe(false);
    expect(listLiveRunCapSignals()).toEqual([router(1)]);
    expect(onRaise).not.toHaveBeenCalled();

    now += LIVE_RUN_CAP_SIGNAL_STALE_MS;
    await poll();
    expect(computeEffectiveLiveRunCap({ setting: 15, signals: listLiveRunCapSignals(), nowMs: now })?.effectiveCap).toBe(15);
    expect(onRaise).toHaveBeenCalledTimes(1);
  });

  it("aborts a router that does not answer within the timeout", async () => {
    // Never answers; only the poll's own timeout signal ends the request.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const poll = createLiveRunCapRouterPoll({ url: "http://router/api/runcap", fetchImpl, timeoutMs: 20 });

    await expect(poll()).resolves.toBe(false);
    expect(listLiveRunCapSignals()).toEqual([]);
  });
});

describe("router poll hardening (real HTTP)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    return `http://127.0.0.1:${(address satisfies AddressInfo).port}`;
  }

  it("refuses to follow a redirect", async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cap: 7 }));
    });
    const redirecting = await listen((_req, res) => {
      res.writeHead(302, { location: `${target}/api/runcap` });
      res.end();
    });

    await expect(createLiveRunCapRouterPoll({ url: `${redirecting}/api/runcap` })()).resolves.toBe(false);
    expect(listLiveRunCapSignals()).toEqual([]);
  });

  it("refuses an answer larger than the body limit", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`${" ".repeat(64 * 1024)}{"cap":7}`);
    });

    await expect(createLiveRunCapRouterPoll({ url })()).resolves.toBe(false);
    expect(listLiveRunCapSignals()).toEqual([]);
  });

  it("still accepts a small, direct answer", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cap: 9, reason: "clamped" }));
    });

    await expect(createLiveRunCapRouterPoll({ url })()).resolves.toBe(true);
    expect(listLiveRunCapSignals().map((signal) => signal.cap)).toEqual([9]);
  });

  it("never has two polls in flight: a poll while one hangs reuses it", async () => {
    let requests = 0;
    // A listener that never answers; only the poll's own (real) abort timeout
    // ends the request, so this case runs on the real clock by design.
    const url = await listen(() => {
      requests += 1;
    });
    const poll = createLiveRunCapRouterPoll({ url, timeoutMs: 200 });

    const results = await Promise.all([poll(), poll(), poll()]);

    expect(results).toEqual([false, false, false]);
    expect(requests).toBe(1);
  });

  it("refuses an answer that declares a body over the limit without waiting for it", async () => {
    // The router declares 1 MB, sends a few bytes and then holds the
    // connection. Only the declared length can end the poll before the timeout.
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(1024 * 1024) });
      res.write('{"cap":7');
    });
    const startedAt = Date.now();

    await expect(createLiveRunCapRouterPoll({ url, timeoutMs: 5_000 })()).resolves.toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(listLiveRunCapSignals()).toEqual([]);
    servers.at(-1)?.closeAllConnections();
  });
});

describe("admission lock", () => {
  afterEach(() => {
    vi.useRealTimers();
    liveRunCapAdmission.clearWaiters();
  });

  it("frees the lock and refuses the admission when a holder overruns its deadline", async () => {
    vi.useFakeTimers();
    const settled: Record<string, string> = {};
    void liveRunCapAdmission.withLock(() => new Promise<string>(() => {}), "timed-out", 50)
      .then((value) => { settled.hung = value; });
    void liveRunCapAdmission.withLock(async () => "admitted", "timed-out", 50)
      .then((value) => { settled.next = value; });

    await vi.advanceTimersByTimeAsync(60);

    expect(settled).toEqual({ hung: "timed-out", next: "admitted" });
  });

  it("lets an overrun holder neither reserve a slot nor record a waiter", async () => {
    vi.useFakeTimers();
    let finishHolder!: () => void;
    const holderDone = new Promise<void>((resolve) => {
      finishHolder = resolve;
    });
    const late: { release: unknown } = { release: "unset" };
    const result = liveRunCapAdmission.withLock(async (lease) => {
      await holderDone;
      late.release = lease.reserve("late-run", "general");
      lease.registerWaiter({ runId: "late-waiter", agentId: "agent", runClass: "general", createdAtMs: NOW });
      return "late";
    }, "timed-out", 20);

    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toBe("timed-out");
    finishHolder();
    await vi.waitFor(() => expect(late.release).toBeNull());
    expect(liveRunCapAdmission.inFlight()).toBe(0);
    expect(liveRunCapAdmission.waiterCount()).toBe(0);
  });
});

describe("liveRunCapAdmission.admit", () => {
  const cap = computeEffectiveLiveRunCap({ setting: 10, signals: [], nowMs: NOW })!;
  const entry = (runId: string, runClass: "general" | "review_recovery" = "general", agentId = runId) => ({
    runId,
    agentId,
    runClass,
    createdAtMs: NOW,
  });
  afterEach(() => {
    vi.useRealTimers();
    liveRunCapAdmission.clearWaiters();
  });

  it("counts admissions still claiming, so two admissions never share the last general slot", async () => {
    const countLive = async () => ({ total: 7, reservedClass: 0 });
    const first = await liveRunCapAdmission.admit({ entry: entry("first"), cap, countLive, countAhead: async () => 0 });
    const second = await liveRunCapAdmission.admit({ entry: entry("second"), cap, countLive, countAhead: async () => 0 });

    expect(first).toMatchObject({ admitted: true });
    expect(second).toEqual({ admitted: false, timedOut: false });
    expect(liveRunCapAdmission.listWaiters().map((waiter) => waiter.runId)).toEqual(["second"]);
    if (first.admitted) first.release();
    expect(liveRunCapAdmission.inFlight()).toBe(0);
  });

  it("counts a priority admission still claiming against the reserve, not the general slots", async () => {
    // 8 live general runs: general full, reserve free. A review run admits
    // into the reserve; while it is still claiming a general run must wait.
    const countLive = async () => ({ total: 8, reservedClass: 0 });
    const review = await liveRunCapAdmission.admit({ entry: entry("review", "review_recovery"), cap, countLive, countAhead: async () => 0 });
    const general = await liveRunCapAdmission.admit({ entry: entry("general"), cap, countLive, countAhead: async () => 0 });

    expect(review).toMatchObject({ admitted: true });
    expect(general).toEqual({ admitted: false, timedOut: false });
    if (review.admitted) review.release();
  });

  it("lets a general run take the general slot a claiming priority run left free by filling the reserve", async () => {
    // 8 live: 7 general and 1 review. A second review run admits and is still
    // claiming: the two priority runs fill the reserve, so one general slot
    // of the 8 is free.
    const countLive = async () => ({ total: 8, reservedClass: 1 });
    const review = await liveRunCapAdmission.admit({ entry: entry("review", "review_recovery"), cap, countLive, countAhead: async () => 0 });
    const general = await liveRunCapAdmission.admit({ entry: entry("general"), cap, countLive, countAhead: async () => 0 });

    expect(review).toMatchObject({ admitted: true });
    expect(general).toMatchObject({ admitted: true });
    if (review.admitted) review.release();
    if (general.admitted) general.release();
  });

  it("refuses an admission whose live count hangs past the deadline and records nothing for it", async () => {
    vi.useFakeTimers();
    let answerCount!: (value: { total: number; reservedClass: number }) => void;
    const hungCount = new Promise<{ total: number; reservedClass: number }>((resolve) => {
      answerCount = resolve;
    });
    const result = liveRunCapAdmission.admit({
      entry: entry("hung"),
      cap,
      countLive: () => hungCount,
      countAhead: async () => 0,
      timeoutMs: 20,
    });

    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toEqual({ admitted: false, timedOut: true });
    // The count finally answers with free room: the overrun holder must not
    // reserve a slot or record a waiter.
    answerCount({ total: 0, reservedClass: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(liveRunCapAdmission.inFlight()).toBe(0);
    expect(liveRunCapAdmission.waiterCount()).toBe(0);
  });
});

describe("liveRunCapAdmission.evaluateAgent", () => {
  afterEach(() => {
    liveRunCapAdmission.clearWaiters();
  });
  const waiter = (runId: string, agentId: string) => ({ runId, agentId, runClass: "general" as const, createdAtMs: NOW });

  // RA M16: an agent's waiters are exactly what its latest evaluation deferred.
  it("drops an agent's earlier waiter when its next evaluation no longer defers that run", async () => {
    await liveRunCapAdmission.evaluateAgent("agent-a", [waiter("run-a", "agent-a")], async () => undefined);
    await liveRunCapAdmission.evaluateAgent("agent-b", [waiter("run-b", "agent-b")], async () => undefined);
    expect(liveRunCapAdmission.listWaiters().map((entry) => entry.runId).sort()).toEqual(["run-a", "run-b"]);

    // Agent A is evaluated again and defers nothing (not invokable, or its own
    // per-agent slot is now full): its old waiter goes; agent B's stays.
    await liveRunCapAdmission.evaluateAgent("agent-a", [], async () => undefined);

    expect(liveRunCapAdmission.listWaiters().map((entry) => entry.runId)).toEqual(["run-b"]);
  });

  it("drops the waiter even when the evaluation throws", async () => {
    await liveRunCapAdmission.evaluateAgent("agent-a", [waiter("run-a", "agent-a")], async () => undefined);
    await expect(
      liveRunCapAdmission.evaluateAgent("agent-a", [], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(liveRunCapAdmission.waiterCount()).toBe(0);
  });
});

describe("live-run cap setting reader", () => {
  const failing = async (): Promise<never> => {
    throw new Error("db down");
  };

  it("fails closed to the ceiling when the first read fails, then keeps the last known value", async () => {
    const reader = createLiveRunCapSettingReader();
    await expect(reader.read(failing, NOW)).resolves.toBe(LIVE_RUN_CAP_CEILING);
    await expect(reader.read(async () => ({ kind: "cap", value: 12 }), NOW + 10_000)).resolves.toBe(12);
    await expect(reader.read(failing, NOW + 20_000)).resolves.toBe(12);
    await expect(reader.read(async () => ({ kind: "off" }), NOW + 30_000)).resolves.toBeNull();
    await expect(reader.read(failing, NOW + 40_000)).resolves.toBeNull();
  });

  it("keeps the last valid cap when the stored value turns invalid, and fails closed to the ceiling with none", async () => {
    const reader = createLiveRunCapSettingReader();
    await expect(reader.read(async () => ({ kind: "invalid" }), NOW)).resolves.toBe(LIVE_RUN_CAP_CEILING);
    await expect(reader.read(async () => ({ kind: "cap", value: 4 }), NOW + 10_000)).resolves.toBe(4);
    // An operator cap of 4 stays 4: failing closed must not loosen it to 15.
    await expect(reader.read(async () => ({ kind: "invalid" }), NOW + 20_000)).resolves.toBe(4);
    await expect(reader.read(async () => ({ kind: "off" }), NOW + 30_000)).resolves.toBeNull();
    await expect(reader.read(async () => ({ kind: "invalid" }), NOW + 40_000)).resolves.toBe(LIVE_RUN_CAP_CEILING);
  });

  it("serves the cached value until invalidated", async () => {
    const reader = createLiveRunCapSettingReader();
    const load = vi.fn(async () => ({ kind: "cap" as const, value: 9 }));
    await reader.read(load, NOW);
    await reader.read(load, NOW + 500);
    expect(load).toHaveBeenCalledTimes(1);
    reader.invalidate();
    await reader.read(load, NOW + 600);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
