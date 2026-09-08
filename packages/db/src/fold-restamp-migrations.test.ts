import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMonotonicWhen } from "./check-migration-numbering.js";
import {
  type Journal,
  type MigrationReference,
  planFoldRestamp,
  repointMigrationReferences,
  snapshotFileName,
} from "./fold-restamp-migrations.js";

// Shape of the real 2026-08-14 fold: the fork line ends at 0189 /
// when=1785930047830 (the watermark the deployed database has applied) and the
// folded upstream migrations were authored earlier, so their `when` is lower.
const FORK_TIP_WHEN = 1785930047830;

function journal(entries: Array<{ tag: string; when: number }>): Journal {
  return {
    version: "7",
    dialect: "postgresql",
    entries: entries.map((entry, idx) => ({ idx, version: "7", breakpoints: true, ...entry })),
  };
}

const baseJournal = journal([
  { tag: "0187_deploy_slot_locks", when: FORK_TIP_WHEN - 2000 },
  { tag: "0188_run_budget_snapshot", when: FORK_TIP_WHEN - 1000 },
  { tag: "0189_merge_arming_enabled", when: FORK_TIP_WHEN },
]);

// A fold merged as-is: upstream files land by filename order, keeping the
// `when` values upstream generated.
const foldedJournal = journal([
  { tag: "0184_routable_blocked", when: 1784916880226 },
  { tag: "0187_deploy_slot_locks", when: FORK_TIP_WHEN - 2000 },
  { tag: "0188_run_budget_snapshot", when: FORK_TIP_WHEN - 1000 },
  { tag: "0189_merge_arming_enabled", when: FORK_TIP_WHEN },
  { tag: "0192_task_watchdog_stop_snapshots", when: 1784916886226 },
]);

describe("fold re-stamp plan", () => {
  it("is needed: an unrepaired fold journal is rejected by the numbering check", () => {
    expect(() => ensureMonotonicWhen(foldedJournal.entries)).toThrow(
      /0192_task_watchdog_stop_snapshots would be SKIPPED/,
    );
  });

  it("renumbers and re-stamps folded migrations above the fork line", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(plan.maxNumber).toBe(189);
    expect(plan.maxWhen).toBe(FORK_TIP_WHEN);
    expect(plan.restamped).toEqual([
      expect.objectContaining({ tag: "0190_routable_blocked", when: FORK_TIP_WHEN + 1000 }),
      expect.objectContaining({
        tag: "0191_task_watchdog_stop_snapshots",
        when: FORK_TIP_WHEN + 2000,
      }),
    ]);
    expect(plan.renames).toEqual([
      { from: "0184_routable_blocked.sql", to: "0190_routable_blocked.sql", when: FORK_TIP_WHEN + 1000 },
      {
        from: "0192_task_watchdog_stop_snapshots.sql",
        to: "0191_task_watchdog_stop_snapshots.sql",
        when: FORK_TIP_WHEN + 2000,
      },
    ]);
  });

  it("produces a journal the numbering check accepts", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(() => ensureMonotonicWhen(plan.journal.entries)).not.toThrow();
    expect(plan.journal.entries.map((entry) => entry.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.journal.entries.map((entry) => entry.tag)).toEqual([
      "0187_deploy_slot_locks",
      "0188_run_budget_snapshot",
      "0189_merge_arming_enabled",
      "0190_routable_blocked",
      "0191_task_watchdog_stop_snapshots",
    ]);
  });

  it("never changes the fork's own `when` values, which are already applied", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    for (const entry of baseJournal.entries) {
      const after = plan.journal.entries.find((candidate) => candidate.tag === entry.tag);
      expect(after?.when).toBe(entry.when);
    }
  });

  // drizzle-orm/migrator.js walks `journal.entries` with a plain
  // `for (const journalEntry of journal.entries)` and never sorts, so the ARRAY
  // is what decides the order migrations are applied in; `when` only gates
  // whether an entry runs at all against the single newest `created_at`. That
  // makes upstream's array order the order upstream itself applies them in, and
  // it is the only ordering the re-stamp is allowed to preserve. Upstream's
  // `when` values are NOT monotonic against that array — in the 2026-08-14 fold,
  // 0194_company_skill_releases carried a lower `when` than the
  // 0193_document_memberships preceding it — so sorting by `when` would reorder
  // upstream's migrations against each other and against their dependencies.
  it("keeps upstream's journal array order even when `when` sorts the other way", () => {
    const plan = planFoldRestamp(
      journal([
        ...baseJournal.entries,
        { tag: "0190_applied_first", when: 1784916886226 },
        { tag: "0191_applied_second", when: 1784916880226 },
      ]),
      baseJournal,
    )!;

    expect(plan.restamped.map((entry) => entry.tag)).toEqual([
      "0190_applied_first",
      "0191_applied_second",
    ]);
    // And the re-stamped `when` values are monotonic in that same order, so the
    // watermark can never skip the second one.
    expect(plan.restamped[0].when).toBeLessThan(plan.restamped[1].when);
  });

  it("returns null when the journal holds no newly folded migrations", () => {
    expect(planFoldRestamp(baseJournal, baseJournal)).toBeNull();
  });

  it("refuses a base journal that shares no entries with the current one", () => {
    expect(() => planFoldRestamp(foldedJournal, journal([{ tag: "0001_unrelated", when: 1 }]))).toThrow(
      /shares no entries with the base journal/,
    );
  });
});

