import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOW_MARKER,
  BENIGN_SECRET_NAMES,
  ENTROPY_FLOOR,
  MAX_REPORTED_NEW_DEPENDENCIES,
  MIN_SECRET_LENGTH,
  analyzeDiff,
  formatAnnotation,
  formatSummary,
  characterClassCount,
  isPeriodic,
  isShellBearingWorkflowLine,
  looksGenerated,
  looksStructured,
  parseLockfilePackageName,
  parseUnifiedDiff,
  parseWaiver,
  readDiff,
  redact,
  runCheck,
  shannonEntropy,
} from "./check-pr-security.mjs";

/** Build a `git diff --unified=0` payload for a single file's added lines. */
function diffAdding(filePath, lines, startLine = 10) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${startLine},0 +${startLine},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function diffRemoving(filePath, lines, startLine = 10) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${startLine},${lines.length} +${startLine},0 @@`,
    ...lines.map((line) => `-${line}`),
    "",
  ].join("\n");
}

const rulesOf = (findings) => findings.map((finding) => finding.rule);

// ── Diff parsing ─────────────────────────────────────────────────────────────

test("parseUnifiedDiff assigns line numbers from the hunk header", () => {
  const files = parseUnifiedDiff(diffAdding("server/src/app.ts", ["const a = 1;", "const b = 2;"], 42));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "server/src/app.ts");
  assert.deepEqual(
    files[0].added.map((entry) => entry.line),
    [42, 43],
  );
});

test("parseUnifiedDiff tracks removed lines on the old-file counter", () => {
  const files = parseUnifiedDiff(diffRemoving("server/src/app.ts", ["const a = 1;"], 7));
  assert.deepEqual(files[0].removed, [{ line: 7, text: "const a = 1;" }]);
  assert.deepEqual(files[0].added, []);
});

test("parseUnifiedDiff separates multiple files and multiple hunks", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,0 +1,1 @@",
    "+first",
    "@@ -20,0 +30,1 @@",
    "+second",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -5,0 +5,1 @@",
    "+third",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((file) => file.path), ["a.ts", "b.ts"]);
  assert.deepEqual(files[0].added.map((entry) => entry.line), [1, 30]);
  assert.deepEqual(files[1].added.map((entry) => entry.line), [5]);
});

test("parseUnifiedDiff marks a deleted file and analyzeDiff skips it", () => {
  const diff = [
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    '-const apiKey = "AKIAIOSFODNN7EXAMPLE";',
  ].join("\n");
  assert.equal(parseUnifiedDiff(diff)[0].deleted, true);
  assert.deepEqual(analyzeDiff(diff).blocking, []);
});

test("parseUnifiedDiff ignores the no-newline marker", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,0 +1,2 @@",
    "+one",
    "\\ No newline at end of file",
    "+two",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff)[0].added.map((entry) => entry.line), [1, 2]);
});

// ── Regressions from the deleted upstream gate ───────────────────────────────
//
// Upstream's gate fired on most ordinary PRs, which is why nobody read its
// output. Each test below pins one of those false-positive classes as *not* a
// finding. Deleting any of these assertions reintroduces the failure mode.

test("touching a hot route file is not a finding on its own", () => {
  // Upstream `SENSITIVE_PATHS`: any change under server/src/routes/agents.ts,
  // companies.ts, approvals.ts, authz.ts or ui/src/components/MarkdownBody.tsx
  // produced a `critical` flag and a draft advisory.
  for (const filePath of [
    "server/src/routes/agents.ts",
    "server/src/routes/companies.ts",
    "server/src/routes/approvals.ts",
    "server/src/routes/authz.ts",
    "server/src/services/workspace-realization.ts",
    "ui/src/components/MarkdownBody.tsx",
    "packages/adapters/codex-local/src/server/execute.ts",
    "scripts/build-bundled-plugins.mjs",
  ]) {
    const result = analyzeDiff(
      diffAdding(filePath, ["  const rows = await listIssues(companyId);"]),
    );
    assert.deepEqual(result.blocking, [], `${filePath} must not block`);
    assert.deepEqual(result.warnings, [], `${filePath} must not warn`);
  }
});

test("a test file using fetch/exec/process.env is not a finding", () => {
  // Upstream `scanTestPatterns` flagged every one of these as `high`.
  const result = analyzeDiff(
    diffAdding("server/src/__tests__/issues-service.test.ts", [
      "  const response = await fetch(`${baseUrl}/api/issues`);",
      "  execSync('pnpm build', { cwd: repoRoot });",
      "  process.env.PAPERCLIP_HOME = tmpDir;",
      "  const contents = readFileSync('/etc/paperclip/config.json', 'utf8');",
    ]),
  );
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.warnings, []);
});

test("an ordinary workflow edit is not a finding", () => {
  // Upstream `scanCITampering` flagged any non-removal change under
  // .github/workflows/ as `high`.
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", [
      "      - name: Run grouped general test suites",
      "        run: pnpm test:run:general -- --group general-server",
      "        timeout-minutes: 20",
    ]),
  );
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.warnings, []);
});

test("pluginKey: \"paperclipai.plugin-llm-wiki\" is not a secret", () => {
  // The exact literal upstream's `key: "<20+ chars>"` regex flagged.
  const result = analyzeDiff(
    diffAdding("packages/plugins/llm-wiki/src/manifest.ts", [
      '  pluginKey: "paperclipai.plugin-llm-wiki",',
    ]),
  );
  assert.deepEqual(result.blocking, []);
  assert.ok(BENIGN_SECRET_NAMES.has("pluginkey"));
});

test("long structured identifiers assigned to key-ish names are not secrets", () => {
  const benign = [
    '  const cacheKey = "issues:company:by-updated-at:page-2";',
    '  const storageKey = "paperclip.instance.default.settings";',
    '  const idempotencyKey = "issue-create-attempt-00000001";',
    '  SESSION_TOKEN_COOKIE_NAME: "paperclip-session-token-v2",',
    '  const secretRefPath = "server/src/services/secret-refs.ts";',
    '  const apiKey = process.env.PAPERCLIP_API_KEY ?? "";',
    '  const apiToken = `${prefix}-${suffix}-${nonce}`;',
    '  const password = "correct-horse-battery-staple";',
    '  const authToken = "<your-token-here>";',
    '  const requestId = "6f1c2b9e-4f0a-4a35-9d2e-1b7c8a0f3e11";',
  ];
  for (const line of benign) {
    const result = analyzeDiff(diffAdding("server/src/services/x.ts", [line]));
    assert.deepEqual(result.blocking, [], `must not block: ${line}`);
  }
});

// ── secret-literal ───────────────────────────────────────────────────────────

test("secret-literal blocks provider-shaped credentials", () => {
  // Every vendor prefix is concatenated at runtime rather than written as one
  // literal. GitHub's own push protection rejected this file when the Slack
  // case was a contiguous string — it read the fixture as a live token, which
  // is the same call this gate makes. Splitting keeps the assembled value out
  // of the committed bytes while the assertions still see the full token.
  const cases = [
    ['GH_TOKEN = "' + "ghp_" + "A".repeat(36) + '"', "GitHub personal access token"],
    ['ANTHROPIC = "' + "sk-ant-" + "api03-" + "b".repeat(40) + '"', "Anthropic API key"],
    ['OPENAI = "' + "sk-" + "c".repeat(48) + '"', "OpenAI API key"],
    ['GOOGLE = "' + "AIza" + "D".repeat(35) + '"', "Google API key"],
    ['AWS = "' + "AKIA" + "IOSFODNN7ABCDEFG" + '"', "AWS access key id"],
    ['SLACK = "' + "xoxb-" + "2847193056-4917283640-" + "Qk7vRm2XbTpLwZa4NcEjH3s" + '"', "Slack token"],
    ['GITLAB = "' + "glpat-" + "e".repeat(20) + '"', "GitLab personal access token"],
    ['NPM = "' + "npm_" + "f".repeat(36) + '"', "npm access token"],
    ['DB = "' + "postgres://paperclip:" + "s3cr3tpassword" + "@db.internal:5432/app" + '"',
      "Connection string"],
  ];
  for (const [line, label] of cases) {
    const result = analyzeDiff(diffAdding("server/src/config.ts", [line]));
    assert.equal(result.blocking.length, 1, `expected a block for ${label}: ${line}`);
    assert.equal(result.blocking[0].rule, "secret-literal");
  }
});

test("secret-literal blocks a PEM block that carries key material", () => {
  const result = analyzeDiff(
    diffAdding("server/src/keys.ts", [
      // paperclip:allow-security secret-literal: synthetic fixture for this gate's own tests
      '  "-----BEGIN OPENSSH PRIVATE KEY-----",',
      '  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",',
    ]),
  );
  assert.deepEqual(rulesOf(result.blocking), ["secret-literal"]);
  assert.equal(result.blocking[0].line, 10, "anchored to the header, not the body");
});

test("secret-literal ignores a bare PEM header with no key material", () => {
  // Every PEM mention in this repo is a marker, not a key: the redaction regex
  // in google-sheets-mcp-server/src/tools.ts, the exe-dev sandbox plugin's
  // error message, and the isSensitiveEnv assertions.
  for (const [filePath, line] of [
    ["packages/google-sheets-mcp-server/src/tools.ts",
     '  return output.replace(/-----BEGIN PRIVATE KEY-----[\\s\\S]*?-----END PRIVATE KEY-----/g, "[REDACTED]");'],
    ["packages/plugins/sandbox-providers/exe-dev/src/plugin.ts",
     "    return \"sshPrivateKey must be PEM-encoded, starting '-----BEGIN OPENSSH PRIVATE KEY-----'.\";"],
    ["ui/src/components/environment-variables-editor/sensitive.test.ts",
     '    expect(isSensitiveEnv("CONFIG", "-----BEGIN RSA PRIVATE KEY-----")).toBe(true);'],
  ]) {
    assert.deepEqual(analyzeDiff(diffAdding(filePath, [line])).blocking, [], filePath);
  }
});

test("secret-literal ignores a loopback dev connection string", () => {
  // `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip` appears in the
  // embedded-postgres helpers and their tests. Loopback host, and the password
  // is the username again — two independent fixture tells.
  for (const line of [
    '  const dbUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;',
    '  const dbUrl = "postgres://paperclip:paperclip@localhost:5432/paperclip";',
    '  const dbUrl = "postgres://appuser:appuser@db:5432/app";',
  ]) {
    assert.deepEqual(analyzeDiff(diffAdding("packages/db/src/x.ts", [line])).blocking, [], line);
  }
});

test("secret-literal ignores a templated connection string in docs", () => {
  const result = analyzeDiff(
    diffAdding("doc/DATABASE.md", [
      "DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres",
      "DATABASE_URL=postgres://appuser:${DB_PASSWORD}@db.example.com:5432/app",
    ]),
  );
  assert.deepEqual(result.blocking, []);
});

test("secret-literal still blocks a real remote connection string", () => {
  const result = analyzeDiff(
    diffAdding("server/src/config.ts", [
      // paperclip:allow-security secret-literal: synthetic fixture for this gate's own tests
      '  const url = "postgres://appuser:Xk8vN2mQzR4t@prod-db.example.com:5432/app";',
    ]),
  );
  assert.deepEqual(rulesOf(result.blocking), ["secret-literal"]);
});

test("secret-literal ignores the repo's TESTONLY synthetic-token convention", () => {
  // server/src/__tests__/log-redaction-secrets.test.ts must contain
  // provider-shaped strings — that is what it tests.
  const result = analyzeDiff(
    diffAdding("server/src/__tests__/log-redaction-secrets.test.ts", [
      '      "glpat-TESTONLYaaaabbbbcccc01",',
      '      "AKIATESTONLYAAAABBBB",',
    ]),
  );
  assert.deepEqual(result.blocking, []);
});

test("secret-literal does not echo the credential back into the log", () => {
  const secret = "ghp_" + "A".repeat(36);
  const result = analyzeDiff(diffAdding("server/src/config.ts", [`const t = "${secret}";`]));
  const annotation = formatAnnotation(result.blocking[0]);
  assert.doesNotMatch(annotation, new RegExp(secret));
  assert.match(annotation, /40 chars/);
});

test("redact keeps short values recognisable without printing them", () => {
  assert.equal(redact("short"), "shor…");
  assert.match(redact("A".repeat(40)), /^AAAAAAAA….{2} \(40 chars\)$/);
});

test("secret-literal ignores documented placeholders", () => {
  for (const line of [
    'AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"',
    '# e.g. ANTHROPIC_API_KEY=sk-ant-api03-your-key-goes-here-0000000000',
    'GITHUB_TOKEN="ghp_' + "x".repeat(36) + '" # placeholder',
  ]) {
    assert.deepEqual(analyzeDiff(diffAdding(".env.example", [line])).blocking, []);
  }
});

test("secret-literal placeholder guard reads the credential, not the comment", () => {
  const real = "ghp_" + "Qk7vRm2XbTpLwZa4NcEjH3sYd8FuGi5oPzAt";
  // A sequential body is a documentation stand-in ...
  assert.deepEqual(
    analyzeDiff(diffAdding("doc/CI.md", ['TOKEN="xoxb-1234567890-1234567890"'])).blocking,
    [],
  );
  // ... but a comment claiming the line is an example does not excuse a real one.
  assert.deepEqual(
    rulesOf(analyzeDiff(diffAdding("doc/CI.md", [`TOKEN="${real}" # just an example`])).blocking),
    ["secret-literal"],
  );
});

