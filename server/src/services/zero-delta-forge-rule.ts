import { createHash } from "node:crypto";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { branchNamesIssue } from "./hardened-git-probe.js";

// A zero-delta close is a forge fact. This module takes no value read from disk.

export interface ForgeRepo {
  hostname: string;
  owner: string;
  repo: string;
}

export interface ForgeRef {
  kind: "branch" | "tag" | "ref";
  name: string;
  sha: string;
}

export interface ForgeSnapshot {
  repo: ForgeRepo;
  baseBranch: string;
  baseSha: string;
  refs: readonly ForgeRef[];
  pullRequestHeads: ReadonlySet<string>;
  digest: string;
}

export interface ForgeBudget {
  perCallMs: number;
  totalMs: number;
  concurrency: number;
}

export interface ForgeReader {
  snapshot(repo: ForgeRepo, baseBranch: string, budget: ForgeBudget): Promise<ForgeSnapshot>;
  aheadBy(repo: ForgeRepo, baseSha: string, tipSha: string, budget: ForgeBudget): Promise<number>;
  resolveCommit(repo: ForgeRepo, ref: string, budget: ForgeBudget): Promise<string | null>;
}

export type ForgeVerdict =
  | { ok: true; proof: { snapshotDigest: string; baseSha: string; headSha: string; classified: number } }
  | { ok: false; reason: string; retriable: boolean };

export const ZERO_DELTA_MEASUREMENT_BUDGET: ForgeBudget = { perCallMs: 10_000, totalMs: 90_000, concurrency: 8 };
export const ZERO_DELTA_WRITE_BUDGET: ForgeBudget = { perCallMs: 10_000, totalMs: 20_000, concurrency: 1 };

type ForgeClock = () => number;
const monotonicNow: ForgeClock = () => performance.now();

const deliveredToBase = new Map<string, true>();
const tagCommits = new Map<string, string>();

export function resetZeroDeltaForgeCache(): void {
  deliveredToBase.clear();
  tagCommits.clear();
}

export function forgeSnapshotDigest(baseSha: string, refs: readonly ForgeRef[], pullRequestHeads: ReadonlySet<string>): string {
  const lines = [
    ...refs.map((ref) => `${ref.kind} ${ref.name} ${ref.sha}`),
    ...[...pullRequestHeads].map((sha) => `pr-head ${sha}`),
  ].sort();
  return createHash("sha256").update(`${baseSha}\n${lines.join("\n")}`).digest("hex");
}

class ForgeReadError extends Error {
  constructor(message: string, readonly retriable: boolean) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringField(value: unknown, key: string): string | null {
  const row = asRecord(value);
  const field = row?.[key];
  return typeof field === "string" ? field : null;
}

function repoPath(repo: ForgeRepo): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

function requestSignal(budget: ForgeBudget, startedAt: number, clock: ForgeClock): AbortSignal {
  const remaining = budget.totalMs - (clock() - startedAt);
  if (remaining <= 0) throw new ForgeReadError("the forge read ran out of its time budget", true);
  return AbortSignal.any([AbortSignal.timeout(budget.perCallMs), AbortSignal.timeout(Math.ceil(remaining))]);
}

async function forgeGet(token: string, url: string, budget: ForgeBudget, startedAt: number, clock: ForgeClock): Promise<Response> {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-zero-delta-forge-rule",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  let lastError: ForgeReadError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await ghFetch(url, { headers, signal: requestSignal(budget, startedAt, clock) });
      if (response.status === 401 || response.status === 403) {
        throw new ForgeReadError(`the forge refused the read (${response.status})`, false);
      }
      if (response.status >= 500) {
        lastError = new ForgeReadError(`the forge read failed (${response.status})`, true);
        continue;
      }
      return response;
    } catch (err) {
      if (err instanceof ForgeReadError) throw err;
      lastError = new ForgeReadError("the forge read did not answer", true);
    }
  }
  throw lastError ?? new ForgeReadError("the forge read did not answer", true);
}

