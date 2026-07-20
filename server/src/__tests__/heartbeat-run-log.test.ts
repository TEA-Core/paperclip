import { describe, expect, it } from "vitest";
import { SECRET_REDACTION_TOKEN, redactSecretTokens } from "../log-redaction.js";
import { compactRunLogChunk } from "../services/heartbeat.js";

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

    expect(result).not.toContain(secret);
    expect(result).toContain(`SUPABASE_SECRET_KEY=${SECRET_REDACTION_TOKEN}`);
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
