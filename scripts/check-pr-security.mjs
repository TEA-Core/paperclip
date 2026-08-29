#!/usr/bin/env node
/**
 * check-pr-security.mjs
 *
 * Offline, diff-based security gate for pull requests and merge-queue entries.
 *
 * This replaces the upstream `.github/scripts/check-pr-security.mjs` that was
 * deleted in paperclipai/paperclip#11828. That gate failed for two reasons, and
 * both are design constraints here:
 *
 *   1. The sink was wrong. It filed a GitHub *draft security advisory* per PR
 *      and posted a `neutral` check run that deliberately could not block. It
 *      accumulated 1,566 bot-authored drafts against ~99 human-reported ones
 *      and nothing ever consumed them. Here the sink is a workflow annotation
 *      on the offending file and line, plus a job-summary table, plus a real
 *      non-zero exit for block-severity findings. The gate runs inside pr.yml's
 *      `policy` job, which every required check transitively depends on, so a
 *      block fails `verify` and the merge queue ejects the entry.
 *
 *   2. The heuristics fired on ordinary PRs. Upstream flagged any touch of a
 *      handful of hot route files (`SENSITIVE_PATHS`), any test file containing
 *      `fetch(`/`exec(`/`process.env.X`, any change under `.github/workflows/`,
 *      and any `key: "<20+ chars>"` string — which flagged
 *      `pluginKey: "paperclipai.plugin-llm-wiki"`. None of those rules survive
 *      here. Every rule below keys on *what the change does*, never on which
 *      file it lands in, and the entropy rule that replaces the 20-char regex
 *      carries an explicit shape allowlist plus a benign-identifier denylist.
 *
 * Severity model:
 *   - `block` findings print `::error` annotations and exit 1.
 *   - `warn`  findings print `::warning` annotations and exit 0.
 *
 * Waivers: a `paperclip:allow-security <rule-id>: <reason>` comment on the
 * offending added line, or on the line immediately above it in the same hunk,
 * downgrades a block to a notice. The rule id is required, so a waiver for one
 * finding cannot silently suppress a different one on the same line, and the
 * reason must be non-empty. Warn findings need no waiver.
 *
 * Input: a unified diff between the PR base and head. In CI the shas come from
 * pr.yml's `BASE_SHA`/`HEAD_SHA` job env, which already resolve both the
 * `pull_request` and `merge_group` payload shapes. Locally, pass them as
 * `PAPERCLIP_SECURITY_BASE_SHA`/`..._HEAD_SHA` or as two positional arguments.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ALLOW_MARKER = "paperclip:allow-security";

// ── Diff parsing ─────────────────────────────────────────────────────────────

/**
 * Parse `git diff -U0` output into per-file added/removed line records.
 *
 * `-U0` means hunks contain no context lines, so every `+`/`-` body line maps
 * to a line number derived purely from the hunk header counters.
 */
export function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let newLine = 0;
  let oldLine = 0;

  for (const rawLine of String(diffText ?? "").split("\n")) {
    const gitHeader = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      current = {
        path: gitHeader[2],
        oldPath: gitHeader[1],
        deleted: false,
        added: [],
        removed: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (rawLine.startsWith("+++ ")) {
      current.deleted = rawLine.slice(4).trim() === "/dev/null";
      continue;
    }
    if (rawLine.startsWith("--- ")) continue;

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (rawLine.startsWith("+")) {
      current.added.push({ line: newLine, text: rawLine.slice(1) });
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      current.removed.push({ line: oldLine, text: rawLine.slice(1) });
      oldLine += 1;
    }
    // `\ No newline at end of file` and anything else advances neither counter.
  }

  return files;
}

// ── Waivers ──────────────────────────────────────────────────────────────────

/**
 * A waiver must name the rule it suppresses and give a reason. `<rule-id>` may
 * be `*` to waive every block finding on the line, which is deliberately ugly
 * to type so it reads as a decision in review.
 */
export function parseWaiver(text) {
  const match = String(text).match(
    new RegExp(`${ALLOW_MARKER}\\s+([A-Za-z0-9_*-]+)\\s*:\\s*(\\S.*)$`),
  );
  if (!match) return null;
  return { rule: match[1], reason: match[2].trim() };
}

