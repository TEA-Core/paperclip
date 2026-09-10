import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guards against resolving two module graphs concurrently inside a
 * `Promise.all`, with either `vi.importActual` or a bare dynamic `import()`.
 *
 * Resolving two module graphs concurrently makes vitest drain its pending
 * mock queue twice at the same time, and the second drain re-applies the
 * suite's `vi.doUnmock` calls after the first drain has already registered
 * the `vi.doMock` replacements.
 *
 * `vitest@4.1.10` drains the queue in
 * `VitestMocker.resolveMocks` (`vitest/dist/chunks/startVitestModuleRunner.*.js`):
 *
 *     async resolveMocks() {
 *       if (!BareModuleMocker.pendingIds.length) return;
 *       const resolveMock = async (mock) => {
 *         const { id, url, external } = await this.resolveId(mock.id, mock.importer);
 *         if (mock.action === "unmock") this.unmockPath(id);
 *         if (mock.action === "mock") this.mockPath(...);
 *       };
 *       const groups = groupByConsecutiveAction(BareModuleMocker.pendingIds);
 *       for (const group of groups) await Promise.all(group.map(resolveMock));
 *       BareModuleMocker.pendingIds = [];
 *     }
 *
 * `pendingIds` is only cleared after every group has settled, so a second
 * module fetch that arrives while the first drain is still in flight sees a
 * non-empty queue and starts its own drain over the same entries. Each entry
 * costs an independent async `resolveId` round trip, so the two drains
 * interleave freely, and nothing serialises them.
 *
 * When the second drain's `unmockPath("…/services/index.ts")` lands after the
 * first drain's `mockPath("…/services/index.ts")`, the mocker registry holds
 * no mock for that module until the second drain reaches its own mock group.
 * Anything that consults the registry inside that window loads the real
 * module instead: `fetchModule` returns no `mockedModule` for it, and
 * `cachedRequest` treats it as stale —
 *
 *     const isStale = !this.mocker.getDependencyMock(mod.id);
 *     if (isStale || isSelfImport) {
 *       const node = await this.fetchModule(injectQuery(url, "_vitest_original"));
 *       return this._cachedRequest(node.url, node, callstack, metadata);
 *     }
 *
 * — and hands the route the real `services/index.js`. The real
 * `instanceSettingsService` then runs a drizzle query against the suite's
 * stand-in `db`, which only implements `transaction`, so the route throws
 * `TypeError: runner.select is not a function` and `errorHandler` answers a
 * bare 500. That is the `Verify serialized server suites` flake: a route that
 * must answer 200/201/422 answering 500, on a tree that passes on re-run at
 * the same head SHA.
 *
 * Awaiting the imports one at a time removes the condition
 * outright. The first call drains the queue and clears `pendingIds` before
 * the second call fetches anything, so the queue is applied exactly once, in
 * order. Instrumenting `resolveMocks` in `instance-settings-routes.test.ts`
 * measured this directly: concurrent imports produced 100 drains across 50
 * tests with two live at a time, sequential imports produced 50 drains with
 * one live at a time.
 *
 * Vitest's own source flags the same hazard in `requestWithMockedModule`:
 * "this will not work if user does Promise.all(import(), import())". A bare
 * dynamic `import()` is if anything more exposed than `vi.importActual`:
 * `importActual` loads its own root module with `ignoreMock = true`, while a
 * bare `import()` consults the mocker registry for the root as well as for
 * every dependency.
 *
 * Sequential imports cost nothing here. Both forms are served from vitest's
 * module cache after the first evaluation, and these suites already
 * serialise every test (`isolate: true`, `maxConcurrency: 1`,
 * `sequence.concurrent: false`, plus `--no-file-parallelism --maxWorkers=1`
 * on the serialized runner).
 */
const testsDir = path.dirname(fileURLToPath(import.meta.url));

/** Index of the `]` that closes the `[` at `open`. */
function matchBracket(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A dynamic `import(` that is not a `typeof import(` type position. */
const DYNAMIC_IMPORT = /(?<![.\w])import\s*\(/;

function findConcurrentImports(source: string): number[] {
  const lines: number[] = [];
  const needle = "Promise.all([";
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    const open = at + needle.length - 1;
    const close = matchBracket(source, open);
    if (close === -1) continue;
    const body = source.slice(open + 1, close);
    // `typeof import("x")` is a type annotation, not a module resolution, so it
    // only counts when it is not preceded by `typeof`.
    const dynamic = body.replaceAll("typeof import(", "typeof IMPORT_TYPE(");
    if (!body.includes("vi.importActual") && !DYNAMIC_IMPORT.test(dynamic)) continue;
    lines.push(source.slice(0, at).split("\n").length);
  }
  return lines;
}

describe("module graphs are never resolved concurrently", () => {
  // This file is excluded from its own scan: the doc comment above quotes the
  // banned pattern verbatim, and the scanner is deliberately text-based rather
  // than comment-aware so that a commented-out offender still gets caught.
  const selfName = path.basename(fileURLToPath(import.meta.url));
  const testFiles = readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.ts") && name !== selfName)
    .sort();

  it("finds the server test files to scan", () => {
    expect(testFiles.length).toBeGreaterThan(300);
  });

  it("has no Promise.all that resolves more than one module graph", () => {
    const offenders: string[] = [];
    for (const name of testFiles) {
      const source = readFileSync(path.join(testsDir, name), "utf-8");
      for (const line of findConcurrentImports(source)) {
        offenders.push(`${name}:${line}`);
      }
    }
    expect(
      offenders,
      "Await these imports one at a time. Resolving two module graphs "
        + "concurrently makes vitest drain its pending mock queue twice, and the second "
        + "drain re-applies vi.doUnmock after the first has registered vi.doMock. In that "
        + "window the route binds the real services module and answers a bare 500. See the "
        + "comment at the top of this file.",
    ).toEqual([]);
  });
});
