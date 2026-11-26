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
let pulls: Array<{ state: string; merged_at?: string | null; head: { ref?: string; sha: string; repo: { full_name: string } | null } }>;
let otherRefs: Array<{ ref: string; object: { type: string; sha: string } }>;

function answer(url: string): Response {
  const { pathname } = new URL(url);
  if (pathname.includes("/commits/")) return Response.json({ sha: pathname.endsWith("/main") ? base : ancestor });
  if (pathname.endsWith("/git/matching-refs/")) return Response.json([
    ...branches.map(({ name, commit }) => ({ ref: `refs/heads/${name}`, object: { type: "commit", sha: commit.sha } })),
    ...tags.map(({ name, commit }) => ({ ref: `refs/tags/${name}`, object: { type: "commit", sha: commit.sha } })),
    ...otherRefs,
  ]);
  if (pathname.endsWith("/branches")) return Response.json(branches);
  if (pathname.endsWith("/tags")) return Response.json(tags);
  if (pathname.endsWith("/pulls")) return Response.json(pulls);
  if (pathname.includes("/compare/")) return Response.json({ ahead_by: pathname.endsWith(hidden) ? 1 : 0 });
  throw new Error(`Unexpected forge read ${url}`);
}

const decide = (clock?: () => number) => decideZeroDeltaFromForge(card, githubForgeReader("test-token", clock), budget);

