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
 * Each entry: { file: string, line: number, reason: string }
 * The line number is the line containing the `logActivity(` or `persistActivity(` call.
 */
const ALLOWLIST: Array<{ file: string; line: number; reason: string }> = [
  // agent actor: board key can never be an agent
  { file: "secrets.ts", line: 318, reason: "agent actor (secret.access.listed)" },
  // system actor: background/system action
  { file: "access.ts", line: 4469, reason: "system actor (agent_api_key.claimed)" },
];

function isAllowlisted(file: string, line: number): boolean {
  return ALLOWLIST.some((entry) => entry.file === file && entry.line === line);
}

/**
 * For a given source file, find all logActivity/persistActivity calls and
 * check whether they pass boardApiKeyId.
 *
 * Strategy: scan for `logActivity(db, {` or `persistActivity(db, {` patterns.
 * Then look at the next 30 lines for:
 *   - actorType: "user" (board-authenticable)
 *   - boardApiKeyId: (the required property)
 *
 * If actorType is "user" and boardApiKeyId is absent, it's a violation
 * unless allowlisted.
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

    // Check if this call uses actorType: "user" (board-authenticable)
    // Either literally in the block or via a spread that resolves to user
    const hasUserActor = /actorType\s*:\s*["']user["']/.test(block);
    // Also check for spread patterns like ...baseLog where baseLog has actorType: "user"
    const hasSpreadUserActor = /\.\.\.\w+Log\b/.test(block) || /activityActorForPipelineRoute/.test(block);

    if (!hasUserActor && !hasSpreadUserActor) continue;

    // Check for boardApiKeyId in the block (top-level, before details)
    // It can be:
    // - boardApiKeyId: getActorInfo(req).boardApiKeyId,
    // - boardApiKeyId: actor.type === "user" ? ... : null,
    // - boardApiKeyId: actor.boardApiKeyId,
    let hasBoardApiKeyId = /boardApiKeyId\s*:/.test(block);

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

    if (!hasBoardApiKeyId && !isAllowlisted(fileName, i + 1)) {
      const actionMatch = block.match(/action\s*:\s*["']([^"']+)["']/);
      violations.push({ line: i + 1, action: actionMatch?.[1] ?? "(unknown)" });
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

  it("allowlist entries reference valid files and lines", () => {
    for (const entry of ALLOWLIST) {
      const filePath = join(ROUTES_DIR, entry.file);
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const targetLine = lines[entry.line - 1] ?? "";
      // The allowlisted line should actually contain a logActivity or persistActivity call
      expect(targetLine, `Allowlist entry ${entry.file}:${entry.line} does not point at a logActivity/persistActivity call. Actual: "${targetLine.trim()}"`).toMatch(
        /\b(logActivity|persistActivity)\s*\(/,
      );
    }
  });
});
