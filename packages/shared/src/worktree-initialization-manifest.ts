/**
 * Worktree state manifest contract (`.paperclip/seed-manifest.json`).
 *
 * Two generations share the file name:
 *
 * - Version 2 seed manifests, written by the legacy clone seeder. Complete
 *   `minimal` and `full` manifests keep their existing consumer rules. The
 *   retired `minimal-no-secrets` mode is refused as legacy-unsafe: its instance
 *   may hold parent credentials, so it must be replaced by a clean generation and
 *   never relabeled or converted.
 * - Version 3 `worktree-initialization` manifests, for fresh isolated
 *   initialization. A v3 manifest is accepted only for the exact policy, target
 *   identity and destination schema the reader expects, with completed
 *   validation evidence bound to the same attempt and generation.
 *
 * This module is pure and self-contained (no relative imports) so the runtime
 * provisioner can load it through Node's type stripping without a build step.
 * Errors and refusal messages never echo parsed manifest content: they name
 * only fields from this contract and fixed reason codes.
 */

export const WORKTREE_INITIALIZATION_MANIFEST_VERSION = 3;
export const WORKTREE_INITIALIZATION_MANIFEST_KIND = "worktree-initialization";
/** The single initialization policy this code implements. */
export const WORKTREE_INITIALIZATION_POLICY_VERSION = 1;
export const WORKTREE_INITIALIZATION_DIAGNOSTIC_LIMIT = 32;

export const WORKTREE_INITIALIZATION_PROFILES = ["fresh", "synthetic-fixture", "structural-preview-v1"] as const;
export type WorktreeInitializationProfile = (typeof WORKTREE_INITIALIZATION_PROFILES)[number];

/**
 * Profiles the current policy authorizes. Structural preview copies parent
 * relationships, which policy version 1 does not permit: no parent rows are
 * copied into a worktree.
 */
export const WORKTREE_INITIALIZATION_AUTHORIZED_PROFILES: readonly WorktreeInitializationProfile[] = [
  "fresh",
  "synthetic-fixture",
];

export const WORKTREE_INITIALIZATION_STATES = ["pending", "running", "verified", "failed"] as const;
export type WorktreeInitializationState = (typeof WORKTREE_INITIALIZATION_STATES)[number];

export const WORKTREE_INITIALIZATION_PHASES = [
  "pending",
  "destination_validation",
  "generation_create",
  "schema_migration",
  "identity_mint",
  "populate",
  "validation",
  "complete",
] as const;
export type WorktreeInitializationPhase = (typeof WORKTREE_INITIALIZATION_PHASES)[number];

export const WORKTREE_INITIALIZATION_DIAGNOSTIC_STATUSES = ["started", "succeeded", "failed"] as const;
export type WorktreeInitializationDiagnosticStatus = (typeof WORKTREE_INITIALIZATION_DIAGNOSTIC_STATUSES)[number];

export const WORKTREE_INITIALIZATION_VALIDATION_KINDS = ["fresh-ready", "projected-data"] as const;
export type WorktreeInitializationValidationKind = (typeof WORKTREE_INITIALIZATION_VALIDATION_KINDS)[number];

export type WorktreeInitializationDiagnostic = {
  phase: WorktreeInitializationPhase;
  code: string;
  status: WorktreeInitializationDiagnosticStatus;
  at: string;
};

/** Opaque identity of an approved structural export. Never a path, URL or credential. */
export type WorktreeInitializationStructuralSource = {
  sourceIdentity: string;
  companyId: string;
  exportSchemaFingerprint: string;
  bundleDigest: string;
};

export type WorktreeInitializationValidation = {
  kind: WorktreeInitializationValidationKind;
  attemptId: string;
  generationId: string;
  completedAt: string;
};

export type WorktreeInitializationManifest = {
  version: 3;
  kind: typeof WORKTREE_INITIALIZATION_MANIFEST_KIND;
  profile: WorktreeInitializationProfile;
  policyVersion: number;
  schemaFingerprint: string;
  migrationRevision: string;
  targetInstanceId: string;
  generationId: string;
  attemptId: string;
  state: WorktreeInitializationState;
  phase: WorktreeInitializationPhase;
  startedAt: string | null;
  finishedAt: string | null;
  source: WorktreeInitializationStructuralSource | null;
  fixtureId?: string;
  fixtureVersion?: number;
  diagnostics: WorktreeInitializationDiagnostic[];
  validation: WorktreeInitializationValidation | null;
};