export function isWaived(file, finding) {
  if (!finding.line) return null;
  const candidates = file.added.filter(
    (entry) => entry.line === finding.line || entry.line === finding.line - 1,
  );
  for (const candidate of candidates) {
    const waiver = parseWaiver(candidate.text);
    if (!waiver) continue;
    if (waiver.rule === finding.rule || waiver.rule === "*") return waiver;
  }
  return null;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SHELLISH_RE = /(^|\/)(Dockerfile[^/]*|Makefile)$|\.(sh|bash|zsh)$/;

/** Generated/derived files whose contents are not authored line by line. */
const UNSCANNED_RE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(snap|map|min\.js|min\.css|svg|png|jpg|jpeg|gif|ico|woff2?|pdf)$/;

export function shannonEntropy(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ── Rule: secret-literal (block) ─────────────────────────────────────────────

/**
 * Provider-shaped credentials only. Every pattern here has a vendor-assigned
 * prefix and a fixed body length, so the false-positive rate is close to zero —
 * unlike upstream's `key: "<20+ chars>"` catch-all.
 */
export const PROVIDER_SECRET_PATTERNS = [
  { name: "GitHub personal access token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{24,}/ },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  // Real Slack tokens are `xoxb-<digits>-<digits>-<24+ alnum>`. The loose
  // `xox[baprs]-<10+ chars>` form flagged `botToken: "xoxb-super-secret"` in
  // this repo's own plugin-orchestration suite.
  { name: "Slack token", re: /\bxox[baprse]-\d{9,}-\d{9,}-[A-Za-z0-9]{20,}/ },
  { name: "Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/ },
  { name: "GitLab personal access token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "npm access token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    name: "Private key block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    refine: pemHasKeyMaterial,
  },
  {
    name: "Connection string with inline password",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/([^\s:/@"']+):([^\s:/@"']{8,})@([^\s:/@"'`$]+)/,
    refine: refineConnectionString,
    // Only the password is the credential. Testing the whole match against the
    // placeholder list would let any host containing "example" through.
    secretGroup: 2,
  },
];

const BASE64_RUN_RE = /[A-Za-z0-9+/=]{40,}/;

/**
 * The PEM header alone is a marker, and every use of it in this repo is one:
 * the redaction regex in `google-sheets-mcp-server/src/tools.ts`, the error
 * message in the exe-dev sandbox plugin, the `isSensitiveEnv` assertions, and
 * the `"-----BEGIN PRIVATE KEY-----\nfake\n..."` fixture. A real pasted key
 * always brings its base64 body, either on the same line or the next one.
 */
export function pemHasKeyMaterial(match, { file, entry }) {
  const marker = "PRIVATE KEY-----";
  const tail = entry.text.slice(entry.text.indexOf(marker) + marker.length);
  if (BASE64_RUN_RE.test(tail)) return true;
  const next = file.added.find((candidate) => candidate.line === entry.line + 1);
  return Boolean(next && BASE64_RUN_RE.test(next.text));
}

/** Hosts that cannot receive an exfiltrated credential. */
const LOCAL_HOST_RE = /^(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|localhost|host\.docker\.internal)$/i;

/**
 * A dev connection string is not a leak. This repo's own test and tooling code
 * carries `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip` in
 * several places — loopback host, and the password is just the username again.
 * Both signals independently mean "fixture", and blocking on them would fire on
 * every PR that touches the embedded-postgres helpers.
 */
export function refineConnectionString(match) {
  const [, user, password, host] = match;
  // A templated segment means this is a documented shape, not a credential.
  // doc/DATABASE.md carries Supabase's own
  // `postgres://postgres.[PROJECT-REF]:[PASSWORD]@...pooler.supabase.com` line.
  if (/[[<{$]/.test(user) || /[[<{$]/.test(password)) return false;
  if (LOCAL_HOST_RE.test(host)) return false;
  if (!host.includes(".")) return false; // bare docker-compose service name
  if (password === user) return false;
  return true;
}

/**
 * Values that are obviously stand-ins. Matched against the credential itself,
 * never against the whole line: a comment that happens to say "example" must
 * not excuse a real key sitting next to it. No word boundaries either, because
 * the canonical placeholders glue the marker onto the prefix — AWS documents
 * `AKIAIOSFODNN7EXAMPLE`, which `\bexample` would miss.
 */
const PLACEHOLDER_RE =
  /(?:example|placeholder|redacted|dummy|fake|sample|changeme|not-?a-?real|no[-_]?such|your[-_]|my[-_]?secret|deadbeef|xxxx+|0{8,}|1234567890|test[-_]?only|do[-_]?not[-_]?use)/i;

export function scanProviderSecrets(file) {
  if (UNSCANNED_RE.test(file.path)) return [];
  const findings = [];
  for (const entry of file.added) {
    for (const { name, re, refine, secretGroup = 0 } of PROVIDER_SECRET_PATTERNS) {
      const match = entry.text.match(re);
      if (!match) continue;
      const credential = match[secretGroup];
      if (PLACEHOLDER_RE.test(credential)) continue;
      if (refine && !refine(match, { file, entry })) continue;
      findings.push({
        rule: "secret-literal",
        severity: "block",
        file: file.path,
        line: entry.line,
        title: `Credential literal (${name})`,
        detail:
          `This added line matches the ${name} format. Move it to a secret ` +
          `and reference it by env var; if it has ever been pushed, rotate it.`,
        evidence: redact(credential),
      });
      break; // one finding per line is enough to make the point
    }
  }
  return findings;
}

/** Never echo a suspected credential back into a public log. */
export function redact(value) {
  const text = String(value);
  if (text.length <= 12) return `${text.slice(0, 4)}…`;
  return `${text.slice(0, 8)}…${text.slice(-2)} (${text.length} chars)`;
}

// ── Rule: secret-entropy (block) ─────────────────────────────────────────────

/**
 * Identifiers whose name ends in a secret-ish word but which routinely hold
 * non-secret values. `pluginKey` is the documented regression: upstream's
 * `key: "<20+ chars>"` regex flagged `pluginKey: "paperclipai.plugin-llm-wiki"`
 * on ordinary plugin PRs.
 */
export const BENIGN_SECRET_NAMES = new Set([
  "cachekey",
  "columnkey",
  "foreignkey",
  "groupkey",
  "idempotencykey",
  "itemkey",
  "objectkey",
  "partitionkey",
  "pluginkey",
  "primarykey",
  "publickey",
  "queuekey",
  "reactkey",
  "rowkey",
  "settingkey",
  "sortkey",
  "storagekey",
  "translationkey",
]);

export const MIN_SECRET_LENGTH = 24;

const SECRET_NAME_RE = new RegExp(
  "(?:^|[^A-Za-z0-9])([A-Za-z_][A-Za-z0-9_]*(?:[Kk]ey|KEY|[Tt]oken|TOKEN|[Ss]ecret|SECRET" +
    "|[Pp]assword|PASSWORD|[Cc]redential|CREDENTIAL))\\s*[:=]{1,2}\\s*" +
    `(["'\`])([^"'\`]{${MIN_SECRET_LENGTH},})\\2`,
);

/**
 * Shapes that carry meaning rather than randomness: reverse-DNS identifiers,
 * kebab/snake word runs, paths, URLs, template interpolations, env lookups,
 * and anything a human would read out loud.
 */
export function looksStructured(value) {
  if (/\$\{|process\.env|import\.meta\.env|<[^>]+>/.test(value)) return true;
  if (/[\s/\\]/.test(value)) return true;
  if (/^[a-z0-9]+(?:[.@][a-z0-9-]+)+$/i.test(value)) return true; // reverse-DNS, emails
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(value)) return true; // kebab / snake word runs
  if (/^[0-9a-f-]+$/i.test(value) && /-/.test(value)) return true; // uuid
  return false;
}

/**
 * True when the string is some shorter block repeated. Hand-written test keys
 * are almost always keyboard walks laid end to end —
 * `"0123456789abcdef".repeat(4)` and `"fedcba9876543210".repeat(2)` are both
 * live in this repo's secrets-provider suite — and no measure of symbol
 * frequency can tell those apart from a real key, because their symbol
 * frequencies are *perfectly* uniform. Periodicity can.
 *
 * The rotation trick: `s` is periodic iff it reappears inside `s + s` before
 * the halfway mark.
 */
export function isPeriodic(value) {
  if (value.length < 4) return false;
  return (value + value).indexOf(value, 1) < value.length;
}

/**
 * How many of {lowercase, uppercase, digit} the value draws on.
 *
 * This carries most of the discrimination, because raw Shannon entropy cannot.
 * At these lengths entropy measures alphabet size, not randomness: measured
 * over 400 samples each, a random 32-char hex key scores 3.15-3.93 bits/char
 * while the English phrase "the quick brown fox jumps over" scores 4.16. A
 * threshold that catches the key also catches the sentence. Character-class
 * mixing does not have that failure mode — prose and identifiers are one or
 * two classes, generated credentials are three.
 */
export function characterClassCount(value) {
  return (
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value))
  );
}

/** Floor that only rejects degenerate strings; random hex-32 measures >= 3.15. */
export const ENTROPY_FLOOR = 2.8;

/** Pure hex is one character class, so it needs its own length-based path. */
const LONG_HEX_RE = /^[0-9a-f]{32,}$/i;
const CREDENTIAL_CHARSET_RE = /^[A-Za-z0-9+/=_-]+$/;

/**
 * A value is credential-shaped when it is one contiguous token from the
 * charset generators use, is not a repeated block, and either mixes all three
 * character classes or is a long pure-hex string.
 */
export function looksGenerated(value) {
  if (!CREDENTIAL_CHARSET_RE.test(value)) return false;
  if (isPeriodic(value)) return false;
  if (shannonEntropy(value) < ENTROPY_FLOOR) return false;
  return characterClassCount(value) === 3 || LONG_HEX_RE.test(value);
}

export function scanEntropySecrets(file) {
  if (UNSCANNED_RE.test(file.path)) return [];
  const findings = [];
  for (const entry of file.added) {
    const match = entry.text.match(SECRET_NAME_RE);
    if (!match) continue;

    const [, identifier, , value] = match;
    if (BENIGN_SECRET_NAMES.has(identifier.toLowerCase())) continue;
    if (PLACEHOLDER_RE.test(value)) continue;
    if (looksStructured(value)) continue;
    if (!looksGenerated(value)) continue;

    findings.push({
      rule: "secret-entropy",
      severity: "block",
      file: file.path,
      line: entry.line,
      title: `Generated-looking value assigned to \`${identifier}\``,
      detail:
        `The literal assigned to \`${identifier}\` is a ${value.length}-char ` +
        `non-repeating token drawn from a credential charset, which is what a ` +
        `generated key looks like and not what an identifier looks like. ` +
        `If this is not a credential, waive it: ` +
        `\`${ALLOW_MARKER} secret-entropy: <reason>\`.`,
      evidence: redact(value),
    });
  }
  return findings;
}

// ── Rule: workflow-injection (block) ─────────────────────────────────────────

/**
 * Expression contexts an outside contributor controls. Interpolating any of
 * these straight into a shell body is remote code execution on a runner that,
 * under `pull_request_target`, holds this repo's secrets.
 */
export const UNTRUSTED_EXPRESSIONS = [
  /github\.head_ref/,
  /github\.event\.(?:issue|pull_request|discussion)\.(?:title|body)/,
  /github\.event\.pull_request\.head\.(?:ref|label|repo\.[A-Za-z_.]+)/,
  /github\.event\.(?:comment|review|review_comment)\.body/,
  /github\.event\.(?:head_commit|commits\[[0-9]+\])\.(?:message|author\.[A-Za-z_]+)/,
  /github\.event\.workflow_run\.(?:head_branch|head_commit\.message)/,
  /github\.event\.pages\[[0-9]+\]\.page_name/,
];

/**
 * A bare `KEY: ${{ … }}` mapping is the *safe* pattern — that is how you get an
 * untrusted value into `env:` so the shell reads it as `"$KEY"` instead of
 * pasting it into the script text. Only flag lines that are shell, i.e. an
 * inline `run:`/`script:` or a body line inside a block scalar (which never
 * has a leading `key:`).
 */
export function isShellBearingWorkflowLine(text) {
  if (/^\s*(?:-\s+)?(?:run|script):/.test(text)) return true;
  return !/^\s*(?:-\s+)?[A-Za-z_][A-Za-z0-9_.-]*:\s/.test(text);
}

export function scanWorkflowInjection(file) {
  if (!WORKFLOW_RE.test(file.path)) return [];
  const findings = [];
  for (const entry of file.added) {
    if (!/\$\{\{/.test(entry.text)) continue;
    if (!isShellBearingWorkflowLine(entry.text)) continue;
    const expression = UNTRUSTED_EXPRESSIONS.find((re) => re.test(entry.text));
    if (!expression) continue;
    findings.push({
      rule: "workflow-injection",
      severity: "block",
      file: file.path,
      line: entry.line,
      title: "Untrusted GitHub expression interpolated into a shell body",
      detail:
        "A contributor-controlled value is pasted into the script text, so a " +
        "crafted branch name or PR title executes as shell on the runner. Bind " +
        "it to an `env:` entry and reference the variable instead:\n" +
        "  env:\n    TITLE: ${{ github.event.pull_request.title }}\n" +
        "  run: echo \"$TITLE\"",
      evidence: entry.text.trim().slice(0, 160),
    });
  }
  return findings;
}

// ── Rule: pipe-to-shell (block) ──────────────────────────────────────────────

const PIPE_TO_SHELL_RE =
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:\/usr\/bin\/|\/bin\/)?(?:ba|z|k|da|a)?sh\b/;

export function scanPipeToShell(file) {
  if (!SHELLISH_RE.test(file.path) && !WORKFLOW_RE.test(file.path)) return [];

  // Advisory, not blocking. Two established uses in this repo would otherwise
  // fail every PR that touches them: `scripts/install.sh` *documents*
  // `curl -fsSL https://paperclip.ing/install.sh | bash` in its own usage text,
  // and `docker/agent-runtime/Dockerfile.base` pipes NodeSource's setup script
  // to install node. A gate that blocks on the base image's existing, accepted
  // build step is the kind that gets deleted rather than fixed. The annotation
  // still puts it in front of a reviewer, which the draft-advisory sink never did.
  const findings = [];
  for (const entry of file.added) {
    if (/^\s*#/.test(entry.text)) continue;
    if (!PIPE_TO_SHELL_RE.test(entry.text)) continue;
    findings.push({
      rule: "pipe-to-shell",
      severity: "warn",
      file: file.path,
      line: entry.line,
      title: "Remote script piped straight into a shell",
      detail:
        "Whatever that host serves at build time runs with full build " +
        "privileges, and nothing pins or verifies it. Download to a file, " +
        "check it against a known digest, then execute it.",
      evidence: entry.text.trim().slice(0, 160),
    });
  }
  return findings;
}

// ── Rule: unpinned-action (warn) ─────────────────────────────────────────────

/** Orgs whose tags this repo already treats as trusted (see pr.yml). */
export const TRUSTED_ACTION_OWNERS = new Set(["actions", "github", "docker", "pnpm"]);

export function scanUnpinnedActions(file) {
  if (!WORKFLOW_RE.test(file.path)) return [];
  const findings = [];
  for (const entry of file.added) {
    const match = entry.text.match(/^\s*(?:-\s+)?uses:\s*([^@\s'"]+)@([^\s'"#]+)/);
    if (!match) continue;
    const [, action, ref] = match;
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    if (TRUSTED_ACTION_OWNERS.has(action.split("/")[0])) continue;
    if (/^[0-9a-f]{40}$/i.test(ref)) continue;
    findings.push({
      rule: "unpinned-action",
      severity: "warn",
      file: file.path,
      line: entry.line,
      title: `Third-party action \`${action}\` pinned to a mutable ref`,
      detail:
        `\`${ref}\` is a tag or branch, so its owner can change what runs here ` +
        "at any time. Pin the full commit SHA and keep the tag in a trailing comment.",
      evidence: entry.text.trim().slice(0, 160),
    });
  }
  return findings;
}

// ── Rule: workflow-privilege (warn) ──────────────────────────────────────────

export const PRIVILEGE_PATTERNS = [
  { name: "`pull_request_target` trigger", re: /^\s*pull_request_target:/ },
  { name: "`workflow_run` trigger", re: /^\s*workflow_run:/ },
  { name: "`permissions: write-all`", re: /^\s*permissions:\s*write-all\s*$/ },
  { name: "`secrets: inherit`", re: /^\s*secrets:\s*inherit\s*$/ },
  { name: "`persist-credentials: true`", re: /^\s*persist-credentials:\s*true\s*$/ },
  { name: "`id-token: write`", re: /^\s*id-token:\s*write\s*$/ },
];

export function scanWorkflowPrivilege(file) {
  if (!WORKFLOW_RE.test(file.path)) return [];
  const findings = [];
  for (const entry of file.added) {
    const hit = PRIVILEGE_PATTERNS.find(({ re }) => re.test(entry.text));
    if (!hit) continue;
    findings.push({
      rule: "workflow-privilege",
      severity: "warn",
      file: file.path,
      line: entry.line,
      title: `Workflow privilege raised: ${hit.name}`,
      detail:
        "This grants the workflow more than a read-only PR check needs. " +
        "Confirm it never checks out or executes PR-authored code while holding it.",
      evidence: entry.text.trim().slice(0, 160),
    });
  }
  return findings;
}

// ── Rule: install-hook (warn) ────────────────────────────────────────────────

export function scanInstallHooks(file) {
  if (path.basename(file.path) !== "package.json") return [];
  const findings = [];
  for (const entry of file.added) {
    const match = entry.text.match(/^\s*"((?:pre|post)?install)"\s*:/);
    if (!match) continue;
    findings.push({
      rule: "install-hook",
      severity: "warn",
      file: file.path,
      line: entry.line,
      title: `npm lifecycle hook \`${match[1]}\` added`,
      detail:
        "Lifecycle hooks execute on every developer machine and every CI " +
        "runner that installs this workspace. Confirm the command is necessary " +
        "and does not reach the network.",
      evidence: entry.text.trim().slice(0, 160),
    });
  }
  return findings;
}

// ── Rules over pnpm-lock.yaml (warn) ─────────────────────────────────────────

export function parseLockfilePackageName(text) {
  let entry = text.trim();
  if (!entry.endsWith(":")) return null;
  entry = entry.slice(0, -1).trim();
  if (
    (entry.startsWith("'") && entry.endsWith("'")) ||
    (entry.startsWith('"') && entry.endsWith('"'))
  ) {
    entry = entry.slice(1, -1);
  }
  entry = entry.replace(/\(.*$/, "").trim();

  const versionSep = entry.lastIndexOf("@");
  if (versionSep <= 0 || versionSep === entry.length - 1) return null;

  const name = entry.slice(0, versionSep);
  if (!/^(?:@[^/\s:]+\/)?[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(name)) return null;
  return name;
}

const OFF_REGISTRY_RE =
  /^\s*(?:resolution:\s*\{)?\s*(?:tarball|repo|commit):|(?:git\+(?:ssh|https?):\/\/|github:|codeload\.github\.com|https?:\/\/(?!registry\.npmjs\.org\/)[^\s"'}]+\.(?:tgz|tar\.gz))/;

export const MAX_REPORTED_NEW_DEPENDENCIES = 20;

export function scanLockfile(file) {
  if (path.basename(file.path) !== "pnpm-lock.yaml") return [];

  const findings = [];
  const added = new Set();
  const removed = new Set();

  for (const entry of file.added) {
    const name = parseLockfilePackageName(entry.text);
    if (name) added.add(name);

    if (OFF_REGISTRY_RE.test(entry.text)) {
      findings.push({
        rule: "offregistry-dep",
        severity: "warn",
        file: file.path,
        line: entry.line,
        title: "Dependency resolved from outside the npm registry",
        detail:
          "A git ref or arbitrary tarball is not immutable the way a registry " +
          "version is, and it bypasses registry-side malware scanning. Prefer a " +
          "published version, or record why this source is required.",
        evidence: entry.text.trim().slice(0, 160),
      });
    }
  }
  for (const entry of file.removed) {
    const name = parseLockfilePackageName(entry.text);
    if (name) removed.add(name);
  }

  const netNew = [...added].filter((name) => !removed.has(name)).sort();
  if (netNew.length > 0) {
    const shown = netNew.slice(0, MAX_REPORTED_NEW_DEPENDENCIES);
    const overflow = netNew.length - shown.length;
    findings.push({
      rule: "new-dependency",
      severity: "warn",
      file: file.path,
      title: `${netNew.length} new package(s) enter the dependency tree`,
      detail:
        `New transitive code runs in CI, in the image, and on every developer ` +
        `machine: ${shown.join(", ")}${overflow > 0 ? `, and ${overflow} more` : ""}.`,
    });
  }

  return findings;
}

// ── Rule: control-removed (warn) ─────────────────────────────────────────────

/**
 * Deleting a guard is invisible in a green diff. Counting occurrences per file
 * catches the removal without caring which file it happened in — the property
 * upstream's `SENSITIVE_PATHS` list tried and failed to approximate.
 */
export const SECURITY_CONTROL_TOKENS = [
  "requireAuth",
  "requireRole",
  "requireAdmin",
  "assertAuthorized",
  "authorizeRequest",
  "checkPermission",
  "hasPermission",
  "verifySignature",
  "timingSafeEqual",
  "sanitizeHtml",
  "escapeHtml",
  "urlTransform",
  "csrfToken",
  "rateLimit",
];

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_RE = /\.(test|spec)\.[jt]sx?$|(^|\/)(__tests__|__mocks__)\//;

export function scanRemovedControls(file) {
  if (!SOURCE_RE.test(file.path) || TEST_RE.test(file.path)) return [];
  if (file.deleted) return [];

  const findings = [];
  for (const token of SECURITY_CONTROL_TOKENS) {
    const count = (lines) =>
      lines.reduce((total, entry) => total + countOccurrences(entry.text, token), 0);
    const net = count(file.removed) - count(file.added);
    if (net <= 0) continue;
    findings.push({
      rule: "control-removed",
      severity: "warn",
      file: file.path,
      title: `\`${token}\` removed (${net} call site${net === 1 ? "" : "s"})`,
      detail:
        `This diff has ${net} fewer \`${token}\` reference(s) than the base. If the ` +
        "guard moved, say where in the PR description; if it was dropped, say why.",
    });
  }
  return findings;
}

function countOccurrences(text, token) {
  let count = 0;
  let index = text.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export const RULES = [
  scanProviderSecrets,
  scanEntropySecrets,
  scanWorkflowInjection,
  scanPipeToShell,
  scanUnpinnedActions,
  scanWorkflowPrivilege,
  scanInstallHooks,
  scanLockfile,
  scanRemovedControls,
];

export function analyzeDiff(diffText) {
  const files = parseUnifiedDiff(diffText);
  const blocking = [];
  const warnings = [];
  const waived = [];

  for (const file of files) {
    if (file.deleted) {
      // A pure deletion adds no new behaviour; only `control-removed` cares,
      // and it already declines deleted files.
      continue;
    }
    for (const rule of RULES) {
      for (const finding of rule(file)) {
        if (finding.severity === "warn") {
          warnings.push(finding);
          continue;
        }
        const waiver = isWaived(file, finding);
        if (waiver) waived.push({ ...finding, waiver });
        else blocking.push(finding);
      }
    }
  }

  return { blocking, warnings, waived };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function escapeAnnotationProperty(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeAnnotationMessage(value) {
  return escapeAnnotationProperty(value).replace(/::/g, "%3A%3A");
}

export function formatAnnotation(finding) {
  const level = finding.severity === "block" ? "error" : "warning";
  const properties = [
    `file=${escapeAnnotationProperty(finding.file)}`,
    `title=${escapeAnnotationProperty(`[${finding.rule}] ${finding.title}`)}`,
  ];
  if (finding.line) properties.splice(1, 0, `line=${finding.line}`);
  const message = [
    finding.detail,
    finding.evidence ? `\nMatched: ${finding.evidence}` : "",
    finding.severity === "block"
      ? `\nWaive with a comment on that line: ${ALLOW_MARKER} ${finding.rule}: <reason>`
      : "",
  ].join("");
  return `::${level} ${properties.join(",")}::${escapeAnnotationMessage(message)}`;
}

export function formatSummary({ blocking, warnings, waived }) {
  const lines = ["## PR security gate", ""];

  if (blocking.length === 0 && warnings.length === 0 && waived.length === 0) {
    lines.push("No security findings in this diff.");
    return lines.join("\n");
  }

  const row = (finding) =>
    `| \`${finding.rule}\` | ${finding.file}${finding.line ? `:${finding.line}` : ""} | ${finding.title} |`;

  if (blocking.length > 0) {
    lines.push(
      `### ❌ Blocking (${blocking.length})`,
      "",
      "| Rule | Location | Finding |",
      "| --- | --- | --- |",
      ...blocking.map(row),
      "",
    );
  }
  if (warnings.length > 0) {
    lines.push(
      `### ⚠️ Advisory (${warnings.length}) — does not block`,
      "",
      "| Rule | Location | Finding |",
      "| --- | --- | --- |",
      ...warnings.map(row),
      "",
    );
  }
  if (waived.length > 0) {
    lines.push(
      `### 🗹 Waived (${waived.length})`,
      "",
      "| Rule | Location | Reason |",
      "| --- | --- | --- |",
      ...waived.map(
        (finding) =>
          `| \`${finding.rule}\` | ${finding.file}:${finding.line} | ${finding.waiver.reason} |`,
      ),
      "",
    );
  }

  return lines.join("\n");
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function readDiff({ baseSha, headSha, cwd = process.cwd(), run = execFileSync } = {}) {
  // Three-dot: compare head against the merge base, so commits that landed on
  // the base branch after this PR forked are not attributed to the PR. Matches
  // every other diff-based step in pr.yml's policy job.
  return run(
    "git",
    ["diff", "--unified=0", "--no-color", "--no-ext-diff", `${baseSha}...${headSha}`],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
}

export function runCheck({
  diffText,
  log = console.log,
  writeSummary = defaultWriteSummary,
} = {}) {
  const result = analyzeDiff(diffText);

  for (const finding of [...result.blocking, ...result.warnings]) {
    log(formatAnnotation(finding));
  }
  for (const finding of result.waived) {
    log(
      `::notice file=${escapeAnnotationProperty(finding.file)},line=${finding.line}::` +
        escapeAnnotationMessage(
          `[${finding.rule}] waived: ${finding.waiver.reason}`,
        ),
    );
  }

  writeSummary(formatSummary(result));

  if (result.blocking.length > 0) {
    log(
      `\n${result.blocking.length} blocking security finding(s). ` +
        "Fix them, or add a `" +
        ALLOW_MARKER +
        " <rule-id>: <reason>` comment on the flagged line if the finding is wrong.",
    );
    return 1;
  }

  log(
    `  ✓  PR security gate: no blocking findings ` +
      `(${result.warnings.length} advisory, ${result.waived.length} waived).`,
  );
  return 0;
}

export function defaultWriteSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  // Must be synchronous. This was a `import("node:fs").then(...)` and the
  // summary silently never landed: the dynamic import had not resolved by the
  // time the entry point called `process.exit`, so the file stayed empty on
  // every run while the exit code still looked correct. Unit tests inject
  // their own `writeSummary`, so nothing here needs deferring.
  appendFileSync(target, `${text}\n`);
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function main() {
  const baseSha =
    process.env.PAPERCLIP_SECURITY_BASE_SHA || process.env.BASE_SHA || process.argv[2];
  const headSha =
    process.env.PAPERCLIP_SECURITY_HEAD_SHA || process.env.HEAD_SHA || process.argv[3];

  if (!baseSha || !headSha) {
    console.error(
      "ERROR: base and head shas required. In CI they come from pr.yml's BASE_SHA/HEAD_SHA;\n" +
        "locally run: node scripts/check-pr-security.mjs <base-sha> <head-sha>",
    );
    return 2;
  }

  return runCheck({ diffText: readDiff({ baseSha, headSha }) });
}

if (isMainModule()) {
  // `process.exitCode`, not `process.exit()`: the latter tears the process down
  // without flushing buffered stdout, which can truncate the annotations that
  // are this gate's whole reporting channel.
  process.exitCode = main();
}