async function listAll(token: string, firstUrl: string, budget: ForgeBudget, startedAt: number, clock: ForgeClock): Promise<unknown[]> {
  const rows: unknown[] = [];
  let next: string | null = firstUrl;
  while (next) {
    const response = await forgeGet(token, next, budget, startedAt, clock);
    if (!response.ok) throw new ForgeReadError(`the forge list failed (${response.status})`, response.status >= 500);
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw new ForgeReadError("the forge list was not a list", false);
    rows.push(...body);
    next = nextLink(response.headers.get("link"));
  }
  return rows;
}

async function readCommitSha(response: Response, label: string): Promise<string> {
  const sha = stringField(asRecord(await response.json().catch(() => null)), "sha")?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ForgeReadError(`${label} could not be read`, false);
  return sha;
}

async function peelTag(token: string, api: string, sha: string, budget: ForgeBudget, startedAt: number, clock: ForgeClock): Promise<string> {
  const visited = new Set<string>();
  while (true) {
    const url = `${api}/git/tags/${sha}`;
    const cached = tagCommits.get(url);
    if (cached) {
      for (const tag of visited) tagCommits.set(tag, cached);
      return cached;
    }
    if (visited.has(url)) throw new ForgeReadError("the forge tag objects formed a cycle", false);
    visited.add(url);
    const response = await forgeGet(token, url, budget, startedAt, clock);
    if (!response.ok) throw new ForgeReadError("the forge tag object could not be read", response.status >= 500);
    const object = asRecord(asRecord(await response.json().catch(() => null))?.object);
    const type = stringField(object, "type");
    sha = stringField(object, "sha")?.toLowerCase() ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha) || (type !== "commit" && type !== "tag")) {
      throw new ForgeReadError("the forge tag did not resolve to a commit", false);
    }
    if (type === "commit") {
      // Tag objects are immutable. Cache only a fully resolved object, never a tag name.
      for (const tag of visited) tagCommits.set(tag, sha);
      return sha;
    }
  }
}

async function readRefs(token: string, api: string, baseBranch: string, baseSha: string, budget: ForgeBudget, startedAt: number, clock: ForgeClock): Promise<ForgeRef[]> {
  // GitHub documents this unfiltered endpoint as one complete, unpaginated
  // namespace read. Offset-paged /branches and /tags can silently skip work.
  const response = await forgeGet(token, `${api}/git/matching-refs/`, budget, startedAt, clock);
  if (response.status !== 200) throw new ForgeReadError(`the forge reference snapshot failed (${response.status})`, response.status >= 500);
  if (response.headers.has("link") || response.headers.has("content-range")) {
    throw new ForgeReadError("the forge reference snapshot was partial or paginated", true);
  }
  const rows: unknown = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw new ForgeReadError("the forge reference snapshot was not a list", false);
  const refs: ForgeRef[] = [];
  const annotated: ForgeRef[] = [];
  const names = new Set<string>();
  for (const row of rows) {
    const name = stringField(row, "ref");
    if (!name?.startsWith("refs/") || names.has(name)) throw new ForgeReadError("the forge reference snapshot had invalid or duplicate names", false);
    names.add(name);
    if (name.startsWith("refs/pull/")) continue;
    const kind = name.startsWith("refs/heads/") ? "branch" : name.startsWith("refs/tags/") ? "tag" : "ref";
    const object = asRecord(asRecord(row)?.object);
    const type = stringField(object, "type");
    const sha = stringField(object, "sha")?.toLowerCase() ?? "";
    const shortName = kind === "ref" ? name : name.slice(kind === "branch" ? "refs/heads/".length : "refs/tags/".length);
    if (!shortName || !/^[0-9a-f]{40}$/.test(sha) || (type !== "commit" && (kind === "branch" || type !== "tag"))) {
      throw new ForgeReadError("the forge reference snapshot omitted a commit", false);
    }
    const ref: ForgeRef = { kind, name: shortName, sha };
    refs.push(ref);
    if (type === "tag") annotated.push(ref);
  }
  if (!refs.some((ref) => ref.kind === "branch" && ref.name === baseBranch && ref.sha === baseSha)) {
    throw new ForgeReadError("the forge reference snapshot omitted or changed the remote base", true);
  }
  await mapPool(annotated, budget.concurrency, async (ref) => {
    ref.sha = await peelTag(token, api, ref.sha, budget, startedAt, clock);
  });
  return refs;
}

