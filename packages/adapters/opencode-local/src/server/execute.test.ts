import { afterEach, describe, expect, it } from "vitest";

import {
  buildOpenCodeRunArgs,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  resolveOpenCodeSessionResume,
} from "./execute.js";

describe("buildOpenCodeRunArgs", () => {
  // SUP-9238: OpenCode 1.18+ re-roots its session on PWD rather than the real
  // process cwd, so relying on the spawn cwd alone let a stale inherited PWD
  // move the whole session (and its write permissions) off the provisioned
  // execution workspace. Pin the run directory on the command line too.
  it("pins the execution directory with --dir", () => {
    expect(
      buildOpenCodeRunArgs({
        dir: "/workspaces/SUP-9238",
        model: "router/coder",
        variant: "",
        extraArgs: [],
        printLogs: false,
        resumeSessionId: null,
      }),
    ).toEqual(["run", "--format", "json", "--dir", "/workspaces/SUP-9238", "--model", "router/coder"]);
  });

  it("omits --dir when no execution directory is known", () => {
    expect(
      buildOpenCodeRunArgs({
        dir: "",
        model: "",
        variant: "",
        extraArgs: [],
        printLogs: false,
        resumeSessionId: null,
      }),
    ).toEqual(["run", "--format", "json"]);
  });

  it("keeps resume, variant and caller-supplied args alongside --dir", () => {
    expect(
      buildOpenCodeRunArgs({
        dir: "/workspaces/SUP-9238",
        model: "router/coder",
        variant: "high",
        extraArgs: ["--auto"],
        printLogs: true,
        resumeSessionId: "ses_123",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--print-logs",
      "--dir",
      "/workspaces/SUP-9238",
      "--session",
      "ses_123",
      "--model",
      "router/coder",
      "--variant",
      "high",
      "--auto",
    ]);
  });
});

// `opencode run --session <s> --dir <d>` where <d> is not the directory <s> was
// created in never terminates: opencode bootstraps <d>, then bootstraps the
// session's own recorded directory, exits its prompt loop, and then hangs with
// zero bytes on stdout. The process adapter waits on child exit, so the run row
// stays `running` forever. Never pair a resume with a directory we cannot prove
// the session belongs to.
describe("resolveOpenCodeSessionResume", () => {
  const base = {
    executionCwd: "/workspaces/wt-a",
    executionTargetMatches: true,
  };

  it("resumes when the session was saved for the same directory", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "/workspaces/wt-a" }),
    ).toEqual({ resume: true, sessionId: "ses_123" });
  });

  it("normalises the compared paths", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "/workspaces/wt-a/" }),
    ).toEqual({ resume: true, sessionId: "ses_123" });
  });

  it("refuses to resume into a different directory", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "/workspaces/wt-b" }),
    ).toEqual({ resume: false, sessionId: "ses_123", reason: "cwd_mismatch" });
  });

  // The regression: `agent_runtime_state.session_id` carries a session id with
  // no recorded cwd (state_json was `{}`), so an unknown cwd used to count as
  // "compatible" and resumed straight into the agent-home fallback workspace.
  it("refuses to resume a session whose directory is unknown", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "ses_123", sessionCwd: "" }),
    ).toEqual({ resume: false, sessionId: "ses_123", reason: "unknown_cwd" });
  });

  it("refuses to resume across a changed remote execution identity", () => {
    expect(
      resolveOpenCodeSessionResume({
        ...base,
        sessionId: "ses_123",
        sessionCwd: "/workspaces/wt-a",
        executionTargetMatches: false,
      }),
    ).toEqual({ resume: false, sessionId: "ses_123", reason: "execution_target_mismatch" });
  });

  it("reports no session when there is nothing to resume", () => {
    expect(
      resolveOpenCodeSessionResume({ ...base, sessionId: "", sessionCwd: "/workspaces/wt-a" }),
    ).toEqual({ resume: false, sessionId: null, reason: "no_session" });
  });

  it("drops --session from the argv when the session cannot be resumed", () => {
    const decision = resolveOpenCodeSessionResume({
      ...base,
      sessionId: "ses_123",
      sessionCwd: "",
    });
    expect(
      buildOpenCodeRunArgs({
        dir: base.executionCwd,
        model: "router/coder",
        variant: "",
        extraArgs: [],
        printLogs: false,
        resumeSessionId: decision.resume ? decision.sessionId : null,
      }),
    ).not.toContain("--session");
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});
