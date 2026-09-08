import { describe, expect, it } from "vitest";
import { formatExternalObjectMentionSourceLabel } from "./external-objects.js";
import {
  buildExternalObjectMentionSourceKey,
  buildExternalObjectScopedIdentityKey,
  canonicalizeExternalObjectUrl,
  extractExternalObjectCanonicalUrls,
  findExternalObjectUrlMatches,
} from "./external-objects-server.js";
import { externalObjectProviderKeySchema, externalObjectTypeSchema } from "./validators/external-object.js";

describe("external object references", () => {
  it("extracts external urls without changing internal issue reference behavior", () => {
    expect(
      findExternalObjectUrlMatches(
        "See PAP-1, /issues/PAP-2, https://paperclip.ing/PAP/issues/PAP-3, and https://github.com/acme/app/pull/4.",
      ),
    ).toEqual([{ index: 70, length: 34, matchedText: "https://github.com/acme/app/pull/4" }]);
  });

  it("ignores urls inside inline and fenced code", () => {
    const markdown = [
      "Use https://github.com/acme/app/pull/1 here.",
      "`https://github.com/acme/app/pull/2` should not count.",
      "```",
      "https://github.com/acme/app/pull/3",
      "```",
    ].join("\n");

    expect(findExternalObjectUrlMatches(markdown).map((match) => match.matchedText)).toEqual([
      "https://github.com/acme/app/pull/1",
    ]);
  });

  it("canonicalizes urls by stripping query and fragment by default", () => {
    expect(canonicalizeExternalObjectUrl("HTTPS://GitHub.com/acme/app/pull/1?token=secret#discussion")).toMatchObject({
      sanitizedCanonicalUrl: "https://github.com/acme/app/pull/1",
      sanitizedDisplayUrl: "https://github.com/acme/app/pull/1",
      redactedMatchedText: "https://github.com/acme/app/pull/1",
      canonicalIdentity: {
        scheme: "https",
        host: "github.com",
        path: "/acme/app/pull/1",
      },
    });
  });

  it("rejects urls with userinfo", () => {
    expect(canonicalizeExternalObjectUrl("https://token:secret@github.com/acme/app/pull/1")).toBeNull();
  });

  it("hashes provider-required query identity values without storing plaintext", () => {
    const first = canonicalizeExternalObjectUrl("https://deploy.test/run?id=secret-run&token=drop", {
      identityQueryParams: ["id"],
    });
    const second = canonicalizeExternalObjectUrl("https://deploy.test/run?id=secret-run&token=other", {
      identityQueryParams: ["id"],
    });

    expect(first?.sanitizedCanonicalUrl).toBe("https://deploy.test/run");
    expect(first?.canonicalIdentity.queryParamHashes?.id).toHaveLength(64);
    expect(first?.canonicalIdentity.queryParamHashes?.id).not.toContain("secret-run");
    expect(second?.canonicalIdentityHash).toBe(first?.canonicalIdentityHash);
  });

  it("dedupes extracted canonical urls by canonical identity", () => {
    expect(
      extractExternalObjectCanonicalUrls(
        "https://github.com/acme/app/pull/1?token=a and https://github.com/acme/app/pull/1#discussion",
      ).map((entry) => entry.sanitizedCanonicalUrl),
    ).toEqual(["https://github.com/acme/app/pull/1"]);
  });

  it("includes company id in scoped object identity keys", () => {
    const base = {
      providerKey: "github",
      objectType: "pull_request",
      canonicalIdentityHash: "hash",
    };

    expect(buildExternalObjectScopedIdentityKey({ companyId: "company-a", ...base })).not.toBe(
      buildExternalObjectScopedIdentityKey({ companyId: "company-b", ...base }),
    );
  });

  it("builds source keys for replacing mentions from the same source", () => {
    const oldMentionSource = buildExternalObjectMentionSourceKey({
      companyId: "company-a",
      sourceIssueId: "issue-1",
      sourceKind: "comment",
      sourceRecordId: "comment-1",
    });
    const newMentionSource = buildExternalObjectMentionSourceKey({
      companyId: "company-a",
      sourceIssueId: "issue-1",
      sourceKind: "comment",
      sourceRecordId: "comment-1",
    });
    const anotherCompanySource = buildExternalObjectMentionSourceKey({
      companyId: "company-b",
      sourceIssueId: "issue-1",
      sourceKind: "comment",
      sourceRecordId: "comment-1",
    });

    expect(newMentionSource).toBe(oldMentionSource);
    expect(anotherCompanySource).not.toBe(oldMentionSource);
  });

  it("formats stable source labels", () => {
    expect(formatExternalObjectMentionSourceLabel({ sourceKind: "title" })).toBe("Title");
    expect(formatExternalObjectMentionSourceLabel({ sourceKind: "document", documentKey: "plan" })).toBe(
      "Document: plan",
    );
    expect(formatExternalObjectMentionSourceLabel({ sourceKind: "property", propertyKey: "pr" })).toBe(
      "Property: pr",
    );
  });

  it("validates provider keys and object types", () => {
    expect(externalObjectProviderKeySchema.parse("github.enterprise")).toBe("github.enterprise");
    expect(externalObjectTypeSchema.parse("pull_request")).toBe("pull_request");
    expect(externalObjectProviderKeySchema.safeParse("GitHub").success).toBe(false);
    expect(externalObjectTypeSchema.safeParse("pull-request").success).toBe(false);
  });

  it("strips a trailing ** from a bold-wrapped url so a PR link stays a PR link", () => {
    const markdown = "Delivered as **https://github.com/acme/app/pull/375** this morning.";
    expect(findExternalObjectUrlMatches(markdown).map((m) => m.matchedText)).toEqual([
      "https://github.com/acme/app/pull/375",
    ]);

    const [canonical] = extractExternalObjectCanonicalUrls(markdown);
    expect(canonical).toMatchObject({
      sanitizedCanonicalUrl: "https://github.com/acme/app/pull/375",
      canonicalIdentity: { scheme: "https", host: "github.com", path: "/acme/app/pull/375" },
    });
  });

  it("strips abutting markdown emphasis and sentence punctuation from urls", () => {
    const cases: Array<[string, string]> = [
      ["See *https://github.com/acme/app/pull/8* now", "https://github.com/acme/app/pull/8"],
      ["See _https://github.com/acme/app/pull/9_ now", "https://github.com/acme/app/pull/9"],
      ["[PR](https://github.com/acme/app/pull/10) here", "https://github.com/acme/app/pull/10"],
      ["Bare: https://github.com/acme/app/pull/11.", "https://github.com/acme/app/pull/11"],
      ["Bare: https://github.com/acme/app/pull/12,", "https://github.com/acme/app/pull/12"],
      ["Bare: https://github.com/acme/app/pull/13;", "https://github.com/acme/app/pull/13"],
      ["Bare: https://github.com/acme/app/pull/14:", "https://github.com/acme/app/pull/14"],
    ];
    for (const [input, expected] of cases) {
      expect(findExternalObjectUrlMatches(input).map((m) => m.matchedText)).toEqual([expected]);
    }
  });

  it("preserves a genuine underscore the token cut off before a paren group (no over-strip)", () => {
    // The token regex stops at `(`, so `Foo_` is captured; the trailing `_` must
    // survive because it is not an abutting markdown emphasis marker.
    const markdown = "Reference: https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(findExternalObjectUrlMatches(markdown).map((m) => m.matchedText)).toEqual([
      "https://en.wikipedia.org/wiki/Foo_",
    ]);
  });

  it("does not strip a url that genuinely ends in an underscore", () => {
    const markdown = "Artifact: https://example.com/exports/2026_daily.";
    expect(findExternalObjectUrlMatches(markdown).map((m) => m.matchedText)).toEqual([
      "https://example.com/exports/2026_daily",
    ]);
  });

  it("strips a labelled bold span **PR: <url>** so the PR token stays clean (SUP-15395)", () => {
    const markdown =
      "Delivered the SUP-15377 systemic fix. **PR: https://github.com/TEA-Core/paperclip/pull/572** (branch `SUP-15377-x`), commit `6699713`";
    expect(findExternalObjectUrlMatches(markdown).map((m) => m.matchedText)).toEqual([
      "https://github.com/TEA-Core/paperclip/pull/572",
    ]);

    const [canonical] = extractExternalObjectCanonicalUrls(markdown);
    expect(canonical).toMatchObject({
      sanitizedCanonicalUrl: "https://github.com/TEA-Core/paperclip/pull/572",
      canonicalIdentity: {
        scheme: "https",
        host: "github.com",
        path: "/TEA-Core/paperclip/pull/572",
      },
    });
  });

  it("covers single-asterisk italics, mixed emphasis, and the five control shapes", () => {
    const cases: Array<[string, string]> = [
      ["**PR: https://github.com/acme/app/pull/572** (branch)", "https://github.com/acme/app/pull/572"],
      ["*PR: https://github.com/acme/app/pull/571* (branch)", "https://github.com/acme/app/pull/571"],
      ["**_https://github.com/acme/app/pull/570_** here", "https://github.com/acme/app/pull/570"],
      ["**https://github.com/acme/app/pull/375**", "https://github.com/acme/app/pull/375"],
      ["https://github.com/acme/app/pull/60,", "https://github.com/acme/app/pull/60"],
      ["https://github.com/acme/app/pull/61.", "https://github.com/acme/app/pull/61"],
      ["[x](https://github.com/acme/app/pull/62)", "https://github.com/acme/app/pull/62"],
      ["Bare: https://github.com/acme/app/pull/63", "https://github.com/acme/app/pull/63"],
    ];
    for (const [input, expected] of cases) {
      expect(findExternalObjectUrlMatches(input).map((m) => m.matchedText)).toEqual([expected]);
    }
  });

  it("keeps a genuine terminal * with no unclosed opener on the line", () => {
    const markdown = "Asset: https://example.com/exports/flag*";
    expect(findExternalObjectUrlMatches(markdown).map((m) => m.matchedText)).toEqual([
      "https://example.com/exports/flag*",
    ]);
  });

  it("does not strip a genuine trailing ** when the earlier emphasis span is balanced (SUP-15395)", () => {
    // `**bold**` is a complete emphasis span, so no opener is still open at the
    // URL; the trailing `**` is genuine content and must survive the trim.
    const cases: Array<[string, string]> = [
      ["See **bold** then https://example.com/path**", "https://example.com/path**"],
      ["See *ital* then https://example.com/path*", "https://example.com/path*"],
      ["See _em_ then https://example.com/path_", "https://example.com/path_"],
      // Contrast: an opener that is still open at the URL makes the trailing
      // marker an emphasis close and strips it.
      ["**See bold then https://example.com/path**", "https://example.com/path"],
    ];
    for (const [input, expected] of cases) {
      expect(findExternalObjectUrlMatches(input).map((m) => m.matchedText)).toEqual([expected]);
    }
  });
});
