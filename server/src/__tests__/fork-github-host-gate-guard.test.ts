import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TEA-Core fork (fold 2c, decision D1): static call-site guard for the GitHub host-mode gate.
//
// Local and SSH runs are host mode unless PAPERCLIP_GITHUB_MANAGED_EXECUTION=on. That only
// holds while every run-bearing git credential provider is told the run's ENVIRONMENT driver,
// and while the tool-plane consumers stay on upstream semantics. A count change here means a
// site was added or removed: classify it as run-bearing (pass environmentDriver), tool-plane
// (upstream semantics) or non-run (no heartbeatRunId, host by default) per fold decision D1,
// then update the map. After a fold, recount on the base tree alone (self-count trap).

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function productionSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        sources.set(path.relative(serverSrc, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
      }
    }
  };
  walk(serverSrc);
  return sources;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function callCounts(sources: Map<string, string>, name: string): Record<string, number> {
  const call = new RegExp(`(?<![\\w.])${escapeRegExp(name)}\\(`, "g");
  const definition = new RegExp(`function ${escapeRegExp(name)}\\(`, "g");
  const counts: Record<string, number> = {};
  for (const [file, source] of sources) {
    const count = (source.match(call)?.length ?? 0) - (source.match(definition)?.length ?? 0);
    if (count > 0) counts[file] = count;
  }
  return counts;
}

function literalCounts(sources: Map<string, string>, literal: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [file, source] of sources) {
    const count = source.split(literal).length - 1;
    if (count > 0) counts[file] = count;
  }
  return counts;
}

/** Argument text of every `name(` call, sliced to its matching `)` with a paren-depth counter. */
function callArguments(source: string, name: string): string[] {
  const call = new RegExp(`(?<![\\w.])${escapeRegExp(name)}\\(`, "g");
  const args: string[] = [];
  for (const match of source.matchAll(call)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    args.push(source.slice(start, index - 1));
  }
  return args;
}

const CLASSIFY =
  "A count change requires classifying the site as run-bearing (pass environmentDriver), tool-plane (upstream semantics) or non-run, per fold decision D1.";

describe("fold decision D1 call-site guard", () => {
  const sources = productionSources();

  it("reads the real server source tree", () => {
    const files = [...sources.keys()];
    expect(files.filter((file) => file.startsWith("services/")).length).toBeGreaterThan(50);
    expect(files.filter((file) => file.startsWith("routes/")).length).toBeGreaterThan(10);
    expect(sources.has("services/heartbeat.ts")).toBe(true);
    expect(sources.has("services/git-credentials.ts")).toBe(true);
  });

  it("pins production call counts for the GitHub credential and identity surface", () => {
    const expected: Record<string, Record<string, number>> = {
      createGitRemoteAuthProvider: {
        "services/heartbeat.ts": 5,
        "services/execution-workspace-provisioning.ts": 1,
        "services/execution-workspaces.ts": 1,
        "routes/execution-workspaces.ts": 1,
      },
      resolveManagedGitHubIdentitySelection: {
        "services/heartbeat.ts": 1,
        "services/git-credentials.ts": 3,
        "services/tool-gateway.ts": 3,
        "services/connection-intents.ts": 1,
      },
      resolveManagedGitHubCredential: {
        "services/git-credentials.ts": 1,
        "services/github-operation-credentials.ts": 1,
      },
      resolveGitHubOperationCredentials: {
        "services/git-credentials.ts": 1,
        "routes/connection-intents.ts": 1,
      },
      filterResolvedGitHubConnectionsForRun: {
        "services/heartbeat.ts": 2,
        "services/native-runtime/runtime-context.ts": 1,
      },
      // D3: executeRun reaches the probe only through prepareGitExecutionEnvironmentWithHostFallback,
      // which receives the binding by reference (see git-context-probe-fallback.test.ts).
      prepareGitHubExecutionEnvironment: {},
      prepareGitHubOperationLaunchers: { "services/heartbeat.ts": 1 },
      forkForcesHostGitHub: {
        "services/git-credentials.ts": 1,
        "services/heartbeat.ts": 1,
      },
    };
    for (const [name, counts] of Object.entries(expected)) {
      expect(callCounts(sources, name), `${name}: ${CLASSIFY}`).toEqual(counts);
    }
    // The github_credentials runtime token is minted only inside executeRun's managed branch.
    expect(literalCounts(sources, 'scope: "github_credentials"'), CLASSIFY).toEqual({
      "services/heartbeat.ts": 1,
    });
  });

  it("threads the environment driver into every run-bearing git credential provider", () => {
    let runBearing = 0;
    for (const [file, source] of sources) {
      for (const args of callArguments(source, "createGitRemoteAuthProvider")) {
        if (!args.includes("heartbeatRunId")) continue;
        runBearing += 1;
        expect(args, `${file}: a run-bearing createGitRemoteAuthProvider call must pass environmentDriver (fold decision D1)`).toContain(
          "environmentDriver",
        );
      }
    }
    expect(runBearing).toBeGreaterThan(0);
  });

  it("wraps upstream's useHostGitHub with the environment-driver gate", () => {
    const heartbeat = sources.get("services/heartbeat.ts")!;
    const start = heartbeat.indexOf("const useHostGitHub =");
    expect(start).toBeGreaterThan(-1);
    expect(heartbeat.indexOf("const useHostGitHub =", start + 1)).toBe(-1);
    const expression = heartbeat.slice(start + "const useHostGitHub =".length, heartbeat.indexOf(";", start));
    expect(expression.trimStart().startsWith("forkHostGitHub ||")).toBe(true);
    const [gateArgs] = callArguments(heartbeat, "forkForcesHostGitHub");
    expect(gateArgs).toContain("selectedEnvironmentForConfig?.driver");
    expect(gateArgs).not.toMatch(/driverKind|driver_kind/);
  });

  it("gates the provider's run-identity branch on host mode, not on the env flag alone", () => {
    const gitCredentials = sources.get("services/git-credentials.ts")!;
    expect(gitCredentials).toContain("if (!hostGitHub && db && context?.heartbeatRunId && context.agentId)");
    expect(gitCredentials).not.toContain("managedExecutionEnabled(env) && db");
    // D1-b (operator accepted, amends I2): host mode skips the provider's managed-identity arm.
    expect(gitCredentials).toContain("managedPromise ??= db && !hostGitHub");
  });
});
