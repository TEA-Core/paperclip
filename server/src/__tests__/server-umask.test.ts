import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

describe("server umask bootstrap", () => {
  it("calls process.umask(0o002) at the top of startServer()", () => {
    const source = readFileSync(INDEX_TS, "utf8");
    const startServerMatch = source.match(/export async function startServer\(\): Promise<StartedServer> \{/);
    expect(startServerMatch).not.toBeNull();

    // Fold 2c: upstream #12956 (023e640a7, "reap idle pool connections ... end
    // it on shutdown") turned startServer() into a thin wrapper that only arms
    // the startup database teardown and delegates the whole boot sequence to
    // startServerWithDatabaseTeardown(); the fork's umask call moved with that
    // body. Pin both halves: the wrapper delegates before doing any work, and
    // the umask is still at the top of the real boot body, ahead of its first
    // await (instrumentation, secrets, config, database, HTTP).
    const wrapperIdx = startServerMatch!.index!;
    const wrapperStart = source.slice(wrapperIdx, wrapperIdx + 500);
    // Only the teardown holder may precede the delegation; any other statement
    // in the wrapper would run ahead of the umask.
    const delegationMatch = wrapperStart.match(
      /^export async function startServer\(\): Promise<StartedServer> \{\s*const startupDatabase: StartupDatabaseTeardown = \{ close: null \};\s*try \{\s*return await startServerWithDatabaseTeardown\(startupDatabase\);/,
    );
    expect(delegationMatch).not.toBeNull();

    const bootBodyMatch = source.match(
      /async function startServerWithDatabaseTeardown\(\s*startupDatabase: StartupDatabaseTeardown,\s*\): Promise<StartedServer> \{/,
    );
    expect(bootBodyMatch).not.toBeNull();

    const bodyIdx = bootBodyMatch!.index! + bootBodyMatch![0].length;
    const bodyStart = source.slice(bodyIdx, bodyIdx + 500);

    const umaskMatch = bodyStart.match(/process\.umask\(0o002\)/);
    expect(umaskMatch).not.toBeNull();
    // Keep the pre-fold budget: 200 chars counted from the startServer()
    // signature, so measured from the opening brace it is 200 minus the
    // signature. A synchronous statement added ahead of the umask must fail.
    expect(umaskMatch!.index).toBeLessThan(200 - startServerMatch![0].length);

    const firstAwaitIdx = bodyStart.search(/\bawait\b/);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(umaskMatch!.index).toBeLessThan(firstAwaitIdx);
  });
});
