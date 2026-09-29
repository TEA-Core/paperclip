/**
 * Regression guard: every board-authenticable `logActivity`/`persistActivity`
 * call site in `server/src/routes/` must pass `boardApiKeyId` in the same call.
 *
 * This is a source-pinning check — it reads the route source as text and
 * verifies the pattern is present. Omitting the property produces no type
 * error and no runtime error, just a NULL column, so only a source scan can
 * catch it.
 *
 * Allowlisted sites (actorType "system" or "agent") cannot have a board key
 * as their actor, so boardApiKeyId is correctly null/absent.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(__dirname, "..", "routes");

/**
 * Sites that are NOT board-key-authenticable:
 * - actorType is "system" (background/system actions)
 * - actorType is "agent" (agent-originated writes)
 *
 * Each entry is keyed by file + action string (not line number) so that
 * other PRs shifting lines do not break the allowlist.
 */
const ALLOWLIST: Array<{ file: string; action: string; reason: string }> = [
  // agent actor: board key can never be an agent
  { file: "secrets.ts", action: "secret.access.listed", reason: "agent actor" },
  // system actor: background/system action
  { file: "access.ts", action: "agent_api_key.claimed", reason: "system actor" },
];

function isAllowlisted(file: string, action: string): boolean {
  return ALLOWLIST.some((entry) => entry.file === file && entry.action === action);
}

/**
 * For a given source file, find all logActivity/persistActivity calls and
 * check whether they pass boardApiKeyId.
 *
 * Strategy: scan for `logActivity(db, {` or `persistActivity(db, {` patterns.
 * Then look at the next 30 lines for:
 *   - a potentially-user actorType (literal "user", a variable expression,
 *     or a spread that resolves to user)
 *   - boardApiKeyId as a top-level property (not nested inside details)
 *
 * If the actor is potentially user and boardApiKeyId is absent, it's a
 * violation unless allowlisted.
 */
function findViolations(content: string, fileName: string): Array<{ line: number; action: string }> {
  const lines = content.split("\n");
  const violations: Array<{ line: number; action: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const callMatch = line.match(/\b(logActivity|persistActivity)\s*\(/);
    if (!callMatch) continue;

    // Skip import lines and type-only references
    if (line.trim().startsWith("import") || line.trim().startsWith("type ")) continue;

    // Look at the next 20 lines for the call block
    const block = lines.slice(i, Math.min(i + 25, lines.length)).join("\n");

    // Detect potentially-user actor types:
    //  - literal "user"
    //  - variable expressions (actor.actorType, req.actor.type, etc.)
    //    that are NOT literal "agent" or "system"
    //  - spread patterns that may resolve to user
    const hasUserActor = /actorType\s*:\s*["']user["']/.test(block);
    const hasVariableActorType =
      /actorType\s*:\s*(?!["'])/.test(block) &&
      !/actorType\s*:\s*["'](?:agent|system)["']/.test(block);
    const hasSpreadUserActor = /\.\.\.\w+Log\b/.test(block) || /activityActorForPipelineRoute/.test(block);

    if (!hasUserActor && !hasVariableActorType && !hasSpreadUserActor) continue;

    // Check for boardApiKeyId at the top level of the call arguments,
    // i.e. before the `details:` key. A boardApiKeyId nested inside
    // `details: { ... }` does not satisfy the requirement.
    const detailsIdx = block.search(/\bdetails\s*:/);
    const topLevel = detailsIdx >= 0 ? block.slice(0, detailsIdx) : block;
    let hasBoardApiKeyId = /boardApiKeyId\s*:/.test(topLevel);

    // Handle spread variables: if the call spreads a local variable (e.g. ...baseLog),
    // check whether that variable's definition (within 40 lines above the call) includes boardApiKeyId.
    if (!hasBoardApiKeyId) {
      const spreadMatch = block.match(/\.\.\.(\w+)/);
      if (spreadMatch) {
        const varName = spreadMatch[1];
        // Search up to 60 lines above for the variable definition
        const above = lines.slice(Math.max(0, i - 60), i).join("\n");
        const defRegex = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`);
        if (defRegex.test(above)) {
          hasBoardApiKeyId = /boardApiKeyId\s*:/.test(above);
        }
      }
    }

    if (!hasBoardApiKeyId) {
      const actionMatch = block.match(/action\s*:\s*["']([^"']+)["']/);
      const action = actionMatch?.[1] ?? "(unknown)";
      if (!isAllowlisted(fileName, action)) {
        violations.push({ line: i + 1, action });
      }
    }
  }

  return violations;
}

describe("board-api-key activity log guard", () => {
  it("all board-authenticable logActivity/persistActivity calls in routes/ pass boardApiKeyId", () => {
    const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const allViolations: Array<{ file: string; line: number; action: string }> = [];

    for (const file of files) {
      const filePath = join(ROUTES_DIR, file);
      const content = readFileSync(filePath, "utf-8");
      const violations = findViolations(content, file);
      for (const v of violations) {
        allViolations.push({ file, ...v });
      }
    }

    if (allViolations.length > 0) {
      const summary = allViolations
        .map((v) => `  ${v.file}:${v.line} — ${v.action}`)
        .join("\n");
      throw new Error(
        `boardApiKeyId missing from ${allViolations.length} board-authenticable logActivity call site(s):\n${summary}\n\n` +
        `Add "boardApiKeyId: getActorInfo(req).boardApiKeyId" to each call, or add the site to the ALLOWLIST if the actor cannot be a board key.`,
      );
    }

    expect(allViolations).toHaveLength(0);
  });

  it("allowlist entries reference valid files and actions", () => {
    for (const entry of ALLOWLIST) {
      const filePath = join(ROUTES_DIR, entry.file);
      const content = readFileSync(filePath, "utf-8");
      // The allowlisted file must contain a logActivity call with the specified action
      const actionPattern = new RegExp(`action\\s*:\\s*["']${entry.action}["']`);
      expect(
        actionPattern.test(content),
        `Allowlist entry ${entry.file} (${entry.action}): action string not found in file`,
      ).toBe(true);
    }
  });
});
