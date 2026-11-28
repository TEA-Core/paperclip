import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { createLiveEventIssueVisibility } from "../realtime/live-event-issue-visibility.js";
import type { AuthorizationActor } from "../services/authorization.js";

const decide = vi.hoisted(() => vi.fn());
const runIssueId = vi.hoisted(() => vi.fn());

vi.mock("../services/authorization.js", () => ({ authorizationService: () => ({ decide }) }));
vi.mock("../services/run-issue-lookup.js", () => ({ createRunIssueLookup: () => runIssueId }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ISSUE_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const CONTENT = "Issue content a failed lookup must not release";

const issueRow = {
  id: ISSUE_ID,
  companyId: COMPANY_ID,
  projectId: null,
  parentId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  status: "todo",
  createdByAgentId: null,
};

const actor: AuthorizationActor = { type: "board", userId: "user-1", companyIds: [COMPANY_ID], source: "session" };

let issueRows: () => Promise<unknown[]>;
const db = { select: () => ({ from: () => ({ where: () => issueRows() }) }) } as unknown as Db;

function allow() {
  return Promise.resolve({ allowed: true });
}

function issueCreated(): LiveEvent {
  return {
    id: 1,
    companyId: COMPANY_ID,
    type: "activity.logged",
    createdAt: new Date().toISOString(),
    payload: {
      action: "issue.created",
      entityType: "issue",
      entityId: ISSUE_ID,
      details: {
        identifier: "PAP-1",
        title: "Issue title",
        description: CONTENT,
        addedReferencedIssues: [{ id: OTHER_ISSUE_ID, identifier: "PAP-2", title: CONTENT }],
      },
    },
  };
}

function runProgress(issueId: string | null): LiveEvent {
  return {
    id: 2,
    companyId: COMPANY_ID,
    type: "heartbeat.run.progress",
    createdAt: new Date().toISOString(),
    payload: { runId: RUN_ID, issueId, phase: "working", message: CONTENT },
  };
}

function goalChanged(): LiveEvent {
  return {
    id: 3,
    companyId: COMPANY_ID,
    type: "agent.session.goal.changed",
    createdAt: new Date().toISOString(),
    payload: { issueId: ISSUE_ID, revision: 1, goal: { objective: CONTENT, status: "active" } },
  };
}

describe("live event issue visibility when an access lookup fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueRows = () => Promise.resolve([issueRow]);
    decide.mockImplementation(allow);
    runIssueId.mockImplementation((_companyId: string, payload: Record<string, unknown>) =>
      Promise.resolve(payload.issueId ?? null),
    );
  });

  it("sends only metadata when the subscriber's read decision throws", async () => {
    decide.mockRejectedValue(new Error("authorization store unavailable"));
    const visible = createLiveEventIssueVisibility(db)(actor);

    const activity = await visible(issueCreated());
    const run = await visible(runProgress(ISSUE_ID));
    const goal = await visible(goalChanged());

    expect(JSON.stringify([activity, run, goal])).not.toContain(CONTENT);
    expect(activity.payload.details).toEqual({
      identifier: "PAP-1",
      title: "Issue title",
      addedReferencedIssues: [{ id: OTHER_ISSUE_ID, identifier: "PAP-2" }],
    });
    expect(run.payload).toEqual({ runId: RUN_ID, issueId: ISSUE_ID, phase: "working" });
    expect(goal.payload).toEqual({ issueId: ISSUE_ID, revision: 1, goal: { status: "active" } });
  });

  it("sends only metadata when the issue lookup fails", async () => {
    issueRows = () => Promise.reject(new Error("database unavailable"));
    const visible = createLiveEventIssueVisibility(db)(actor);

    const activity = await visible(issueCreated());
    const run = await visible(runProgress(ISSUE_ID));

    expect(JSON.stringify([activity, run])).not.toContain(CONTENT);
    expect(activity.payload).toMatchObject({ action: "issue.created", entityId: ISSUE_ID, details: null });
    expect(run.payload).toEqual({ runId: RUN_ID, issueId: ISSUE_ID, phase: "working" });
  });

  it("does not treat a run whose issue lookup fails as a run without an issue", async () => {
    // Company-wide read is granted, so a run without an issue would go out in full.
    runIssueId.mockRejectedValue(new Error("database unavailable"));
    const visible = createLiveEventIssueVisibility(db)(actor);

    const run = await visible(runProgress(null));

    expect(run.payload).toEqual({ runId: RUN_ID, issueId: null, phase: "working" });
  });

  it("decides again after a failed read decision", async () => {
    decide.mockRejectedValueOnce(new Error("authorization store unavailable"));
    const visible = createLiveEventIssueVisibility(db)(actor);

    const failed = await visible(runProgress(ISSUE_ID));
    const next = await visible(runProgress(ISSUE_ID));

    expect(failed.payload).not.toHaveProperty("message");
    expect(next.payload).toMatchObject({ message: CONTENT });
  });
});
