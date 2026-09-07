#!/usr/bin/env node
/**
 * check-fold-duplication.mjs
 *
 * Catches the "merge kept both sides" defect: a 3-way merge resolves a
 * conflicted region by keeping BOTH parents' versions of a block, back to back,
 * with no conflict marker and no compiler diagnostic. The second copy is either
 * unreachable (dead) or a real second execution of the same side effect.
 *
 * Real instance (fold 1446a58c0, 2026-08-30): five of these landed at once --
 * a 52-line `if (directOAuthEntry && step === "key")` return block in
 * AppsConnect.tsx, two redefined shell functions in scripts/release-lib.sh, a
 * doubled `queueAdditionalApprovalReviewPathWakes` call in the approval-reject
 * route, a doubled resume-intent guard in the issue PATCH route, and a second
 * `pendingCleanupAttemptsSql` that shadows the documented module-level one.
 *
 * A plain text-duplication linter is far too noisy on this repo (test fixtures
 * repeat by design). The signal is narrower, and this check encodes it:
 *
 *   1. only files the merge actually had to resolve -- changed against BOTH
 *      parents (640 file/merge pairs across 447 merges, vs 729 files in a
 *      single fold diff);
 *   2. the two copies are ADJACENT (<= GAP normalized lines apart), which is
 *      where a 3-way merge puts them;
 *   3. the block's occurrence count in the merge exceeds its count in BOTH
 *      parents -- so pre-existing duplication, and duplication that only one
 *      side introduced, are self-baselining and never reported.
 *
 * Usage:
 *   node scripts/check-fold-duplication.mjs [<head>] [<base>]
 *
 * With a base, every two-parent merge in `<base>..<head>` is checked, plus
 * `<head>` itself when it is one. That range form is the one that matters in
 * CI: a fold PR carries its fold merge INSIDE the branch and its head is an
 * ordinary follow-up commit, so checking only the head inspects nothing.
 *
 * Exits 0 when the range holds no two-parent merge, so it is safe to run on
 * every PR. Set FOLD_DUP_MIN_LINES / FOLD_DUP_MAX_GAP to retune.
 */

import { execFileSync } from "node:child_process";

// A byte that cannot appear in source text, so a seed key can never be forged
// by two different line splits that happen to concatenate the same way.
const SEP = "\u0000";

const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "sh", "sql", "py", "go"]);

// Lines that carry no meaning on their own; a window made of these is noise.
const TRIVIAL_LINES = new Set([
  "}", "{", "});", "},", ")", "]", "],", ");", "};", "}));", "})", "*/", "/*",
]);

const DEFAULT_MIN_LINES = Number(process.env.FOLD_DUP_MIN_LINES ?? 6);
const DEFAULT_MAX_GAP = Number(process.env.FOLD_DUP_MAX_GAP ?? 4);

/**
 * Column-0 declarations. Restricting to column 0 is what keeps this quiet: a
 * `const issue = ...` repeated across route handlers is legitimate and indented,
 * while a declaration a merge dropped in keeps the donor's zero indentation even
 * when it lands inside another function's body -- which is exactly how the
 * second `pendingCleanupAttemptsSql` ended up shadowing the module-level one
 * from inside `heartbeatService`, with no TS2393 because the scopes differ.
 */
const DECLARATION_PATTERNS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/,
  /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/,
  /^([A-Za-z_][\w]*)\s*\(\)\s*\{/, // shell function
];

let repoCwd;

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repoCwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: allowFailure ? ["ignore", "pipe", "ignore"] : undefined,
    });
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

/**
 * Drop blank and comment-only lines and collapse indentation, so a block that
 * a merge re-indented or re-commented still compares equal.
 */
export function normalize(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const s = lines[i].trim();
    if (!s) continue;
    if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("--")) continue;
    if (s.startsWith("#") && !s.startsWith("#!")) continue;
    out.push({ line: i + 1, text: s });
  }
  return out;
}

export function isSubstantive(block) {
  const meaty = block.filter((l) => !TRIVIAL_LINES.has(l) && l.length > 6);
  return meaty.length >= 3 && new Set(block).size >= 3;
}

/** Non-overlapping occurrences of an exact normalized sequence. */
export function countOccurrences(lines, block) {
  const len = block.length;
  let count = 0;
  for (let i = 0; i <= lines.length - len; ) {
    let hit = true;
    for (let k = 0; k < len; k += 1) {
      if (lines[i + k] !== block[k]) { hit = false; break; }
    }
    if (hit) { count += 1; i += len; } else { i += 1; }
  }
  return count;
}

