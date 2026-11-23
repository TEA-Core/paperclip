import { useId, useState } from "react";
import { parkRecoveryCarrierSchema, type ParkRecoveryCarrier, type RecoveryCarrierParkCandidate } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function RecoveryCarrierParkForm({ candidate, onPark, pending = false, error }: {
  candidate: RecoveryCarrierParkCandidate;
  onPark: (input: ParkRecoveryCarrier) => void;
  pending?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const [decisionId, setDecisionId] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const decision = candidate.decisions.find(row => row.id === decisionId);
  const { decisions: _decisions, ...snapshot } = candidate;
  const parsed = parkRecoveryCarrierSchema.safeParse({ ...snapshot, decisionInteractionId: decisionId,
    expectedDecisionUpdatedAt: decision?.updatedAt, reason });
  const liveBlocker = candidate.expectedBlockers.find(row => row.status !== "done" && row.status !== "cancelled");
  return (
    <section className="flex flex-col gap-3" aria-label="Board recovery carrier disposition">
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>Park recovery carrier</Button>
      {open ? (
        <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (parsed.success) onPark(parsed.data); }}>
          <p className="text-sm text-muted-foreground">Keep the source recovery escalated and intentionally unresolved. Board release removes the carrier hold and the automatic-recovery gate on this action; release itself does not repair or re-arm the source action. Parking does not approve delivery or repair.</p>
          <p className="text-xs font-mono text-muted-foreground">Source: {candidate.sourceIssueId} · Recovery action: {candidate.recoveryActionId}</p>
          <Label htmlFor={`${id}-decision`}>Historical board decision</Label>
          <select id={`${id}-decision`} className="rounded-md border border-input bg-background p-2 text-base" value={decisionId} onChange={event => setDecisionId(event.target.value)} disabled={pending} required>
            <option value="">Choose the rejected confirmation</option>
            {candidate.decisions.map(row => <option key={row.id} value={row.id}>{row.summary || row.id}</option>)}
          </select>
          <Label htmlFor={`${id}-reason`}>Reason for accepting unresolved recovery</Label>
          <Textarea id={`${id}-reason`} value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} disabled={pending} required />
          {liveBlocker ? <p role="alert" className="text-sm text-destructive">Parking requires terminal blockers. Blocker {liveBlocker.id} is {liveBlocker.status}.</p> : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal" disabled={pending || !parsed.success}>{pending ? "Parking…" : "Accept unresolved recovery and park"}</Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