beforeEach(() => {
  resetZeroDeltaForgeCache();
  branches = [{ name: "main", commit: { sha: base } }];
  tags = [];
  pulls = [];
  otherRefs = [];
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

  it.each(["test/project", "fork/project"])("refuses an off-base card-named open pull-request head retained only by a pull ref (%s)", async (fullName) => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: hidden } });
    pulls.push({ state: "open", head: { ref: "CARD-1-cycle", sha: hidden, repo: { full_name: fullName } } });
    expect(await decide()).toMatchObject({ ok: false });
  });

  it.each(["CARD-2-cycle", "CARD-10-cycle", "xCARD-1-cycle"])("does not block on an unrelated open pull-request name %s", async (name) => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: hidden } });
    pulls.push({ state: "open", head: { ref: name, sha: hidden, repo: { full_name: "test/project" } } });
    expect(await decide()).toMatchObject({ ok: true });
  });

  it("accepts a card-named open pull-request head already on the base line", async () => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: ancestor } });
    pulls.push({ state: "open", head: { ref: "CARD-1-cycle", sha: ancestor, repo: { full_name: "test/project" } } });
    expect(await decide()).toMatchObject({ ok: true });
  });

  it.each(["test/project", "fork/project"])("refuses a closed-unmerged card-named pull-request head retained only by a pull ref (%s)", async (fullName) => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: hidden } });
    pulls.push({ state: "closed", merged_at: null, head: { ref: "CARD-1-cycle", sha: hidden, repo: { full_name: fullName } } });
    expect(await decide()).toMatchObject({ ok: false });
  });

  it("accepts a squash-merged card-named pull request whose old head is off base", async () => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: hidden } });
    pulls.push({ state: "closed", merged_at: "2026-11-26T00:00:00Z", head: { ref: "CARD-1-cycle", sha: hidden, repo: { full_name: "test/project" } } });
    expect(await decide()).toMatchObject({ ok: true });
  });

  it.each(["CARD-2-cycle", "CARD-10-cycle", "xCARD-1-cycle"])("accepts an unrelated off-base fork PR named %s", async (name) => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: hidden } });
    pulls.push({ state: "open", head: { ref: name, sha: hidden, repo: { full_name: "fork/project" } } });
    expect(await decide()).toMatchObject({ ok: true });
  });

  it.each(["c".repeat(39), "c".repeat(41), "z".repeat(40)])("ignores malformed PR head SHA evidence at the close write (%s)", async (sha) => {
    const measured = await decide();
    if (!measured.ok) throw new Error(measured.reason);
    pulls.push({ state: "open", head: { ref: "CARD-1-cycle", sha, repo: { full_name: "test/project" } } });
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: true });
  });

  it.each([undefined, null, 42])("ignores a PR without a string head.ref at the close write (%s)", async (ref) => {
    const measured = await decide();
    if (!measured.ok) throw new Error(measured.reason);
    fetch.mockImplementation(async (url: string) => new URL(url).pathname.endsWith("/pulls")
      ? Response.json([{ state: "open", head: { ref, sha: base, repo: { full_name: "fork/project" } } }]) : answer(url));
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: true });
  });

  it("accepts a delivered recorded branch without a card token that is also a repository PR head", async () => {
    branches.push({ name: "fm/cycle", commit: { sha: ancestor } });
    pulls.push({ state: "open", head: { ref: "fm/cycle", sha: ancestor, repo: { full_name: "test/project" } } });
    expect(await decideZeroDeltaFromForge({ ...card, cardBranch: "fm/cycle" }, githubForgeReader("test-token"), budget)).toMatchObject({ ok: true });
  });

  it.each(["tree", "blob", undefined])("refuses an unsupported additional-namespace object type (%s)", async (type) => {
    fetch.mockImplementation(async (url: string) => url.endsWith("/git/matching-refs/") ? Response.json([
      { ref: "refs/heads/main", object: { type: "commit", sha: base } },
      { ref: "refs/keep/unrelated", object: { type, sha: base } },
    ]) : answer(url));
    expect(await decide()).toMatchObject({ ok: false });
  });

  it("does not invalidate a close when only an unrelated raw pull ref moves", async () => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: hidden } });
    const measured = await decide();
    if (!measured.ok) throw new Error(measured.reason);
    otherRefs[0]!.object.sha = ancestor;
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: true });
  });

  it("refuses at the close write when an unchanged pull-request head is renamed for this card", async () => {
    otherRefs.push({ ref: "refs/pull/17/head", object: { type: "commit", sha: hidden } });
    pulls.push({ state: "open", head: { ref: "CARD-2-cycle", sha: hidden, repo: { full_name: "test/project" } } });
    const measured = await decide();
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    pulls[0]!.head.ref = "CARD-1-cycle";
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({
      ok: false, retriable: true,
    });
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

  it.each(["pagination", "partial status", "content range"])("refuses a reference response without complete evidence (%s)", async (partial) => {
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/matching-refs/")) {
        const headers = new Headers();
        if (partial === "pagination") headers.set("link", `<${api}/git/matching-refs/?page=2>; rel="next"`);
        if (partial === "content range") headers.set("content-range", "items 0-0/2");
        return Response.json([{ ref: "refs/heads/main", object: { type: "commit", sha: base } }], {
          status: partial === "partial status" ? 206 : 200,
          headers,
        });
      }
      return answer(url);
    });
    expect(await decide()).toMatchObject({ ok: false });
  });

  it("classifies every tip in a complete inventory larger than twenty former pages", async () => {
    branches.push(...Array.from({ length: 2101 }, (_, i) => ({ name: `delivered-${i}`, commit: { sha: base } })));
    expect(await decide()).toMatchObject({ ok: true });
    branches[branches.length - 1]!.commit.sha = hidden;
    expect(await decide()).toMatchObject({ ok: false, reason: "branch delivered-2100 is not on the base line and is not a pull-request head" });
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

  it.each(["branch", "tag"] as const)("refuses a close-write %s inventory whose offset pages shift after a deletion", async (kind) => {
    const listed = kind === "branch" ? branches : tags;
    listed.unshift({ name: "a-ephemeral", commit: { sha: base } });
    if (kind === "tag") listed.push({ name: "delivered", commit: { sha: base } });
    const measured = await decide();
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    listed.push({ name: "parked-work", commit: { sha: hidden } });

    fetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith(kind === "branch" ? "/branches" : "/tags")) {
        const page = Number(u.searchParams.get("page") ?? "1");
        const rows = listed.slice((page - 1) * 2, page * 2);
        if (page === 1) {
          listed.shift();
          return Response.json(rows, { headers: { link: `<${api}/${kind === "branch" ? "branches" : "tags"}?per_page=2&page=2>; rel="next"` } });
        }
        return Response.json(rows);
      }
      if (u.pathname.endsWith("/git/matching-refs/")) {
        return Response.json([
          ...branches.map(({ name, commit }) => ({ ref: `refs/heads/${name}`, object: { type: "commit", sha: commit.sha } })),
          ...tags.map(({ name, commit }) => ({ ref: `refs/tags/${name}`, object: { type: "commit", sha: commit.sha } })),
        ]);
      }
      return answer(url);
    });

    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({
      ok: false,
      retriable: true,
    });
  });

  it.each([
    [],
    [{ ref: "refs/heads/main", object: { type: "commit", sha: hidden } }],
    [{ ref: "refs/heads/main", object: { type: "commit", sha: base } }, { ref: "refs/heads/main", object: { type: "commit", sha: base } }],
    [{ ref: "refs/heads/main", object: { type: "commit", sha: base } }, { ref: "refs/tags/broken", object: { type: "commit", sha: "not-a-sha" } }],
  ])("refuses incomplete or ambiguous reference evidence %#", async (...rows) => {
    fetch.mockImplementation(async (url: string) => url.endsWith("/git/matching-refs/") ? Response.json(rows) : answer(url));
    expect(await decide()).toMatchObject({ ok: false });
  });

  it("peels annotated tags by captured immutable object rather than by tag name", async () => {
    const tag = "d".repeat(40);
    const nested = "e".repeat(40);
    let taggedCommit = ancestor;
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/matching-refs/")) return Response.json([
        { ref: "refs/heads/main", object: { type: "commit", sha: base } },
        { ref: "refs/tags/release", object: { type: "tag", sha: taggedCommit === ancestor ? tag : "f".repeat(40) } },
      ]);
      if (url.endsWith(`/git/tags/${tag}`)) return Response.json({ object: { type: "tag", sha: nested } });
      if (url.includes("/git/tags/")) return Response.json({ object: { type: "commit", sha: taggedCommit } });
      return answer(url);
    });
    const measured = await decide();
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: true });
    taggedCommit = hidden;
    expect(await decide()).toMatchObject({ ok: false, reason: "tag release is not on the base line and is not a pull-request head" });
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: false });
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
    fetch.mockImplementation(async (url: string) => {
      if (url.includes("/pulls?")) {
        now = 5001;
        return Response.json(pulls, { headers: { link: `<${api}/pulls?state=all&per_page=100&page=2>; rel="next"` } });
      }
      return answer(url);
    });
    expect(await decide(() => now)).toMatchObject({ ok: false, retriable: true, reason: "the forge read ran out of its time budget" });
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

  it.each(["refs/preserved/CARD-1/cycle", "refs/keep/CARD-1", "refs/CARD-1/work"])("refuses undelivered card-named non-branch ref %s", async (ref) => {
    otherRefs.push({ ref, object: { type: "commit", sha: hidden } });
    expect(await decide()).toMatchObject({ ok: false, reason: expect.stringContaining(ref) });
    pulls.push({ state: "open", head: { sha: hidden, repo: { full_name: "test/project" } } });
    expect(await decide()).toMatchObject({ ok: false, reason: expect.stringContaining(ref) });
  });

  it("refuses a preserved ref added before the close write", async () => {
    const measured = await decide();
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    otherRefs.push({ ref: "refs/preserved/CARD-1/cycle", object: { type: "commit", sha: hidden } });
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({
      ok: false, retriable: true,
    });
  });

  it.each(["refs/preserved/CARD-2/cycle", "refs/pull/7/head"])("does not globally block the card on unrelated non-branch ref %s", async (ref) => {
    otherRefs.push({ ref, object: { type: "commit", sha: hidden } });
    const measured = await decide();
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({ ok: true });
  });

  it.each(["branch", "tag"] as const)("accepts a delivered card-named %s even when its SHA is a pull-request head", async (kind) => {
    (kind === "branch" ? branches : tags).push({ name: "CARD-1-cycle", commit: { sha: ancestor } });
    expect(await decide()).toMatchObject({ ok: true });
    pulls.push({ state: "open", head: { sha: ancestor, repo: { full_name: "test/project" } } });
    expect(await decide()).toMatchObject({ ok: true });
  });

  it.each(["default", "injected"])("uses monotonic time at the close write when the wall clock jumps forward (%s)", async (mode) => {
    let wall = 0;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    vi.spyOn(performance, "now").mockReturnValue(0);
    const reader = githubForgeReader("test-token", mode === "injected" ? () => 0 : undefined);
    const measured = await decideZeroDeltaFromForge(card, reader, budget);
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/matching-refs/")) wall = 25_000;
      return answer(url);
    });
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, reader, {
      perCallMs: 10_000, totalMs: 20_000, concurrency: 1,
    })).toMatchObject({ ok: true });
  });

  it("exhausts the injected write budget despite a backward wall-clock jump", async () => {
    let elapsed = 0;
    let wall = 0;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    const reader = githubForgeReader("test-token", () => elapsed);
    const measured = await decideZeroDeltaFromForge(card, reader, budget);
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/matching-refs/")) {
        elapsed = 20_001;
        wall = -25_000;
      }
      return answer(url);
    });
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, reader, {
      perCallMs: 10_000, totalMs: 20_000, concurrency: 1,
    })).toMatchObject({ ok: false, retriable: true, reason: "the forge read ran out of its time budget" });
  });

  it("refuses when the base moves while pull pages are read inside the close-write bracket", async () => {
    pulls = [base, ancestor].map((sha) => ({ state: "open", head: { sha, repo: { full_name: "test/project" } } }));
    const measured = await decide();
    expect(measured.ok, JSON.stringify(measured)).toBe(true);
    if (!measured.ok) throw new Error(measured.reason);
    let currentBase = base;
    fetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/commits/main")) return Response.json({ sha: currentBase });
      if (u.pathname.endsWith("/pulls")) {
        if (u.searchParams.get("page") === "2") {
          currentBase = hidden;
          return Response.json([pulls[1]]);
        }
        return Response.json([pulls[0]], { headers: { link: `<${api}/pulls?state=all&per_page=1&page=2>; rel="next"` } });
      }
      return answer(url);
    });
    expect(await recheckZeroDeltaForgeAtWrite(card, measured.proof, githubForgeReader("test-token"), budget)).toMatchObject({
      ok: false, retriable: true, reason: "the remote base main moved while it was listed",
    });
  });

  it("refuses a ref row without the refs namespace prefix instead of silently dropping it", async () => {
    otherRefs.push({ ref: "heads/undelivered", object: { type: "commit", sha: hidden } });
    expect(await decide()).toMatchObject({ ok: false, reason: "the forge reference snapshot had invalid or duplicate names" });
  });

  it("refuses a tag cycle before spending the full snapshot budget", async () => {
    const a = "d".repeat(40);
    const b = "e".repeat(40);
    let elapsed = 0;
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/matching-refs/")) return Response.json([
        { ref: "refs/heads/main", object: { type: "commit", sha: base } },
        { ref: "refs/tags/cycle", object: { type: "tag", sha: a } },
      ]);
      if (url.includes("/git/tags/")) {
        elapsed += 1000;
        return Response.json({ object: { type: "tag", sha: url.endsWith(a) ? b : a } });
      }
      return answer(url);
    });
    expect(await decide(() => elapsed)).toMatchObject({ ok: false, retriable: false });
    expect(elapsed).toBeLessThan(budget.totalMs);
  });

  it.each(["branch", "tag"] as const)("refuses an invalid %s row object type even when its SHA is the delivered base", async (kind) => {
    for (const type of ["tree", "blob", undefined]) {
      fetch.mockImplementation(async (url: string) => url.endsWith("/git/matching-refs/") ? Response.json([
        { ref: "refs/heads/main", object: { type: "commit", sha: base } },
        { ref: `refs/${kind === "branch" ? "heads" : "tags"}/invalid`, object: { sha: base, ...(type ? { type } : {}) } },
      ]) : answer(url));
      expect(await decide()).toMatchObject({ ok: false, reason: "the forge reference snapshot omitted a commit" });
    }
  });
});