test("secret-literal skips generated lockfiles and snapshots", () => {
  const line = 'resolution: {integrity: sha512-AKIAIOSFODNN7ABCDEF' + "z".repeat(40) + '==}';
  assert.deepEqual(analyzeDiff(diffAdding("ui/src/__snapshots__/x.snap", [line])).blocking, []);
});

// ── secret-entropy ───────────────────────────────────────────────────────────

test("secret-entropy blocks a generated-looking literal on a secret-ish name", () => {
  const random = "kJ8xQ2mZ7vB4nR6tY1wE3pL5sD9gH0aF";
  const result = analyzeDiff(diffAdding("server/src/config.ts", [`const apiSecret = "${random}";`]));
  assert.deepEqual(rulesOf(result.blocking), ["secret-entropy"]);
  assert.match(result.blocking[0].title, /apiSecret/);
});

test("secret-entropy blocks a long pure-hex key despite its single character class", () => {
  // paperclip:allow-security secret-entropy: synthetic fixture for this gate's own tests
  const hexKey = "9f3a1c7e02b58d46af91e35c8072bd14";
  assert.equal(characterClassCount(hexKey), 2, "hex is lower+digit only");
  assert.deepEqual(
    rulesOf(analyzeDiff(diffAdding("server/src/config.ts", [`const masterKey = "${hexKey}";`])).blocking),
    ["secret-entropy"],
  );
});

