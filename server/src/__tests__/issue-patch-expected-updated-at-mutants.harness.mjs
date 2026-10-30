// Release-assurance evidence, not a CI check. Applies one source mutant at a
// time, runs the killer assertion, and restores the file. A non-zero vitest
// exit is a kill. Every patched file is snapshotted up front and restored on
// exit, on a signal, and after each mutant; the run fails if any file differs
// from its snapshot at the end. A mutant whose anchor no longer matches the
// source reports ERROR and counts as not killed, so refactors fail loudly.
// Run from the repo root:
//   node server/src/__tests__/issue-patch-expected-updated-at-mutants.harness.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../../../", import.meta.url);

const mutants = [
  {
    name: "compare-strings-instead-of-instants",
    file: "server/src/routes/issues.ts",
    from: "existing.updatedAt.getTime() !== new Date(expectedUpdatedAtRaw).getTime()",
    to: "existing.updatedAt.toISOString() !== expectedUpdatedAtRaw",
    test: "accepts an equivalent offset",
  },
  {
    name: "sql-lte-instead-of-eq",
    file: "server/src/services/issues.ts",
    from: "date_trunc('milliseconds', ${issues.updatedAt}) = date_trunc('milliseconds', ${expectedUpdatedAt.toISOString()}::timestamptz)",
    to: "date_trunc('milliseconds', ${issues.updatedAt}) <= date_trunc('milliseconds', ${expectedUpdatedAt.toISOString()}::timestamptz)",
    test: "service rejects a future expectedUpdatedAt",
  },
  {
    name: "drop-cas-check",
    file: "server/src/routes/issues.ts",
    from: `    if (
      expectedUpdatedAtRaw !== undefined &&
      existing.updatedAt.getTime() !== new Date(expectedUpdatedAtRaw).getTime()
    ) {
      throw issueVersionConflict(existing.updatedAt);
    }
`,
    to: "",
    also: {
      file: "server/src/services/issues.ts",
      from: `        const writePredicate = expectedUpdatedAt === undefined
          ? idPredicate
          : and(
              idPredicate,
              sql\`date_trunc('milliseconds', \${issues.updatedAt}) = date_trunc('milliseconds', \${expectedUpdatedAt.toISOString()}::timestamptz)\`,
            );`,
      to: "        const writePredicate = idPredicate;",
    },
    test: "rejects a stale expectedUpdatedAt with 409 and writes nothing",
  },
  {
    name: "move-check-before-authorization",
    file: "server/src/routes/issues.ts",
    from: `    if (!existing) return;
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));`,
    to: `    if (!existing) return;
    if (
      typeof req.body.expectedUpdatedAt === "string" &&
      existing.updatedAt.getTime() !== new Date(req.body.expectedUpdatedAt).getTime()
    ) {
      throw issueVersionConflict(existing.updatedAt);
    }
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));`,
    test: "rejects a non-assignee agent before comparing a stale token",
  },
  {
    name: "drop-interrupt-path-rejection",
    file: "server/src/routes/issues.ts",
    from: `      rejectExpectedUpdatedAtBeforeSideEffect();

      const runToInterrupt = await resolveActiveIssueRun(existing);`,
    to: "      const runToInterrupt = await resolveActiveIssueRun(existing);",
    test: "interrupt cancel",
  },
  {
    name: "drop-reassignment-path-rejection",
    file: "server/src/routes/issues.ts",
    from: `    if (assigneeWillChange && existing.assigneeAgentId) {
      rejectExpectedUpdatedAtBeforeSideEffect();
      await stopRunnerGoalForOwnershipChange({`,
    to: `    if (assigneeWillChange && existing.assigneeAgentId) {
      await stopRunnerGoalForOwnershipChange({`,
    test: "reassignment cancel",
  },
  {
    name: "drop-terminalization-path-rejection",
    file: "server/src/routes/issues.ts",
    from: `      rejectExpectedUpdatedAtBeforeSideEffect();
      const goalStopAction = await stopRunnerGoalForOwnershipChange({`,
    to: "      const goalStopAction = await stopRunnerGoalForOwnershipChange({",
    test: "terminalization cancel",
  },
  {
    name: "drop-scheduled-retry-path-rejection",
    file: "server/src/routes/issues.ts",
    from: `      rejectExpectedUpdatedAtBeforeSideEffect();
      cancelledScheduledRetryRunId = await cancelScheduledRetrySupersededByComment({`,
    to: "      cancelledScheduledRetryRunId = await cancelScheduledRetrySupersededByComment({",
    test: "scheduled retry comment rejects expectedUpdatedAt before cancelling the retry",
  },
  {
    name: "drop-checkout-adoption-rejection",
    file: "server/src/routes/issues.ts",
    from: "noCheckoutAdoption: req.body.expectedUpdatedAt !== undefined,",
    to: "noCheckoutAdoption: false,",
    test: "returns 409 checkout_adoption_required with no adoption",
  },
  {
    name: "move-check-outside-write-transaction-lock",
    file: "server/src/services/issues.ts",
    from: `        const writePredicate = expectedUpdatedAt === undefined
          ? idPredicate
          : and(
              idPredicate,
              sql\`date_trunc('milliseconds', \${issues.updatedAt}) = date_trunc('milliseconds', \${expectedUpdatedAt.toISOString()}::timestamptz)\`,
            );`,
    to: "        const writePredicate = idPredicate;",
    test: "produces exactly one success for five concurrent patches",
  },
  {
    name: "accept-null-empty-as-a-match",
    file: "server/src/routes/issues.ts",
    from: "expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),",
    to: "expectedUpdatedAt: z.union([z.string().datetime({ offset: true }), z.literal(\"\"), z.null()]).optional(),",
    test: "rejects null and empty expectedUpdatedAt before any write",
  },
  {
    name: "malformed-value-becomes-no-precondition",
    file: "server/src/routes/issues.ts",
    from: "expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),",
    to: "expectedUpdatedAt: z.string().optional(),",
    test: "rejects a non-timestamp expectedUpdatedAt before any write",
  },
];

