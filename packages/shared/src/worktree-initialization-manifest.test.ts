import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedStateFileError, readBoundedStateFile, STATE_FILE_MAX_BYTES } from "./bounded-state-file.js";
import {
  classifyWorktreeStateManifest,
  isVerifiedWorktreeSeedManifest,
  WORKTREE_INITIALIZATION_DIAGNOSTIC_LIMIT,
  type WorktreeInitializationExpectation,
  type WorktreeStateManifestClassification,
} from "./worktree-initialization-manifest.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function manifestPath(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-init-manifest-")));
  temporaryRoots.push(root);
  return path.join(root, "seed-manifest.json");
}

const fingerprint = () => `sha256:${randomBytes(32).toString("hex")}`;

/** Every identity value is generated per run; nothing here is a real credential. */
function buildFixture() {
  const generationId = randomUUID();
  const attemptId = randomUUID();
  const expected = {
    targetInstanceId: `wt-${randomBytes(4).toString("hex")}`,
    generationId,
    schema: { schemaFingerprint: fingerprint(), migrationRevision: "0142_fixture.sql" },
  } satisfies WorktreeInitializationExpectation;
  const manifest: Record<string, unknown> = {
    version: 3,
    kind: "worktree-initialization",
    profile: "fresh",
    policyVersion: 1,
    schemaFingerprint: expected.schema.schemaFingerprint,
    migrationRevision: expected.schema.migrationRevision,
    targetInstanceId: expected.targetInstanceId,
    generationId,
    attemptId,
    state: "verified",
    phase: "complete",
    startedAt: "2026-11-11T10:00:00.000Z",
    finishedAt: "2026-11-11T10:00:05.000Z",
    source: null,
    diagnostics: [
      { phase: "pending", code: "attempt_started", status: "started", at: "2026-11-11T10:00:00.000Z" },
      { phase: "complete", code: "fresh_ready", status: "succeeded", at: "2026-11-11T10:00:05.000Z" },
    ],
    validation: {
      kind: "fresh-ready",
      attemptId,
      generationId,
      completedAt: "2026-11-11T10:00:05.000Z",
    },
  };
  return { manifest, expected };
}

/** Write real bytes to a real file, then read them back through the bounded reader. */
function classifyFile(
  contents: string | Buffer,
  expected: WorktreeInitializationExpectation,
): WorktreeStateManifestClassification {
  const filePath = manifestPath();
  fs.writeFileSync(filePath, contents);
  const bytes = readBoundedStateFile(filePath);
  if (bytes === null) throw new Error("fixture manifest disappeared");
  return classifyWorktreeStateManifest(bytes, expected);
}

function refusalReason(classification: WorktreeStateManifestClassification): string {
  return classification.kind === "refused" ? classification.reason : `accepted:${classification.kind}`;
}

function completeLegacyManifest(seedMode: string): Record<string, unknown> {
  return {
    version: 2,
    source: { instanceId: "legacy-source", configPath: "/fixture/source/config.json" },
    snapshotAt: "2026-08-18T00:00:00.000Z",
    seedMode,
    migrationRevision: "0001",
    targetInstanceId: "legacy-target",
    phase: "complete",
    state: "verified",
    attemptId: "attempt",
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:01:00.000Z",
    diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
  };
}