test("secret-entropy ignores a repeated keyboard-walk block", () => {
  // Both of these are live fixtures in server/src/secrets/. Their symbol
  // frequencies are perfectly uniform, so no entropy threshold can reject them
  // — only periodicity can.
  for (const value of ["0123456789abcdef".repeat(4), "fedcba9876543210".repeat(2)]) {
    assert.ok(isPeriodic(value), `${value} must read as periodic`);
    assert.deepEqual(
      analyzeDiff(diffAdding("server/src/config.ts", [`const masterKey = "${value}";`])).blocking,
      [],
    );
  }
});

test("secret-entropy ignores a degenerate single-class run", () => {
  const value = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.ok(shannonEntropy(value) < ENTROPY_FLOOR);
  assert.deepEqual(
    analyzeDiff(diffAdding("server/src/config.ts", [`const apiSecret = "${value}";`])).blocking,
    [],
  );
});

test(`secret-entropy ignores values shorter than ${MIN_SECRET_LENGTH} characters`, () => {
  const short = "kJ8xQ2mZ7vB4nR6tY1wE";
  assert.ok(short.length < MIN_SECRET_LENGTH);
  assert.deepEqual(
    analyzeDiff(diffAdding("server/src/config.ts", [`const apiSecret = "${short}";`])).blocking,
    [],
  );
});

