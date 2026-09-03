import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const HELPER = new URL("paperclip-github-credential-helper.sh", import.meta.url).pathname;
const WRAPPER = new URL("paperclip-gh-wrapper.sh", import.meta.url).pathname;

// A fake `curl` that records each requested `--data` body to $FAKE_CURL_CALLS (one JSON
// body per line) and prints a canned broker body chosen by FAKE_CURL_MODE. The
// `fail_then_ok` mode models the contents-only fallback: the FIRST mint fails (as if the
// App lacks `workflows`) and the SECOND succeeds, so the scripts can be exercised
// without a live broker.
function writeFakeCurl(binDir) {
  const p = path.join(binDir, "curl");
  writeFileSync(
    p,
    [
      "#!/usr/bin/env bash",
      'body=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--data" ]; then body="$a"; fi',
      '  prev="$a"',
      "done",
      'calls="${FAKE_CURL_CALLS:-}"',
      "n=0",
      'if [ -n "$calls" ]; then',
      '  if [ -f "$calls" ]; then',
      '    n="$(wc -l < "$calls" | tr -d " ")"',
      "  fi",
      "  printf '%s\\n' \"$body\" >> \"$calls\"",
      "fi",
      'case "${FAKE_CURL_MODE:-ok}" in',
      "  not_configured) printf '%s' '{\"error\":\"GitHub App is not configured for this company\",\"code\":\"app_not_configured\"}' ;;",
      "  mint_fail) printf '%s' '{\"error\":\"mint exploded\",\"code\":\"internal\"}' ;;",
      "  fail_then_ok)",
      '    if [ "$n" -eq 0 ]; then printf \'%s\' \'{\"error\":\"workflows not granted\",\"code\":\"internal\"}\'; else printf \'%s\' \'{\"token\":\"MINTED_123\",\"installationId\":42}\'; fi ;;',
      "  *) printf '%s' '{\"token\":\"MINTED_123\",\"installationId\":42}' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(p, 0o755);
}

function withRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-gh-helper-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeCurl(binDir);
  try {
    return fn(root, binDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runHelper(root, { action, input, curlMode, apiBase, access } = {}) {
  const env = {
    ...process.env,
    PAPERCLIP_API_URL: apiBase ?? "http://broker.invalid",
    PAPERCLIP_API_KEY: "run-key",
    PAPERCLIP_GIT_REPO: "paperclipai/paperclip",
    PAPERCLIP_GIT_ACCESS: access ?? "write",
    FAKE_CURL_MODE: curlMode ?? "ok",
    FAKE_CURL_CALLS: path.join(root, "curl-calls.log"),
    PATH: `${root}/bin:${process.env.PATH}`,
  };
  return spawnSync("bash", [HELPER, action ?? "get"], {
    input: input ?? "protocol=https\nhost=github.com\n",
    env,
    cwd: root,
    encoding: "utf8",
  });
}

// Read back the requested broker bodies (one JSON object per line) captured by the fake
// curl, so a test can assert exactly which permission set the helper requested.
function readCalls(root) {
  const f = path.join(root, "curl-calls.log");
  return readFileSync(f, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function runWrapper(root, { args = [], curlMode, tokenFile } = {}) {
  const env = {
    ...process.env,
    PAPERCLIP_API_URL: "http://broker.invalid",
    PAPERCLIP_API_KEY: "run-key",
    PAPERCLIP_GIT_REPO: "paperclipai/paperclip",
    PAPERCLIP_GH_REAL: path.join(root, "bin", "fake-gh"),
    FAKE_GH_TOKEN_FILE: tokenFile ?? path.join(root, "gh-token.out"),
    FAKE_CURL_MODE: curlMode ?? "ok",
    PATH: `${root}/bin:${process.env.PATH}`,
  };
  return spawnSync("bash", [WRAPPER, ...args], { env, cwd: root, encoding: "utf8" });
}

test("helper get mints a token and emits it over stdout only", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "ok" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /username=x-access-token/);
    assert.match(res.stdout, /password=MINTED_123/);
  });
});

test("helper get is a clean no-op when the broker reports app_not_configured", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "not_configured" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /not configured/);
  });
});

test("helper get hard-fails on a real mint failure (not the no-op path)", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "mint_fail" });
    assert.equal(res.status, 1);
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /GitHub token mint failed/);
    assert.match(res.stderr, /mint exploded/);
  });
});

test("AC1: on write access the mint body requests contents AND workflows", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "ok", access: "write" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /password=MINTED_123/);
    const calls = readCalls(root);
    assert.equal(calls.length, 1, "write access mints exactly once on a clean mint");
    assert.ok(calls[0].includes('"contents":"write"'), `body must request contents:write, got: ${calls[0]}`);
    assert.ok(calls[0].includes('"workflows":"write"'), `body must request workflows:write, got: ${calls[0]}`);
  });
});

test("AC2: on read access the mint body keeps the tighter contents-only set (no workflows)", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "ok", access: "read" });
    assert.equal(res.status, 0, res.stderr);
    const calls = readCalls(root);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('"contents":"read"'), `body must request contents:read, got: ${calls[0]}`);
    assert.ok(!calls[0].includes("workflows"), `read access must not request workflows, got: ${calls[0]}`);
  });
});

test("AC2: on none access the mint body keeps the tighter contents-only set (no workflows)", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "ok", access: "none" });
    assert.equal(res.status, 0, res.stderr);
    const calls = readCalls(root);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('"contents":"none"'), `body must request contents:none, got: ${calls[0]}`);
    assert.ok(!calls[0].includes("workflows"), `none access must not request workflows, got: ${calls[0]}`);
  });
});