export function githubForgeReader(token: string, clock: ForgeClock = monotonicNow): ForgeReader {
  return {
    async snapshot(repo, baseBranch, budget) {
      const startedAt = clock();
      const api = gitHubApiBase(repo.hostname);
      const baseUrl = `${api}${repoPath(repo)}/commits/${encodeURIComponent(baseBranch)}`;
      const before = await forgeGet(token, baseUrl, budget, startedAt, clock);
      if (before.status === 404 || !before.ok) {
        throw new ForgeReadError(`the remote base ${baseBranch} could not be read`, before.status >= 500);
      }
      const baseSha = await readCommitSha(before, `the remote base ${baseBranch}`);
      const refs = await readRefs(token, `${api}${repoPath(repo)}`, baseBranch, baseSha, budget, startedAt, clock);
      const pullRows = await listAll(token, `${api}${repoPath(repo)}/pulls?state=all&per_page=100`, budget, startedAt, clock);
      const pullRequestHeads = new Set<string>();
      const repositoryName = `${repo.owner}/${repo.repo}`.toLowerCase();
      for (const row of pullRows) {
        const pull = asRecord(row);
        const head = asRecord(pull?.head);
        const sha = stringField(head, "sha")?.toLowerCase();
        if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
        const branch = stringField(head, "ref");
        // Retain unmerged PR names even after the source branch was deleted.
        // These refusal-only refs also bind name/merge changes into the digest.
        const unmerged = pull?.state === "open" || (pull?.state === "closed" && pull.merged_at == null);
        if (unmerged && branch) {
          refs.push({ kind: "ref", name: `pull-request ${branch}`, sha });
        }
        if (stringField(head?.repo, "full_name")?.toLowerCase() === repositoryName) pullRequestHeads.add(sha);
      }
      const after = await forgeGet(token, baseUrl, budget, startedAt, clock);
      if (!after.ok) throw new ForgeReadError(`the remote base ${baseBranch} could not be read`, after.status >= 500);
      if (await readCommitSha(after, `the remote base ${baseBranch}`) !== baseSha) {
        throw new ForgeReadError(`the remote base ${baseBranch} moved while it was listed`, true);
      }
      return { repo, baseBranch, baseSha, refs, pullRequestHeads, digest: forgeSnapshotDigest(baseSha, refs, pullRequestHeads) };
    },
    async aheadBy(repo, baseSha, tipSha, budget) {
      const key = `${repo.hostname}/${repo.owner}/${repo.repo} ${baseSha} ${tipSha}`;
      if (deliveredToBase.has(key)) return 0;
      const startedAt = clock();
      const response = await forgeGet(
        token,
        `${gitHubApiBase(repo.hostname)}${repoPath(repo)}/compare/${baseSha}...${tipSha}`,
        budget,
        startedAt,
        clock,
      );
      if (!response.ok) throw new ForgeReadError(`the forge could not compare ${tipSha} with the base`, response.status >= 500);
      const aheadBy = asRecord(await response.json().catch(() => null))?.ahead_by;
      if (typeof aheadBy !== "number") throw new ForgeReadError(`the forge could not compare ${tipSha} with the base`, false);
      if (aheadBy === 0) deliveredToBase.set(key, true);
      return aheadBy;
    },
    async resolveCommit(repo, ref, budget) {
      const startedAt = clock();
      const response = await forgeGet(
        token,
        `${gitHubApiBase(repo.hostname)}${repoPath(repo)}/commits/${encodeURIComponent(ref)}`,
        budget,
        startedAt,
        clock,
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new ForgeReadError(`the forge could not resolve ${ref}`, response.status >= 500);
      const sha = stringField(asRecord(await response.json().catch(() => null)), "sha")?.toLowerCase() ?? "";
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
  };
}

async function mapPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

export async function decideZeroDeltaFromForge(
  card: { repo: ForgeRepo; baseBranch: string; declaredHead: string; cardBranch: string; cardIdentifier: string },
  forge: ForgeReader,
  budget: ForgeBudget,
): Promise<ForgeVerdict> {
  try {
    const snapshot = await forge.snapshot(card.repo, card.baseBranch, budget);
    const pullHeads = snapshot.pullRequestHeads;
    const delivered = new Set<string>([snapshot.baseSha]);
    const relevantTips = new Set<string>();
    const mustLand = new Set<string>();
    const namedRefs: ForgeRef[] = [];
    let cardBranch: ForgeRef | undefined;
    for (const ref of snapshot.refs) {
      const named = branchNamesIssue(ref.name, card.cardIdentifier);
      const ownBranch = ref.kind === "branch" && ref.name === card.cardBranch;
      if (named) namedRefs.push(ref);
      if (ownBranch) cardBranch = ref;
      if (named || ownBranch) mustLand.add(ref.sha);
      if (ref.kind !== "ref" || named) relevantTips.add(ref.sha);
    }
    const unclassified = [...relevantTips].filter(
      (sha) => sha !== snapshot.baseSha && (!pullHeads.has(sha) || mustLand.has(sha)),
    );
    let refused: string | null = null;
    await mapPool(unclassified, budget.concurrency, async (tip) => {
      if (refused) return;
      const ahead = await forge.aheadBy(card.repo, snapshot.baseSha, tip, budget);
      if (ahead === 0) delivered.add(tip);
      else if (!pullHeads.has(tip) && !refused) {
        const name = snapshot.refs.find((ref) => ref.sha === tip);
        refused = `${name ? `${name.kind} ${name.name}` : tip} is not on the base line and is not a pull-request head`;
      }
    });
    if (refused) return { ok: false, reason: refused, retriable: false };
    for (const ref of namedRefs) {
      if (!delivered.has(ref.sha)) {
        return { ok: false, reason: `${ref.kind} ${ref.name} names this card and is not on the base line`, retriable: false };
      }
    }
    if (cardBranch && !delivered.has(cardBranch.sha)) {
      return { ok: false, reason: `the card's branch ${card.cardBranch} on the remote is not on the base line`, retriable: false };
    }
    const headSha = await forge.resolveCommit(card.repo, card.declaredHead, budget);
    if (!headSha) return { ok: false, reason: `HEAD ${card.declaredHead} could not be resolved on the remote`, retriable: false };
    if (!delivered.has(headSha)) {
      const ahead = await forge.aheadBy(card.repo, snapshot.baseSha, headSha, budget);
      if (ahead !== 0) return { ok: false, reason: `HEAD ${headSha} carries ${ahead} commit(s) that the remote base lacks`, retriable: false };
    }
    return {
      ok: true,
      proof: { snapshotDigest: snapshot.digest, baseSha: snapshot.baseSha, headSha, classified: snapshot.refs.length },
    };
  } catch (err) {
    const retriable = err instanceof ForgeReadError ? err.retriable : true;
    return { ok: false, reason: err instanceof Error ? err.message : "the forge read failed", retriable };
  }
}

export async function recheckZeroDeltaForgeAtWrite(
  card: { repo: ForgeRepo; baseBranch: string },
  proof: { snapshotDigest: string; baseSha: string },
  forge: ForgeReader,
  budget: ForgeBudget,
): Promise<ForgeVerdict> {
  try {
    const snapshot = await forge.snapshot(card.repo, card.baseBranch, budget);
    if (snapshot.baseSha !== proof.baseSha) {
      return { ok: false, reason: "the remote base commit changed after the close was measured", retriable: true };
    }
    if (snapshot.digest !== proof.snapshotDigest) {
      return { ok: false, reason: "the remote refs changed after the close was measured", retriable: true };
    }
    return {
      ok: true,
      proof: { snapshotDigest: snapshot.digest, baseSha: snapshot.baseSha, headSha: proof.baseSha, classified: snapshot.refs.length },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "the forge read failed", retriable: true };
  }
}