test("secret-entropy ignores two-class identifiers that are not hex", () => {
  // A long CamelCase constant draws on only lower+upper, so it never reads as
  // generated no matter how many distinct characters it happens to contain.
  const value = "VeryLongConstantNameForSomething";
  assert.equal(characterClassCount(value), 2);
  assert.ok(!looksGenerated(value));
  assert.deepEqual(
    analyzeDiff(diffAdding("server/src/config.ts", [`const cacheToken = "${value}";`])).blocking,
    [],
  );
});

test("looksGenerated separates credentials from prose and identifiers", () => {
  assert.ok(looksGenerated("kJ8xQ2mZ7vB4nR6tY1wE3pL5sD9gH0aF"));
  assert.ok(looksGenerated("9f3a1c7e02b58d46af91e35c8072bd14"));
  assert.ok(!looksGenerated("0123456789abcdef".repeat(4)), "periodic");
  assert.ok(!looksGenerated("the quick brown fox jumps over"), "not a single token");
  assert.ok(!looksGenerated("VeryLongConstantNameForSomething"), "two classes, not hex");
});

test("isPeriodic detects repeated blocks and nothing else", () => {
  assert.ok(isPeriodic("abcabcabc"));
  assert.ok(isPeriodic("0123456789abcdef".repeat(4)));
  assert.ok(!isPeriodic("kJ8xQ2mZ7vB4nR6tY1wE3pL5sD9gH0aF"));
  assert.ok(!isPeriodic("abc"));
});

test("secret-entropy only looks at secret-ish identifiers", () => {
  const random = "kJ8xQ2mZ7vB4nR6tY1wE3pL5sD9gH0aF";
  assert.deepEqual(
    analyzeDiff(diffAdding("server/src/config.ts", [`const buildHash = "${random}";`])).blocking,
    [],
  );
});

test("looksStructured recognises the shapes that are meaning, not randomness", () => {
  assert.ok(looksStructured("paperclipai.plugin-llm-wiki"));
  assert.ok(looksStructured("some-long-kebab-case-identifier"));
  assert.ok(looksStructured("SOME_LONG_SNAKE_CASE_NAME"));
  assert.ok(looksStructured("server/src/services/x.ts"));
  assert.ok(looksStructured("${prefix}-${suffix}"));
  assert.ok(looksStructured("process.env.PAPERCLIP_API_KEY"));
  assert.ok(looksStructured("6f1c2b9e-4f0a-4a35-9d2e-1b7c8a0f3e11"));
  assert.ok(!looksStructured("kJ8xQ2mZ7vB4nR6tY1wE3pL5sD9gH0aF"));
});

