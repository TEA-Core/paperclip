import { z } from "zod";
import { ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES } from "../constants.js";

const activityEventResponseSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  actorType: z.enum(["agent", "user", "system", "plugin"]),
  actorId: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  agentId: z.string().nullable(),
  runId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
}).passthrough();

// This specialized variant documents the close-time loss without narrowing
// the historical or unrelated activity entries returned by the same feed.
export const futureMonitorClearedActivitySchema = activityEventResponseSchema.extend({
  action: z.literal("issue.monitor_cleared"),
  details: z.object({
    identifier: z.string().nullable(),
    previousNextCheckAt: z.string().datetime(),
    recoveryPolicy: z.enum(ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES).nullable(),
    reason: z.literal("cleared_by_close_future_check"),
    notes: z.string().nullable(),
  }),
});

export const issueActivityResponseSchema = z.array(z.union([
  futureMonitorClearedActivitySchema,
  activityEventResponseSchema,
]));
