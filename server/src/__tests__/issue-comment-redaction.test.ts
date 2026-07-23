import { describe, expect, it } from "vitest";
import { SECRET_REDACTION_TOKEN, maskUserNameForLogs } from "../log-redaction.js";
import { redactIssueCommentBody } from "../services/issues.js";

// SUP-7928 leaked a service-role key through an auto-posted heartbeat comment.
// Every comment body — agent-authored or human-authored — passes through this
// helper before the issueComments insert.
describe("redactIssueCommentBody", () => {
  const opts = { userNames: ["paperclipuser"], homeDirs: ["/home/paperclipuser"] };

  it("masks a service-role JWT pasted into narration", () => {
    const jwt = "eyJTESTONLYheader.eyJTESTONLYpayload.TESTONLYsignature01";

    const result = redactIssueCommentBody(`Verification used ${jwt} — it worked.`, opts);

    expect(result).toBe(`Verification used ${SECRET_REDACTION_TOKEN} — it worked.`);
  });

  it("masks a secret assignment echoed from a shell command", () => {
    const result = redactIssueCommentBody(
      "Ran `export SUPABASE_SERVICE_ROLE_KEY=sb_secret_TESTONLYaaaabbbbcccc1234`",
      opts,
    );

    expect(result).not.toContain("sb_secret_TESTONLY");
    expect(result).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SECRET_REDACTION_TOKEN}`);
  });

  it("still masks the current username, and does so before secret masking", () => {
    const result = redactIssueCommentBody(
      "cwd=/home/paperclipuser/scratch, GITHUB_TOKEN=ghp_TESTONLYaaaabbbbccccddddeeee01",
      opts,
    );

    expect(result).toContain(`/home/${maskUserNameForLogs("paperclipuser")}/scratch`);
    expect(result).not.toContain("paperclipuser");
    expect(result).toContain(`GITHUB_TOKEN=${SECRET_REDACTION_TOKEN}`);
  });

  it("leaves the bounded-liveness dedup prefix intact", () => {
    // heartbeat.ts dedups this comment with a `like 'Bounded liveness…%'` query;
    // redaction must never rewrite the leading text.
    const body = "Bounded liveness continuation exhausted after 3 attempts.";

    expect(redactIssueCommentBody(body, opts)).toBe(body);
  });

  it("leaves ordinary review prose untouched", () => {
    const body = [
      "Please rotate SUPABASE_SERVICE_ROLE_KEY and confirm.",
      "const SESSION_TOKEN = await getToken();",
      "See the API_KEY: section of the runbook.",
    ].join("\n");

    expect(redactIssueCommentBody(body, opts)).toBe(body);
  });
});