// `migration-snapshot-drift.test.ts` diffs the schema against the snapshot it
// resolves from the journal's newest `idx` — not from the newest tag, and not
// from a file it globs for. Snapshots are retained sparsely, so the file for
// the next `idx` is normally absent. Appending N folded entries therefore moves
// the required filename by N and the fold lands with
// `ENOENT ... meta/0246_snapshot.json` (measured on the 2026-09-07 fold: idx
// 243 -> 246, repaired by hand in adc299006). The plan has to name that file so
// the re-stamp can emit it.
describe("fold re-stamp snapshot", () => {
  // This is the drift test's own resolution rule, copied verbatim. If that test
  // ever resolves the snapshot some other way, this assertion is what catches
  // the re-stamp still writing the old name.
  function driftTestSnapshotFile(journalToRead: Journal): string {
    const newest = journalToRead.entries.at(-1)!;
    return `${String(newest.idx).padStart(4, "0")}_snapshot.json`;
  }

  it("names the snapshot the merged journal's newest idx resolves to", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(plan.snapshot.nextFile).toBe(driftTestSnapshotFile(plan.journal));
    expect(plan.snapshot.nextFile).toBe("0004_snapshot.json");
  });

  it("chains onto the snapshot the pre-fold journal's newest idx resolved to", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(plan.snapshot.previousFile).toBe(driftTestSnapshotFile(baseJournal));
    expect(plan.snapshot.previousFile).toBe("0002_snapshot.json");
  });

  // The regression this guards: `idx` and the migration number are independent
  // counters. The newest entry here is tagged 0191 but sits at idx 4, so a
  // snapshot named off the tag — or off `maxNumber` — would be `0191_snapshot`
  // and the drift test would still ENOENT on `0004_snapshot.json`.
  it("follows journal idx, not the migration number in the tag", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(plan.journal.entries.at(-1)!.tag).toBe("0191_task_watchdog_stop_snapshots");
    expect(plan.snapshot.nextFile).not.toContain("0191");
    expect(plan.snapshot.nextFile).not.toContain(String(plan.maxNumber));
  });

  // A fold that appends entries always moves the filename, so a re-stamp that
  // wrote nothing leaves the drift test pointed at a file that does not exist.
  it("moves the filename by exactly the number of folded entries", () => {
    const plan = planFoldRestamp(foldedJournal, baseJournal)!;

    expect(plan.snapshot.previousFile).not.toBe(plan.snapshot.nextFile);
    const previousIdx = baseJournal.entries.at(-1)!.idx;
    expect(plan.snapshot.nextFile).toBe(snapshotFileName(previousIdx + plan.restamped.length));
  });

  it("pads the idx to four digits", () => {
    expect(snapshotFileName(0)).toBe("0000_snapshot.json");
    expect(snapshotFileName(246)).toBe("0246_snapshot.json");
    expect(snapshotFileName(1234)).toBe("1234_snapshot.json");
  });
});
// A fold that renumbers a migration breaks every test that reads it off disk by
// literal filename — three of them on 2026-09-07, out of 14 db test files that
// name a migration that way. `--repoint` is the mechanical repair, and it edits
// source files, so its substitution has to be exact.
describe("re-pointing source references", () => {
  async function fixture(contents: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "fold-repoint-"));
    for (const [file, body] of Object.entries(contents)) await writeFile(join(root, file), body, "utf8");
    return root;
  }

  function reference(file: string, from: string, to: string): MigrationReference {
    return { file, line: 1, text: "", from, to };
  }

  it("rewrites the tag wherever it appears, with or without the .sql suffix", async () => {
    const root = await fixture({
      "a.test.ts": [
        'const MIGRATION_FILE = "0232_fixed_hannibal_king.sql";',
        'await readMigration("0232_fixed_hannibal_king.sql");',
        'expect(tag).toBe("0232_fixed_hannibal_king");',
      ].join("\n"),
    });

    const changed = await repointMigrationReferences(
      [reference("a.test.ts", "0232_fixed_hannibal_king", "0247_fixed_hannibal_king")],
      root,
    );

    expect(changed).toEqual([{ file: "a.test.ts", count: 3 }]);
    const after = await readFile(join(root, "a.test.ts"), "utf8");
    expect(after).not.toContain("0232_fixed_hannibal_king");
    expect(after.match(/0247_fixed_hannibal_king/g)).toHaveLength(3);
  });

  // The renumbering walks the folded entries in order, so one migration's NEW
  // tag can be another's OLD tag. Substituting rename by rename would then move
  // the same string twice and land it on the wrong migration; the rewrite is a
  // single pass per file for exactly this reason.
  it("does not double-substitute when one rename's target is another's source", async () => {
    const root = await fixture({
      "b.test.ts": 'readMigration("0232_alpha.sql"); readMigration("0247_beta.sql");',
    });

    await repointMigrationReferences(
      [
        reference("b.test.ts", "0232_alpha", "0247_alpha"),
        reference("b.test.ts", "0247_beta", "0248_beta"),
      ],
      root,
    );

    expect(await readFile(join(root, "b.test.ts"), "utf8")).toBe(
      'readMigration("0247_alpha.sql"); readMigration("0248_beta.sql");',
    );
  });

  it("leaves a file alone when the tag is no longer in it", async () => {
    const root = await fixture({ "c.test.ts": 'readMigration("0300_unrelated.sql");' });

    expect(
      await repointMigrationReferences([reference("c.test.ts", "0232_gone", "0247_gone")], root),
    ).toEqual([]);
    expect(await readFile(join(root, "c.test.ts"), "utf8")).toBe('readMigration("0300_unrelated.sql");');
  });
});
