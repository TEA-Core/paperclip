import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalObjectSummary } from "@paperclipai/shared";
import { externalObjectsApi } from "../api/externalObjects";
import {
  EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE,
  fetchIssueExternalObjectSummariesInBatches,
} from "../hooks/useIssueExternalObjects";
import {
  DOCTRINE_NET_LOC_SOFT_CAP,
  dominantExternalObjectTone,
  externalObjectCategoryLabel,
  externalObjectDisplayStatusLabel,
  externalObjectDisplayLabel,
  externalObjectDominantCount,
  externalObjectFallbackTone,
  externalObjectIconForCategory,
  externalObjectIconForKey,
  externalObjectLivenessLabel,
  externalObjectProviderLabel,
  externalObjectToneSeverity,
  externalObjectTypeLabel,
  formatDeliveredNetLoc,
  sortExternalObjectsBySeverity,
} from "./external-objects";
import { normalizeExternalObjectHref } from "./external-object-href";

vi.mock("../api/externalObjects", () => ({
  externalObjectsApi: {
    getIssueSummaries: vi.fn(),
  },
}));

const emptySummary: ExternalObjectSummary = {
  total: 0,
  byStatusCategory: {},
  byLiveness: {},
  highestSeverity: "neutral",
  staleCount: 0,
  authRequiredCount: 0,
  unreachableCount: 0,
  objects: [],
};

