/**
 * Fold 2c / D9 deferral guard (operator decision 2026-09-15).
 *
 * D9 -- moving releaseIssueExecutionAndPromote onto modules/wake-queue -- is deferred to its own
 * slice. Until it lands, the fork's in-file release in heartbeat.ts is the ONLY live release path:
 * it carries SUP-15589, SUP-14737, SUP-14913, SUP-11306/15237, SUP-12231, SUP-11280, D12 and the
 * #13075 / df984cbc2 stop-gaps, none of which the module half reproduces. The module's
 * `releaseIssueExecution` and its host glue (`deps.recovery`, `applyWakeQueuePostCommitEffects`)
 * stay in the tree, DORMANT, so a later fold does not re-conflict on them.
 *
 * A fold resolution that quietly wires the module release -- or brings back a second in-file
 * body -- would switch production onto upstream semantics with no test going red, because the
 * upstream module tests pass either way. This guard makes that change visible. When the D9 port
 * lands, update it in the same change (exactly one module caller, the in-file body gone).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSrc = fileURLToPath(new URL("..", import.meta.url));
const wakeQueueModuleDir = path.join(serverSrc, "modules", "wake-queue") + path.sep;

function productionSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      files.push(...productionSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("wake-queue release stays dormant while D9 is deferred (fold 2c)", () => {
  it("has no production caller of releaseIssueExecution( outside modules/wake-queue", () => {
    // Matches a bare or member call, but not releaseIssueExecutionAndPromote(.
    const callPattern = /(?<![A-Za-z0-9_$])releaseIssueExecution\(/;
    const offenders = productionSourceFiles(serverSrc)
      .filter((file) => !file.startsWith(wakeQueueModuleDir))
      .filter((file) => callPattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(serverSrc, file));
    expect(offenders).toEqual([]);
  });

  it("keeps exactly one in-file release implementation and both DORMANT markers in heartbeat.ts", () => {
    const heartbeat = readFileSync(path.join(serverSrc, "services", "heartbeat.ts"), "utf8");
    expect(heartbeat.match(/async function releaseIssueExecutionAndPromote\(/g) ?? []).toHaveLength(1);
    expect(heartbeat.match(/wakeQueue\.releaseIssueExecution\(/g) ?? []).toHaveLength(0);
    // One on the `deps.recovery` port, one on applyWakeQueuePostCommitEffects.
    expect(heartbeat.match(/DORMANT \(fold 2c \/ D9\)/g) ?? []).toHaveLength(2);
  });
});
