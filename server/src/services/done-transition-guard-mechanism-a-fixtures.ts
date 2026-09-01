/**
 * SUP-14561 (mechanism A) fixtures — the historical no-ladder closes, captured live from
 * paperclip.dvit.io on 2026-08-31. Each parent carries its recorded executionPolicy (null,
 * or `stages: []` for SUP-13777) and its children with the real identifiers, stage ids, and
 * fired-ladder state. Child execution states are trimmed to the schema-relevant fields;
 * `parseIssueExecutionState` accepts them.
 */
export type MechanismAChildFixture = {
  identifier: string;
  executionPolicy: Record<string, unknown> | null;
  executionState: Record<string, unknown> | null;
};

export type MechanismAParentFixture = {
  identifier: string;
  closedAt: string;
  expected: "refused" | "allowed";
  executionPolicy: Record<string, unknown> | null;
  executionState: Record<string, unknown> | null;
  children: MechanismAChildFixture[];
};

export const mechanismACorpus: MechanismAParentFixture[] = [
  // SUP-13777 — closed 2026-08-26T23:42:30.857Z
  { identifier: "SUP-13777", closedAt: "2026-08-26T23:42:30.857Z", expected: "refused",
    executionPolicy: {"mode": "normal", "stages": [], "commentRequired": true},
    executionState: {"status": "idle", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null},
    children: [
      { identifier: "SUP-13779", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "dc148072-f2ab-4f67-b64d-30ee53f1f582", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["dc148072-f2ab-4f67-b64d-30ee53f1f582"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-13883", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "72ac830a-f7db-4050-ada8-9222e3fdf864", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["72ac830a-f7db-4050-ada8-9222e3fdf864"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-13972", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "d86a30a3-25f0-4aa4-932b-20eef1a2dbcb", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["d86a30a3-25f0-4aa4-932b-20eef1a2dbcb"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-14023 — closed 2026-08-26T15:25:39.041Z
  { identifier: "SUP-14023", closedAt: "2026-08-26T15:25:39.041Z", expected: "refused",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-14028", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "04e7fb1b-b961-4f30-9d8d-40b22e445a7f", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["04e7fb1b-b961-4f30-9d8d-40b22e445a7f"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14030", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "7e93bae5-c410-4042-b790-20039a3aa412", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["7e93bae5-c410-4042-b790-20039a3aa412"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14031", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "37b83f8f-8ac6-4702-a0a6-89775805dc52", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["37b83f8f-8ac6-4702-a0a6-89775805dc52"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-14306 — closed 2026-08-29T20:21:59.924Z
  { identifier: "SUP-14306", closedAt: "2026-08-29T20:21:59.924Z", expected: "refused",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-14307", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "a5896703-9a14-4ec9-928d-e76b2bcc38f8", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["a5896703-9a14-4ec9-928d-e76b2bcc38f8"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14308", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "f280901e-00e0-40f7-95df-38d7ea456b2a", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["f280901e-00e0-40f7-95df-38d7ea456b2a"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14309", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14310", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "1c497c13-9f60-4f05-a46b-57eafde08bef", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["1c497c13-9f60-4f05-a46b-57eafde08bef"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14311", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "43400396-b2b5-4c82-bfed-aca69192799f", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["65ee7259-9955-4131-b924-09fd5f462962", "43400396-b2b5-4c82-bfed-aca69192799f"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14312", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "54b8cc59-185a-4744-8309-f59ffc50fb8b", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["54b8cc59-185a-4744-8309-f59ffc50fb8b"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-14309 — closed 2026-08-29T01:16:07.084Z
  { identifier: "SUP-14309", closedAt: "2026-08-29T01:16:07.084Z", expected: "refused",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-14313", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "4e8a65d6-75a7-4178-9fc0-f1972d96a8d8", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["4e8a65d6-75a7-4178-9fc0-f1972d96a8d8"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14314", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "17e6fcab-eb01-4e4e-bd88-3fe2f32c44be", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["17e6fcab-eb01-4e4e-bd88-3fe2f32c44be"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14315", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "4df2dbdf-3a11-40fb-89bb-b8d302db8076", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["4df2dbdf-3a11-40fb-89bb-b8d302db8076"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14327", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "1a80d5e7-fc0f-4c43-a1c5-97b6819172c8", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["1a80d5e7-fc0f-4c43-a1c5-97b6819172c8"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14328", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "1b9e9021-525d-40bb-b134-f1c470cf50d7", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["1b9e9021-525d-40bb-b134-f1c470cf50d7"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14340", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "43d79161-1eaf-49fd-9e33-5a7d1e07ab8b", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["43d79161-1eaf-49fd-9e33-5a7d1e07ab8b"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-12043 — closed 2026-08-30T10:10:59.573Z
  { identifier: "SUP-12043", closedAt: "2026-08-30T10:10:59.573Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-12065", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-14486", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-12548 — closed 2026-08-28T05:05:52.837Z
  { identifier: "SUP-12548", closedAt: "2026-08-28T05:05:52.837Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-12652", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-12697", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-12699", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-12700", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-13745 — closed 2026-08-24T11:20:21.588Z
  { identifier: "SUP-13745", closedAt: "2026-08-24T11:20:21.588Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-13755", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
      { identifier: "SUP-13838", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-13791 — closed 2026-08-24T19:39:26.545Z
  { identifier: "SUP-13791", closedAt: "2026-08-24T19:39:26.545Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-13810", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-13797 — closed 2026-08-24T03:39:55.112Z
  { identifier: "SUP-13797", closedAt: "2026-08-24T03:39:55.112Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-13802", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-13837 — closed 2026-08-24T07:29:58.463Z
  { identifier: "SUP-13837", closedAt: "2026-08-24T07:29:58.463Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-13840", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-13958 — closed 2026-08-25T19:32:24.762Z
  { identifier: "SUP-13958", closedAt: "2026-08-25T19:32:24.762Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-13965", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-14009 — closed 2026-08-26T14:44:00.534Z
  { identifier: "SUP-14009", closedAt: "2026-08-26T14:44:00.534Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-14013", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "45089731-fe00-46aa-942d-6d7282307d69", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["45089731-fe00-46aa-942d-6d7282307d69"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-14025 — closed 2026-08-26T15:37:52.654Z
  { identifier: "SUP-14025", closedAt: "2026-08-26T15:37:52.654Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-14034", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-14040 — closed 2026-08-26T16:15:27.971Z
  { identifier: "SUP-14040", closedAt: "2026-08-26T16:15:27.971Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-14041", executionPolicy: null, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": [], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
  // SUP-14525 — closed 2026-08-30T15:12:15.364Z
  { identifier: "SUP-14525", closedAt: "2026-08-30T15:12:15.364Z", expected: "allowed",
    executionPolicy: null,
    executionState: null,
    children: [
      { identifier: "SUP-14527", executionPolicy: {"mode": "normal", "commentRequired": true, "stages": [{"id": "c57df2ee-438b-46c7-81de-08d7ebcd223d", "type": "review"}]}, executionState: {"status": "completed", "currentStageId": null, "currentStageIndex": null, "currentStageType": null, "currentParticipant": null, "returnAssignee": null, "completedStageIds": ["c57df2ee-438b-46c7-81de-08d7ebcd223d"], "skippedStageIds": [], "lastDecisionId": null, "lastDecisionOutcome": null} },
    ]
  },
];