describe("normalizeExternalObjectHref", () => {
  it("lowercases the host (case preserving the path) and drops query/fragment", () => {
    expect(
      normalizeExternalObjectHref("HTTPS://Github.com/Acme/Web/pull/241?token=abc#frag"),
    ).toBe("https://github.com/Acme/Web/pull/241");
  });

  it("rejects non-http(s) and userinfo-bearing URLs", () => {
    expect(normalizeExternalObjectHref("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalObjectHref("ftp://example.com/file")).toBeNull();
    expect(normalizeExternalObjectHref("https://user:pass@example.com/")).toBeNull();
    expect(normalizeExternalObjectHref(null)).toBeNull();
    expect(normalizeExternalObjectHref(undefined)).toBeNull();
    expect(normalizeExternalObjectHref("not a url")).toBeNull();
  });

  it("defaults pathless URLs to /", () => {
    expect(normalizeExternalObjectHref("https://example.com")).toBe("https://example.com/");
  });
});

describe("fetchIssueExternalObjectSummariesInBatches", () => {
  afterEach(() => {
    vi.mocked(externalObjectsApi.getIssueSummaries).mockReset();
  });

  it("chunks bulk summary requests below the server validation cap and merges results", async () => {
    const issueIds = Array.from(
      { length: EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE * 2 + 3 },
      (_entry, index) => `issue-${index}`,
    );
    vi.mocked(externalObjectsApi.getIssueSummaries).mockImplementation(async (_companyId, ids) => ({
      summaries: Object.fromEntries(ids.map((id) => [id, { ...emptySummary, total: id.endsWith("-0") ? 1 : 0 }])),
    }));

    const result = await fetchIssueExternalObjectSummariesInBatches("company-1", issueIds);

    expect(externalObjectsApi.getIssueSummaries).toHaveBeenCalledTimes(3);
    expect(vi.mocked(externalObjectsApi.getIssueSummaries).mock.calls.map((call) => call[1].length)).toEqual([
      EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE,
      EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE,
      3,
    ]);
    expect(Object.keys(result.summaries)).toHaveLength(issueIds.length);
    expect(result.summaries["issue-0"]?.total).toBe(1);
  });
});

describe("external-objects helpers", () => {
  it("labels categories with copy from the UX spec", () => {
    expect(externalObjectCategoryLabel("auth_required")).toBe("Authorization required");
    expect(externalObjectCategoryLabel("succeeded")).toBe("Succeeded");
    expect(externalObjectCategoryLabel("unknown")).toBe("Not yet resolved");
  });

  it("labels liveness states with non-tech copy", () => {
    expect(externalObjectLivenessLabel("stale")).toBe("Stale");
    expect(externalObjectLivenessLabel("auth_required")).toBe("Requires auth");
    expect(externalObjectLivenessLabel("fresh")).toBe("Fresh");
  });

  it("falls back to a humanised label for unknown providers and types", () => {
    expect(externalObjectProviderLabel("github")).toBe("GitHub");
    expect(externalObjectProviderLabel("hubspot_marketing")).toBe("Hubspot Marketing");
    expect(externalObjectProviderLabel(null)).toBe("External");
    expect(externalObjectTypeLabel("workflow_run")).toBe("workflow run");
    expect(externalObjectTypeLabel("url_link")).toBe("URL");
    expect(externalObjectTypeLabel(null)).toBe("object");
  });

  it("labels generic URL link objects as URL", () => {
    expect(externalObjectDisplayLabel("url", "link")).toBe("URL");
    expect(externalObjectDisplayLabel("url", "link", "Canonical URL")).toBe("Canonical URL");
    expect(externalObjectDisplayLabel("github", "pull_request")).toBe("GitHub pull request");
  });

  it("labels unresolved known objects as not refreshed while preserving generic URL copy", () => {
    expect(
      externalObjectDisplayStatusLabel({
        providerKey: "github",
        objectType: "pull_request",
        statusCategory: "unknown",
        liveness: "unknown",
      }),
    ).toBe("Not yet refreshed");
    expect(
      externalObjectDisplayStatusLabel({
        providerKey: "url",
        objectType: "link",
        statusCategory: "unknown",
        liveness: "unknown",
      }),
    ).toBe("Not yet resolved");
    expect(
      externalObjectDisplayStatusLabel({
        providerKey: "github",
        objectType: "pull_request",
        statusCategory: "unknown",
        liveness: "fresh",
      }),
    ).toBe("Status unavailable");
    expect(
      externalObjectDisplayStatusLabel({
        providerKey: "github",
        objectType: "pull_request",
        statusCategory: "open",
        liveness: "fresh",
        statusLabel: "Open",
      }),
    ).toBe("Open");
  });

  it("orders tones from danger down to muted", () => {
    expect(externalObjectToneSeverity("danger")).toBeGreaterThan(externalObjectToneSeverity("warning"));
    expect(externalObjectToneSeverity("warning")).toBeGreaterThan(externalObjectToneSeverity("info"));
    expect(externalObjectToneSeverity("info")).toBeGreaterThan(externalObjectToneSeverity("success"));
    expect(externalObjectToneSeverity("success")).toBeGreaterThan(externalObjectToneSeverity("muted"));
    expect(externalObjectToneSeverity(null)).toBe(0);
    expect(externalObjectToneSeverity("nonsense")).toBe(0);
  });

  it("maps every spec category to a fallback tone", () => {
    expect(externalObjectFallbackTone("failed")).toBe("danger");
    expect(externalObjectFallbackTone("waiting")).toBe("warning");
    expect(externalObjectFallbackTone("running")).toBe("info");
    expect(externalObjectFallbackTone("succeeded")).toBe("success");
    expect(externalObjectFallbackTone("auth_required")).toBe("warning");
    expect(externalObjectFallbackTone("unreachable")).toBe("danger");
  });

  it("returns the spec lucide icon names for every category", () => {
    expect(externalObjectIconForCategory("succeeded").displayName ?? "").toMatch(/CheckCircle2|Check/);
    expect(externalObjectIconForCategory("failed").displayName ?? "").toMatch(/XCircle|X/);
    expect(externalObjectIconForCategory("auth_required").displayName ?? "").toMatch(/KeyRound|Key/);
    expect(externalObjectIconForCategory("unreachable").displayName ?? "").toMatch(/CloudOff|Cloud/);
    expect(externalObjectIconForCategory("running").displayName ?? "").toMatch(/Loader2|Loader/);
  });

  it("maps provider-controlled icon keys through host-owned icons", () => {
    expect(externalObjectIconForKey("github")?.displayName ?? "").toMatch(/Github/i);
    expect(externalObjectIconForKey("git-pull-request")?.displayName ?? "").toMatch(/GitPullRequest/i);
    expect(externalObjectIconForKey("unknown-provider-icon")).toBeNull();
  });

  it("sorts items by severity first, preserving insertion order within a tone", () => {
    const items = [
      { id: "a", statusTone: "info", providerKey: "github", objectType: "pull_request", displayTitle: null, statusCategory: "running", liveness: "fresh", isTerminal: false },
      { id: "b", statusTone: "danger", providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed", liveness: "fresh", isTerminal: false },
      { id: "c", statusTone: "warning", providerKey: "hubspot", objectType: "lead", displayTitle: null, statusCategory: "waiting", liveness: "fresh", isTerminal: false },
      { id: "d", statusTone: "danger", providerKey: "github", objectType: "issue", displayTitle: null, statusCategory: "blocked", liveness: "fresh", isTerminal: false },
    ] as const;
    const sorted = sortExternalObjectsBySeverity(items as never);
    expect(sorted.map((item) => item.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("hides the rollup when every item is in a muted tone", () => {
    const summary = {
      total: 2,
      byStatusCategory: { closed: 2 },
      byLiveness: { fresh: 2 },
      highestSeverity: "muted" as const,
      staleCount: 0,
      authRequiredCount: 0,
      unreachableCount: 0,
      objects: [
        { id: "a", providerKey: "x", objectType: "y", displayTitle: null, statusCategory: "closed" as const, statusTone: "muted" as const, liveness: "fresh" as const, isTerminal: true },
        { id: "b", providerKey: "x", objectType: "y", displayTitle: null, statusCategory: "closed" as const, statusTone: "muted" as const, liveness: "fresh" as const, isTerminal: true },
      ],
    };
    expect(dominantExternalObjectTone(summary)).toBeNull();
    expect(externalObjectDominantCount(summary)).toBe(0);
  });

  it("counts only the dominant-severity items in the rollup", () => {
    const summary = {
      total: 5,
      byStatusCategory: { failed: 3, succeeded: 2 },
      byLiveness: { fresh: 5 },
      highestSeverity: "danger" as const,
      staleCount: 0,
      authRequiredCount: 0,
      unreachableCount: 0,
      objects: [
        { id: "a", providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed" as const, statusTone: "danger" as const, liveness: "fresh" as const, isTerminal: false },
        { id: "b", providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed" as const, statusTone: "danger" as const, liveness: "fresh" as const, isTerminal: false },
        { id: "c", providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed" as const, statusTone: "danger" as const, liveness: "fresh" as const, isTerminal: false },
        { id: "d", providerKey: "github", objectType: "pull_request", displayTitle: null, statusCategory: "succeeded" as const, statusTone: "success" as const, liveness: "fresh" as const, isTerminal: true },
        { id: "e", providerKey: "github", objectType: "pull_request", displayTitle: null, statusCategory: "succeeded" as const, statusTone: "success" as const, liveness: "fresh" as const, isTerminal: true },
      ],
    };
    expect(dominantExternalObjectTone(summary)).toBe("danger");
    expect(externalObjectDominantCount(summary)).toBe(3);
  });
});

describe("formatDeliveredNetLoc", () => {
  it("derives net LOC when both additions and deletions are present numbers", () => {
    const figure = formatDeliveredNetLoc({ additions: 220, deletions: 1 });
    expect(figure).not.toBeNull();
    expect(figure!.additions).toBe(220);
    expect(figure!.deletions).toBe(1);
    expect(figure!.net).toBe(219);
    expect(figure!.label).toBe("+220/-1 net +219");
    expect(figure!.exceedsDoctrineSoftCap).toBe(false);
  });

  it("returns null when only additions is present", () => {
    expect(formatDeliveredNetLoc({ additions: 220 })).toBeNull();
  });

  it("returns null when only deletions is present", () => {
    expect(formatDeliveredNetLoc({ deletions: 1 })).toBeNull();
  });

  it("returns null when neither field is present", () => {
    expect(formatDeliveredNetLoc({})).toBeNull();
    expect(formatDeliveredNetLoc({ provider: "github" })).toBeNull();
  });

  it("returns null for missing or non-number measurements", () => {
    expect(formatDeliveredNetLoc(null)).toBeNull();
    expect(formatDeliveredNetLoc(undefined)).toBeNull();
    expect(formatDeliveredNetLoc({ additions: "220", deletions: 1 })).toBeNull();
    expect(formatDeliveredNetLoc({ additions: 220, deletions: "1" })).toBeNull();
    expect(formatDeliveredNetLoc({ additions: Number.NaN, deletions: 1 })).toBeNull();
  });

  it("renders a genuine zero-diff as net 0 instead of suppressing it", () => {
    const figure = formatDeliveredNetLoc({ additions: 0, deletions: 0 });
    expect(figure).not.toBeNull();
    expect(figure!.net).toBe(0);
    expect(figure!.label).toBe("+0/-0 net 0");
    expect(figure!.exceedsDoctrineSoftCap).toBe(false);
  });

  it("flags net over the doctrine soft cap for emphasis and names the doctrine", () => {
    const figure = formatDeliveredNetLoc({ additions: 813, deletions: 1 });
    expect(figure).not.toBeNull();
    expect(figure!.net).toBe(812);
    expect(figure!.exceedsDoctrineSoftCap).toBe(true);
    expect(figure!.label).toBe("+813/-1 net +812");
    expect(figure!.doctrineNote).toContain(String(DOCTRINE_NET_LOC_SOFT_CAP));
    expect(figure!.doctrineNote).toContain("812");
  });

  it("treats exactly the doctrine cap as not exceeding it", () => {
    const figure = formatDeliveredNetLoc({ additions: DOCTRINE_NET_LOC_SOFT_CAP + 1, deletions: 1 });
    expect(figure!.net).toBe(DOCTRINE_NET_LOC_SOFT_CAP);
    expect(figure!.exceedsDoctrineSoftCap).toBe(false);
  });

  it("computes a negative net for a pure-deletion PR", () => {
    const figure = formatDeliveredNetLoc({ additions: 5, deletions: 50 });
    expect(figure).not.toBeNull();
    expect(figure!.net).toBe(-45);
    expect(figure!.label).toBe("+5/-50 net -45");
    expect(figure!.exceedsDoctrineSoftCap).toBe(false);
  });
});