describe("classifyWorktreeStateManifest", () => {
  it("accepts a verified fresh manifest only for the exact policy, identity and schema", () => {
    const { manifest, expected } = buildFixture();
    const accepted = classifyFile(JSON.stringify(manifest), expected);
    expect(accepted.kind).toBe("initialization");

    const synthetic = {
      ...manifest,
      profile: "synthetic-fixture",
      fixtureId: "board-basics",
      fixtureVersion: 1,
    };
    expect(classifyFile(JSON.stringify(synthetic), expected).kind).toBe("initialization");
  });

  it("refuses policy, profile, target, generation and schema mismatches", () => {
    const { manifest, expected } = buildFixture();
    const cases: Array<[Record<string, unknown>, WorktreeInitializationExpectation, string]> = [
      [{ ...manifest, policyVersion: 2 }, expected, "initialization_policy"],
      [{
        ...manifest,
        profile: "structural-preview-v1",
        source: {
          sourceIdentity: "fixture-source",
          companyId: randomUUID(),
          exportSchemaFingerprint: fingerprint(),
          bundleDigest: fingerprint(),
        },
        validation: { ...(manifest.validation as object), kind: "projected-data" },
      }, expected, "initialization_policy"],
      [manifest, { ...expected, targetInstanceId: "wt-other" }, "initialization_mismatch"],
      [manifest, { ...expected, generationId: randomUUID() }, "initialization_mismatch"],
      [manifest, { ...expected, schema: { ...expected.schema, schemaFingerprint: fingerprint() } }, "initialization_mismatch"],
      [manifest, { ...expected, schema: { ...expected.schema, migrationRevision: "0143_other.sql" } }, "initialization_mismatch"],
    ];
    for (const [candidate, expectation, reason] of cases) {
      expect(refusalReason(classifyFile(JSON.stringify(candidate), expectation))).toBe(reason);
    }
  });

  it("refuses a valid manifest when the reader cannot confirm target or schema", () => {
    const { manifest, expected } = buildFixture();
    expect(refusalReason(classifyFile(JSON.stringify(manifest), { ...expected, schema: null })))
      .toBe("initialization_unconfirmed");
    expect(refusalReason(classifyFile(JSON.stringify(manifest), { ...expected, targetInstanceId: null })))
      .toBe("initialization_unconfirmed");
  });

  it("refuses manifests that have not completed", () => {
    const { manifest, expected } = buildFixture();
    const notReady = [
      { ...manifest, state: "pending", phase: "pending", startedAt: null, finishedAt: null, validation: null },
      { ...manifest, state: "running", phase: "schema_migration", finishedAt: null, validation: null },
      { ...manifest, state: "failed", phase: "populate", validation: null },
    ];
    for (const candidate of notReady) {
      expect(refusalReason(classifyFile(JSON.stringify(candidate), expected))).toBe("initialization_not_ready");
    }
  });

  it("rejects a bare verified state and evidence bound to another attempt or generation", () => {
    const { manifest, expected } = buildFixture();
    const validation = manifest.validation as Record<string, unknown>;
    const invalid = [
      { ...manifest, validation: null },
      { ...manifest, validation: { ...validation, attemptId: randomUUID() } },
      { ...manifest, validation: { ...validation, generationId: randomUUID() } },
      { ...manifest, validation: { ...validation, kind: "projected-data" } },
      { ...manifest, validation: { ...validation, completedAt: "2026-11-11T10:00:06.000Z" } },
      { ...manifest, phase: "validation" },
    ];
    for (const candidate of invalid) {
      expect(refusalReason(classifyFile(JSON.stringify(candidate), expected))).toBe("initialization_invalid");
    }
  });

  it("enforces UTC timestamps and coherent terminal rules", () => {
    const { manifest, expected } = buildFixture();
    const invalid = [
      { ...manifest, finishedAt: "2026-11-11T09:59:59.000Z" },
      { ...manifest, startedAt: "2026-11-11T12:00:00+02:00" },
      { ...manifest, startedAt: "2026-02-30T10:00:00.000Z" },
      { ...manifest, state: "pending", phase: "pending", startedAt: "2026-11-11T10:00:00.000Z", finishedAt: null, validation: null },
      { ...manifest, state: "running", phase: "populate", validation: null },
      { ...manifest, state: "failed", phase: "populate", finishedAt: null, validation: null },
      { ...manifest, state: "failed", phase: "populate" },
    ];
    for (const candidate of invalid) {
      expect(refusalReason(classifyFile(JSON.stringify(candidate), expected))).toBe("initialization_invalid");
    }
  });

  it("rejects wrong types, unknown enums and profile-inconsistent source or fixture fields", () => {
    const { manifest, expected } = buildFixture();
    const invalid = [
      { ...manifest, attemptId: 42 },
      { ...manifest, policyVersion: "1" },
      { ...manifest, diagnostics: {} },
      { ...manifest, profile: "clone" },
      { ...manifest, state: "seeded" },
      { ...manifest, phase: "restore" },
      { ...manifest, kind: "seed" },
      { ...manifest, source: { sourceIdentity: "fixture-source" } },
      { ...manifest, fixtureId: "board-basics", fixtureVersion: 1 },
      { ...manifest, profile: "synthetic-fixture" },
      { ...manifest, targetInstanceId: "../parent" },
      {
        ...manifest,
        profile: "structural-preview-v1",
        source: {
          sourceIdentity: "/home/fixture/.paperclip/instances/default/config.json",
          companyId: randomUUID(),
          exportSchemaFingerprint: fingerprint(),
          bundleDigest: fingerprint(),
        },
      },
    ];
    for (const candidate of invalid) {
      expect(refusalReason(classifyFile(JSON.stringify(candidate), expected))).toBe("initialization_invalid");
    }
  });

  it("refuses unexpected fields at every level", () => {
    const { manifest, expected } = buildFixture();
    const diagnostics = manifest.diagnostics as Array<Record<string, unknown>>;
    const invalid = [
      { ...manifest, sourceConfigPath: "/fixture/config.json" },
      { ...manifest, validation: { ...(manifest.validation as object), freshReady: true } },
      { ...manifest, diagnostics: [{ ...diagnostics[0], message: "raw exception text" }] },
    ];
    for (const candidate of invalid) {
      expect(refusalReason(classifyFile(JSON.stringify(candidate), expected))).toBe("initialization_invalid");
    }

    // `__proto__` stays an own, unexpected field rather than a prototype swap.
    const protoText = JSON.stringify(manifest).replace(/^\{/, "{\"__proto__\":{\"polluted\":true},");
    expect(refusalReason(classifyFile(protoText, expected))).toBe("initialization_invalid");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses duplicate fields, which JSON.parse would silently collapse", () => {
    const { manifest, expected } = buildFixture();
    const text = JSON.stringify(manifest);
    const duplicateTopLevel = text.replace(/^\{/, "{\"state\":\"failed\",");
    expect(JSON.parse(duplicateTopLevel).state).toBe("verified");
    expect(refusalReason(classifyFile(duplicateTopLevel, expected))).toBe("malformed");

    const duplicateNested = text.replace("\"kind\":\"fresh-ready\"", "\"kind\":\"projected-data\",\"kind\":\"fresh-ready\"");
    expect(refusalReason(classifyFile(duplicateNested, expected))).toBe("malformed");
  });

  it("bounds diagnostics at the documented limit", () => {
    const { manifest, expected } = buildFixture();
    const entry = { phase: "populate", code: "fixture_rows", status: "succeeded", at: "2026-11-11T10:00:01.000Z" };
    const atLimit = { ...manifest, diagnostics: Array.from({ length: WORKTREE_INITIALIZATION_DIAGNOSTIC_LIMIT }, () => entry) };
    expect(classifyFile(JSON.stringify(atLimit), expected).kind).toBe("initialization");
    const overLimit = { ...atLimit, diagnostics: [...atLimit.diagnostics, entry] };
    expect(refusalReason(classifyFile(JSON.stringify(overLimit), expected))).toBe("initialization_invalid");
  });

  it("refuses empty, truncated, non-object, non-UTF-8 and trailing-garbage input", () => {
    const { manifest, expected } = buildFixture();
    const text = JSON.stringify(manifest);
    for (const contents of [
      "",
      text.slice(0, Math.floor(text.length / 2)),
      "null",
      "[]",
      "\"manifest\"",
      `${text} {}`,
      Buffer.from([0x7b, 0xff, 0x7d]),
    ]) {
      expect(refusalReason(classifyFile(contents, expected))).toBe("malformed");
    }
  });

  it("refuses unknown versions without relabeling", () => {
    const { manifest, expected } = buildFixture();
    for (const version of [1, 4, "3", null]) {
      expect(refusalReason(classifyFile(JSON.stringify({ ...manifest, version }), expected))).toBe("unknown_version");
    }
    const { version: _omitted, ...withoutVersion } = manifest;
    expect(refusalReason(classifyFile(JSON.stringify(withoutVersion), expected))).toBe("unknown_version");
  });

  it("refuses an oversized manifest file before parsing it", () => {
    const { manifest } = buildFixture();
    const filePath = manifestPath();
    fs.writeFileSync(filePath, `${JSON.stringify(manifest)}${" ".repeat(STATE_FILE_MAX_BYTES)}`);
    expect(() => readBoundedStateFile(filePath)).toThrow(BoundedStateFileError);
  });

  it("refuses a v2 minimal-no-secrets manifest as legacy-unsafe and keeps complete minimal and full", () => {
    const { expected } = buildFixture();
    const unsafe = classifyFile(JSON.stringify(completeLegacyManifest("minimal-no-secrets")), expected);
    expect(unsafe).toMatchObject({ kind: "refused", reason: "legacy_unsafe" });
    const message = unsafe.kind === "refused" ? unsafe.message : "";
    expect(message).toMatch(/clean generation/);
    expect(message).toMatch(/cannot be reused, relabeled, or converted/);

    for (const seedMode of ["minimal", "full"]) {
      const legacy = classifyFile(JSON.stringify(completeLegacyManifest(seedMode)), expected);
      expect(legacy.kind).toBe("legacy-seed");
      expect(legacy.kind === "legacy-seed" && isVerifiedWorktreeSeedManifest(legacy.manifest)).toBe(true);
    }
    const bareVerified = classifyFile(JSON.stringify({ version: 2, state: "verified" }), expected);
    expect(bareVerified.kind === "legacy-seed" && isVerifiedWorktreeSeedManifest(bareVerified.manifest)).toBe(false);
  });

  it("never echoes parsed content in a refusal", () => {
    const { manifest, expected } = buildFixture();
    const canary = `canary${randomBytes(16).toString("hex")}`;
    const refusals = [
      classifyFile(`{"${canary}": `, expected),
      classifyFile(JSON.stringify({ ...manifest, [canary]: canary }), expected),
      classifyFile(JSON.stringify({ ...manifest, attemptId: canary }), expected),
      classifyFile(JSON.stringify({ ...manifest, targetInstanceId: canary }), expected),
      classifyFile(JSON.stringify({ ...manifest, version: canary }), expected),
      classifyFile(JSON.stringify({ ...completeLegacyManifest("minimal-no-secrets"), attemptId: canary }), expected),
    ];
    for (const refusal of refusals) {
      expect(refusal.kind).toBe("refused");
      expect(refusal.kind === "refused" && refusal.message.includes(canary)).toBe(false);
    }
  });
});
