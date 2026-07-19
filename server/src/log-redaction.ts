import os from "node:os";

import { REDACTED_EVENT_VALUE } from "./redaction.js";

export const CURRENT_USER_REDACTION_TOKEN = "*";

export const SECRET_REDACTION_TOKEN = "[REDACTED:secret]";

export interface CurrentUserRedactionOptions {
  enabled?: boolean;
  replacement?: string;
  userNames?: string[];
  homeDirs?: string[];
}

type CurrentUserCandidates = {
  userNames: string[];
  homeDirs: string[];
  replacement: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function splitPathSegments(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
}

function replaceLastPathSegment(pathValue: string, replacement: string) {
  const normalized = pathValue.replace(/[\\/]+$/, "");
  const lastSeparator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSeparator < 0) return replacement;
  return `${normalized.slice(0, lastSeparator + 1)}${replacement}`;
}

export function maskUserNameForLogs(value: string, fallback = CURRENT_USER_REDACTION_TOKEN) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return `${trimmed[0]}${"*".repeat(Math.max(1, Array.from(trimmed).length - 1))}`;
}

function defaultUserNames() {
  const candidates = [
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
  ];

  try {
    candidates.push(os.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

function defaultHomeDirs(userNames: string[]) {
  const candidates: Array<string | null | undefined> = [
    process.env.HOME,
    process.env.USERPROFILE,
  ];

  try {
    candidates.push(os.homedir());
  } catch {
    // Ignore and fall back to env hints below.
  }

  for (const userName of userNames) {
    candidates.push(`/Users/${userName}`);
    candidates.push(`/home/${userName}`);
    candidates.push(`C:\\Users\\${userName}`);
  }

  return uniqueNonEmpty(candidates);
}

let cachedCurrentUserCandidates: CurrentUserCandidates | null = null;

function getDefaultCurrentUserCandidates(): CurrentUserCandidates {
  if (cachedCurrentUserCandidates) return cachedCurrentUserCandidates;
  const userNames = defaultUserNames();
  cachedCurrentUserCandidates = {
    userNames,
    homeDirs: defaultHomeDirs(userNames),
    replacement: CURRENT_USER_REDACTION_TOKEN,
  };
  return cachedCurrentUserCandidates;
}

function resolveCurrentUserCandidates(opts?: CurrentUserRedactionOptions) {
  const defaults = getDefaultCurrentUserCandidates();
  const userNames = uniqueNonEmpty(opts?.userNames ?? defaults.userNames);
  const homeDirs = uniqueNonEmpty(opts?.homeDirs ?? defaults.homeDirs);
  const replacement = opts?.replacement?.trim() || defaults.replacement;
  return { userNames, homeDirs, replacement };
}

export function redactCurrentUserText(input: string, opts?: CurrentUserRedactionOptions) {
  if (!input) return input;
  if (opts?.enabled === false) return input;

  const { userNames, homeDirs, replacement } = resolveCurrentUserCandidates(opts);
  let result = input;

  for (const homeDir of [...homeDirs].sort((a, b) => b.length - a.length)) {
    if (!result.includes(homeDir)) continue;
    const lastSegment = splitPathSegments(homeDir).pop() ?? "";
    const replacementDir = lastSegment
      ? replaceLastPathSegment(homeDir, maskUserNameForLogs(lastSegment, replacement))
      : replacement;
    result = result.split(homeDir).join(replacementDir);
  }

  for (const userName of [...userNames].sort((a, b) => b.length - a.length)) {
    if (!result.includes(userName)) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(userName)}(?![A-Za-z0-9._-])`, "g");
    result = result.replace(pattern, maskUserNameForLogs(userName, replacement));
  }

  return result;
}

// --- secret-token redaction (SUP-8631) --------------------------------------
// Masks secret-SHAPED tokens on the two persistence boundaries that leaked in
// SUP-7928 (agent narration -> issue comment) and SUP-8315 (run-log writes).
// Complements redactCurrentUserText, which only masks the current OS user.
//
// ReDoS constraints — load-bearing, do NOT "simplify":
//   * every quantifier is bounded ({0,128} names, {1,512} values); the existing
//     unbounded style in redaction.ts is quadratic in word-run length.
//   * the JWT segment separator "." stays OUTSIDE the segment class
//     [A-Za-z0-9_-], which is what keeps the segment loops effectively atomic.
//     Adding "." to that class would make the pattern quadratic.

// Never rewrite a marker we (or redaction.ts) already wrote — keeps the filter
// idempotent and stops marker churn when both redactors run on one string.
const NOT_ALREADY_REDACTED = `(?!${escapeRegExp(SECRET_REDACTION_TOKEN)})(?!${escapeRegExp(REDACTED_EVENT_VALUE)})`;
// Supabase publishable keys are public by design and must survive both the
// value-driven and the name-driven patterns.
const NOT_PUBLISHABLE_VALUE = String.raw`(?!sb_publishable_)`;
const NOT_PUBLIC_NAME = String.raw`(?![A-Za-z0-9_-]{0,128}(?:PUBLISHABLE|ANON_KEY))`;

// A name is secret-shaped when it ENDS in a secret suffix — the leading "_" is
// load-bearing (without it MONKEY=/TURKEY= would match) — or is one of the
// well-known lowercase JSON/env field names.
const SECRET_NAME = String.raw`(?:[A-Za-z0-9_]{0,128}(?:_KEY|_SECRET|_TOKEN|_PASSWORD|SERVICE_ROLE)|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|service[-_]?role[-_]?key|private[-_]?key|credential|password|passwd|secret)`;
const NAME_START = String.raw`(?<![A-Za-z0-9_])`;

// Value terminators are deliberately wide: a match that runs past the secret
// eats real diagnostic content (and can break enclosing JSON).
const QUOTED_VALUE = String.raw`[^"'\`\r\n]{1,512}`;
const BARE_VALUE = String.raw`[^\s"'\`,;\\)\]}<>&|#\[]{1,512}`;
// Consumes JSON escape pairs but stops at the closing \" delimiter, so an
// escaped secret cannot leak its tail.
const ESCAPED_JSON_VALUE = String.raw`(?:\\[^"]|[^\\"\r\n]){1,512}`;

// For `NAME = value` with whitespace around "=" the value must look like a
// credential (contains a digit, or is 20+ chars). Without this, prose and code
// such as `const SESSION_TOKEN = await getToken();` loses its next word.
// Tight `NAME=value` — the shape that actually leaks in env dumps and
// server.log lines — is accepted unconditionally via the (?<==) branch.
const CREDENTIAL_SHAPED_VALUE = String.raw`(?:(?<==)|(?=[^\s]{0,512}\d)|(?=[^\s]{20}))`;

const SECRET_ESCAPED_JSON_ASSIGNMENT_RE = new RegExp(
  String.raw`(\\"${NOT_PUBLIC_NAME}${SECRET_NAME}\\"\s*:\s*\\")${NOT_ALREADY_REDACTED}${NOT_PUBLISHABLE_VALUE}${ESCAPED_JSON_VALUE}`,
  "gi",
);
const SECRET_QUOTED_ASSIGNMENT_RE = new RegExp(
  String.raw`(${NAME_START}["'\`]?${NOT_PUBLIC_NAME}${SECRET_NAME}["'\`]?\s*[:=]\s*["'\`])${NOT_ALREADY_REDACTED}${NOT_PUBLISHABLE_VALUE}${QUOTED_VALUE}`,
  "gi",
);
// "=" only. An unquoted `NAME: value` form would mangle prose, markdown and
// YAML references; the quoted/escaped patterns above already cover JSON.
const SECRET_BARE_ASSIGNMENT_RE = new RegExp(
  String.raw`(${NAME_START}${NOT_PUBLIC_NAME}${SECRET_NAME}\s*=\s*)${NOT_ALREADY_REDACTED}${NOT_PUBLISHABLE_VALUE}${CREDENTIAL_SHAPED_VALUE}${BARE_VALUE}`,
  "gi",
);

const CONNECTION_URI_PASSWORD_RE = /([a-z][a-z0-9+.-]{1,31}:\/\/[^\s:@/"'`]{1,256}:)[^\s@/"'`]{1,256}(?=@)/gi;
// Keeps the scheme word; the digit lookahead stops `basic authentication` and
// similar prose from being eaten.
const AUTH_SCHEME_RE =
  /((?<![A-Za-z0-9_-])(?:bearer|basic)\s+)(?=[A-Za-z0-9._~+/=-]{0,512}\d)[A-Za-z0-9._~+/=-]{12,512}/gi;
const SUPABASE_SECRET_KEY_RE = /(?<![A-Za-z0-9_-])sb_secret_[A-Za-z0-9_-]{8,512}/g;
// The digit lookahead keeps CSS/source identifiers (sk-circle-fade-delay-one,
// sk_internal_state_container) out; the lookbehind must exclude "." and "/" so
// property access and paths are not match starts.
const PREFIXED_API_KEY_RE =
  /(?<![A-Za-z0-9_./-])sk[-_](?=[A-Za-z0-9_-]{0,512}\d)[A-Za-z0-9_-]{17,512}/g;
const VENDOR_TOKEN_RE =
  /(?<![A-Za-z0-9_./-])(?:github_pat_|gh[pousr]_|xox[baprs]-|glpat-|rk_live_|dop_v1_|hf_|npm_|AKIA|AIza)[A-Za-z0-9_-]{16,512}/g;
// The "eyJ" anchor is base64url for '{"', so this only fires on real JWT/JWE
// headers — that is what keeps semver and dotted paths out. 2-4 trailing
// segments so a JWE is consumed whole rather than leaking its ciphertext.
const JWT_RE =
  /(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,512}(?:\.[A-Za-z0-9_-]{8,512}){2,4}(?![A-Za-z0-9_-])/g;
const PEM_PRIVATE_KEY_RE =
  /-----BEGIN[^-\r\n]{0,64}PRIVATE KEY-----[\s\S]{0,8192}?-----END[^-\r\n]{0,64}PRIVATE KEY-----/g;

/**
 * Masks secret-shaped tokens in free text with {@link SECRET_REDACTION_TOKEN}.
 *
 * Assignment patterns run before value patterns: `FOO_SECRET=eyJ...` must be
 * consumed as one assignment, otherwise the JWT is replaced first and the
 * assignment pattern then rewrites the marker into garbage.
 */
export function redactSecretTokens(input: string): string {
  if (!input) return input;
  return input
    .replace(SECRET_ESCAPED_JSON_ASSIGNMENT_RE, `$1${SECRET_REDACTION_TOKEN}`)
    .replace(SECRET_QUOTED_ASSIGNMENT_RE, `$1${SECRET_REDACTION_TOKEN}`)
    .replace(SECRET_BARE_ASSIGNMENT_RE, `$1${SECRET_REDACTION_TOKEN}`)
    .replace(CONNECTION_URI_PASSWORD_RE, `$1${SECRET_REDACTION_TOKEN}`)
    .replace(AUTH_SCHEME_RE, `$1${SECRET_REDACTION_TOKEN}`)
    .replace(SUPABASE_SECRET_KEY_RE, SECRET_REDACTION_TOKEN)
    .replace(PREFIXED_API_KEY_RE, SECRET_REDACTION_TOKEN)
    .replace(VENDOR_TOKEN_RE, SECRET_REDACTION_TOKEN)
    .replace(JWT_RE, SECRET_REDACTION_TOKEN)
    .replace(PEM_PRIVATE_KEY_RE, SECRET_REDACTION_TOKEN);
}

/** Value-walker mirroring {@link redactCurrentUserValue}; redacts values, not keys. */
export function redactSecretValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecretTokens(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretValue(entry)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactSecretValue(entry);
  }
  return redacted as T;
}

export function redactCurrentUserValue<T>(value: T, opts?: CurrentUserRedactionOptions): T {
  if (typeof value === "string") {
    return redactCurrentUserText(value, opts) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCurrentUserValue(entry, opts)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactCurrentUserValue(entry, opts);
  }
  return redacted as T;
}