test("shannonEntropy is a floor only — it cannot rank secrets against prose", () => {
  // Documented so nobody reinstates it as the discriminator: measured over 400
  // samples, random 32-char hex scores 3.15-3.93 bits/char while the English
  // phrase below scores 4.16. Any threshold that catches the key catches the
  // sentence. It is used solely to reject degenerate strings.
  assert.ok(shannonEntropy("the quick brown fox jumps over") > shannonEntropy("9f3a1c7e02b58d46af91e35c8072bd14"));
  assert.ok(shannonEntropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") < ENTROPY_FLOOR);
  assert.equal(shannonEntropy(""), 0);
});

// ── workflow-injection ───────────────────────────────────────────────────────

test("workflow-injection blocks an untrusted expression inside a run body", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", [
      '        run: echo "Reviewing ${{ github.event.pull_request.title }}"',
    ]),
  );
  assert.deepEqual(rulesOf(result.blocking), ["workflow-injection"]);
});

test("workflow-injection blocks an untrusted expression on a block-scalar body line", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", ["          git checkout ${{ github.head_ref }}"]),
  );
  assert.deepEqual(rulesOf(result.blocking), ["workflow-injection"]);
});

test("workflow-injection allows the safe env-binding form", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", [
      "        env:",
      "          PR_TITLE: ${{ github.event.pull_request.title }}",
      "          PR_BRANCH: ${{ github.head_ref }}",
      '        run: echo "$PR_TITLE on $PR_BRANCH"',
    ]),
  );
  assert.deepEqual(result.blocking, []);
});

test("workflow-injection does not fire on the existing concurrency-group expression", () => {
  // commitperclip-review.yml keys its concurrency group on `github.head_ref`.
  // That is a YAML mapping value, not shell, and re-flagging it on every edit
  // of that line is exactly the noise this gate exists to avoid.
  const result = analyzeDiff(
    diffAdding(".github/workflows/commitperclip-review.yml", [
      "  group: commitperclip-${{ github.event_name == 'pull_request' && github.head_ref || github.run_id }}",
    ]),
  );
  assert.deepEqual(result.blocking, []);
});

test("workflow-injection ignores trusted expressions in a run body", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", [
      '        run: echo "sha ${{ github.event.pull_request.head.sha }} run ${{ github.run_id }}"',
    ]),
  );
  assert.deepEqual(result.blocking, []);
});

test("workflow-injection only applies to workflow files", () => {
  const result = analyzeDiff(
    diffAdding("doc/CI.md", ['    run: echo "${{ github.event.pull_request.title }}"']),
  );
  assert.deepEqual(result.blocking, []);
});

test("isShellBearingWorkflowLine distinguishes shell from YAML mappings", () => {
  assert.ok(isShellBearingWorkflowLine("        run: echo hi"));
  assert.ok(isShellBearingWorkflowLine("      - run: echo hi"));
  assert.ok(isShellBearingWorkflowLine("          echo \"title: $T\""));
  assert.ok(!isShellBearingWorkflowLine("          PR_TITLE: ${{ github.head_ref }}"));
  assert.ok(!isShellBearingWorkflowLine("  group: pr-${{ github.head_ref }}"));
  assert.ok(!isShellBearingWorkflowLine("        if: github.head_ref != ''"));
});

// ── pipe-to-shell ────────────────────────────────────────────────────────────

test("pipe-to-shell warns, and never blocks, on remote scripts", () => {
  // Advisory by design: `scripts/install.sh` documents this pattern in its own
  // usage text and `docker/agent-runtime/Dockerfile.base` uses it to install
  // node. Blocking would fail every PR touching either.
  const cases = [
    ["Dockerfile", "RUN curl -fsSL https://example.com/install.sh | sh"],
    ["scripts/setup.sh", "wget -qO- https://get.example.dev | bash"],
    [".github/workflows/pr.yml", "        run: curl -sL https://cli.example/install | sudo bash"],
  ];
  for (const [filePath, line] of cases) {
    const result = analyzeDiff(diffAdding(filePath, [line]));
    assert.deepEqual(rulesOf(result.warnings), ["pipe-to-shell"], `${filePath}: ${line}`);
    assert.deepEqual(result.blocking, [], `${filePath} must not block`);
  }
});

test("pipe-to-shell ignores the pattern inside a comment", () => {
  const result = analyzeDiff(
    diffAdding("scripts/setup.sh", ["# install with: curl -fsSL https://get.example.dev | bash"]),
  );
  assert.deepEqual(result.warnings, []);
});