/**
 * What the reader knows about the destination it is guarding. `null` means the
 * reader cannot confirm that property, so no v3 manifest can be accepted.
 */
export type WorktreeInitializationExpectation = {
  targetInstanceId: string | null;
  generationId?: string | null;
  schema: { schemaFingerprint: string; migrationRevision: string } | null;
};

export type WorktreeStateManifestRefusalReason =
  | "malformed"
  | "unknown_version"
  | "legacy_unsafe"
  | "initialization_invalid"
  | "initialization_policy"
  | "initialization_mismatch"
  | "initialization_not_ready"
  | "initialization_unconfirmed";

export type WorktreeStateManifestClassification =
  | { kind: "legacy-seed"; manifest: Record<string, unknown> }
  | { kind: "initialization"; manifest: WorktreeInitializationManifest }
  | { kind: "refused"; reason: WorktreeStateManifestRefusalReason; message: string };

export type WorktreeInitializationValidationResult =
  | { ok: true; manifest: WorktreeInitializationManifest }
  | { ok: false; field: string };

export const LEGACY_UNSAFE_SEED_MODE = "minimal-no-secrets";

const LEGACY_UNSAFE_MESSAGE =
  "This worktree was seeded by the retired minimal-no-secrets mode and may hold parent credentials. "
  + "It cannot be reused, relabeled, or converted: retire this instance and create a clean generation "
  + "with a new instance and fresh keys.";

const MAX_JSON_DEPTH = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIAGNOSTIC_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const MANIFEST_REQUIRED_FIELDS = [
  "version",
  "kind",
  "profile",
  "policyVersion",
  "schemaFingerprint",
  "migrationRevision",
  "targetInstanceId",
  "generationId",
  "attemptId",
  "state",
  "phase",
  "startedAt",
  "finishedAt",
  "source",
  "diagnostics",
  "validation",
] as const;
const MANIFEST_OPTIONAL_FIELDS = ["fixtureId", "fixtureVersion"] as const;
const SOURCE_FIELDS = ["sourceIdentity", "companyId", "exportSchemaFingerprint", "bundleDigest"] as const;
const DIAGNOSTIC_FIELDS = ["phase", "code", "status", "at"] as const;
const VALIDATION_FIELDS = ["kind", "attemptId", "generationId", "completedAt"] as const;

class StrictJsonError extends Error {}

/**
 * Strict RFC 8259 parser. Unlike `JSON.parse` it rejects duplicate object keys
 * (which would otherwise silently keep the last value) and bounds nesting, and
 * its errors carry no source text.
 */
