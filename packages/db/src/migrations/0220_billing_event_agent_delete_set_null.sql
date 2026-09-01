-- SUP-14056: Agent deletion (DELETE /api/agents/:id) returned 500 for any agent
-- that had ever emitted a cost or finance event. agentService.remove() deletes
-- the agent's heartbeat_runs rows inside a transaction, but
-- cost_events.heartbeat_run_id and finance_events.heartbeat_run_id pointed at
-- heartbeat_runs with ON DELETE NO ACTION, and the final agents delete was
-- additionally blocked by the same tables' agent_id FKs (cost_events.agent_id
-- is NOT NULL). Retiring an agent must not silently delete billing history, so
-- both tables detach from agents/heartbeat_runs with ON DELETE SET NULL: the
-- rows survive with null agent/run references.

ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT "finance_events_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
