import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";

// SUP-21902: synthetic delivery for e2e journeys whose agents close a card at
// Tier 2. The company GITHUB_TOKEN secret carries the value that
// fixtures/agent-chat-github.mjs answers deterministically, the project's
// primary workspace names the delivery repository, and each issue records one
// merged pull_request work product whose merge commit the Tier 2 probe head
// must equal.
const TIER2_RECORDED_MERGE_COMMIT = "7d3f9c1e0a25b864d7f2c9e6a18b40c3d5e72f19";
const TIER2_GITHUB_TOKEN_VALUE = "paperclip-e2e-signoff-fixture";
const TIER2_REPO_URL = "https://github.com/TEA-Core/paperclip";
const TIER2_DEFAULT_REF = "fold/tea-patches-v2026.722.0";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.url()}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

function tier2Workspace(cwd: string) {
  return {
    name: "Primary",
    sourceType: "git_repo",
    repoUrl: TIER2_REPO_URL,
    repoRef: TIER2_DEFAULT_REF,
    defaultRef: TIER2_DEFAULT_REF,
    cwd,
    isPrimary: true,
  };
}

export async function seedTier2Credential(request: APIRequestContext, companyId: string) {
  await json(
    await request.post(`/api/companies/${companyId}/secrets`, {
      data: { name: "GITHUB_TOKEN", value: TIER2_GITHUB_TOKEN_VALUE },
    }),
  );
}

export async function seedTier2Project(request: APIRequestContext, companyId: string, name: string, cwd: string) {
  await seedTier2Credential(request, companyId);
  return json(
    await request.post(`/api/companies/${companyId}/projects`, {
      data: { name, workspace: tier2Workspace(cwd) },
    }),
  );
}

export async function recordTier2MergedDelivery(request: APIRequestContext, issueId: string) {
  await json(
    await request.post(`/api/issues/${issueId}/work-products`, {
      data: {
        type: "pull_request",
        provider: "github",
        externalId: "TEA-Core/paperclip#404",
        title: "PR #404 TEA-Core/paperclip",
        url: "https://github.com/TEA-Core/paperclip/pull/404",
        status: "merged",
        isPrimary: true,
        metadata: {
          prNumber: 404,
          repository: "TEA-Core/paperclip",
          mergedAt: "2026-08-29T00:11:06Z",
          mergeCommitSha: TIER2_RECORDED_MERGE_COMMIT,
        },
      },
    }),
  );
}
