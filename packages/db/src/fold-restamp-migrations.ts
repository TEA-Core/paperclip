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
 * 1. Newly folded upstream migrations are moved to the END of the line:
 *    renumbered above the fork's highest migration number and re-stamped above
 *    the fork's highest `when`. The fork's own entries are never touched — they
 *    are already applied on the deployed instance, and raising their `when`
 *    would make drizzle re-run them.
 *
 * 2. It emits `meta/NNNN_snapshot.json` for the journal's new newest `idx`.
 *    `migration-snapshot-drift.test.ts` resolves the snapshot it diffs the
 *    schema against by journal **idx**, not by tag
 *    (`String(newest.idx).padStart(4, "0") + "_snapshot.json"`), and snapshots
 *    are retained sparsely — only the newest is guaranteed present. Appending N
 *    folded entries moves `idx` by N, so the file that test needs changes name
 *    and does not exist, and the fold lands with
 *    `ENOENT ... meta/0246_snapshot.json`. Measured on the 2026-09-07 fold:
 *    idx 243 -> 246. The snapshot is generated from the MERGED schema via
 *    `generateDrizzleJson` with its `prevId` chained onto the previous newest
 *    snapshot, so the chain stays intact and the drift test compares against a
 *    state the schema actually reached. It is not a copy of the previous
 *    snapshot: folded upstream migrations change the schema, so a copy would
 *    make the drift test fail for real.
 *
 *    The diff `previous snapshot -> merged schema` is printed. Every statement
 *    in it must trace to one of the folded `.sql` files; a statement that does
 *    not means the snapshot is papering over real drift rather than recording
 *    the fold. On 2026-09-07 that diff was 30 statements and all 30 traced to
 *    0247_fixed_hannibal_king.sql / 0248_living_dreaming_celestial.sql.
 *
 * 3. It reports every source file that names a renamed migration by literal
 *    filename. 14 db test files read a migration off disk that way, so a fold
 *    that renumbers one breaks them with `ENOENT`. The 2026-09-07 fold broke
 *    three (connection-grants-phase2, connection-grants-phase4,
 *    vercel-connect-credential-source). Reporting is the default rather than
 *    rewriting, because not every hit is a path: some are fixture strings
 *    (`9999_fixture.sql`) and some are negative assertions that a migration is
 *    absent, and rewriting those inverts what the test proves. `--repoint`
 *    rewrites them anyway when the operator has looked at the list and wants
 *    the mechanical edit.
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
 *   tsx src/fold-restamp-migrations.ts [--base <ref>] [--apply] [--repoint]
 *
 *   --base            git ref holding the pre-fold journal, used to tell fork
 *                     entries from newly folded upstream ones.
 *                     Default: origin/fold/tea-patches-v2026.722.0
 *   --apply           rename files, rewrite the journal and write the snapshot.
 *                     Without it, prints the plan and changes nothing.
 *   --repoint         with --apply, also rewrite source references to renamed
 *                     migration filenames. Review the reported list first.
 *   --skip-snapshot   do not generate the snapshot. Escape hatch for when
 *                     drizzle-kit cannot load the merged schema; the snapshot
 *                     then has to be produced by hand before CI goes green.
 */
import { execFileSync } from "node:child_process";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("./schema", import.meta.url));
const metaDir = join(migrationsDir, "meta");
const journalPath = join(metaDir, "_journal.json");
const journalRepoPath = "packages/db/src/migrations/meta/_journal.json";

export type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints?: boolean };
export type Journal = { version: string; dialect: string; entries: JournalEntry[] };

export type FoldRestampRename = { from: string; to: string; when: number };
export type FoldRestampSnapshot = {
  /** Snapshot `migration-snapshot-drift.test.ts` resolved BEFORE the fold. */
  previousFile: string;
  /** Snapshot it resolves AFTER the fold, which the fold has to produce. */
  nextFile: string;
};
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
  /** Snapshot filenames the journal's newest `idx` resolves to, before and after. */
  snapshot: FoldRestampSnapshot;
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
 * The snapshot filename for a journal `idx`.
 *
 * This must stay byte-identical to how `migration-snapshot-drift.test.ts`
 * derives it, because that test is the only consumer and it resolves by `idx`
 * rather than by tag. `fold-restamp-migrations.test.ts` re-derives it the
 * test's way and asserts the two agree.
 */