export function parseStrictJson(text: string): unknown {
  let index = 0;

  const fail = (): never => {
    throw new StrictJsonError("Manifest is not valid strict JSON.");
  };
  const skipWhitespace = () => {
    while (index < text.length) {
      const char = text.charCodeAt(index);
      if (char === 0x20 || char === 0x09 || char === 0x0a || char === 0x0d) index += 1;
      else break;
    }
  };
  const expectLiteral = (literal: string, value: unknown): unknown => {
    if (text.startsWith(literal, index)) {
      index += literal.length;
      return value;
    }
    return fail();
  };
  const parseString = (): string => {
    if (text[index] !== "\"") fail();
    index += 1;
    let result = "";
    while (index < text.length) {
      const char = text[index];
      const code = text.charCodeAt(index);
      if (char === "\"") {
        index += 1;
        return result;
      }
      if (code < 0x20) fail();
      if (char !== "\\") {
        result += char;
        index += 1;
        continue;
      }
      const escape = text[index + 1];
      index += 2;
      switch (escape) {
        case "\"": result += "\""; break;
        case "\\": result += "\\"; break;
        case "/": result += "/"; break;
        case "b": result += "\b"; break;
        case "f": result += "\f"; break;
        case "n": result += "\n"; break;
        case "r": result += "\r"; break;
        case "t": result += "\t"; break;
        case "u": {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          result += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
          break;
        }
        default:
          fail();
      }
    }
    return fail();
  };
  const parseNumber = (): number => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index, index + 64));
    if (!match) fail();
    index += match![0].length;
    const value = Number(match![0]);
    if (!Number.isFinite(value)) fail();
    return value;
  };
  const parseValue = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) fail();
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      const result: Record<string, unknown> = {};
      const seen = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      for (;;) {
        skipWhitespace();
        const key = parseString();
        if (seen.has(key)) fail();
        seen.add(key);
        skipWhitespace();
        if (text[index] !== ":") fail();
        index += 1;
        const value = parseValue(depth + 1);
        // defineProperty keeps a `__proto__` key an own data property instead of
        // replacing the object's prototype.
        Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return result;
        }
        fail();
      }
    }
    if (char === "[") {
      index += 1;
      const result: unknown[] = [];
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      for (;;) {
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return result;
        }
        fail();
      }
    }
    if (char === "\"") return parseString();
    if (char === "t") return expectLiteral("true", true);
    if (char === "f") return expectLiteral("false", false);
    if (char === "n") return expectLiteral("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return parseNumber();
    return fail();
  };

  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  if (!required.every((field) => Object.prototype.hasOwnProperty.call(value, field))) return false;
  return keys.every((key) => required.includes(key) || optional.includes(key));
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A canonical UTC instant that names a real calendar date. */
function parseUtcTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return parsed;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function validateDiagnostic(value: unknown): boolean {
  return isPlainObject(value)
    && hasExactFields(value, DIAGNOSTIC_FIELDS)
    && includes(WORKTREE_INITIALIZATION_PHASES, value.phase)
    && typeof value.code === "string"
    && DIAGNOSTIC_CODE_PATTERN.test(value.code)
    && includes(WORKTREE_INITIALIZATION_DIAGNOSTIC_STATUSES, value.status)
    && parseUtcTimestamp(value.at) !== null;
}

function validateSource(profile: WorktreeInitializationProfile, value: unknown): boolean {
  if (profile !== "structural-preview-v1") return value === null;
  return isPlainObject(value)
    && hasExactFields(value, SOURCE_FIELDS)
    && isToken(value.sourceIdentity)
    && isUuid(value.companyId)
    && isSha256(value.exportSchemaFingerprint)
    && isSha256(value.bundleDigest);
}

/**
 * Structural validation of a version 3 manifest: exact fields, finite enums,
 * bounded strings and diagnostics, and coherent state/time/evidence rules.
 * It does not decide whether this reader may accept it; see
 * {@link classifyWorktreeStateManifest}.
 */
