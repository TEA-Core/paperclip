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
  kind: "branch" | "tag";
  name: string;
  sha: string;
}

export interface ForgeSnapshot {
  repo: ForgeRepo;
  baseBranch: string;
  baseSha: string;
  refs: readonly ForgeRef[];
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
  pullRequestHeads(repo: ForgeRepo, budget: ForgeBudget): Promise<ReadonlySet<string>>;
  resolveCommit(repo: ForgeRepo, ref: string, budget: ForgeBudget): Promise<string | null>;
}

export type ForgeVerdict =
  | { ok: true; proof: { snapshotDigest: string; baseSha: string; headSha: string; classified: number } }
  | { ok: false; reason: string; retriable: boolean };

export const ZERO_DELTA_MEASUREMENT_BUDGET: ForgeBudget = { perCallMs: 10_000, totalMs: 90_000, concurrency: 8 };
export const ZERO_DELTA_WRITE_BUDGET: ForgeBudget = { perCallMs: 10_000, totalMs: 20_000, concurrency: 1 };

const deliveredToBase = new Map<string, true>();

export function resetZeroDeltaForgeCache(): void {
  deliveredToBase.clear();
}

export function forgeSnapshotDigest(baseSha: string, refs: readonly ForgeRef[]): string {
  const lines = [...refs].map((ref) => `${ref.kind} ${ref.name} ${ref.sha}`).sort();
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

function commitSha(entry: unknown): { name: string; sha: string } | null {
  const row = asRecord(entry);
  const name = row?.name;
  const sha = stringField(row?.commit, "sha")?.toLowerCase() ?? "";
  if (typeof name !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;
  return { name, sha };
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

function requestSignal(budget: ForgeBudget, startedAt: number): AbortSignal {
  const remaining = budget.totalMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new ForgeReadError("the forge read ran out of its time budget", true);
  return AbortSignal.any([AbortSignal.timeout(budget.perCallMs), AbortSignal.timeout(remaining)]);
}

async function forgeGet(token: string, url: string, budget: ForgeBudget, startedAt: number): Promise<Response> {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-zero-delta-forge-rule",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  let lastError: ForgeReadError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await ghFetch(url, { headers, signal: requestSignal(budget, startedAt) });
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

async function listAll(token: string, firstUrl: string, budget: ForgeBudget, startedAt: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  let next: string | null = firstUrl;
  while (next) {
    const response = await forgeGet(token, next, budget, startedAt);
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

export function githubForgeReader(token: string): ForgeReader {
  return {
    async snapshot(repo, baseBranch, budget) {
      const startedAt = Date.now();
      const api = gitHubApiBase(repo.hostname);
      const baseUrl = `${api}${repoPath(repo)}/commits/${encodeURIComponent(baseBranch)}`;
      const before = await forgeGet(token, baseUrl, budget, startedAt);
      if (before.status === 404 || !before.ok) {
        throw new ForgeReadError(`the remote base ${baseBranch} could not be read`, before.status >= 500);
      }
      const baseSha = await readCommitSha(before, `the remote base ${baseBranch}`);
      const branchRows = await listAll(token, `${api}${repoPath(repo)}/branches?per_page=100`, budget, startedAt);
      const tagRows = await listAll(token, `${api}${repoPath(repo)}/tags?per_page=100`, budget, startedAt);
      const after = await forgeGet(token, baseUrl, budget, startedAt);
      if (!after.ok) throw new ForgeReadError(`the remote base ${baseBranch} could not be read`, after.status >= 500);
      if (await readCommitSha(after, `the remote base ${baseBranch}`) !== baseSha) {
        throw new ForgeReadError(`the remote base ${baseBranch} moved while it was listed`, true);
      }
      const refs: ForgeRef[] = [];
      for (const row of branchRows) {
        const parsed = commitSha(row);
        if (!parsed) throw new ForgeReadError("the forge branch list omitted a commit", false);
        refs.push({ kind: "branch", name: parsed.name, sha: parsed.sha });
      }
      for (const row of tagRows) {
        const parsed = commitSha(row);
        if (!parsed) throw new ForgeReadError("the forge tag list omitted a commit", false);
        refs.push({ kind: "tag", name: parsed.name, sha: parsed.sha });
      }
      return { repo, baseBranch, baseSha, refs, digest: forgeSnapshotDigest(baseSha, refs) };
    },
    async aheadBy(repo, baseSha, tipSha, budget) {
      const key = `${repo.hostname}/${repo.owner}/${repo.repo} ${baseSha} ${tipSha}`;
      if (deliveredToBase.has(key)) return 0;
      const startedAt = Date.now();
      const response = await forgeGet(
        token,
        `${gitHubApiBase(repo.hostname)}${repoPath(repo)}/compare/${baseSha}...${tipSha}`,
        budget,
        startedAt,
      );
      if (!response.ok) throw new ForgeReadError(`the forge could not compare ${tipSha} with the base`, response.status >= 500);
      const aheadBy = asRecord(await response.json().catch(() => null))?.ahead_by;
      if (typeof aheadBy !== "number") throw new ForgeReadError(`the forge could not compare ${tipSha} with the base`, false);
      if (aheadBy === 0) deliveredToBase.set(key, true);
      return aheadBy;
    },
    async pullRequestHeads(repo, budget) {
      const startedAt = Date.now();
      const rows = await listAll(
        token,
        `${gitHubApiBase(repo.hostname)}${repoPath(repo)}/pulls?state=all&per_page=100`,
        budget,
        startedAt,
      );
      const heads = new Set<string>();
      for (const row of rows) {
        const head = stringField(asRecord(asRecord(row)?.head), "sha")?.toLowerCase();
        if (head && /^[0-9a-f]{40}$/.test(head)) heads.add(head);
      }
      return heads;
    },
    async resolveCommit(repo, ref, budget) {
      const startedAt = Date.now();
      const response = await forgeGet(
        token,
        `${gitHubApiBase(repo.hostname)}${repoPath(repo)}/commits/${encodeURIComponent(ref)}`,
        budget,
        startedAt,
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
    const pullHeads = await forge.pullRequestHeads(card.repo, budget);
    const delivered = new Set<string>([snapshot.baseSha]);
    const unclassified = [...new Set(snapshot.refs.map((ref) => ref.sha))].filter(
      (sha) => sha !== snapshot.baseSha && !pullHeads.has(sha),
    );
    let refused: string | null = null;
    await mapPool(unclassified, budget.concurrency, async (tip) => {
      if (refused) return;
      const ahead = await forge.aheadBy(card.repo, snapshot.baseSha, tip, budget);
      if (ahead === 0) delivered.add(tip);
      else if (!refused) {
        const name = snapshot.refs.find((ref) => ref.sha === tip);
        refused = `${name ? `${name.kind} ${name.name}` : tip} is not on the base line and is not a pull-request head`;
      }
    });
    if (refused) return { ok: false, reason: refused, retriable: false };
    for (const ref of snapshot.refs) {
      if (!branchNamesIssue(ref.name, card.cardIdentifier)) continue;
      if (!delivered.has(ref.sha)) {
        return { ok: false, reason: `${ref.kind} ${ref.name} names this card and is not on the base line`, retriable: false };
      }
    }
    const cardBranch = snapshot.refs.find((ref) => ref.kind === "branch" && ref.name === card.cardBranch);
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
