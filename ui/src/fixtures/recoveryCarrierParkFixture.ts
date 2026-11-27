import type { RecoveryCarrierParkCandidate } from "@paperclipai/shared";

export const recoveryCarrierParkFixture: RecoveryCarrierParkCandidate = {
  sourceIssueId: "11111111-1111-4111-8111-111111111111",
  recoveryActionId: "22222222-2222-4222-8222-222222222222",
  expectedStatus: "blocked",
  expectedStatusVersion: 4,
  expectedAssigneeAgentId: null,
  expectedAssigneeUserId: "board-operator",
  expectedActionUpdatedAt: "2026-11-01T00:00:00.000Z",
  expectedBlockers: [{ id: "33333333-3333-4333-8333-333333333333", status: "done", statusVersion: 2 }],
  decisions: [{ id: "44444444-4444-4444-8444-444444444444", summary: "Further repair rejected by the board", updatedAt: "2026-11-01T01:00:00.000Z" }],
};
