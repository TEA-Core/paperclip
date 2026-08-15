import { basename } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

/**
 * `when` monotonicity is enforced from this entry onward, not over the whole
 * journal. The history before it carries 45 inversions inherited from upstream
 * — drizzle-kit stamps `when` with `Date.now()` at generate time, so any two
 * migrations authored out of merge order invert — and re-stamping them would
 * rewrite migrations every database in existence has already applied, for no
 * behavioural gain.
 *
 * This is the fold branch's tip migration as of 2026-08-14. Everything from
 * here on is fork-controlled or fold-restamped, so it can and must be clean.
 */
export const MIGRATION_WHEN_MONOTONIC_BASELINE_TAG = "0189_merge_arming_enabled";

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
    when?: number;
  }>;
};

function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

/**
 * `when` must increase strictly down the journal, in the same order as the
 * filenames.
 *
 * drizzle's migrator does NOT dedupe per migration hash. It reads the single
 * newest `created_at` from `drizzle.__drizzle_migrations` and runs only the
 * migrations whose `when` is strictly greater than it
 * (drizzle-orm/pg-core/dialect.js). So `when` is a global apply watermark, not
 * a timestamp, and any entry that sorts after an applied migration but carries
 * a lower `when` is skipped in silence — no error, no log line, just a schema
 * that is missing it.
 *
 * That is not hypothetical here. On 2026-08-14 this fork's newest migration sat
 * at when=1785930047830 while 24 pending upstream migrations sat below it,
 * because the fork mints `when` at authoring time and upstream commits are
 * folded in later than they were written. Folding them without a re-stamp would
 * have skipped every one, and PAPERCLIP_MIGRATION_AUTO_APPLY=true means the
 * container would have come up on the wrong schema and failed at first query.
 *
 * Keeping `when` monotonic in filename order collapses the two orderings into
 * one, so the array order a reader sees IS the order the migrator uses.
 * `fold-restamp-migrations.ts` is what re-establishes this after a fold.
 */
export function ensureMonotonicWhen(entries: Array<{ tag?: string; when?: number }>) {
  let runningMax = Number.NEGATIVE_INFINITY;
  let runningMaxTag = "";
  let enforcing = false;

  for (const [index, entry] of entries.entries()) {
    const when = entry.when;
    const tag = entry.tag ?? `#${index}`;
    if (typeof when !== "number" || !Number.isFinite(when)) {
      throw new Error(`Migration journal entry ${tag} is missing a numeric "when"`);
    }

    if (enforcing && when <= runningMax) {
      throw new Error(
        `Migration journal "when" must exceed every entry before it: ${tag} has ${when}, `
          + `but ${runningMaxTag} earlier in the journal has ${runningMax}. drizzle applies `
          + `only migrations above the newest applied "when", so ${tag} would be SKIPPED `
          + `silently on any database that already ran ${runningMaxTag}. `
          + `Re-stamp with: pnpm --filter @paperclipai/db exec tsx src/fold-restamp-migrations.ts`,
      );
    }

    if (when > runningMax) {
      runningMax = when;
      runningMaxTag = tag;
    }
    if (tag === MIGRATION_WHEN_MONOTONIC_BASELINE_TAG) enforcing = true;
  }

  if (!enforcing) {
    throw new Error(
      `Migration journal is missing the "when" monotonicity baseline `
        + `${MIGRATION_WHEN_MONOTONIC_BASELINE_TAG}. If that migration was intentionally `
        + `removed, move the baseline in check-migration-numbering.ts to the last entry `
        + `that predates it.`,
    );
  }
}

function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalTags = (journal.entries ?? [])
    .map((entry, index) => {
      if (typeof entry.tag !== "string" || entry.tag.length === 0) {
        throw new Error(`Migration journal entry ${index} is missing a tag`);
      }
      return entry.tag;
    });

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);
  ensureMonotonicWhen(journal.entries ?? []);
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
