<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its seven references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 157
- Eval cases: 106 across 16 groups
- Total normative rows: 263
- Legacy MCP aliases folded into normative rows: 45

| Eval group | Cases |
| --- | ---: |
| hb | 5 |
| co | 6 |
| st | 8 |
| cm | 6 |
| se | 4 |
| su | 4 |
| bl | 5 |
| dp | 3 |
| ix | 9 |
| ap | 6 |
| ar | 4 |
| er | 9 |
| rf | 22 |
| mh | 4 |
| rs | 3 |
| wk | 8 |

## Regeneration

- `pnpm --dir packages/paperclip-runner generate:capability-inventory` imports the canonical baselines and rewrites every generated file.
- `pnpm --dir packages/paperclip-runner check:capability-inventory` validates counts, uniqueness, normative dispositions, one-to-one MCP folds, required fields, and generated-file drift without requiring the external eval repository.

## Skill / Reference Rows

| Capability | Primary disposition | Source anchor |
| --- | --- | --- |
| skill:skills/paperclip/SKILL.md:paperclip-skill:10 | optional_agent_tool | skills/paperclip/SKILL.md:10 |
| skill:skills/paperclip/SKILL.md:terminology:14 | optional_agent_tool | skills/paperclip/SKILL.md:14 |
| skill:skills/paperclip/SKILL.md:authentication:18 | control_plane_owned | skills/paperclip/SKILL.md:18 |
| skill:skills/paperclip/SKILL.md:conversation-tasks:30 | optional_agent_tool | skills/paperclip/SKILL.md:30 |
| skill:skills/paperclip/SKILL.md:server-verified-external-chat-turns:47 | control_plane_owned | skills/paperclip/SKILL.md:47 |
| skill:skills/paperclip/SKILL.md:the-heartbeat-procedure:87 | optional_agent_tool | skills/paperclip/SKILL.md:87 |
| skill:skills/paperclip/SKILL.md:generated-artifacts-and-work-products:197 | always_agent_tool | skills/paperclip/SKILL.md:197 |
| skill:skills/paperclip/SKILL.md:status-quick-guide:245 | control_plane_owned | skills/paperclip/SKILL.md:245 |
| skill:skills/paperclip/SKILL.md:monitors-and-watchers-say-only-what-you-actually-scheduled:255 | optional_agent_tool | skills/paperclip/SKILL.md:255 |
| skill:skills/paperclip/SKILL.md:delegating-review-tasks:268 | always_agent_tool | skills/paperclip/SKILL.md:268 |
| skill:skills/paperclip/SKILL.md:managing-a-user-s-inbox:279 | control_plane_owned | skills/paperclip/SKILL.md:279 |
| skill:skills/paperclip/SKILL.md:issue-dependencies-blockers:287 | control_plane_owned | skills/paperclip/SKILL.md:287 |
| skill:skills/paperclip/SKILL.md:requesting-board-approval:312 | optional_agent_tool | skills/paperclip/SKILL.md:312 |
| skill:skills/paperclip/SKILL.md:issue-thread-interactions:333 | optional_agent_tool | skills/paperclip/SKILL.md:333 |
| skill:skills/paperclip/SKILL.md:standalone-decisions:362 | optional_agent_tool | skills/paperclip/SKILL.md:362 |
| skill:skills/paperclip/SKILL.md:mcp-tool-approval-gates:466 | optional_agent_tool | skills/paperclip/SKILL.md:466 |
| skill:skills/paperclip/SKILL.md:niche-workflow-pointers:508 | optional_agent_tool | skills/paperclip/SKILL.md:508 |
| skill:skills/paperclip/SKILL.md:cases:518 | optional_agent_tool | skills/paperclip/SKILL.md:518 |
| skill:skills/paperclip/SKILL.md:company-skills-workflow:523 | optional_agent_tool | skills/paperclip/SKILL.md:523 |
| skill:skills/paperclip/SKILL.md:routines:534 | optional_agent_tool | skills/paperclip/SKILL.md:534 |
| skill:skills/paperclip/SKILL.md:issue-workspace-runtime-controls:545 | optional_agent_tool | skills/paperclip/SKILL.md:545 |
| skill:skills/paperclip/SKILL.md:proposing-credentials-safely:552 | optional_agent_tool | skills/paperclip/SKILL.md:552 |
| skill:skills/paperclip/SKILL.md:reading-granted-secrets:559 | optional_agent_tool | skills/paperclip/SKILL.md:559 |
| skill:skills/paperclip/SKILL.md:critical-rules:585 | optional_agent_tool | skills/paperclip/SKILL.md:585 |
| skill:skills/paperclip/SKILL.md:comment-style-required:606 | always_agent_tool | skills/paperclip/SKILL.md:606 |
| skill:skills/paperclip/SKILL.md:update:638 | optional_agent_tool | skills/paperclip/SKILL.md:638 |
| skill:skills/paperclip/SKILL.md:planning-required-when-planning-requested:648 | optional_agent_tool | skills/paperclip/SKILL.md:648 |
| skill:skills/paperclip/SKILL.md:key-endpoints-hot-routes:681 | optional_agent_tool | skills/paperclip/SKILL.md:681 |
| skill:skills/paperclip/SKILL.md:searching-issues:710 | optional_agent_tool | skills/paperclip/SKILL.md:710 |
| skill:skills/paperclip/SKILL.md:full-reference:720 | optional_agent_tool | skills/paperclip/SKILL.md:720 |
| skill:skills/paperclip/SKILL.md:conversational-confirmation-answers:724 | always_agent_tool | skills/paperclip/SKILL.md:724 |
| skill:skills/paperclip/references/artifacts.md:generated-artifacts-and-work-products:1 | always_agent_tool | skills/paperclip/references/artifacts.md:1 |
| skill:skills/paperclip/references/artifacts.md:workspace-only-file-references:15 | optional_agent_tool | skills/paperclip/references/artifacts.md:15 |
| skill:skills/paperclip/references/cases.md:cases:1 | optional_agent_tool | skills/paperclip/references/cases.md:1 |
| skill:skills/paperclip/references/cases.md:core-model:12 | optional_agent_tool | skills/paperclip/references/cases.md:12 |
| skill:skills/paperclip/references/cases.md:upsert-semantics:29 | optional_agent_tool | skills/paperclip/references/cases.md:29 |
| skill:skills/paperclip/references/cases.md:read-and-search:67 | optional_agent_tool | skills/paperclip/references/cases.md:67 |
| skill:skills/paperclip/references/cases.md:documents:90 | always_agent_tool | skills/paperclip/references/cases.md:90 |
| skill:skills/paperclip/references/cases.md:fields:118 | optional_agent_tool | skills/paperclip/references/cases.md:118 |
| skill:skills/paperclip/references/cases.md:issue-links:151 | optional_agent_tool | skills/paperclip/references/cases.md:151 |
| skill:skills/paperclip/references/cases.md:child-cases:176 | optional_agent_tool | skills/paperclip/references/cases.md:176 |
| skill:skills/paperclip/references/cases.md:attachments:195 | optional_agent_tool | skills/paperclip/references/cases.md:195 |
| skill:skills/paperclip/references/cases.md:lifecycle:208 | optional_agent_tool | skills/paperclip/references/cases.md:208 |
| skill:skills/paperclip/references/cases.md:worked-blog-post-example:222 | optional_agent_tool | skills/paperclip/references/cases.md:222 |
| skill:skills/paperclip/references/company-skills.md:company-skills-workflow:1 | optional_agent_tool | skills/paperclip/references/company-skills.md:1 |
| skill:skills/paperclip/references/company-skills.md:what-exists:5 | optional_agent_tool | skills/paperclip/references/company-skills.md:5 |
| skill:skills/paperclip/references/company-skills.md:permission-model:22 | optional_agent_tool | skills/paperclip/references/company-skills.md:22 |
| skill:skills/paperclip/references/company-skills.md:core-endpoints:29 | optional_agent_tool | skills/paperclip/references/company-skills.md:29 |
| skill:skills/paperclip/references/company-skills.md:install-a-skill-into-the-company:65 | optional_agent_tool | skills/paperclip/references/company-skills.md:65 |
| skill:skills/paperclip/references/company-skills.md:app-shipped-catalog:75 | optional_agent_tool | skills/paperclip/references/company-skills.md:75 |
| skill:skills/paperclip/references/company-skills.md:external-source-import:101 | optional_agent_tool | skills/paperclip/references/company-skills.md:101 |
| skill:skills/paperclip/references/company-skills.md:source-types-in-order-of-preference:105 | optional_agent_tool | skills/paperclip/references/company-skills.md:105 |
| skill:skills/paperclip/references/company-skills.md:example-skills-sh-import-preferred:116 | optional_agent_tool | skills/paperclip/references/company-skills.md:116 |
| skill:skills/paperclip/references/company-skills.md:example-github-import:138 | optional_agent_tool | skills/paperclip/references/company-skills.md:138 |
| skill:skills/paperclip/references/company-skills.md:inspect-what-was-installed:164 | optional_agent_tool | skills/paperclip/references/company-skills.md:164 |
| skill:skills/paperclip/references/company-skills.md:assign-skills-to-an-existing-agent:181 | optional_agent_tool | skills/paperclip/references/company-skills.md:181 |
| skill:skills/paperclip/references/company-skills.md:include-skills-during-hire-or-create:216 | optional_agent_tool | skills/paperclip/references/company-skills.md:216 |
| skill:skills/paperclip/references/company-skills.md:notes:256 | optional_agent_tool | skills/paperclip/references/company-skills.md:256 |
| skill:skills/paperclip/references/issue-workspaces.md:issue-workspace-runtime-controls:1 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:1 |
| skill:skills/paperclip/references/issue-workspaces.md:discover-the-workspace:5 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:5 |
| skill:skills/paperclip/references/issue-workspaces.md:control-services:23 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:23 |
| skill:skills/paperclip/references/issue-workspaces.md:start-all-configured-services-waits-for-configured-readiness-checks:28 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:28 |
| skill:skills/paperclip/references/issue-workspaces.md:restart-all-configured-services:36 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:36 |
| skill:skills/paperclip/references/issue-workspaces.md:stop-all-running-services:44 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:44 |
| skill:skills/paperclip/references/issue-workspaces.md:read-the-url:63 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:63 |
| skill:skills/paperclip/references/issue-workspaces.md:mcp-tools:72 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:72 |
| skill:skills/paperclip/references/routines.md:paperclip-routines:1 | optional_agent_tool | skills/paperclip/references/routines.md:1 |
| skill:skills/paperclip/references/routines.md:lifecycle:16 | optional_agent_tool | skills/paperclip/references/routines.md:16 |
| skill:skills/paperclip/references/routines.md:creating-a-routine:27 | optional_agent_tool | skills/paperclip/references/routines.md:27 |
| skill:skills/paperclip/references/routines.md:concurrency-policies:65 | optional_agent_tool | skills/paperclip/references/routines.md:65 |
| skill:skills/paperclip/references/routines.md:catch-up-policies:77 | optional_agent_tool | skills/paperclip/references/routines.md:77 |
| skill:skills/paperclip/references/routines.md:activity-gated-scheduled-runs:88 | optional_agent_tool | skills/paperclip/references/routines.md:88 |
| skill:skills/paperclip/references/routines.md:example-skip-quiet-nights:108 | optional_agent_tool | skills/paperclip/references/routines.md:108 |
| skill:skills/paperclip/references/routines.md:adding-triggers:127 | optional_agent_tool | skills/paperclip/references/routines.md:127 |
| skill:skills/paperclip/references/routines.md:schedule-cron:137 | optional_agent_tool | skills/paperclip/references/routines.md:137 |
| skill:skills/paperclip/references/routines.md:webhook:151 | optional_agent_tool | skills/paperclip/references/routines.md:151 |
| skill:skills/paperclip/references/routines.md:api-manual-only:168 | optional_agent_tool | skills/paperclip/references/routines.md:168 |
| skill:skills/paperclip/references/routines.md:updating-and-deleting-triggers:180 | optional_agent_tool | skills/paperclip/references/routines.md:180 |
| skill:skills/paperclip/references/routines.md:manual-run:197 | optional_agent_tool | skills/paperclip/references/routines.md:197 |
| skill:skills/paperclip/references/routines.md:updating-a-routine:213 | optional_agent_tool | skills/paperclip/references/routines.md:213 |
| skill:skills/paperclip/references/routines.md:reading-routines-and-runs:224 | optional_agent_tool | skills/paperclip/references/routines.md:224 |
| skill:skills/paperclip/references/workflows.md:paperclip-workflow-playbooks:1 | optional_agent_tool | skills/paperclip/references/workflows.md:1 |
| skill:skills/paperclip/references/workflows.md:project-setup-ceo-manager:7 | optional_agent_tool | skills/paperclip/references/workflows.md:7 |
| skill:skills/paperclip/references/workflows.md:openclaw-invite-ceo:21 | optional_agent_tool | skills/paperclip/references/workflows.md:21 |
| skill:skills/paperclip/references/workflows.md:setting-agent-instructions-path:49 | optional_agent_tool | skills/paperclip/references/workflows.md:49 |
| skill:skills/paperclip/references/workflows.md:company-import-export:78 | optional_agent_tool | skills/paperclip/references/workflows.md:78 |
| skill:skills/paperclip/references/workflows.md:self-test-playbook-app-level:105 | optional_agent_tool | skills/paperclip/references/workflows.md:105 |
| skill:skills/paperclip/references/api-reference.md:paperclip-api-reference:1 | optional_agent_tool | skills/paperclip/references/api-reference.md:1 |
| skill:skills/paperclip/references/api-reference.md:response-schemas:9 | optional_agent_tool | skills/paperclip/references/api-reference.md:9 |
| skill:skills/paperclip/references/api-reference.md:agent-record-get-api-agents-me-or-get-api-agents-agentid:11 | optional_agent_tool | skills/paperclip/references/api-reference.md:11 |
| skill:skills/paperclip/references/api-reference.md:company-portability:44 | optional_agent_tool | skills/paperclip/references/api-reference.md:44 |
| skill:skills/paperclip/references/api-reference.md:issue-with-ancestors-get-api-issues-issueid:121 | optional_agent_tool | skills/paperclip/references/api-reference.md:121 |
| skill:skills/paperclip/references/api-reference.md:issue-update-response-patch-api-issues-issueid:207 | optional_agent_tool | skills/paperclip/references/api-reference.md:207 |
| skill:skills/paperclip/references/api-reference.md:blocker-diagnostics-get-api-issues-issueid-diagnostics-blockers:249 | control_plane_owned | skills/paperclip/references/api-reference.md:249 |
| skill:skills/paperclip/references/api-reference.md:wake-diagnostics-get-api-issues-issueid-diagnostics-wakes:288 | control_plane_owned | skills/paperclip/references/api-reference.md:288 |
| skill:skills/paperclip/references/api-reference.md:subtree-diagnostics-get-api-issues-issueid-diagnostics-subtree:332 | optional_agent_tool | skills/paperclip/references/api-reference.md:332 |
| skill:skills/paperclip/references/api-reference.md:execution-policy-fields-on-an-issue:380 | optional_agent_tool | skills/paperclip/references/api-reference.md:380 |
| skill:skills/paperclip/references/api-reference.md:cross-agent-review-gates:432 | always_agent_tool | skills/paperclip/references/api-reference.md:432 |
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:465 | optional_agent_tool | skills/paperclip/references/api-reference.md:465 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:470 | control_plane_owned | skills/paperclip/references/api-reference.md:470 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox:474 | control_plane_owned | skills/paperclip/references/api-reference.md:474 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:481 | optional_agent_tool | skills/paperclip/references/api-reference.md:481 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:488 | optional_agent_tool | skills/paperclip/references/api-reference.md:488 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:490 | always_agent_tool | skills/paperclip/references/api-reference.md:490 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:494 | control_plane_owned | skills/paperclip/references/api-reference.md:494 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:501 | always_agent_tool | skills/paperclip/references/api-reference.md:501 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:506 | control_plane_owned | skills/paperclip/references/api-reference.md:506 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:511 | optional_agent_tool | skills/paperclip/references/api-reference.md:511 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:515 | control_plane_owned | skills/paperclip/references/api-reference.md:515 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:529 | always_agent_tool | skills/paperclip/references/api-reference.md:529 |
| skill:skills/paperclip/references/api-reference.md:worked-example-archive-a-resolved-inbox-item:534 | control_plane_owned | skills/paperclip/references/api-reference.md:534 |
| skill:skills/paperclip/references/api-reference.md:the-responsible-user-s-id-is-resolved-from-the-authenticated-agent-run:539 | optional_agent_tool | skills/paperclip/references/api-reference.md:539 |
| skill:skills/paperclip/references/api-reference.md:reverse-the-archive-if-it-was-premature-or-no-longer-desired:548 | optional_agent_tool | skills/paperclip/references/api-reference.md:548 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:558 | always_agent_tool | skills/paperclip/references/api-reference.md:558 |
| skill:skills/paperclip/references/api-reference.md:worked-example-manager-heartbeat:597 | optional_agent_tool | skills/paperclip/references/api-reference.md:597 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:600 | control_plane_owned | skills/paperclip/references/api-reference.md:600 |
| skill:skills/paperclip/references/api-reference.md:2-check-team-status:604 | optional_agent_tool | skills/paperclip/references/api-reference.md:604 |
| skill:skills/paperclip/references/api-reference.md:3-agent-42-is-blocked-read-comments:611 | control_plane_owned | skills/paperclip/references/api-reference.md:611 |
| skill:skills/paperclip/references/api-reference.md:4-unblock-reassign-and-comment:615 | control_plane_owned | skills/paperclip/references/api-reference.md:615 |
| skill:skills/paperclip/references/api-reference.md:5-check-own-assignments:619 | optional_agent_tool | skills/paperclip/references/api-reference.md:619 |
| skill:skills/paperclip/references/api-reference.md:6-create-subtasks-and-delegate:626 | optional_agent_tool | skills/paperclip/references/api-reference.md:626 |
| skill:skills/paperclip/references/api-reference.md:load-tests-depend-on-caching-layer-being-done-first-paperclip-will-auto-wake-agent-55-when-the-blocker-resolves:632 | control_plane_owned | skills/paperclip/references/api-reference.md:632 |
| skill:skills/paperclip/references/api-reference.md:7-dashboard-for-health-check:637 | optional_agent_tool | skills/paperclip/references/api-reference.md:637 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:643 | always_agent_tool | skills/paperclip/references/api-reference.md:643 |
| skill:skills/paperclip/references/api-reference.md:update:650 | optional_agent_tool | skills/paperclip/references/api-reference.md:650 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:672 | optional_agent_tool | skills/paperclip/references/api-reference.md:672 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:676 | optional_agent_tool | skills/paperclip/references/api-reference.md:676 |
| skill:skills/paperclip/references/api-reference.md:questions-and-dependencies:686 | always_agent_tool | skills/paperclip/references/api-reference.md:686 |
| skill:skills/paperclip/references/api-reference.md:company-context:698 | optional_agent_tool | skills/paperclip/references/api-reference.md:698 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:710 | optional_agent_tool | skills/paperclip/references/api-reference.md:710 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:730 | optional_agent_tool | skills/paperclip/references/api-reference.md:730 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:749 | optional_agent_tool | skills/paperclip/references/api-reference.md:749 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:782 | optional_agent_tool | skills/paperclip/references/api-reference.md:782 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:813 | optional_agent_tool | skills/paperclip/references/api-reference.md:813 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:830 | optional_agent_tool | skills/paperclip/references/api-reference.md:830 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:856 | optional_agent_tool | skills/paperclip/references/api-reference.md:856 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:860 | optional_agent_tool | skills/paperclip/references/api-reference.md:860 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:925 | optional_agent_tool | skills/paperclip/references/api-reference.md:925 |
| skill:skills/paperclip/references/api-reference.md:questions-and-waiting-for-human-input:934 | always_agent_tool | skills/paperclip/references/api-reference.md:934 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:1041 | always_agent_tool | skills/paperclip/references/api-reference.md:1041 |
| skill:skills/paperclip/references/api-reference.md:conversational-confirmation-answers:1099 | always_agent_tool | skills/paperclip/references/api-reference.md:1099 |
| skill:skills/paperclip/references/api-reference.md:checkbox-confirmations:1105 | always_agent_tool | skills/paperclip/references/api-reference.md:1105 |
| skill:skills/paperclip/references/api-reference.md:item-verdict-requests:1220 | optional_agent_tool | skills/paperclip/references/api-reference.md:1220 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:1330 | optional_agent_tool | skills/paperclip/references/api-reference.md:1330 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:1336 | always_agent_tool | skills/paperclip/references/api-reference.md:1336 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:1354 | always_agent_tool | skills/paperclip/references/api-reference.md:1354 |
| skill:skills/paperclip/references/api-reference.md:error-handling:1384 | control_plane_owned | skills/paperclip/references/api-reference.md:1384 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:1398 | optional_agent_tool | skills/paperclip/references/api-reference.md:1398 |
| skill:skills/paperclip/references/api-reference.md:agents:1400 | optional_agent_tool | skills/paperclip/references/api-reference.md:1400 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:1421 | optional_agent_tool | skills/paperclip/references/api-reference.md:1421 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:1464 | optional_agent_tool | skills/paperclip/references/api-reference.md:1464 |
| skill:skills/paperclip/references/api-reference.md:routines:1488 | optional_agent_tool | skills/paperclip/references/api-reference.md:1488 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:1504 | optional_agent_tool | skills/paperclip/references/api-reference.md:1504 |
| skill:skills/paperclip/references/api-reference.md:secrets:1526 | optional_agent_tool | skills/paperclip/references/api-reference.md:1526 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-proposals:1539 | optional_agent_tool | skills/paperclip/references/api-reference.md:1539 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-access:1639 | optional_agent_tool | skills/paperclip/references/api-reference.md:1639 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:1679 | optional_agent_tool | skills/paperclip/references/api-reference.md:1679 |