export function validateWorktreeInitializationManifest(value: unknown): WorktreeInitializationValidationResult {
  const invalid = (field: string): WorktreeInitializationValidationResult => ({ ok: false, field });
  if (!isPlainObject(value)) return invalid("manifest");
  if (!hasExactFields(value, MANIFEST_REQUIRED_FIELDS, MANIFEST_OPTIONAL_FIELDS)) return invalid("fields");
  if (value.version !== WORKTREE_INITIALIZATION_MANIFEST_VERSION) return invalid("version");
  if (value.kind !== WORKTREE_INITIALIZATION_MANIFEST_KIND) return invalid("kind");
  if (!includes(WORKTREE_INITIALIZATION_PROFILES, value.profile)) return invalid("profile");
  const profile = value.profile;
  if (!isPositiveInteger(value.policyVersion)) return invalid("policyVersion");
  if (!isSha256(value.schemaFingerprint)) return invalid("schemaFingerprint");
  if (!isToken(value.migrationRevision)) return invalid("migrationRevision");
  if (!isToken(value.targetInstanceId)) return invalid("targetInstanceId");
  if (!isUuid(value.generationId)) return invalid("generationId");
  if (!isUuid(value.attemptId)) return invalid("attemptId");
  if (!includes(WORKTREE_INITIALIZATION_STATES, value.state)) return invalid("state");
  if (!includes(WORKTREE_INITIALIZATION_PHASES, value.phase)) return invalid("phase");
  if (!validateSource(profile, value.source)) return invalid("source");

  const hasFixtureId = Object.prototype.hasOwnProperty.call(value, "fixtureId");
  const hasFixtureVersion = Object.prototype.hasOwnProperty.call(value, "fixtureVersion");
  if (profile === "synthetic-fixture") {
    if (!isToken(value.fixtureId)) return invalid("fixtureId");
    if (!isPositiveInteger(value.fixtureVersion)) return invalid("fixtureVersion");
  } else if (hasFixtureId || hasFixtureVersion) {
    return invalid("fixtureId");
  }

  if (!Array.isArray(value.diagnostics)) return invalid("diagnostics");
  if (value.diagnostics.length > WORKTREE_INITIALIZATION_DIAGNOSTIC_LIMIT) return invalid("diagnostics");
  if (!value.diagnostics.every(validateDiagnostic)) return invalid("diagnostics");

  const startedAt = value.startedAt === null ? null : parseUtcTimestamp(value.startedAt);
  if (value.startedAt !== null && startedAt === null) return invalid("startedAt");
  const finishedAt = value.finishedAt === null ? null : parseUtcTimestamp(value.finishedAt);
  if (value.finishedAt !== null && finishedAt === null) return invalid("finishedAt");
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) return invalid("finishedAt");

  const state = value.state;
  const phase = value.phase;
  switch (state) {
    case "pending":
      if (phase !== "pending" || startedAt !== null || finishedAt !== null) return invalid("state");
      if (value.validation !== null) return invalid("validation");
      break;
    case "running":
      if (phase === "complete" || startedAt === null || finishedAt !== null) return invalid("state");
      if (value.validation !== null) return invalid("validation");
      break;
    case "failed":
      if (phase === "complete" || finishedAt === null) return invalid("state");
      if (value.validation !== null) return invalid("validation");
      break;
    case "verified": {
      if (phase !== "complete" || startedAt === null || finishedAt === null) return invalid("state");
      // A bare `verified` is not completion: the validation evidence must be
      // bound to this attempt and generation and match the profile's kind.
      const validation = value.validation;
      if (!isPlainObject(validation) || !hasExactFields(validation, VALIDATION_FIELDS)) return invalid("validation");
      const expectedKind = profile === "structural-preview-v1" ? "projected-data" : "fresh-ready";
      if (validation.kind !== expectedKind) return invalid("validation");
      if (validation.attemptId !== value.attemptId) return invalid("validation");
      if (validation.generationId !== value.generationId) return invalid("validation");
      const completedAt = parseUtcTimestamp(validation.completedAt);
      if (completedAt === null || completedAt < startedAt || completedAt > finishedAt) return invalid("validation");
      break;
    }
  }

  return { ok: true, manifest: value as unknown as WorktreeInitializationManifest };
}

function refuse(
  reason: WorktreeStateManifestRefusalReason,
  message: string,
): WorktreeStateManifestClassification {
  return { kind: "refused", reason, message };
}

function classifyInitializationManifest(
  value: Record<string, unknown>,
  expected: WorktreeInitializationExpectation,
): WorktreeStateManifestClassification {
  const validated = validateWorktreeInitializationManifest(value);
  if (!validated.ok) {
    return refuse(
      "initialization_invalid",
      `Worktree initialization manifest is invalid (field: ${validated.field}). Create a clean generation; it will not be repaired or reseeded automatically.`,
    );
  }
  const manifest = validated.manifest;
  if (manifest.policyVersion !== WORKTREE_INITIALIZATION_POLICY_VERSION) {
    return refuse(
      "initialization_policy",
      "Worktree initialization manifest was written under a different initialization policy than this build implements. Use a compatible Paperclip build or create a clean generation.",
    );
  }
  if (!WORKTREE_INITIALIZATION_AUTHORIZED_PROFILES.includes(manifest.profile)) {
    return refuse(
      "initialization_policy",
      "Worktree initialization profile is not authorized by the current initialization policy. Create a clean generation with an authorized profile.",
    );
  }
  if (expected.targetInstanceId !== null && manifest.targetInstanceId !== expected.targetInstanceId) {
    return refuse(
      "initialization_mismatch",
      "Worktree initialization manifest belongs to a different target instance. It will not be adopted; create a clean generation for this instance.",
    );
  }
  if (expected.generationId != null && manifest.generationId !== expected.generationId) {
    return refuse(
      "initialization_mismatch",
      "Worktree initialization manifest belongs to a different generation. It will not be adopted; create a clean generation for this instance.",
    );
  }
  if (
    expected.schema !== null
    && (manifest.schemaFingerprint !== expected.schema.schemaFingerprint
      || manifest.migrationRevision !== expected.schema.migrationRevision)
  ) {
    return refuse(
      "initialization_mismatch",
      "Worktree initialization manifest was produced for a different destination schema. Create a clean generation with this build.",
    );
  }
  if (manifest.state !== "verified") {
    return refuse(
      "initialization_not_ready",
      `Worktree initialization has not completed (state: ${manifest.state}, phase: ${manifest.phase}). Run a clean fresh initialization; no parent data is used as a fallback.`,
    );
  }
  if (expected.targetInstanceId === null || expected.schema === null) {
    return refuse(
      "initialization_unconfirmed",
      "This Paperclip build cannot confirm the target identity and destination schema of a worktree initialization manifest, so it refuses to use it. Use a build that supports fresh worktree initialization.",
    );
  }
  return { kind: "initialization", manifest };
}

