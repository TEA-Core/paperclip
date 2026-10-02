import { describe, expect, it } from "vitest";
import {
  SECRET_REDACTION_TOKEN,
  redactCurrentUserText,
  redactSecretTokens,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { compactRunLogChunk } from "../services/heartbeat.js";
import { formatOpenCodeSkillExposureLine } from "@paperclipai/adapter-opencode-local/server";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });
});

// SUP-8631: the run-log path composes these as
// redactSecretTokens(compactRunLogChunk(redactCurrentUserText(chunk))) — the
// secret filter runs OUTSIDE compaction so it sees a 64KB-capped chunk with the
// base64 image payloads already removed.
describe("compactRunLogChunk composed with redactSecretTokens", () => {
  it("masks a secret assignment in an oversized chunk", () => {
    const secret = "sb_secret_TESTONLYaaaabbbbcccc1234";
    const chunk = `${"x".repeat(90_000)}\nSUPABASE_SECRET_KEY=${secret}\n`;

    const result = redactSecretTokens(compactRunLogChunk(chunk));

    // Two filters cover this line and the inner one wins: compactRunLogChunk
    // itself runs redactSensitiveText, which masks `NAME=value` shapes before
    // redactSecretTokens ever sees them. What matters here is that the tail of
    // an oversized chunk is retained AND masked, not which filter did it.
    expect(result).not.toContain(secret);
    expect(result).toContain(`SUPABASE_SECRET_KEY=${REDACTED_EVENT_VALUE}`);
  });

  it("masks a bare secret-shaped token in the tail of an oversized chunk", () => {
    // No `NAME=` assignment, so redactSensitiveText does not fire and this is
    // the SUP-8631 filter working alone — the case that justifies running it
    // outside compaction rather than relying on the inner one.
    const secret = "sb_secret_TESTONLYaaaabbbbcccc1234";
    const chunk = `${"x".repeat(90_000)}\nleaked value ${secret} here\n`;

    const result = redactSecretTokens(compactRunLogChunk(chunk));

    expect(result).not.toContain(secret);
    expect(result).toContain(`leaked value ${SECRET_REDACTION_TOKEN} here`);
  });

  it("does not emit a secret marker inside inline base64 image data", () => {
    // Standard base64 payloads carry a token-like "eyJ" run constantly. Running
    // the secret filter after compaction means it only ever sees the
    // "[omitted base64 image data: N chars]" marker, which is itself inert.
    const base64 = `${"A".repeat(1024)}eyJhbGciOiJIUzI1NiJ9${"B".repeat(1024)}`;
    const chunk = `{"type":"image","source":{"type":"base64","data":"${base64}"}}\n`;

    const result = redactSecretTokens(compactRunLogChunk(chunk));

    expect(result).toContain("[omitted base64 image data:");
    expect(result).not.toContain(SECRET_REDACTION_TOKEN);
  });
});

describe("opencode exposure line on the persisted run-log path", () => {
  // The heartbeat onLog persists redactSecretTokens(compactRunLogChunk(
  // redactCurrentUserText(chunk, { enabled: censorUsernameInLogs }))), and the
  // run-log store applies redactSecretTokens once more on append.
  // censorUsernameInLogs defaults to false.
  const persist = (line: string, currentUser: CurrentUserRedactionOptions = { enabled: false }) =>
    redactSecretTokens(redactSecretTokens(compactRunLogChunk(redactCurrentUserText(line, currentUser))));
  const listItems = (line: string) => line.slice(line.indexOf(" names=") + " names=".length, -1).split(",");

  it("survives the chain byte-identical for names shaped like NAME=VALUE or NAME: VALUE", () => {
    const line = formatOpenCodeSkillExposureLine({
      mode: "shared",
      names: [
        ...Array.from({ length: 60 }, (_, i) => `example-skill-${String(i).padStart(2, "0")}--0123456789`),
        "api-key-rotation--1a2b3c4d5e",
        "credential-helper",
        "MY_TOKEN=abc",
        "password:hunter2",
      ],
      location: "/paperclip/.claude/skills",
    });

    expect(persist(line)).toBe(line);
    expect(line).toContain(" names=MY_TOKEN%3Dabc,api-key-rotation--1a2b3c4d5e,credential-helper,");
  });

  it("masks a name shaped like a secret value one item at a time, with a marker a reader can see", () => {
    const line = formatOpenCodeSkillExposureLine({
      mode: "shared",
      names: [
        "alpha-skill",
        "hf_dataset-loader-utility-x",
        "sk-research-helper-2024-tools",
        "npm_release-automation-helper",
        "abcdefgh.ijklmnop.qrstuvwx",
        "zeta-skill",
      ],
      location: "/paperclip/.claude/skills",
    });

    const before = listItems(line);
    const after = listItems(persist(line));
    expect(after).toHaveLength(before.length);
    expect(after).toContain("alpha-skill");
    expect(after).toContain("zeta-skill");
    const changed = after.filter((item, index) => item !== before[index]);
    expect(changed.length).toBeGreaterThan(0);
    for (const item of changed) expect(item).toMatch(/[*[]/);
    // Reader rule R3 relies on every redaction marker carrying a raw "*" or "[".
    expect(SECRET_REDACTION_TOKEN).toMatch(/[*[]/);
    expect(REDACTED_EVENT_VALUE).toMatch(/[*[]/);
  });

  it("is masked by censorUsernameInLogs: the home directory and a name equal to the OS user", () => {
    const line = formatOpenCodeSkillExposureLine({
      mode: "shared",
      names: ["node", "paperclip"],
      location: "/paperclip/.claude/skills",
    });

    expect(persist(line, { enabled: true, homeDirs: ["/paperclip"], userNames: ["node"] })).toBe(
      "[paperclip] skillIsolation=shared: run exposes 2 skill(s) via shared skills home /p********/.claude/skills names=n***,paperclip\n",
    );
  });
});
