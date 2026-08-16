import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { count, lte } from "drizzle-orm";
import { decisions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { resolveSecretsKeyDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const VERSION = "decision-spec-v2";
const MIN_SECRET_LENGTH = 32;
const FINGERPRINT_LENGTH = 12;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(secret: string): string {
  return sha256Hex(secret).slice(0, FINGERPRINT_LENGTH);
}

// Beside the master key, not under the Paperclip home volume: an agent that can
// read this key can forge decision signatures, which is the same exposure
// SUP-12234 closed for the master key. Upstream resolves the secrets directory
// from the instance root, where agent workspaces can reach it.
function resolveGeneratedSecretFilePath() {
  return path.join(resolveSecretsKeyDir(), "decision-signing.key");
}

function assertOwnedByCurrentUser(stats: Stats, description: string) {
  if (process.platform === "win32") return;

  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw new Error(`${description} must be owned by the Paperclip process user`);
  }
}

function enforceKeyFilePermissions(keyPath: string) {
  let stats = lstatSync(keyPath);
  if (!stats.isFile()) {
    throw new Error(`Decision signing key at ${keyPath} must be a regular file`);
  }
  assertOwnedByCurrentUser(stats, `Decision signing key at ${keyPath}`);
  if (process.platform === "win32") return;

  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    chmodSync(keyPath, 0o600);
    stats = lstatSync(keyPath);
    if (!stats.isFile()) {
      throw new Error(`Decision signing key at ${keyPath} must be a regular file`);
    }
    assertOwnedByCurrentUser(stats, `Decision signing key at ${keyPath}`);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Decision signing key at ${keyPath} must have permissions 0600`);
    }
  }
}

function enforceSecretsDirectoryPermissions(directoryPath: string) {
  let stats = lstatSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error(`Decision signing secrets directory at ${directoryPath} must be a directory`);
  }
  assertOwnedByCurrentUser(stats, `Decision signing secrets directory at ${directoryPath}`);
  if (process.platform === "win32") return;

  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    chmodSync(directoryPath, 0o700);
    stats = lstatSync(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error(`Decision signing secrets directory at ${directoryPath} must be a directory`);
    }
    assertOwnedByCurrentUser(stats, `Decision signing secrets directory at ${directoryPath}`);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Decision signing secrets directory at ${directoryPath} must have permissions 0700`);
    }
  }
}

