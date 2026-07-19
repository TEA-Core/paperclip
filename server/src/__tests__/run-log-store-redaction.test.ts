import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SECRET_REDACTION_TOKEN } from "../log-redaction.js";
import { createLocalFileRunLogStore } from "../services/run-log-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-"));
  tempRoots.push(root);
  const store = createLocalFileRunLogStore(root);
  const handle = await store.begin({
    companyId: "company-TESTONLY",
    agentId: "agent-TESTONLY",
    runId: "run-TESTONLY",
  });
  return { store, handle, root };
}

describe("run log store redaction", () => {
  it("masks secret-shaped tokens before the line reaches disk", async () => {
    const { store, handle } = await makeStore();
    const secret = "sb_secret_TESTONLYaaaabbbbcccc1234";

    await store.append(handle, {
      stream: "stdout",
      chunk: `exporting SUPABASE_SECRET_KEY=${secret}\nnext line survives\n`,
      ts: new Date(0).toISOString(),
    });

    const { content } = await store.read(handle);

    expect(content).not.toContain(secret);
    expect(content).toContain(SECRET_REDACTION_TOKEN);
    expect(content).toContain("next line survives");
  });

  it("keeps the persisted line valid NDJSON after redaction", async () => {
    const { store, handle } = await makeStore();

    await store.append(handle, {
      stream: "stderr",
      chunk: `{"GITHUB_TOKEN":"ghp_TESTONLYaaaabbbbccccddddeeee01","ok":true}`,
      ts: new Date(0).toISOString(),
    });

    const { content } = await store.read(handle);
    const parsed = JSON.parse(content.trim()) as { stream: string; chunk: string };

    expect(parsed.stream).toBe("stderr");
    expect(parsed.chunk).not.toContain("ghp_TESTONLY");
    expect(parsed.chunk).toContain(SECRET_REDACTION_TOKEN);
    expect(JSON.parse(parsed.chunk) as { ok: boolean }).toEqual({
      GITHUB_TOKEN: SECRET_REDACTION_TOKEN,
      ok: true,
    });
  });

  it("reports the byte count of the redacted line", async () => {
    const { store, handle } = await makeStore();
    const chunk = `API_KEY=TESTONLYaaaabbbbcccc1234`;

    const bytes = await store.append(handle, {
      stream: "stdout",
      chunk,
      ts: new Date(0).toISOString(),
    });
    const summary = await store.finalize(handle);

    expect(bytes).toBe(summary.bytes);
  });
});
