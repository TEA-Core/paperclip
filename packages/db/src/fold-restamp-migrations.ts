/**
 * Repair the migration journal after folding upstream commits into the fork.
 *
 * WHY THIS EXISTS
 *
 * drizzle's migrator does not dedupe per migration hash. It reads the single
 * newest `created_at` from `drizzle.__drizzle_migrations` and applies only the
 * migrations whose journal `when` is strictly greater
 * (drizzle-orm/pg-core/dialect.js). `when` is therefore a global apply
 * watermark, and drizzle-kit stamps it with `Date.now()` at generate time.
 *
 * A fork breaks that. Fork migrations are authored now; upstream migrations are
 * authored earlier but folded in later. So after a fold, upstream's pending
 * migrations sit BELOW the fork's newest `when` and the migrator skips every one
 * of them in silence. Measured on 2026-08-14: the deployed watermark was
 * 1785930047830 (fork's 0189) and all 24 pending upstream migrations were below
 * it. With PAPERCLIP_MIGRATION_AUTO_APPLY=true, that ships a container onto a
 * schema missing 24 migrations with nothing in the log to say so.
 *
 * WHAT IT DOES
 *
 * Newly folded upstream migrations are moved to the END of the line: renumbered
 * above the fork's highest migration number and re-stamped above the fork's
 * highest `when`. The fork's own entries are never touched — they are already
 * applied on the deployed instance, and raising their `when` would make drizzle
 * re-run them.
 *
 * Renaming a migration file is safe. drizzle hashes the SQL *content*
 * (migrator.js: `sha256(query)`), not the filename or tag, so an
 * already-applied migration stays recognised under a new number. The tag is
 * only ever used to find the file on disk.
 *
 * Ordering note: this puts fork migrations before upstream's on a fresh
 * database. That matches the order the deployed instance actually applied them
 * in, so CI and production converge on the same schema rather than two
 * plausible ones.
 *
 * Usage:
 *   tsx src/fold-restamp-migrations.ts [--base <ref>] [--apply]
 *
 *   --base   git ref holding the pre-fold journal, used to tell fork entries
 *            from newly folded upstream ones.
 *            Default: origin/fold/tea-patches-v2026.722.0
 *   --apply  rename files and rewrite the journal. Without it, prints the plan
 *            and changes nothing.
 */
import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = join(migrationsDir, "meta", "_journal.json");
const journalRepoPath = "packages/db/src/migrations/meta/_journal.json";

export type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints?: boolean };
export type Journal = { version: string; dialect: string; entries: JournalEntry[] };

export type FoldRestampRename = { from: string; to: string; when: number };
export type FoldRestampPlan = {
  /** Fork entries, untouched and kept at the front of the journal. */
  ours: JournalEntry[];
  /** Newly folded entries, renumbered and re-stamped above the fork line. */
  restamped: JournalEntry[];
  /** File renames implied by the renumbering. */
  renames: FoldRestampRename[];
  /** Highest migration number on the fork line. */
  maxNumber: number;
  /** Highest `when` on the fork line: the deployed apply watermark. */
  maxWhen: number;
  /** The journal to write: fork line first, re-stamped folds after, `idx` resequenced. */
  journal: Journal;
};

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function migrationNumber(tag: string): number {
  const match = tag.match(/^(\d{4})_/);
  if (!match) throw new Error(`Migration tag does not start with a 4-digit number: ${tag}`);
  return Number(match[1]);
}

function renumber(tag: string, next: number): string {
  return `${String(next).padStart(4, "0")}_${tag.slice(5)}`;
}

/**
 * Compute the re-stamp plan. Pure: no disk, no git, no process state.
 *
 * `baseJournal` is the pre-fold journal, and its tags are what identifies the
 * fork's own entries. Everything in `journal` that it does not know about is a
 * newly folded upstream migration. Returns null when there is nothing to do.
 */
