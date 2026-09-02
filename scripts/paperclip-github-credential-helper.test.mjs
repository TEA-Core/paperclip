import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const HELPER = new URL("paperclip-github-credential-helper.sh", import.meta.url).pathname;
const WRAPPER = new URL("paperclip-gh-wrapper.sh", import.meta.url).pathname;

// A fake `curl` that ignores its arguments and prints a canned broker body chosen by
// FAKE_CURL_MODE, so the scripts can be exercised without a live broker.
function writeFakeCurl(binDir) {
  const p = path.join(binDir, "curl");
  writeFileSync(
    p,
    [
      "#!/usr/bin/env bash",
      "case \"${FAKE_CURL_MODE:-ok}\" in",
      "  not_configured) printf '%s' '{\"error\":\"GitHub App is not configured for this company\",\"code\":\"app_not_configured\"}' ;;",
      "  mint_fail) printf '%s' '{\"error\":\"mint exploded\",\"code\":\"internal\"}' ;;",
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

function runHelper(root, { action, input, curlMode, apiBase } = {}) {
  const env = {
    ...process.env,
    PAPERCLIP_API_URL: apiBase ?? "http://broker.invalid",
    PAPERCLIP_API_KEY: "run-key",
    PAPERCLIP_GIT_REPO: "paperclipai/paperclip",
    FAKE_CURL_MODE: curlMode ?? "ok",
    PATH: `${root}/bin:${process.env.PATH}`,
  };
  return spawnSync("bash", [HELPER, action ?? "get"], {
    input: input ?? "protocol=https\nhost=github.com\n",
    env,
    cwd: root,
    encoding: "utf8",
  });
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
