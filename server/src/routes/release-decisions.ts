import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { enrollReleaseAssuranceSchema, releaseAssuranceDecisionSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, issueService } from "../services/index.js";
import {
  evaluateReleaseAssuranceHead,
  releaseAssuranceService,
  type ReleaseAssuranceDeps,
} from "../services/release-assurance.js";
import { assertBoardOrgAccess, getAccessibleResource, getActorInfo } from "./authz.js";

/**
 * Release-assurance control plane, SHADOW mode (SUP-20771). Board-only: the
 * ledger records HOLD / GO / NO-GO and reports the durable verdict, but nothing
 * here writes `release-assurance/approved` or admits a PR. The enrolling seat
 * and the signed-issuer check land with the live-provisioning steps.
 */
export function releaseDecisionRoutes(db: Db, deps?: ReleaseAssuranceDeps) {
  const router = Router();
  const issues = issueService(db);
  const access = accessService(db);
  const ledger = releaseAssuranceService(db, deps);

  async function boardIssue(req: Request, res: Parameters<typeof getAccessibleResource>[1], write: boolean) {
    assertBoardOrgAccess(req);
    const issue = await getAccessibleResource(req, res, issues.getById(req.params.id as string), "Issue not found");
    if (!issue || !write) return issue;
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      const membership = req.actor.userId ? await access.getMembership(issue.companyId, "user", req.actor.userId) : null;
      const role = membership?.status === "active" ? membership.membershipRole : null;
      if (role !== "owner" && role !== "admin") throw forbidden("Company owner or admin required for release assurance");
    }
    return issue;
  }

  router.get("/issues/:id/release-decisions", async (req, res) => {
    const issue = await boardIssue(req, res, false);
    if (!issue) return;
    const events = await ledger.listEvents(issue.companyId, issue.id);
    const hold = events.find((event) => event.kind === "hold") ?? null;
    const heads = [...new Set(events.flatMap((event) => (event.headSha ? [event.headSha] : [])))];
    res.json({
      publicationMode: "shadow",
      enrolled: hold !== null,
      binding: hold && { owner: hold.owner, repo: hold.repo, pullRequestNumber: hold.pullRequestNumber, raAgentId: hold.raAgentId },
      verdicts: Object.fromEntries(heads.map((head) => [head, evaluateReleaseAssuranceHead(events, head)])),
      events,
    });
  });

  router.post("/issues/:id/release-assurance/enroll", validate(enrollReleaseAssuranceSchema), async (req, res) => {
    const issue = await boardIssue(req, res, true);
    if (!issue) return;
    const result = await ledger.enroll({ companyId: issue.companyId, issueId: issue.id, actor: getActorInfo(req), body: req.body });
    res.status(result.replayed ? 200 : 201).json({ event: result.event, replayed: result.replayed });
  });

  router.post("/issues/:id/release-decisions", validate(releaseAssuranceDecisionSchema), async (req, res) => {
    const issue = await boardIssue(req, res, true);
    if (!issue) return;
    const result = await ledger.decide({ companyId: issue.companyId, issueId: issue.id, actor: getActorInfo(req), body: req.body });
    res.status(result.replayed ? 200 : 201).json({
      event: result.event, replayed: result.replayed, verdict: result.verdict, publication: result.publication,
    });
  });

  return router;
}