export function planFoldRestamp(journal: Journal, baseJournal: Journal): FoldRestampPlan | null {
  const forkTags = new Set(baseJournal.entries.map((entry) => entry.tag));
  const ours = journal.entries.filter((entry) => forkTags.has(entry.tag));
  const folded = journal.entries.filter((entry) => !forkTags.has(entry.tag));

  if (folded.length === 0) return null;
  if (ours.length === 0) throw new Error("Journal shares no entries with the base journal — wrong --base ref?");

  // The fork's own line is the fixed point: its highest number and highest
  // `when` are what the deployed database has already applied.
  const maxNumber = Math.max(...ours.map((entry) => migrationNumber(entry.tag)));
  const maxWhen = Math.max(...ours.map((entry) => entry.when));

  // Keep upstream's relative order, which is the journal ARRAY order and not
  // `when` order. drizzle reads the single newest `created_at` once and then
  // walks `journal.entries` in array order, so the array is what decides the
  // sequence a migration is applied in; `when` only gates whether it runs at
  // all. Upstream's own `when` values are not monotonic against that array
  // (0194_company_skill_releases carries a lower `when` than the
  // 0193_document_memberships that precedes it), so sorting by `when` here
  // would silently reorder upstream's migrations against each other.
  const ordered = folded;

  const renames: FoldRestampRename[] = [];
  const restamped: JournalEntry[] = ordered.map((entry, index) => {
    const tag = renumber(entry.tag, maxNumber + 1 + index);
    const when = maxWhen + 1000 * (index + 1);
    if (tag !== entry.tag) renames.push({ from: `${entry.tag}.sql`, to: `${tag}.sql`, when });
    return { ...entry, tag, when };
  });

  const entries = [...ours, ...restamped].map((entry, index) => ({ ...entry, idx: index }));

  return {
    ours,
    restamped,
    renames,
    maxNumber,
    maxWhen,
    journal: { version: journal.version, dialect: journal.dialect, entries },
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const baseRef = arg("--base", "origin/fold/tea-patches-v2026.722.0")!;
  const repoRoot = git(["rev-parse", "--show-toplevel"], migrationsDir);

  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;

  let baseJournal: Journal;
  try {
    baseJournal = JSON.parse(git(["show", `${baseRef}:${journalRepoPath}`], repoRoot)) as Journal;
  } catch {
    throw new Error(`Could not read ${journalRepoPath} at ${baseRef}. Pass --base <ref>.`);
  }

  const plan = planFoldRestamp(journal, baseJournal);
  if (!plan) {
    console.log("No newly folded migrations — journal already reflects the fork line.");
    return;
  }

  const { ours, restamped, renames, maxNumber, maxWhen } = plan;
  const merged = plan.journal.entries;

  console.log(`fork line:      ${ours.length} entries, highest ${String(maxNumber).padStart(4, "0")}, when ${maxWhen}`);
  console.log(`newly folded:   ${restamped.length} entries -> ${String(maxNumber + 1).padStart(4, "0")}..${String(maxNumber + restamped.length).padStart(4, "0")}, when ${maxWhen + 1000}..${maxWhen + 1000 * restamped.length}`);
  for (const rename_ of renames) console.log(`  ${rename_.from} -> ${rename_.to}  (when ${rename_.when})`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to rename the files and rewrite the journal.");
    return;
  }

  for (const rename_ of renames) {
    const from = join(migrationsDir, rename_.from);
    const to = join(migrationsDir, rename_.to);
    try {
      git(["mv", from, to], repoRoot);
    } catch {
      // Not tracked yet (a fold that has not been staged): plain rename.
      await rename(from, to);
    }
  }

  await writeFile(journalPath, `${JSON.stringify(plan.journal, null, 2)}\n`, "utf8");
  console.log(`\nRewrote ${journalRepoPath}: ${merged.length} entries, last ${merged[merged.length - 1].tag} @ ${merged[merged.length - 1].when}.`);
  console.log("Run `pnpm --filter @paperclipai/db run check:migrations` to verify.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${basename(process.argv[1])}: ${detail}`);
    process.exitCode = 1;
  }
}