export function snapshotFileName(idx: number): string {
  return `${String(idx).padStart(4, "0")}_snapshot.json`;
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

  // Read the previous filename off the BASE journal rather than assuming the
  // fork line is idx 0..ours.length-1 in the merged journal: the base journal's
  // own newest `idx` is by definition what the drift test resolved before the
  // fold, however the merged journal happens to interleave.
  const previousIdx = baseJournal.entries[baseJournal.entries.length - 1].idx;
  const nextIdx = entries[entries.length - 1].idx;

  return {
    ours,
    restamped,
    renames,
    maxNumber,
    maxWhen,
    snapshot: { previousFile: snapshotFileName(previousIdx), nextFile: snapshotFileName(nextIdx) },
    journal: { version: journal.version, dialect: journal.dialect, entries },
  };
}

/**
 * Load the drizzle schema the way drizzle.config.ts does: every module in the
 * schema directory, not the hand-maintained barrel, so a table missing from the
 * barrel cannot hide from the snapshot.
 *
 * Deliberately duplicated from `migration-snapshot-drift.test.ts` rather than
 * shared. That test is upstream's file; extracting a helper out of it would put
 * a fork edit in an upstream path and buy a conflict on every fold, which is
 * exactly the cost this script exists to reduce.
 */
async function importSchemaModules(): Promise<Record<string, unknown>> {
  const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".ts")).sort();
  const exports: Record<string, unknown> = {};
  // The barrel re-exports the same table objects the per-table modules export,
  // so dedupe by identity: serializing one table twice trips drizzle-kit's
  // duplicate-index guard.
  const seen = new Set<unknown>();
  for (const file of files) {
    const module = (await import(pathToFileURL(join(schemaDir, file)).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) continue;
        seen.add(value);
      }
      exports[`${file}#${name}`] = value;
    }
  }
  return exports;
}

/**
 * Build the snapshot for the journal's new newest `idx`, chained onto the
 * previous newest snapshot. Returns the JSON to write plus the diff between the
 * two, which is the operator's check that the fold — and only the fold —
 * accounts for the difference.
 *
 * drizzle-kit is a devDependency and this whole file is a dev tool, so the
 * import is dynamic: `tsc` still compiles the module into `dist`, and a static
 * import would make that build output unloadable in a production install.
 */
export async function buildFoldSnapshot(
  plan: Pick<FoldRestampPlan, "snapshot">,
): Promise<{ snapshot: Record<string, unknown>; statements: string[] }> {
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");

  const previousPath = join(metaDir, plan.snapshot.previousFile);
  let previousRaw: string;
  try {
    previousRaw = await readFile(previousPath, "utf8");
  } catch {
    throw new Error(
      `Cannot chain the new snapshot: ${plan.snapshot.previousFile} is missing from meta/. ` +
        "It is the state the pre-fold journal's newest idx resolved to, so the tree was already " +
        "failing migration-snapshot-drift before this fold. Fix that first, or pass --skip-snapshot.",
    );
  }
  const previous = JSON.parse(previousRaw) as Record<string, unknown>;

  const snapshot = (await generateDrizzleJson(
    await importSchemaModules(),
    previous.id as string,
  )) as unknown as Record<string, unknown>;

  const statements = await generateMigration(
    previous as Parameters<typeof generateMigration>[0],
    snapshot as unknown as Parameters<typeof generateMigration>[1],
  );

  return { snapshot, statements };
}

export type MigrationReference = { file: string; line: number; text: string; from: string; to: string };

/**
 * Find every tracked source file that names a renamed migration by filename.
 *
 * Searches for the bare tag rather than `<tag>.sql`, so a reference that
 * rebuilds the filename from parts is still caught. The migrations directory
 * itself is excluded — the `.sql` file and the journal are what the rename is
 * already handling.
 */
export function scanMigrationReferences(renames: FoldRestampRename[], repoRoot: string): MigrationReference[] {
  const found: MigrationReference[] = [];

  for (const rename_ of renames) {
    const fromTag = rename_.from.replace(/\.sql$/, "");
    const toTag = rename_.to.replace(/\.sql$/, "");
    let output: string;
    try {
      output = git(
        ["grep", "-n", "--fixed-strings", "-e", fromTag, "--", ".", ":(exclude)packages/db/src/migrations"],
        repoRoot,
      );
    } catch {
      // git grep exits 1 with no output when nothing matches.
      continue;
    }
    for (const line of output.split("\n").filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):(.*)$/s);
      if (!match) continue;
      found.push({ file: match[1], line: Number(match[2]), text: match[3].trim(), from: fromTag, to: toTag });
    }
  }

  return found;
}