/**
 * Adjacent repeats: lines[i .. i+L) === lines[i+L+gap .. i+2L+gap).
 * Seeded on repeated minLines-windows, then extended, so this stays near-linear
 * on the 20k-line files in this repo.
 */
export function findAdjacentRepeats(lines, { minLines = DEFAULT_MIN_LINES, maxGap = DEFAULT_MAX_GAP } = {}) {
  const n = lines.length;
  if (n < 2 * minLines) return [];

  const seeds = new Map();
  for (let i = 0; i <= n - minLines; i += 1) {
    const key = lines.slice(i, i + minLines).join(SEP);
    const bucket = seeds.get(key);
    if (bucket) bucket.push(i);
    else seeds.set(key, [i]);
  }

  const candidates = [];
  for (const positions of seeds.values()) {
    if (positions.length < 2) continue;
    for (let a = 0; a < positions.length; a += 1) {
      for (let b = a + 1; b < Math.min(a + 5, positions.length); b += 1) {
        const i = positions[a];
        const j = positions[b];
        const period = j - i;
        const cap = Math.min(period, n - j);
        let common = 0;
        while (common < cap && lines[i + common] === lines[j + common]) common += 1;
        const length = Math.min(common, period);
        const gap = period - length;
        if (length >= minLines && gap <= maxGap && isSubstantive(lines.slice(i, i + length))) {
          candidates.push({ start: i, length, gap });
        }
      }
    }
  }

  candidates.sort((x, y) => y.length - x.length || x.start - y.start);
  const kept = [];
  const spans = [];
  for (const c of candidates) {
    const from = c.start;
    const to = c.start + 2 * c.length + c.gap;
    if (spans.some(([s, e]) => from < e && s < to)) continue;
    spans.push([from, to]);
    kept.push(c);
  }
  return kept.sort((x, y) => x.start - y.start);
}

