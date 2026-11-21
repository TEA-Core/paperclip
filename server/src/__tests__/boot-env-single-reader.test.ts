import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Structural gate (advisor 6.3.2): the boot ledger is the only loader. A new
// dotenv.config call, process.loadEnvFile, or hand-written .env line parser
// outside the allowlisted repair/writer modules reopens the door the ledger
// closed, so this test fails the moment one appears.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SCAN_ROOTS = [
  "server/src",
  "cli/src",
  "packages/db/src",
  "packages/shared/src",
  "scripts",
];

// The writer/oracle itself, the ledger, and the dev orchestrator's
// repair-side parser (its output never reaches the server child as operator
// env; scripts/dev-runner.ts spawns with operatorEnvForChild()).
const ALLOWED_HAND_PARSERS: Record<string, true> = {
  "packages/shared/src/env-file.ts": true,
  "packages/shared/src/boot-env.ts": true,
  "server/src/dev-runner-worktree.ts": true,
};

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      files.push(entryPath);
    }
  }
  return files;
}

function toRepoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

describe("single env reader (SUP-24365)", () => {
  it("keeps dotenv.config, process.loadEnvFile and hand env parsers out of non-ledger modules", () => {
    const offenders: string[] = [];

    for (const scanRoot of SCAN_ROOTS) {
      for (const filePath of listSourceFiles(path.join(REPO_ROOT, scanRoot))) {
        const relative = toRepoRelative(filePath);
        let contents: string;
        try {
          contents = fs.readFileSync(filePath, "utf8");
        } catch {
          continue;
        }

        if (
          relative !== "packages/shared/src/boot-env.ts" &&
          (/import\s*\{[^}]*\bconfig\b[^}]*\}\s*from\s*["']dotenv["']/.test(contents) ||
            /dotenv\.config\s*\(/.test(contents))
        ) {
          offenders.push(`${relative}: dotenv config import/call outside the boot ledger`);
        }
        if (/process\.loadEnvFile/.test(contents)) {
          offenders.push(`${relative}: process.loadEnvFile`);
        }
        if (
          !ALLOWED_HAND_PARSERS[relative] &&
          contents.includes("readFileSync") &&
          contents.includes("split(/\\r?\\n/") &&
          contents.includes("(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)")
        ) {
          offenders.push(`${relative}: hand .env line parser outside the allowlist`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
