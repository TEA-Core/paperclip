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

    const startIdx = startServerMatch!.index!;
    const bodyStart = source.slice(startIdx, startIdx + 500);

    const umaskMatch = bodyStart.match(/process\.umask\(0o002\)/);
    expect(umaskMatch).not.toBeNull();
    expect(umaskMatch!.index).toBeLessThan(200);
  });
});