/** Count column-0 declarations by name. */
export function countDeclarations(text) {
  const counts = new Map();
  if (text === null || text === undefined) return counts;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || /^\s/.test(raw)) continue;
    for (const pattern of DECLARATION_PATTERNS) {
      const hit = raw.match(pattern);
      if (hit) {
        counts.set(hit[1], (counts.get(hit[1]) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

function blobAt(ref, path) {
  return git(["show", `${ref}:${path}`], { allowFailure: true });
}

function normalizedTextAt(ref, path) {
  const text = blobAt(ref, path);
  return text === null ? null : normalize(text).map((l) => l.text);
}

export function findMergeDuplication(commit, options = {}) {
  repoCwd = options.cwd;
  const parents = git(["rev-parse", `${commit}^@`]).trim().split("\n").filter(Boolean);
  if (parents.length !== 2) return { skipped: true, reason: `not a two-parent merge (${parents.length} parents)`, findings: [], redeclarations: [] };

  const changedAgainst = (parent) => new Set(git(["diff", "--name-only", parent, commit]).split("\n").filter(Boolean));
  const [a, b] = parents.map(changedAgainst);
  const resolved = [...a].filter((f) => b.has(f) && CODE_EXTENSIONS.has(f.split(".").pop()));

  const findings = [];
  const redeclarations = [];
  for (const path of resolved) {
    const mergedText = blobAt(commit, path);
    if (mergedText === null) continue;

    // Rule 2: a column-0 declaration the merge now holds more copies of than
    // either parent. Catches the copies the adjacency rule cannot -- the two
    // `pendingCleanupAttemptsSql` bodies sit 14k lines apart in heartbeat.ts.
    const mergedDecls = countDeclarations(mergedText);
    const parentDecls = parents.map((p) => countDeclarations(blobAt(p, path)));
    for (const [name, count] of mergedDecls) {
      if (count < 2) continue;
      const parentCounts = parentDecls.map((d) => d.get(name) ?? 0);
      if (!parentCounts.every((c) => count > c)) continue;
      redeclarations.push({ path, name, count, parentCounts });
    }

    const merged = normalize(mergedText);
    const mergedLines = merged.map((l) => l.text);
    const repeats = findAdjacentRepeats(mergedLines, options);
    if (repeats.length === 0) continue;

    const parentLines = parents.map((p) => normalizedTextAt(p, path) ?? []);
    for (const { start, length, gap } of repeats) {
      const block = mergedLines.slice(start, start + length);
      const mergeCount = countOccurrences(mergedLines, block);
      const parentCounts = parentLines.map((lines) => countOccurrences(lines, block));
      if (!parentCounts.every((c) => mergeCount > c)) continue;
      findings.push({
        path,
        firstCopy: [merged[start].line, merged[start + length - 1].line],
        secondCopy: [merged[start + length + gap].line, merged[start + 2 * length + gap - 1].line],
        blockLines: length,
        gap,
        mergeCount,
        parentCounts,
        head: block[0].slice(0, 120),
      });
    }
  }

  findings.sort((x, y) => y.blockLines - x.blockLines);
  redeclarations.sort((x, y) => x.path.localeCompare(y.path) || x.name.localeCompare(y.name));
  return { skipped: false, parents, resolvedFiles: resolved.length, findings, redeclarations };
}

/**
 * Every two-parent merge to inspect for a head, optionally bounded by a base.
 *
 * `head` is canonicalized first. `git rev-list` emits full 40-char SHAs, so a
 * symbolic or abbreviated `head` that is itself a merge inside the range would
 * not match the listed entry, get appended a second time, and have every
 * finding on it reported twice. CI passes a full SHA and never hit this; the
 * documented CLI form (`check-fold-duplication.mjs HEAD <base>`) does.
 */
export function mergesToCheck(head, base, options = {}) {
  repoCwd = options.cwd;
  const resolved = git(["rev-parse", head], { allowFailure: true })?.trim() || head;
  const commits = [];
  if (base) {
    const listed = git(["rev-list", "--merges", `${base}..${resolved}`], { allowFailure: true });
    if (listed) commits.push(...listed.split("\n").filter(Boolean));
  }
  if (!commits.includes(resolved)) commits.push(resolved);
  return commits;
}

function main() {
  const head = process.argv[2] ?? "HEAD";
  const base = process.argv[3] ?? "";
  const commits = mergesToCheck(head, base);

  const results = commits
    .map((commit) => ({ commit, result: findMergeDuplication(commit) }))
    .filter(({ result }) => !result.skipped);

  if (results.length === 0) {
    console.log(
      `check-fold-duplication: no two-parent merge in ${base ? `${base}..${head}` : head}; nothing to check.`,
    );
    return 0;
  }

  for (const { commit, result } of results) {
    console.log(
      `check-fold-duplication: ${commit.slice(0, 9)} resolved ${result.resolvedFiles} code file(s) `
      + `against both parents (${result.parents.map((p) => p.slice(0, 9)).join(", ")}).`,
    );
  }

  const findings = results.flatMap(({ commit, result }) =>
    result.findings.map((f) => ({ ...f, commit: commit.slice(0, 9) })));
  const redeclarations = results.flatMap(({ commit, result }) =>
    result.redeclarations.map((r) => ({ ...r, commit: commit.slice(0, 9) })));
  const result = { findings, redeclarations };

  if (result.findings.length === 0 && result.redeclarations.length === 0) {
    console.log("check-fold-duplication: no merge-introduced duplication.");
    return 0;
  }

  if (result.findings.length > 0) {
    console.error(`\ncheck-fold-duplication: ${result.findings.length} adjacent block(s) duplicated by this merge:\n`);
    for (const f of result.findings) {
      console.error(`  ${f.path}  (merge ${f.commit})`);
      console.error(`    lines ${f.firstCopy[0]}-${f.firstCopy[1]} repeat at ${f.secondCopy[0]}-${f.secondCopy[1]} `
        + `(${f.blockLines} statement lines, gap ${f.gap})`);
      console.error(`    occurrences: merge ${f.mergeCount}, parents ${f.parentCounts.join(" / ")}`);
      console.error(`    first line: ${f.head}`);
      console.error("");
    }
  }

  if (result.redeclarations.length > 0) {
    console.error(`check-fold-duplication: ${result.redeclarations.length} declaration(s) this merge holds extra copies of:\n`);
    for (const r of result.redeclarations) {
      console.error(`  ${r.path}: ${r.name} declared ${r.count}x (parents ${r.parentCounts.join(" / ")}) (merge ${r.commit})`);
    }
    console.error("");
  }

  console.error(
    "Each of these exists more times in the merge result than in EITHER parent. That is a conflicted\n"
    + "region resolved by keeping both sides: the extra copy is either unreachable or a second run of\n"
    + "the same side effect, and neither tsc nor a text-duplication linter reports it. Delete the\n"
    + "redundant copy, or -- if the repetition is deliberate -- make the two copies differ.",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