/**
 * Rewrite the references found by `scanMigrationReferences` to the new tags.
 *
 * One combined pass per file rather than a `replaceAll` per rename, so a fold
 * whose renames chain (one migration's new tag being another's old tag) cannot
 * substitute twice.
 */
export async function repointMigrationReferences(
  references: MigrationReference[],
  repoRoot: string,
): Promise<Array<{ file: string; count: number }>> {
  const byFile = new Map<string, Map<string, string>>();
  for (const reference of references) {
    const mapping = byFile.get(reference.file) ?? new Map<string, string>();
    mapping.set(reference.from, reference.to);
    byFile.set(reference.file, mapping);
  }

  const changed: Array<{ file: string; count: number }> = [];
  for (const [file, mapping] of byFile) {
    const path = join(repoRoot, file);
    const before = await readFile(path, "utf8");
    const pattern = new RegExp([...mapping.keys()].map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    let count = 0;
    const after = before.replace(pattern, (tag) => {
      count += 1;
      return mapping.get(tag) ?? tag;
    });
    if (count === 0) continue;
    await writeFile(path, after, "utf8");
    changed.push({ file, count });
  }
  return changed;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const repoint = process.argv.includes("--repoint");
  const skipSnapshot = process.argv.includes("--skip-snapshot");
  const baseRef = arg("--base", "origin/fold/tea-patches-v2026.722.0")!;
  const repoRoot = git(["rev-parse", "--show-toplevel"], migrationsDir);

  if (repoint && !apply) throw new Error("--repoint rewrites source files, so it needs --apply.");

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

  console.log(`\nsnapshot:       ${plan.snapshot.previousFile} -> ${plan.snapshot.nextFile}`);

  const references = scanMigrationReferences(renames, repoRoot);
  if (references.length > 0) {
    console.log(`\nsource references to renamed migrations (${references.length}):`);
    for (const reference of references) {
      console.log(`  ${reference.file}:${reference.line}  ${reference.from} -> ${reference.to}`);
      console.log(`      ${reference.text}`);
    }
    console.log(
      "  Not every hit is a path to re-point: fixture names and negative assertions\n" +
        "  (a test proving a migration is absent) must stay as they are. Review the list,\n" +
        `  then re-run with --apply --repoint to rewrite the rest.`,
    );
  } else {
    console.log("\nNo source file references a renamed migration by filename.");
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to rename the files, rewrite the journal and write the snapshot.");
    return;
  }

  // Everything that can fail is computed before anything is written: a half
  // re-stamped tree is not re-runnable, because the second run tries to rename
  // files the first one already moved.
  let snapshot: { snapshot: Record<string, unknown>; statements: string[] } | null = null;
  if (!skipSnapshot) snapshot = await buildFoldSnapshot(plan);

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

  if (snapshot) {
    await writeFile(join(metaDir, plan.snapshot.nextFile), `${JSON.stringify(snapshot.snapshot, null, 2)}\n`, "utf8");
    console.log(`Wrote meta/${plan.snapshot.nextFile}, prevId chained onto ${plan.snapshot.previousFile}.`);
    console.log(
      `\n${plan.snapshot.previousFile} -> merged schema is ${snapshot.statements.length} statement(s). ` +
        "Every one must trace to a folded migration; anything that does not is real drift\n" +
        "the snapshot would otherwise bury:",
    );
    for (const statement of snapshot.statements) console.log(`  ${statement.replace(/\s+/g, " ").trim()}`);
  } else {
    console.log(`Skipped meta/${plan.snapshot.nextFile}; migration-snapshot-drift will fail until it exists.`);
  }

  if (repoint) {
    const changed = await repointMigrationReferences(references, repoRoot);
    console.log(`\nRe-pointed ${changed.length} file(s):`);
    for (const entry of changed) console.log(`  ${entry.file}  (${entry.count} occurrence(s))`);
    console.log("  Check `git diff` — fixture names and negative assertions were rewritten too.");
  }

  console.log("\nRun `pnpm --filter @paperclipai/db run check:migrations` to verify.");
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