## Legacy MCP Alias Index

This is a compatibility/traceability index, not a tool catalog. “Inherited disposition” is shown only to make the normative target easy to audit.

| Legacy MCP name | Folded into normative row | Inherited disposition | Source anchor |
| --- | --- | --- | --- |
| paperclipMe | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:303 |
| paperclipInboxLite | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:309 |
| paperclipListAgents | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:315 |
| paperclipListSkills | eval:rf-cskill-audit-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:321 |
| paperclipGetAgent | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:327 |
| paperclipListIssues | eval:se-q-filters-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:336 |
| paperclipGetIssue | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:351 |
| paperclipGetHeartbeatContext | eval:hb-context-01 | control_plane_owned | packages/mcp-server/src/tools.ts:357 |
| paperclipListComments | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:366 |
| paperclipGetComment | eval:hb-wake-comment-01 | control_plane_owned | packages/mcp-server/src/tools.ts:379 |
| paperclipListIssueApprovals | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:386 |
| paperclipListDocuments | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:392 |
| paperclipGetDocument | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:398 |
| paperclipListDocumentRevisions | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:405 |
| paperclipListProjects | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:415 |
| paperclipGetProject | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:421 |
| paperclipGetIssueWorkspaceRuntime | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:430 |
| paperclipControlIssueWorkspaceServices | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:436 |
| paperclipWaitForIssueWorkspaceService | eval:rf-iws-target-restart-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:453 |
| paperclipListGoals | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:479 |
| paperclipGetGoal | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:485 |
| paperclipListApprovals | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:491 |
| paperclipCreateApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:500 |
| paperclipGetApproval | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:509 |
| paperclipGetApprovalIssues | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:515 |
| paperclipListApprovalComments | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:521 |
| paperclipCreateIssue | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:527 |
| paperclipUpdateIssue | eval:st-done-comment-01 | always_agent_tool | packages/mcp-server/src/tools.ts:534 |
| paperclipCheckoutIssue | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:541 |
| paperclipReleaseIssue | eval:er-release-01 | control_plane_owned | packages/mcp-server/src/tools.ts:553 |
| paperclipOpenWorkSession | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:559 |
| paperclipHeartbeatWorkSession | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:566 |
| paperclipCloseWorkSession | eval:er-release-01 | control_plane_owned | packages/mcp-server/src/tools.ts:573 |
| paperclipAddComment | eval:cm-multiline-01 | always_agent_tool | packages/mcp-server/src/tools.ts:587 |
| paperclipSuggestTasks | eval:ix-suggest-tasks-01 | always_agent_tool | packages/mcp-server/src/tools.ts:594 |
| paperclipAskUserQuestions | eval:ix-questions-01 | always_agent_tool | packages/mcp-server/src/tools.ts:606 |
| paperclipRequestConfirmation | eval:ix-confirmation-plan-01 | always_agent_tool | packages/mcp-server/src/tools.ts:618 |
| paperclipRequestCheckboxConfirmation | eval:ix-checkbox-01 | always_agent_tool | packages/mcp-server/src/tools.ts:630 |
| paperclipUpsertIssueDocument | eval:dp-plan-doc-01 | always_agent_tool | packages/mcp-server/src/tools.ts:642 |
| paperclipRestoreIssueDocumentRevision | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:653 |
| paperclipLinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:668 |
| paperclipUnlinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:677 |
| paperclipApprovalDecision | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:687 |
| paperclipAddApprovalComment | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:709 |
| paperclipApiRequest | eval:rf-api-404-report-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:718 |