test("pipe-to-shell allows download-then-verify", () => {
  const result = analyzeDiff(
    diffAdding("Dockerfile", [
      "RUN curl -fsSL https://example.com/install.sh -o /tmp/install.sh \\",
      " && echo \"$INSTALL_SHA  /tmp/install.sh\" | sha256sum -c - \\",
      " && sh /tmp/install.sh",
    ]),
  );
  assert.deepEqual(result.warnings, []);
});

test("pipe-to-shell ignores unrelated curl pipelines", () => {
  const result = analyzeDiff(
    diffAdding("scripts/probe.sh", ["curl -s http://localhost:3000/health | jq -r .status"]),
  );
  assert.deepEqual(result.warnings, []);
});

// ── unpinned-action ──────────────────────────────────────────────────────────

test("unpinned-action warns on a third-party action pinned to a tag", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", ["      - uses: some-vendor/deploy-action@v3"]),
  );
  assert.deepEqual(rulesOf(result.warnings), ["unpinned-action"]);
  assert.deepEqual(result.blocking, []);
});

test("unpinned-action accepts a SHA pin and trusted owners", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", [
      "      - uses: some-vendor/deploy-action@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
      "      - uses: actions/checkout@v7",
      "      - uses: pnpm/action-setup@v6",
      "      - uses: ./.github/actions/local",
    ]),
  );
  assert.deepEqual(result.warnings, []);
});

// ── workflow-privilege ───────────────────────────────────────────────────────

test("workflow-privilege warns when a workflow gains elevated rights", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/new.yml", [
      "  pull_request_target:",
      "permissions: write-all",
      "    secrets: inherit",
      "          persist-credentials: true",
    ]),
  );
  assert.equal(result.warnings.length, 4);
  assert.deepEqual(new Set(rulesOf(result.warnings)), new Set(["workflow-privilege"]));
  assert.deepEqual(result.blocking, []);
});

test("workflow-privilege ignores ordinary read permissions", () => {
  const result = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", [
      "permissions:",
      "  contents: read",
      "  pull-requests: write",
    ]),
  );
  assert.deepEqual(result.warnings, []);
});

// ── install-hook ─────────────────────────────────────────────────────────────

test("install-hook warns on a new npm lifecycle hook", () => {
  const result = analyzeDiff(
    diffAdding("packages/db/package.json", ['    "postinstall": "node ./scripts/patch.mjs",']),
  );
  assert.deepEqual(rulesOf(result.warnings), ["install-hook"]);
});

test("install-hook ignores ordinary scripts", () => {
  const result = analyzeDiff(
    diffAdding("packages/db/package.json", [
      '    "build": "tsc -p tsconfig.json",',
      '    "prepare": "husky",',
      '    "test": "vitest run",',
    ]),
  );
  assert.deepEqual(result.warnings, []);
});

// ── lockfile rules ───────────────────────────────────────────────────────────

test("new-dependency reports net-new packages as a single advisory finding", () => {
  const diff = [
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "@@ -100,1 +100,3 @@",
    "-  left-pad@1.3.0:",
    "+  '@scope/thing@2.0.0':",
    "+  right-pad@1.0.0:",
    "+  left-pad@1.3.1:",
  ].join("\n");
  const result = analyzeDiff(diff);
  const newDeps = result.warnings.filter((finding) => finding.rule === "new-dependency");
  assert.equal(newDeps.length, 1, "collapse to one annotation, not one per package");
  assert.match(newDeps[0].title, /^2 new package/);
  assert.match(newDeps[0].detail, /@scope\/thing, right-pad/);
  assert.doesNotMatch(newDeps[0].detail, /left-pad/, "a version bump is not a new package");
  assert.deepEqual(result.blocking, []);
});

test("new-dependency caps the package list it prints", () => {
  const packages = Array.from({ length: MAX_REPORTED_NEW_DEPENDENCIES + 5 }, (_, i) => `pkg-${i}@1.0.0:`);
  const result = analyzeDiff(diffAdding("pnpm-lock.yaml", packages.map((p) => `  ${p}`)));
  const finding = result.warnings.find((f) => f.rule === "new-dependency");
  assert.match(finding.title, new RegExp(`^${MAX_REPORTED_NEW_DEPENDENCIES + 5} new package`));
  assert.match(finding.detail, /and 5 more/);
});

test("offregistry-dep warns on a git or tarball resolution", () => {
  const result = analyzeDiff(
    diffAdding("pnpm-lock.yaml", [
      "      resolution: {tarball: https://cdn.example.com/pkg-1.0.0.tgz}",
      "    version: git+ssh://git@github.com/someone/pkg.git#abc123",
    ]),
  );
  const offRegistry = result.warnings.filter((f) => f.rule === "offregistry-dep");
  assert.equal(offRegistry.length, 2);
});

