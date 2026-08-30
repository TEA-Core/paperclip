-- SUP-14085 / Redo 2 (SUP-14439): validation phase for the 30 NOT VALID FK
-- additions staged in 0222_agent_delete_fk_policies.sql. The migration
-- runner applies each migration file in its own transaction, so by the time
-- this file runs the phase-1 SHARE ROW EXCLUSIVE locks are released.
-- Statements are grouped into three phases (within each phase, in the same
-- per-constraint order as 0222's ADDs):
--   1. all 30 VALIDATE CONSTRAINT scans (SHARE UPDATE EXCLUSIVE: each scan
--      runs concurrently with reads/writes),
--   2. all 30 DROP CONSTRAINT (brief catalog-only lock),
--   3. all 30 RENAME CONSTRAINT to the canonical names (catalog-only, does
--      not wait on active writers).
-- Phase 1 must precede the DROPs: DROP CONSTRAINT takes ACCESS EXCLUSIVE and,
-- because the whole file is one transaction, a DROP taken early would be
-- held to COMMIT - read+write-blocking its table across every later
-- validation scan. Ordering all scans first keeps every scan under SHARE
-- UPDATE EXCLUSIVE, concurrent with fleet writes.
ALTER TABLE "issue_watchdogs" VALIDATE CONSTRAINT "issue_watchdogs_watchdog_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_bundles" VALIDATE CONSTRAINT "decision_bundles_origin_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_bundles" VALIDATE CONSTRAINT "decision_bundles_origin_run_id_heartbeat_runs_id_fk_new";--> statement-breakpoint
ALTER TABLE "decisions" VALIDATE CONSTRAINT "decisions_origin_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decisions" VALIDATE CONSTRAINT "decisions_origin_run_id_heartbeat_runs_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_archive_notification_outbox" VALIDATE CONSTRAINT "decision_archive_notification_outbox__new";--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" VALIDATE CONSTRAINT "company_skill_test_runs_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "approval_comments" VALIDATE CONSTRAINT "approval_comments_author_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "approvals" VALIDATE CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "assets" VALIDATE CONSTRAINT "assets_created_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "goals" VALIDATE CONSTRAINT "goals_owner_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "projects" VALIDATE CONSTRAINT "projects_lead_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "routines" VALIDATE CONSTRAINT "routines_assignee_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "join_requests" VALIDATE CONSTRAINT "join_requests_created_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" VALIDATE CONSTRAINT "issue_thread_interactions_created_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" VALIDATE CONSTRAINT "issue_thread_interactions_resolved_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_queues" VALIDATE CONSTRAINT "decision_queues_created_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_queue_items" VALIDATE CONSTRAINT "decision_queue_items_added_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_triage" VALIDATE CONSTRAINT "decision_triage_set_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_triage_events" VALIDATE CONSTRAINT "decision_triage_events_actor_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_retention" VALIDATE CONSTRAINT "decision_retention_archived_by_agent_id_agents_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_queues" VALIDATE CONSTRAINT "decision_queues_created_by_run_id_heartbeat_runs_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_queue_items" VALIDATE CONSTRAINT "decision_queue_items_added_by_run_id_heartbeat_runs_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_triage" VALIDATE CONSTRAINT "decision_triage_set_by_run_id_heartbeat_runs_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_triage_events" VALIDATE CONSTRAINT "decision_triage_events_actor_run_id_heartbeat_runs_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_retention" VALIDATE CONSTRAINT "decision_retention_archived_by_run_id_heartbeat_runs_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_queues" VALIDATE CONSTRAINT "decision_queues__new";--> statement-breakpoint
ALTER TABLE "decision_queue_items" VALIDATE CONSTRAINT "decision_queue_items__new";--> statement-breakpoint
ALTER TABLE "decision_triage" VALIDATE CONSTRAINT "decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk_new";--> statement-breakpoint
ALTER TABLE "decision_triage_events" VALIDATE CONSTRAINT "decision_triage_events_agent_api_key_id_agent_api_keys_id_fk_new";--> statement-breakpoint
ALTER TABLE "issue_watchdogs" DROP CONSTRAINT "issue_watchdogs_watchdog_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_bundles" DROP CONSTRAINT "decision_bundles_origin_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_bundles" DROP CONSTRAINT "decision_bundles_origin_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_origin_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_origin_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_archive_notification_outbox" DROP CONSTRAINT "decision_archive_notification_outbox_origin_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" DROP CONSTRAINT "company_skill_test_runs_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "approval_comments" DROP CONSTRAINT "approval_comments_author_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "assets_created_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "goals" DROP CONSTRAINT "goals_owner_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_lead_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_assignee_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "join_requests" DROP CONSTRAINT "join_requests_created_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" DROP CONSTRAINT "issue_thread_interactions_created_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" DROP CONSTRAINT "issue_thread_interactions_resolved_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queues" DROP CONSTRAINT "decision_queues_created_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queue_items" DROP CONSTRAINT "decision_queue_items_added_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage" DROP CONSTRAINT "decision_triage_set_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage_events" DROP CONSTRAINT "decision_triage_events_actor_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_retention" DROP CONSTRAINT "decision_retention_archived_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queues" DROP CONSTRAINT "decision_queues_created_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queue_items" DROP CONSTRAINT "decision_queue_items_added_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage" DROP CONSTRAINT "decision_triage_set_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage_events" DROP CONSTRAINT "decision_triage_events_actor_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_retention" DROP CONSTRAINT "decision_retention_archived_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queues" DROP CONSTRAINT "decision_queues_created_by_agent_api_key_id_agent_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queue_items" DROP CONSTRAINT "decision_queue_items_added_by_agent_api_key_id_agent_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage" DROP CONSTRAINT "decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage_events" DROP CONSTRAINT "decision_triage_events_agent_api_key_id_agent_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "issue_watchdogs" RENAME CONSTRAINT "issue_watchdogs_watchdog_agent_id_agents_id_fk_new" TO "issue_watchdogs_watchdog_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_bundles" RENAME CONSTRAINT "decision_bundles_origin_agent_id_agents_id_fk_new" TO "decision_bundles_origin_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_bundles" RENAME CONSTRAINT "decision_bundles_origin_run_id_heartbeat_runs_id_fk_new" TO "decision_bundles_origin_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decisions" RENAME CONSTRAINT "decisions_origin_agent_id_agents_id_fk_new" TO "decisions_origin_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decisions" RENAME CONSTRAINT "decisions_origin_run_id_heartbeat_runs_id_fk_new" TO "decisions_origin_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_archive_notification_outbox" RENAME CONSTRAINT "decision_archive_notification_outbox__new" TO "decision_archive_notification_outbox_origin_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" RENAME CONSTRAINT "company_skill_test_runs_agent_id_agents_id_fk_new" TO "company_skill_test_runs_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "approval_comments" RENAME CONSTRAINT "approval_comments_author_agent_id_agents_id_fk_new" TO "approval_comments_author_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "approvals" RENAME CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk_new" TO "approvals_requested_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "assets" RENAME CONSTRAINT "assets_created_by_agent_id_agents_id_fk_new" TO "assets_created_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "goals" RENAME CONSTRAINT "goals_owner_agent_id_agents_id_fk_new" TO "goals_owner_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "projects" RENAME CONSTRAINT "projects_lead_agent_id_agents_id_fk_new" TO "projects_lead_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "routines" RENAME CONSTRAINT "routines_assignee_agent_id_agents_id_fk_new" TO "routines_assignee_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "join_requests" RENAME CONSTRAINT "join_requests_created_agent_id_agents_id_fk_new" TO "join_requests_created_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" RENAME CONSTRAINT "issue_thread_interactions_created_by_agent_id_agents_id_fk_new" TO "issue_thread_interactions_created_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" RENAME CONSTRAINT "issue_thread_interactions_resolved_by_agent_id_agents_id_fk_new" TO "issue_thread_interactions_resolved_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queues" RENAME CONSTRAINT "decision_queues_created_by_agent_id_agents_id_fk_new" TO "decision_queues_created_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queue_items" RENAME CONSTRAINT "decision_queue_items_added_by_agent_id_agents_id_fk_new" TO "decision_queue_items_added_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage" RENAME CONSTRAINT "decision_triage_set_by_agent_id_agents_id_fk_new" TO "decision_triage_set_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage_events" RENAME CONSTRAINT "decision_triage_events_actor_agent_id_agents_id_fk_new" TO "decision_triage_events_actor_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_retention" RENAME CONSTRAINT "decision_retention_archived_by_agent_id_agents_id_fk_new" TO "decision_retention_archived_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queues" RENAME CONSTRAINT "decision_queues_created_by_run_id_heartbeat_runs_id_fk_new" TO "decision_queues_created_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queue_items" RENAME CONSTRAINT "decision_queue_items_added_by_run_id_heartbeat_runs_id_fk_new" TO "decision_queue_items_added_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage" RENAME CONSTRAINT "decision_triage_set_by_run_id_heartbeat_runs_id_fk_new" TO "decision_triage_set_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage_events" RENAME CONSTRAINT "decision_triage_events_actor_run_id_heartbeat_runs_id_fk_new" TO "decision_triage_events_actor_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_retention" RENAME CONSTRAINT "decision_retention_archived_by_run_id_heartbeat_runs_id_fk_new" TO "decision_retention_archived_by_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queues" RENAME CONSTRAINT "decision_queues__new" TO "decision_queues_created_by_agent_api_key_id_agent_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "decision_queue_items" RENAME CONSTRAINT "decision_queue_items__new" TO "decision_queue_items_added_by_agent_api_key_id_agent_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage" RENAME CONSTRAINT "decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk_new" TO "decision_triage_set_by_agent_api_key_id_agent_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "decision_triage_events" RENAME CONSTRAINT "decision_triage_events_agent_api_key_id_agent_api_keys_id_fk_new" TO "decision_triage_events_agent_api_key_id_agent_api_keys_id_fk";
