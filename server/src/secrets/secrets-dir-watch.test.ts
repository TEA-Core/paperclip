import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const tmpDir = path.join(os.tmpdir(), `paperclip-secrets-dir-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function fingerprintPrefix(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 12);
}

function fakeDb(): { db: Db; inserted: unknown[][] } {
  const inserted: unknown[][] = [];
  const db = {
    insert: () => ({
      values: (rows: unknown) => {
        inserted.push(rows as unknown[]);
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
  return { db, inserted };
}

describe("secrets-dir-watch", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("classifies the allowlisted files and produces no observations", async () => {
    writeFileSync(path.join(tmpDir, "master.key"), "master-key-bytes", { encoding: "utf8", mode: 0o600 });
    writeFileSync(path.join(tmpDir, "decision-signing.key"), "signing-key-bytes", { encoding: "utf8", mode: 0o600 });

    const logger = await import("../middleware/logger.js");
    const warnSpy = vi.spyOn(logger.logger, "warn").mockImplementation(() => logger.logger);

    const { scanSecretsDirectory, logUnexpectedObservations, persistUnexpectedObservations } =
      await import("./secrets-dir-watch.js");
    const result = scanSecretsDirectory();

    expect(result.unexpected).toHaveLength(0);
    expect(result.files.map((file) => file.observedFileName).sort()).toEqual([
      "decision-signing.key",
      "master.key",
    ]);

    logUnexpectedObservations(result);
    expect(warnSpy).not.toHaveBeenCalled();

    const { db, inserted } = fakeDb();
    const persisted = await persistUnexpectedObservations(db, result);
    expect(persisted).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("produces exactly one warn-level observation with a fingerprint for an unexpected file", async () => {
    const secret = "a-planted-key-material-0123456789abcdef";
    writeFileSync(path.join(tmpDir, "rogue.key"), secret, { encoding: "utf8", mode: 0o600 });

    const logger = await import("../middleware/logger.js");
    const warnSpy = vi.spyOn(logger.logger, "warn").mockImplementation(() => logger.logger);

    const { scanSecretsDirectory, logUnexpectedObservations, persistUnexpectedObservations } =
      await import("./secrets-dir-watch.js");
    const result = scanSecretsDirectory();

    expect(result.unexpected).toHaveLength(1);
    const observation = result.unexpected[0];
    expect(observation.observedFileName).toBe("rogue.key");
    expect(observation.classification).toBe("unexpected");
    expect(observation.sha256FingerprintPrefix).toBe(fingerprintPrefix(secret));
    expect(observation.sha256FingerprintPrefix).toMatch(/^[0-9a-f]{12}$/);
    expect(Number.isInteger(observation.mtimeMs)).toBe(true);

    logUnexpectedObservations(result);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(warnArg.fileName).toBe("rogue.key");
    expect(warnArg.sha256FingerprintPrefix).toBe(fingerprintPrefix(secret));

    const { db, inserted } = fakeDb();
    const persisted = await persistUnexpectedObservations(db, result);
    expect(persisted).toBe(1);
    expect(inserted).toHaveLength(1);
    const row = inserted[0][0] as Record<string, unknown>;
    expect(row.observedFileName).toBe("rogue.key");
    expect(row.classification).toBe("unexpected");
    expect(Number.isInteger(row.mtimeMs)).toBe(true);
    expect(row.sha256FingerprintPrefix).toBe(fingerprintPrefix(secret));
  });

  it("never leaks key material or a full hash into logs or persisted rows", async () => {
    const secret = "super-secret-key-material-do-not-leak-0123456789";
    writeFileSync(path.join(tmpDir, "rogue.key"), secret, { encoding: "utf8", mode: 0o600 });

    const logger = await import("../middleware/logger.js");
    const warnSpy = vi.spyOn(logger.logger, "warn").mockImplementation(() => logger.logger);

    const { runSecretsDirectoryWatch } = await import("./secrets-dir-watch.js");
    const { db, inserted } = fakeDb();
    await runSecretsDirectoryWatch(db);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const serializedWarn = JSON.stringify(warnSpy.mock.calls[0][0]);
    expect(serializedWarn).not.toContain(secret);
    expect(serializedWarn).not.toMatch(/[0-9a-f]{64}/);

    const row = inserted[0][0] as Record<string, unknown>;
    const serializedRow = JSON.stringify(row);
    expect(serializedRow).not.toContain(secret);
    expect(serializedRow).not.toMatch(/[0-9a-f]{64}/);
    expect(String(row.sha256FingerprintPrefix)).toMatch(/^[0-9a-f]{12}$/);
  });
});
