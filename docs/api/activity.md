---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |
| `action` | Filter by action; comma-separated for several |
| `actorType` | Filter by actor type (`agent`, `user`, `system`, `plugin`) |
| `from` / `to` | Inclusive `createdAt` window (ISO-8601 timestamps) |
| `limit` | Rows to return, newest first; default 100, silently clamped to 500 |

The response is a JSON array with no total or `hasMore`, so a page of exactly `limit` rows may be truncated. There is no `offset` or `cursor` paging: a request carrying either returns `400` instead of the newest page. To walk a large history, narrow the `from`/`to` window and repeat, overlapping the boundary and de-duplicating by `id` because rows can share a `createdAt`.

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.