function abs(file) {
  return new URL(file, root);
}

const snapshots = new Map();
for (const mutant of mutants) {
  for (const { file } of [mutant, ...(mutant.also ? [mutant.also] : [])]) {
    if (!snapshots.has(file)) snapshots.set(file, readFileSync(abs(file), "utf8"));
  }
}

function restoreAll() {
  for (const [file, original] of snapshots) writeFileSync(abs(file), original);
}

process.on("exit", restoreAll);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130));
}

function apply(file, from, to) {
  const path = abs(file);
  const original = readFileSync(path, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: mutant anchor matched ${count} times (expected 1); update the snippet to the current source`);
  }
  writeFileSync(path, original.replace(from, to));
  return original;
}

function runKiller(testName) {
  const child = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "server/src/__tests__/issue-patch-expected-updated-at.test.ts", "-t", testName],
    { cwd: root, encoding: "utf8", timeout: 180_000 },
  );
  if (child.error || child.status === null) {
    throw new Error(`vitest did not complete: ${child.error ?? `signal ${child.signal}`}`);
  }
  return child.status;
}

const results = [];
for (const mutant of mutants) {
  const originals = new Map();
  try {
    originals.set(mutant.file, apply(mutant.file, mutant.from, mutant.to));
    if (mutant.also) {
      originals.set(mutant.also.file, apply(mutant.also.file, mutant.also.from, mutant.also.to));
    }
    const status = runKiller(mutant.test);
    results.push({ name: mutant.name, killed: status !== 0, status });
    process.stdout.write(`${status === 0 ? "SURVIVED" : "KILLED"} ${mutant.name} exit=${status}\n`);
  } catch (err) {
    results.push({ name: mutant.name, killed: false, status: "error", error: String(err) });
    process.stdout.write(`ERROR ${mutant.name} ${err}\n`);
  } finally {
    for (const [file, original] of originals) writeFileSync(abs(file), original);
  }
}

const drifted = [...snapshots].filter(([file, original]) => readFileSync(abs(file), "utf8") !== original);
if (drifted.length > 0) {
  process.stdout.write(`ERROR files differ from their pre-run snapshot: ${drifted.map(([file]) => file).join(", ")}\n`);
  restoreAll();
  process.exitCode = 1;
}

const killed = results.filter((row) => row.killed).length;
process.stdout.write(`\n${killed}/${results.length} killed\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (killed !== results.length) process.exitCode = 1;