test("AC3: a workflows-mint failure retries exactly once with the contents-only body", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "fail_then_ok", access: "write" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /password=MINTED_123/);
    const calls = readCalls(root);
    assert.equal(calls.length, 2, "exactly one retry on the workflows-mint failure");
    assert.ok(calls[0].includes('"workflows":"write"'), `first attempt must request workflows, got: ${calls[0]}`);
    assert.ok(calls[1].includes('"contents":"write"'), `retry must still request contents:write, got: ${calls[1]}`);
    assert.ok(!calls[1].includes("workflows"), `retry must be contents-only, got: ${calls[1]}`);
    // AC4: the first (failed) response body must not leak onto stdout.
    assert.ok(!res.stdout.includes("workflows not granted"), "retry must not log the first response body to stdout");
  });
});

test("AC3: if the contents-only fallback also fails, the helper exits with the legible error (no further retry)", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "mint_fail", access: "write" });
    assert.equal(res.status, 1);
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /GitHub token mint failed/);
    assert.match(res.stderr, /mint exploded/);
    const calls = readCalls(root);
    assert.equal(calls.length, 2, "must not retry more than once");
  });
});

test("AC3: app_not_configured stays a clean no-op and does not trigger the fallback retry", () => {
  withRoot((root) => {
    const res = runHelper(root, { action: "get", curlMode: "not_configured", access: "write" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /not configured/);
    const calls = readCalls(root);
    assert.equal(calls.length, 1, "app_not_configured must not retry");
  });
});

test("helper store/erase/approve/reject drain stdin and succeed without minting", () => {
  withRoot((root) => {
    for (const action of ["store", "erase", "approve", "reject"]) {
      const res = runHelper(root, {
        action,
        input: "protocol=https\nhost=github.com\nusername=x\npassword=secret\n",
      });
      assert.equal(res.status, 0, `${action}: ${res.stderr}`);
      assert.equal(res.stdout, "");
    }
  });
});

test("helper refuses non-github.com hosts", () => {
  withRoot((root) => {
    const res = runHelper(root, {
      action: "get",
      input: "protocol=https\nhost=evil.example.com\n",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /github\.com only/);
  });
});

test("helper refuses non-https protocols (dual-gate)", () => {
  withRoot((root) => {
    const res = runHelper(root, {
      action: "get",
      input: "protocol=http\nhost=github.com\n",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /only over https/);
  });
});

test("helper fails legibly when the broker is unreachable", () => {
  withRoot((root) => {
    // Use the real curl (no fake on PATH) pointed at a closed local port.
    const env = {
      ...process.env,
      PAPERCLIP_API_URL: "http://127.0.0.1:1",
      PAPERCLIP_API_KEY: "run-key",
      PAPERCLIP_GIT_REPO: "paperclipai/paperclip",
    };
    const res = spawnSync("bash", [HELPER, "get"], {
      input: "protocol=https\nhost=github.com\n",
      env,
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /could not reach the Paperclip broker/);
  });
});

test("gh wrapper execs the real gh with GH_TOKEN set for the minted token", () => {
  withRoot((root, binDir) => {
    const gh = path.join(binDir, "fake-gh");
    writeFileSync(
      gh,
      ["#!/usr/bin/env bash", "printf '%s\\n' \"$GH_TOKEN\" > \"$FAKE_GH_TOKEN_FILE\"", "exit 0", ""].join(
        "\n",
      ),
    );
    chmodSync(gh, 0o755);
    const tokenFile = path.join(root, "gh-token.out");
    const res = runWrapper(root, { args: ["repo", "view"], curlMode: "ok", tokenFile });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(tokenFile, "utf8").trim(), "MINTED_123");
  });
});

test("gh wrapper fails legibly when the broker reports app_not_configured", () => {
  withRoot((root) => {
    const res = runWrapper(root, { args: ["repo", "view"], curlMode: "not_configured" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /app_not_configured|not configured/);
  });
});

test("neither script falls back to a predictable /tmp curl-err path", () => {
  const helperSrc = readFileSync(HELPER, "utf8");
  const wrapperSrc = readFileSync(WRAPPER, "utf8");
  assert.ok(
    !helperSrc.includes('echo "/tmp/.gh-helper-curl.err'),
    "helper must not use a predictable /tmp fallback",
  );
  assert.ok(
    !wrapperSrc.includes('echo "/tmp/.gh-wrapper-curl.err'),
    "wrapper must not use a predictable /tmp fallback",
  );
  assert.ok(
    helperSrc.includes('[ -n "$CURL_ERR" ] || fail'),
    "helper must fail safely when mktemp is unavailable",
  );
  assert.ok(
    wrapperSrc.includes('[ -n "$CURL_ERR" ] || fail'),
    "wrapper must fail safely when mktemp is unavailable",
  );
});

test("sed fallback extraction pulls error/code from the broker JSON", () => {
  // Mirrors the sed branch of both scripts (covers the no-jq path).
  const run = (body, sedExpr) =>
    spawnSync("bash", ["-c", `printf '%s' '${body}' | sed -n '${sedExpr}' | head -n1`], {
      encoding: "utf8",
    }).stdout.trim();

  const body = '{"error":"GitHub App is not configured for this company","code":"app_not_configured"}';
  assert.equal(
    run(body, 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'),
    "",
    "no token in an error body",
  );
  assert.equal(run(body, 's/.*"error"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'), "GitHub App is not configured for this company");
  assert.equal(run(body, 's/.*"code"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'), "app_not_configured");

  const okBody = '{"token":"TOK","error":"boom","code":"c1"}';
  assert.equal(run(okBody, 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'), "TOK");
});