function readGeneratedSecret(keyPath: string): string {
  enforceKeyFilePermissions(keyPath);
  const existing = readFileSync(keyPath, "utf8").trim();
  if (existing.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Invalid decision signing key at ${keyPath} (must be at least ${MIN_SECRET_LENGTH} characters); remove the file to regenerate it or set PAPERCLIP_DECISION_SIGNING_SECRET`,
    );
  }
  return existing;
}

function isAlreadyExists(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFound(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function loadOrCreateGeneratedSecret(): string {
  const keyPath = resolveGeneratedSecretFilePath();
  const secretsDirectoryPath = path.dirname(keyPath);
  try {
    enforceSecretsDirectoryPermissions(secretsDirectoryPath);
    return readGeneratedSecret(keyPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const allowKeyGeneration = process.env.PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION === "1";
  if (!allowKeyGeneration) {
    throw new Error(
      `No decision signing key found at ${keyPath} and PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION is not set to "1". ` +
        `Refusing to auto-generate a signing key to prevent silent signature invalidation across container restarts. ` +
        `Set PAPERCLIP_DECISION_SIGNING_SECRET to the existing key, ` +
        `or set PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION=1 to allow one-time key generation.`,
    );
  }

  mkdirSync(secretsDirectoryPath, { recursive: true, mode: 0o700 });
  enforceSecretsDirectoryPermissions(secretsDirectoryPath);
  const generated = randomBytes(32).toString("base64");
  const temporaryPath = `${keyPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    writeFileSync(temporaryPath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    enforceKeyFilePermissions(temporaryPath);

    try {
      // Publish only a complete key. A hard link is atomic and never replaces
      // a key another server process created first.
      linkSync(temporaryPath, keyPath);
      enforceKeyFilePermissions(keyPath);
      return generated;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return readGeneratedSecret(keyPath);
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export function resolveDecisionSigningSecret(): string {
  const fromEnv = process.env.PAPERCLIP_DECISION_SIGNING_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `PAPERCLIP_DECISION_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters when set (unset it to use an auto-generated key)`,
      );
    }
    return fromEnv;
  }
  return loadOrCreateGeneratedSecret();
}

/**
 * Startup guard: resolves the signing secret once so an invalid explicit
 * PAPERCLIP_DECISION_SIGNING_SECRET fails fast and the generated key file is
 * materialized before the first decision write. A missing env var is not an
 * error only when PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION=1 — otherwise
 * the gate refuses to auto-generate, mirroring the master-key guard.
 *
 * Mirrors assertKeyPathAtBoot from local-encrypted-provider.ts: logs the
 * resolved key path and a sha256 fingerprint (never the key itself) once at
 * boot so operators can confirm the same key survives a container restart.
 */
export function assertDecisionSigningKeyPathAtBoot(): void {
  const keyPath = resolveGeneratedSecretFilePath();
  const envSecretRaw = process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
  const hasEnvSecret = envSecretRaw && envSecretRaw.trim().length > 0;
  const envFingerprint = hasEnvSecret ? fingerprint(envSecretRaw.trim()) : null;

  let fileKeyFingerprint: string | null = null;
  if (existsSync(keyPath)) {
    try {
      const raw = readFileSync(keyPath, "utf8").trim();
      if (raw.length >= MIN_SECRET_LENGTH) {
        fileKeyFingerprint = fingerprint(raw);
      }
    } catch {
      // best effort; health check surfaces persistent read problems.
    }
  }

  logger.info(
    {
      keyPath,
      keySource: hasEnvSecret ? "env" : "file",
      envKeyFingerprint: envFingerprint,
      fileKeyFingerprint,
      allowKeyGeneration: process.env.PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION === "1",
    },
    "decision signing key resolved at boot",
  );
}

export function ensureDecisionSigningSecret() {
  resolveDecisionSigningSecret();
}

/**
 * Diagnostic: count decisions whose signedSpec was written before the current
 * container started. These rows are already broken — their signatures can never
 * be verified again because the signing key that produced them is gone.
 *
 * Returns { count, containerStart } or null if the DB is not available.
 * Call this at boot after assertDecisionSigningKeyPathAtBoot to report the
 * already-broken population (SUP-13017 acceptance criterion #6).
 */
export async function countStaleSignedDecisions(db: Db): Promise<{ count: number; containerStart: Date } | null> {
  try {
    const containerStart = new Date(Date.now() - process.uptime() * 1000);
    const result = await db
      .select({ count: count() })
      .from(decisions)
      .where(lte(decisions.createdAt, containerStart));
    return { count: Number(result[0]?.count ?? 0), containerStart };
  } catch {
    return null;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signDecisionSpec(value: unknown) {
  const secret = resolveDecisionSigningSecret();
  const keyFingerprint = fingerprint(secret);
  const mac = createHmac("sha256", secret).update(`${VERSION}:${canonical(value)}`).digest("hex");
  return `${VERSION}.${keyFingerprint}.${mac}`;
}

export function verifyDecisionSpec(value: unknown, signature: string) {
  const parts = signature.split(".");

  // v2 signature: VERSION.keyFingerprint.mac
  if (parts.length === 3 && parts[0] === VERSION) {
    const recordedFingerprint = parts[1];
    const currentFingerprint = fingerprint(resolveDecisionSigningSecret());

    if (recordedFingerprint !== currentFingerprint) {
      return {
        ok: false,
        reason: "key_rotation" as const,
        message:
          `Decision signature verification failed: the signing key was rotated. ` +
          `The current key (sha256:${currentFingerprint}) differs from the key that produced this signature (sha256:${recordedFingerprint}). ` +
          `This usually means the container was replaced and the signing key was regenerated, ` +
          `or PAPERCLIP_DECISION_SIGNING_SECRET was changed. ` +
          `The decision spec may be intact — verify the signature against the previous key before treating it as tampering.`,
      };
    }

    const expectedMac = createHmac("sha256", resolveDecisionSigningSecret())
      .update(`${VERSION}:${canonical(value)}`)
      .digest("hex");
    const expected = Buffer.from(expectedMac);
    const actual = Buffer.from(parts[2]);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "tampered" as const,
      message: `Decision signature verification failed: the decision spec does not match its signature. ` +
        `This may indicate tampering. Current signing key fingerprint: sha256:${currentFingerprint}.`,
    };
  }

  // Legacy v1 signature: decision-spec-v1.mac — recompute the v1 HMAC directly.
  // This format predates key-fingerprint tracking, so rotation cannot be ruled out.
  const currentSecret = resolveDecisionSigningSecret();
  const expectedMac = createHmac("sha256", currentSecret)
    .update(`decision-spec-v1:${canonical(value)}`)
    .digest("hex");
  const expected = Buffer.from(expectedMac);
  const actual = Buffer.from(signature);
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
    return { ok: true };
  }
  const currentFingerprint = fingerprint(currentSecret);
  return {
    ok: false,
    reason: "tampered" as const,
    message: `Decision signature verification failed: the decision spec does not match its signature. ` +
      `This is a legacy signature that predates key-fingerprint tracking, so key rotation cannot be ruled out. ` +
      `Current signing key fingerprint: sha256:${currentFingerprint}.`,
  };
}
