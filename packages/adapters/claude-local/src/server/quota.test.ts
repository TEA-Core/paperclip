import { describe, expect, it } from "vitest";
import { describeClaudeSubscriptionAuth } from "./quota.js";

/**
 * SUP-13941. Paperclip's fleet auth is moving from an interactive `claude.ai`
 * login (which mints an access token that expires every 8 hours, and whose
 * refresh lands in a per-agent credential fork that is never written back) to a
 * long-lived subscription token delivered as `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * That flips `claude auth status` from `authMethod: "claude.ai"` to
 * `authMethod: "oauth_token"`. Quota reporting keyed on the literal string, so
 * the switch would have silently blanked subscription quota for the whole
 * fleet: `getQuotaWindows` would fall through to "no local claude auth token"
 * on a host that is, in fact, logged in.
 */
describe("describeClaudeSubscriptionAuth (SUP-13941)", () => {
  it("recognises an interactive claude.ai login", () => {
    expect(
      describeClaudeSubscriptionAuth({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    ).toBe("Claude is logged in via claude.ai (max)");
  });

  it("recognises a long-lived subscription OAuth token", () => {
    expect(
      describeClaudeSubscriptionAuth({ loggedIn: true, authMethod: "oauth_token", subscriptionType: "max" }),
    ).toBe("Claude is logged in via a subscription OAuth token (max)");
  });

  it("describes an oauth_token session with no subscriptionType", () => {
    expect(
      describeClaudeSubscriptionAuth({ loggedIn: true, authMethod: "oauth_token", subscriptionType: null }),
    ).toBe("Claude is logged in via a subscription OAuth token");
  });

  it("does not treat an API key session as a subscription", () => {
    // Metered separately, with no subscription quota to report.
    expect(
      describeClaudeSubscriptionAuth({ loggedIn: true, authMethod: "apiKey", subscriptionType: null }),
    ).toBeNull();
  });

  it("requires loggedIn even when the auth method looks right", () => {
    expect(
      describeClaudeSubscriptionAuth({ loggedIn: false, authMethod: "oauth_token", subscriptionType: "max" }),
    ).toBeNull();
  });

  it("returns null for an absent or unknown status", () => {
    expect(describeClaudeSubscriptionAuth(null)).toBeNull();
    expect(
      describeClaudeSubscriptionAuth({ loggedIn: true, authMethod: null, subscriptionType: null }),
    ).toBeNull();
  });
});