test("offregistry-dep ignores normal registry integrity lines", () => {
  const result = analyzeDiff(
    diffAdding("pnpm-lock.yaml", [
      "      resolution: {integrity: sha512-abcdefghijklmnopqrstuvwxyz0123456789==}",
    ]),
  );
  assert.deepEqual(result.warnings.filter((f) => f.rule === "offregistry-dep"), []);
});

test("parseLockfilePackageName handles scoped, quoted and peer-suffixed entries", () => {
  assert.equal(parseLockfilePackageName("  left-pad@1.3.0:"), "left-pad");
  assert.equal(parseLockfilePackageName("  '@scope/thing@2.0.0':"), "@scope/thing");
  assert.equal(parseLockfilePackageName("  react-dom@18.2.0(react@18.2.0):"), "react-dom");
  assert.equal(parseLockfilePackageName("  not-an-entry"), null);
  assert.equal(parseLockfilePackageName("  settings:"), null);
});

// ── control-removed ──────────────────────────────────────────────────────────

test("control-removed warns when a guard call site disappears", () => {
  const diff = [
    "diff --git a/server/src/routes/agents.ts b/server/src/routes/agents.ts",
    "--- a/server/src/routes/agents.ts",
    "+++ b/server/src/routes/agents.ts",
    "@@ -40,2 +40,1 @@",
    "-  await assertAuthorized(actor, 'agents:write');",
    "-  await checkPermission(actor, agentId);",
    "+  // fast path",
  ].join("\n");
  const result = analyzeDiff(diff);
  const removed = result.warnings.filter((f) => f.rule === "control-removed");
  assert.deepEqual(
    removed.map((f) => f.title).sort(),
    ["`assertAuthorized` removed (1 call site)", "`checkPermission` removed (1 call site)"],
  );
  assert.deepEqual(result.blocking, []);
});

test("control-removed stays quiet when a guard simply moves within the file", () => {
  const diff = [
    "diff --git a/server/src/routes/agents.ts b/server/src/routes/agents.ts",
    "--- a/server/src/routes/agents.ts",
    "+++ b/server/src/routes/agents.ts",
    "@@ -40,1 +40,1 @@",
    "-  await assertAuthorized(actor, 'agents:write');",
    "@@ -60,0 +60,1 @@",
    "+  await assertAuthorized(actor, 'agents:write');",
  ].join("\n");
  assert.deepEqual(
    analyzeDiff(diff).warnings.filter((f) => f.rule === "control-removed"),
    [],
  );
});

test("control-removed ignores test files", () => {
  const diff = [
    "diff --git a/server/src/__tests__/authz.test.ts b/server/src/__tests__/authz.test.ts",
    "--- a/server/src/__tests__/authz.test.ts",
    "+++ b/server/src/__tests__/authz.test.ts",
    "@@ -1,1 +1,0 @@",
    "-  expect(assertAuthorized).toHaveBeenCalled();",
  ].join("\n");
  assert.deepEqual(analyzeDiff(diff).warnings, []);
});

// ── Waivers ──────────────────────────────────────────────────────────────────

test("parseWaiver requires a rule id and a reason", () => {
  assert.deepEqual(parseWaiver(`// ${ALLOW_MARKER} secret-entropy: rotated test vector`), {
    rule: "secret-entropy",
    reason: "rotated test vector",
  });
  assert.equal(parseWaiver(`// ${ALLOW_MARKER} secret-entropy:`), null, "reason required");
  assert.equal(parseWaiver(`// ${ALLOW_MARKER}: no rule id`), null, "rule id required");
  assert.equal(parseWaiver("// nothing here"), null);
});

test("a same-line waiver downgrades a block to a notice", () => {
  const random = "kJ8xQ2mZ7vB4nR6tY1wE3pL5sD9gH0aF";
  const result = analyzeDiff(
    diffAdding("server/src/__fixtures__/keys.ts", [
      `const apiSecret = "${random}"; // ${ALLOW_MARKER} secret-entropy: revoked fixture, see SUP-1234`,
    ]),
  );
  assert.deepEqual(result.blocking, []);
  assert.equal(result.waived.length, 1);
  assert.equal(result.waived[0].waiver.reason, "revoked fixture, see SUP-1234");
});

test("a waiver on the line above also applies", () => {
  const random = "kJ8xQ2mZ7vB4nR6tY1wE3pL5sD9gH0aF";
  const result = analyzeDiff(
    diffAdding("server/src/x.ts", [
      `// ${ALLOW_MARKER} secret-entropy: revoked fixture`,
      `const apiSecret = "${random}";`,
    ]),
  );
  assert.deepEqual(result.blocking, []);
  assert.equal(result.waived.length, 1);
});

