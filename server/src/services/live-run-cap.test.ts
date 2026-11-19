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
  decideLiveRunCapAdmission,
  invalidateLiveRunCapSettingCache,
  isLiveRunCapExemptAgent,
  listLiveRunCapSignals,
  liveRunCapAdmission,
  readLiveRunCapSetting,
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
});

describe("decideLiveRunCapAdmission", () => {
  const cap = computeEffectiveLiveRunCap({ setting: 10, signals: [], nowMs: NOW })!;

  it("stops general work at cap - 2 and keeps the 2 reserved slots for priority work", () => {
    expect(decideLiveRunCapAdmission({ cap, occupied: 7, runClass: "general", aheadCount: 0 })).toEqual({ admit: true });
    expect(decideLiveRunCapAdmission({ cap, occupied: 8, runClass: "general", aheadCount: 0 })).toEqual({
      admit: false,
      reason: "cap_full",
    });
    for (const runClass of ["human_board", "review_recovery"] as const) {
      expect(decideLiveRunCapAdmission({ cap, occupied: 8, runClass, aheadCount: 0 })).toEqual({ admit: true });
      expect(decideLiveRunCapAdmission({ cap, occupied: 9, runClass, aheadCount: 0 })).toEqual({ admit: true });
      expect(decideLiveRunCapAdmission({ cap, occupied: 10, runClass, aheadCount: 0 })).toEqual({
        admit: false,
        reason: "cap_full",
      });
    }
  });

  it("starts nothing while the live count is above a lowered cap", () => {
    expect(decideLiveRunCapAdmission({ cap, occupied: 14, runClass: "human_board", aheadCount: 0 })).toEqual({
      admit: false,
      reason: "cap_full",
    });
  });

  it("yields free slots to waiters that are ahead in line", () => {
    expect(decideLiveRunCapAdmission({ cap, occupied: 6, runClass: "general", aheadCount: 2 })).toEqual({
      admit: false,
      reason: "behind_earlier_waiters",
    });
    expect(decideLiveRunCapAdmission({ cap, occupied: 6, runClass: "general", aheadCount: 1 })).toEqual({ admit: true });
  });
});

describe("classifyLiveRunCapRun", () => {
  const agentId = "agent-under-test";
  const base = { agentId, requestedByActorType: "system", issueOriginKind: "manual", issueExecutionState: null };
  const pendingStage = (participantAgentId: string, currentStageType = "review") => ({
    status: "pending",
    currentStageType,
    currentParticipant: { type: "agent", agentId: participantAgentId },
  });

  it("puts human and board wakes first, even on review work", () => {
    expect(classifyLiveRunCapRun({ ...base, requestedByActorType: "user", issueExecutionState: pendingStage(agentId) })).toBe("human_board");
  });

  it.each([
    { issueOriginKind: "stranded_issue_recovery" },
    { issueOriginKind: "harness_liveness_escalation" },
    { issueExecutionState: pendingStage(agentId) },
    { issueExecutionState: pendingStage(agentId, "approval") },
  ])("treats %j as review/recovery", (override) => {
    expect(classifyLiveRunCapRun({ ...base, ...override })).toBe("review_recovery");
  });

  it.each([
    { label: "a stage pending for another agent", issueExecutionState: pendingStage("someone-else") },
    { label: "a stage that is not pending", issueExecutionState: { ...pendingStage(agentId), status: "changes_requested" } },
    { label: "an unknown stage type", issueExecutionState: pendingStage(agentId, "custom") },
    { label: "a user participant", issueExecutionState: { status: "pending", currentStageType: "review", currentParticipant: { type: "user", userId: "u" } } },
    { label: "a malformed state", issueExecutionState: "pending" },
    { label: "a plugin origin kind", issueOriginKind: "plugin:example:stranded_issue_recovery" },
  ])("treats $label as general", ({ label: _label, ...override }) => {
    expect(classifyLiveRunCapRun({ ...base, ...override })).toBe("general");
  });

  it.each(["agent", "system", null])("ignores everything a %s-requested wake could choose", (requestedByActorType) => {
    expect(classifyLiveRunCapRun({ ...base, requestedByActorType })).toBe("general");
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
});

describe("admission lock", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("tells an overrun holder its lease expired, so it can skip its reservation", async () => {
    vi.useFakeTimers();
    let expiredSeen: boolean | null = null;
    let finishHolder!: () => void;
    const holderDone = new Promise<void>((resolve) => {
      finishHolder = resolve;
    });
    const result = liveRunCapAdmission.withLock(async (lease) => {
      await holderDone;
      expiredSeen = lease.expired();
      return "late";
    }, "timed-out", 20);

    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toBe("timed-out");
    finishHolder();
    await vi.waitFor(() => expect(expiredSeen).toBe(true));
  });
});

describe("readLiveRunCapSetting", () => {
  it("keeps the last good value when a read fails, and is off when there is none", async () => {
    await expect(readLiveRunCapSetting(async () => { throw new Error("db down"); }, NOW)).resolves.toBeNull();
    await expect(readLiveRunCapSetting(async () => 12, NOW)).resolves.toBe(12);
    await expect(
      readLiveRunCapSetting(async () => { throw new Error("db down"); }, NOW + 10_000),
    ).resolves.toBe(12);
  });

  it("serves the cached value until invalidated", async () => {
    const load = vi.fn(async () => 9);
    await readLiveRunCapSetting(load, NOW);
    await readLiveRunCapSetting(load, NOW + 500);
    expect(load).toHaveBeenCalledTimes(1);
    invalidateLiveRunCapSettingCache();
    await readLiveRunCapSetting(load, NOW + 600);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
