import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideZeroDeltaFromForge,
  githubForgeReader,
  recheckZeroDeltaForgeAtWrite,
  resetZeroDeltaForgeCache,
} from "./zero-delta-forge-rule.js";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("./github-fetch.js", () => ({
  ghFetch: fetch,
  gitHubApiBase: () => "https://api.github.com",
}));

const base = "a".repeat(40);
const ancestor = "b".repeat(40);
const hidden = "c".repeat(40);
const repo = { hostname: "github.com", owner: "test", repo: "project" };
const card = { repo, baseBranch: "main", declaredHead: ancestor, cardBranch: "CARD-1-cycle", cardIdentifier: "CARD-1" };
const budget = { perCallMs: 1000, totalMs: 5000, concurrency: 2 };
const api = "https://api.github.com/repos/test/project";
let branches: Array<{ name: string; commit: { sha: string } }>;
let tags: typeof branches;
let pulls: Array<{ state: string; merged_at?: string; head: { sha: string; repo: { full_name: string } | null } }>;

function answer(url: string): Response {
  const { pathname } = new URL(url);
  if (pathname.includes("/commits/")) return Response.json({ sha: pathname.endsWith("/main") ? base : ancestor });
  if (pathname.endsWith("/branches")) return Response.json(branches);
  if (pathname.endsWith("/tags")) return Response.json(tags);
  if (pathname.endsWith("/pulls")) return Response.json(pulls);
  if (pathname.includes("/compare/")) return Response.json({ ahead_by: pathname.endsWith(hidden) ? 1 : 0 });
  throw new Error(`Unexpected forge read ${url}`);
}

const decide = () => decideZeroDeltaFromForge(card, githubForgeReader("test-token"), budget);

beforeEach(() => {
  resetZeroDeltaForgeCache();
  branches = [{ name: "main", commit: { sha: base } }];
  tags = [];
  pulls = [];
  fetch.mockReset();
  fetch.mockImplementation(async (url: string) => answer(url));
});
afterEach(() => vi.restoreAllMocks());

