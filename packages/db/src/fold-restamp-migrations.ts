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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = join(migrationsDir, "meta", "_journal.json");
const journalRepoPath = "packages/db/src/migrations/meta/_journal.json";

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints?: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

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

  const forkTags = new Set(baseJournal.entries.map((entry) => entry.tag));
  const ours = journal.entries.filter((entry) => forkTags.has(entry.tag));
  const folded = journal.entries.filter((entry) => !forkTags.has(entry.tag));

  if (folded.length === 0) {
    console.log("No newly folded migrations — journal already reflects the fork line.");
    return;
  }

  // The fork's own line is the fixed point: its highest number and highest
  // `when` are what the deployed database has already applied.
  const maxNumber = Math.max(...ours.map((entry) => migrationNumber(entry.tag)));
  const maxWhen = Math.max(...ours.map((entry) => entry.when));

  // Keep upstream's relative order. Their own `when` values are the only
  // ordering signal we have for them, and upstream authored them in that order.
  const ordered = [...folded].sort((a, b) => a.when - b.when);

  const renames: Array<{ from: string; to: string; when: number }> = [];
  const restamped: JournalEntry[] = ordered.map((entry, index) => {
    const tag = renumber(entry.tag, maxNumber + 1 + index);
    const when = maxWhen + 1000 * (index + 1);
    if (tag !== entry.tag) renames.push({ from: `${entry.tag}.sql`, to: `${tag}.sql`, when });
    return { ...entry, tag, when };
  });

  const merged = [...ours, ...restamped].map((entry, index) => ({ ...entry, idx: index }));

  console.log(`fork line:      ${ours.length} entries, highest ${String(maxNumber).padStart(4, "0")}, when ${maxWhen}`);
  console.log(`newly folded:   ${folded.length} entries -> ${String(maxNumber + 1).padStart(4, "0")}..${String(maxNumber + folded.length).padStart(4, "0")}, when ${maxWhen + 1000}..${maxWhen + 1000 * folded.length}`);
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

  const next: Journal = { version: journal.version, dialect: journal.dialect, entries: merged };
  await writeFile(journalPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`\nRewrote ${journalRepoPath}: ${merged.length} entries, last ${merged[merged.length - 1].tag} @ ${merged[merged.length - 1].when}.`);
  console.log("Run `pnpm --filter @paperclipai/db run check:migrations` to verify.");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