/**
 * Decode, strictly parse and classify manifest bytes.
 *
 * - v2 `minimal-no-secrets` is refused as legacy-unsafe.
 * - Any other v2 manifest is returned unchanged for the consumer's existing
 *   legacy rules (complete `minimal`/`full` behaviour is preserved).
 * - v3 is accepted only per {@link WorktreeInitializationExpectation}.
 * - Anything else is refused. Callers must not fall back to a parent source or
 *   trigger an automatic reseed on refusal.
 */
export function classifyWorktreeStateManifest(
  bytes: Uint8Array,
  expected: WorktreeInitializationExpectation,
): WorktreeStateManifestClassification {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = parseStrictJson(text);
  } catch {
    return refuse(
      "malformed",
      "Worktree state manifest is not a complete strict JSON document (empty, truncated, or malformed).",
    );
  }
  if (!isPlainObject(parsed)) {
    return refuse("malformed", "Worktree state manifest is not a JSON object.");
  }
  if (parsed.version === 2) {
    if (parsed.seedMode === LEGACY_UNSAFE_SEED_MODE) return refuse("legacy_unsafe", LEGACY_UNSAFE_MESSAGE);
    return { kind: "legacy-seed", manifest: parsed };
  }
  if (parsed.version === WORKTREE_INITIALIZATION_MANIFEST_VERSION) {
    return classifyInitializationManifest(parsed, expected);
  }
  return refuse(
    "unknown_version",
    "Worktree state manifest has an unsupported version. It will not be relabeled or converted; use a compatible Paperclip build or create a clean generation.",
  );
}

type LegacySeedDiagnostic = {
  phase?: unknown;
  status?: unknown;
  at?: unknown;
};

/**
 * A v2 manifest is readiness evidence only when the complete validation phase
 * was durably recorded. A bare `state: verified` is deliberately insufficient so
 * truncated or hand-edited files cannot start a partially restored workspace.
 */
export function isVerifiedWorktreeSeedManifest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  const source = manifest.source as Record<string, unknown> | null;
  const diagnostics = manifest.diagnostics as LegacySeedDiagnostic[] | null;
  return manifest.version === 2
    && manifest.state === "verified"
    && manifest.phase === "complete"
    && typeof source?.instanceId === "string"
    && source.instanceId.length > 0
    && typeof source.configPath === "string"
    && source.configPath.length > 0
    && (manifest.seedMode === "minimal" || manifest.seedMode === "full")
    && typeof manifest.snapshotAt === "string"
    && manifest.snapshotAt.length > 0
    && typeof manifest.migrationRevision === "string"
    && manifest.migrationRevision.length > 0
    && typeof manifest.targetInstanceId === "string"
    && manifest.targetInstanceId.length > 0
    && typeof manifest.attemptId === "string"
    && manifest.attemptId.length > 0
    && typeof manifest.startedAt === "string"
    && typeof manifest.finishedAt === "string"
    && Array.isArray(diagnostics)
    && diagnostics.some((diagnostic) => (
      diagnostic?.phase === "complete"
      && diagnostic.status === "succeeded"
      && typeof diagnostic.at === "string"
    ));
}