describe("zero-delta forge evidence", () => {
  it.each(["other-work", "xCARD-1-hidden", "CARD-10-hidden"])("refuses unaccounted work regardless of branch name %s", async (name) => {
    branches.push({ name, commit: { sha: hidden } });
    expect(await decide()).toMatchObject({ ok: false, reason: `branch ${name} is not on the base line and is not a pull-request head` });
  });

  it.each(["open", "closed", "merged"])("accounts for an unrelated %s pull-request head by SHA", async (state) => {
    branches.push({ name: "other-work", commit: { sha: hidden } });
    pulls.push({ state: state === "merged" ? "closed" : state, ...(state === "merged" ? { merged_at: "2026-11-21T00:00:00Z" } : {}), head: { sha: hidden, repo: { full_name: "test/project" } } });
    expect(await decide()).toMatchObject({ ok: true, proof: { baseSha: base, headSha: ancestor } });
    pulls[0]!.head.sha = "d".repeat(40);
    expect(await decide()).toMatchObject({ ok: false, reason: expect.stringContaining("not a pull-request head") });
  });

  it.each(["branch", "tag"] as const)("a card-named %s cannot use the pull-request exemption", async (kind) => {
    (kind === "branch" ? branches : tags).push({ name: "CARD-1-hidden", commit: { sha: hidden } });
    pulls.push({ state: "open", head: { sha: hidden, repo: { full_name: "test/project" } } });
    expect(await decide()).toMatchObject({ ok: false, reason: `${kind} CARD-1-hidden names this card and is not on the base line` });
  });

  it("refuses an unaccounted forge tag even with a clean branch list", async () => {
    tags.push({ name: "hidden-release", commit: { sha: hidden } });
    expect(await decide()).toMatchObject({ ok: false, reason: "tag hidden-release is not on the base line and is not a pull-request head" });
  });

  it.each([404, 500, "network"])("refuses an unreadable base (%s) without a local fallback", async (failure) => {
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/commits/main")) {
        if (failure === "network") throw new Error("offline");
        return Response.json({}, { status: failure as number });
      }
      return answer(url);
    });
    expect(await decide()).toMatchObject({ ok: false });
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/commits/main"))).toBe(true);
  });

  it("follows a short non-final branch page and refuses hidden work on its successor", async () => {
    fetch.mockImplementation(async (url: string) => {
      if (url === `${api}/branches?per_page=100`) return Response.json(branches, { headers: { link: `<${api}/branches?per_page=100&page=2>; rel="next"` } });
      if (url.endsWith("/branches?per_page=100&page=2")) return Response.json([{ name: "later-work", commit: { sha: hidden } }]);
      return answer(url);
    });
    expect(await decide()).toMatchObject({ ok: false, reason: "branch later-work is not on the base line and is not a pull-request head" });
  });

  it("reaches a valid final page beyond the old twenty-page cap", async () => {
    fetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/branches")) {
        const page = Number(u.searchParams.get("page") ?? "1");
        return Response.json([{ name: `delivered-${page}`, commit: { sha: base } }], page < 21 ? { headers: { link: `<${api}/branches?per_page=100&page=${page + 1}>; rel="next"` } } : undefined);
      }
      return answer(url);
    });
    expect(await decide()).toMatchObject({ ok: true, proof: { classified: 21 } });
  });

  it("refuses when the base moves while the snapshot is listed", async () => {
    let baseReads = 0;
    fetch.mockImplementation(async (url: string) => url.endsWith("/commits/main")
      ? Response.json({ sha: ++baseReads === 1 ? base : hidden }) : answer(url));
    expect(await decide()).toMatchObject({ ok: false, retriable: true, reason: "the remote base main moved while it was listed" });
  });

  it("refuses a tag added between measurement and the close write", async () => {
    const measured = await decide();
    expect(measured.ok).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    tags.push({ name: "late", commit: { sha: base } });
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({
      ok: false, retriable: true, reason: "the remote refs changed after the close was measured",
    });
  });

  it("aborts an unanswered forge read and refuses rather than hanging", async () => {
    const signals: AbortSignal[] = [];
    // The server's TypeScript library target predates Promise.withResolvers.
    fetch.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    expect(await decideZeroDeltaFromForge(card, githubForgeReader("test-token"), { perCallMs: 20, totalMs: 100, concurrency: 1 })).toMatchObject({ ok: false, retriable: true });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("refuses when paging consumes the total snapshot budget", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetch.mockImplementation(async (url: string) => {
      if (url.includes("/branches?")) {
        now = 5001;
        return Response.json(branches, { headers: { link: `<${api}/branches?per_page=100&page=2>; rel="next"` } });
      }
      return answer(url);
    });
    expect(await decide()).toMatchObject({ ok: false, retriable: true, reason: "the forge read ran out of its time budget" });
  });

  it.each(["other/project", null])("refuses a pull-request exemption from a foreign or unknown head repository (%s)", async (fullName) => {
    branches.push({ name: "other-work", commit: { sha: hidden } });
    pulls.push({ state: "open", head: { sha: hidden, repo: fullName === null ? null : { full_name: fullName } } });

    expect(await decide()).toMatchObject({
      ok: false,
      reason: "branch other-work is not on the base line and is not a pull-request head",
    });
  });

  it.each(["moved", "removed", "forked"] as const)("refuses at the close write when an accounting pull-request head is %s", async (change) => {
    branches.push({ name: "other-work", commit: { sha: hidden } });
    pulls.push({ state: "open", head: { sha: hidden, repo: { full_name: "test/project" } } });
    const measured = await decide();
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: true });

    if (change === "moved") pulls[0]!.head.sha = ancestor;
    else if (change === "removed") pulls = [];
    else pulls[0]!.head.repo = { full_name: "fork/project" };

    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({
      ok: false,
      retriable: true,
      reason: "the remote refs changed after the close was measured",
    });
  });

  it("refuses at the close write when the pull-request accounting set cannot be read", async () => {
    const measured = await decide();
    expect(measured.ok).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    fetch.mockImplementation(async (url: string) => new URL(url).pathname.endsWith("/pulls")
      ? Response.json({}, { status: 503 }) : answer(url));

    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: false, retriable: true });
  });
});