test("a waiver for one rule does not suppress a different rule on the same line", () => {
  const token = "ghp_" + "A".repeat(36);
  const result = analyzeDiff(
    diffAdding("server/src/x.ts", [
      `const t = "${token}"; // ${ALLOW_MARKER} pipe-to-shell: unrelated`,
    ]),
  );
  assert.deepEqual(rulesOf(result.blocking), ["secret-literal"]);
  assert.deepEqual(result.waived, []);
});

test("the wildcard waiver suppresses every block on its line", () => {
  const token = "ghp_" + "A".repeat(36);
  const result = analyzeDiff(
    diffAdding("server/src/x.ts", [`const t = "${token}"; // ${ALLOW_MARKER} *: documented rotation drill`]),
  );
  assert.deepEqual(result.blocking, []);
  assert.equal(result.waived.length, 1);
});

// ── Reporting and exit codes ─────────────────────────────────────────────────

test("formatAnnotation emits a GitHub error annotation anchored to file and line", () => {
  const [finding] = analyzeDiff(
    diffAdding(".github/workflows/pr.yml", ["        run: echo ${{ github.head_ref }}"], 77),
  ).blocking;
  const annotation = formatAnnotation(finding);
  assert.match(annotation, /^::error file=\.github\/workflows\/pr\.yml,line=77,title=/);
  assert.match(annotation, /\[workflow-injection\]/);
  assert.doesNotMatch(annotation.slice(annotation.indexOf("::", 2)), /\n/, "message must be single-line");
});

test("formatAnnotation emits a warning annotation and omits line when unknown", () => {
  const finding = analyzeDiff(diffAdding("pnpm-lock.yaml", ["  right-pad@1.0.0:"])).warnings.find(
    (f) => f.rule === "new-dependency",
  );
  const annotation = formatAnnotation(finding);
  assert.match(annotation, /^::warning file=pnpm-lock\.yaml,title=/);
  assert.doesNotMatch(annotation, /line=/);
});

test("formatSummary renders the blocking, advisory and waived sections", () => {
  const summary = formatSummary({
    blocking: [{ rule: "secret-literal", file: "a.ts", line: 3, title: "Credential literal" }],
    warnings: [{ rule: "new-dependency", file: "pnpm-lock.yaml", title: "2 new package(s)" }],
    waived: [{ rule: "secret-entropy", file: "b.ts", line: 9, waiver: { reason: "fixture" } }],
  });
  assert.match(summary, /### ❌ Blocking \(1\)/);
  assert.match(summary, /### ⚠️ Advisory \(1\) — does not block/);
  assert.match(summary, /### 🗹 Waived \(1\)/);
  assert.match(summary, /\| `secret-literal` \| a\.ts:3 \|/);
});

test("formatSummary says so plainly when the diff is clean", () => {
  assert.match(formatSummary({ blocking: [], warnings: [], waived: [] }), /No security findings/);
});

test("runCheck exits non-zero only for blocking findings", () => {
  const clean = diffAdding("server/src/routes/agents.ts", ["  const x = 1;"]);
  const warned = diffAdding(".github/workflows/pr.yml", ["      - uses: vendor/act@v1"]);
  const blocked = diffAdding("server/src/config.ts", [`const t = "ghp_${"A".repeat(36)}";`]);
  const sink = { lines: [], summary: "" };
  const opts = {
    log: (line) => sink.lines.push(line),
    writeSummary: (text) => {
      sink.summary = text;
    },
  };

  assert.equal(runCheck({ diffText: clean, ...opts }), 0);
  assert.equal(runCheck({ diffText: warned, ...opts }), 0);
  assert.equal(runCheck({ diffText: blocked, ...opts }), 1);
  assert.ok(sink.lines.some((line) => line.startsWith("::error ")));
  assert.ok(sink.lines.some((line) => line.startsWith("::warning ")));
});

test("runCheck emits a notice for each waived finding", () => {
  const token = "ghp_" + "A".repeat(36);
  const lines = [];
  const code = runCheck({
    diffText: diffAdding("server/src/x.ts", [
      `const t = "${token}"; // ${ALLOW_MARKER} secret-literal: rotated 2026-08-29`,
    ]),
    log: (line) => lines.push(line),
    writeSummary: () => {},
  });
  assert.equal(code, 0);
  assert.ok(lines.some((line) => line.startsWith("::notice ") && line.includes("rotated 2026-08-29")));
});

test("runCheck is clean on an empty diff", () => {
  assert.equal(runCheck({ diffText: "", log: () => {}, writeSummary: () => {} }), 0);
});

// ── Diff acquisition ─────────────────────────────────────────────────────────

test("readDiff compares head against the merge base with zero context", () => {
  let captured;
  readDiff({
    baseSha: "base1",
    headSha: "head1",
    run: (command, args) => {
      captured = { command, args };
      return "";
    },
  });
  assert.equal(captured.command, "git");
  assert.deepEqual(captured.args, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "base1...head1",
  ]);
});
