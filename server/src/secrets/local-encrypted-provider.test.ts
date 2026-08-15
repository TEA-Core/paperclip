import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipHomeDir } from "@paperclipai/shared/home-paths";

const tmpDir = path.join(os.tmpdir(), `paperclip-secrets-test-${randomUUID()}`);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe("local-encrypted-provider", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("loadOrCreateMasterKey env-key-vs-file divergence", () => {
    const envKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const fileKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    it("refuses when env key disagrees with the key file", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, fileKey, { encoding: "utf8", mode: 0o600 });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;

      const { localEncryptedProvider } = await import("./local-encrypted-provider.js");
      let message = "";
      try {
        await localEncryptedProvider.createSecret({ value: "test" });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/Refusing to start: the master key file at.*disagrees with PAPERCLIP_SECRETS_MASTER_KEY/);
      const fingerprints = message.match(/sha256:[0-9a-f]{12}/g) ?? [];
      expect(fingerprints).toHaveLength(2);
      expect(message).not.toContain(envKey);
      expect(message).not.toContain(fileKey);
    });

    it("succeeds when env key matches the key file", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, envKey, { encoding: "utf8", mode: 0o600 });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;

      const { localEncryptedProvider } = await import("./local-encrypted-provider.js");
      const result = await localEncryptedProvider.createSecret({ value: "test" });
      expect(result.material.scheme).toBe("local_encrypted_v1");
    });

    it("succeeds when env key is set and no key file exists", async () => {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;

      const { localEncryptedProvider } = await import("./local-encrypted-provider.js");
      const result = await localEncryptedProvider.createSecret({ value: "test" });
      expect(result.material.scheme).toBe("local_encrypted_v1");
    });

    it("reads the key file to verify env key matches when env key is set and file exists", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, envKey, { encoding: "utf8", mode: 0o600 });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;

      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockClear();
      const { localEncryptedProvider } = await import("./local-encrypted-provider.js");
      await localEncryptedProvider.createSecret({ value: "test" });
      expect(fs.readFileSync).toHaveBeenCalledWith(keyPath, "utf8");
    });
  });

  describe("assertKeyPathAtBoot", () => {
    it("logs the resolved key path and fingerprints", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", {
        encoding: "utf8",
        mode: 0o600,
      });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const logger = await import("../middleware/logger.js");
      const spy = vi.spyOn(logger.logger, "info").mockImplementation(() => logger.logger);

      const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
      assertKeyPathAtBoot();

      expect(spy).toHaveBeenCalled();
      const callArg = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.keyPath).toBe(keyPath);
      expect(callArg.keySource).toBe("env");
      expect(callArg.insidePaperclipHome).toBe(false);
      expect(callArg.envKeyFingerprint).toBeTruthy();
      expect(callArg.fileKeyFingerprint).toBeTruthy();
    });

    it("reports insidePaperclipHome=true when key path is inside PAPERCLIP_HOME", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", {
        encoding: "utf8",
        mode: 0o600,
      });
      process.env.PAPERCLIP_HOME = tmpDir;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const logger = await import("../middleware/logger.js");
      const spy = vi.spyOn(logger.logger, "info").mockImplementation(() => logger.logger);

      const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
      assertKeyPathAtBoot();

      expect(spy).toHaveBeenCalled();
      const callArg = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.keyPath).toBe(keyPath);
      expect(callArg.insidePaperclipHome).toBe(true);
    });

    it("emits a WARN when key path is inside Paperclip home and env key is set", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", {
        encoding: "utf8",
        mode: 0o600,
      });
      process.env.PAPERCLIP_HOME = tmpDir;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const logger = await import("../middleware/logger.js");
      const warnSpy = vi.spyOn(logger.logger, "warn").mockImplementation(() => logger.logger);

      const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
      assertKeyPathAtBoot();

      expect(warnSpy).toHaveBeenCalled();
      const warnArg = warnSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(warnArg.keyPath).toBe(keyPath);
    });

    it("does not emit a WARN when key path is inside Paperclip home and no env key is set", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", {
        encoding: "utf8",
        mode: 0o600,
      });
      process.env.PAPERCLIP_HOME = tmpDir;
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

      const logger = await import("../middleware/logger.js");
      const warnSpy = vi.spyOn(logger.logger, "warn").mockImplementation(() => logger.logger);

      const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
      assertKeyPathAtBoot();

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("healthCheck env-key-vs-file divergence", () => {
    const envKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const fileKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    it("reports error when env key disagrees with the key file", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, fileKey, { encoding: "utf8", mode: 0o600 });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;

      const { localEncryptedProvider } = await import("./local-encrypted-provider.js");
      const health = await localEncryptedProvider.healthCheck();
      expect(health.status).toBe("error");
      expect(health.message).toBe(
        `Master key file at ${keyPath} disagrees with PAPERCLIP_SECRETS_MASTER_KEY ` +
          `(env sha256:a8ae6e6ee929 vs file sha256:7b9d07f2404b). ` +
          `Remove the stray key file or align PAPERCLIP_SECRETS_MASTER_KEY with the file.`,
      );
      const fingerprints = health.message.match(/sha256:[0-9a-f]{12}/g) ?? [];
      expect(fingerprints).toHaveLength(2);
      expect(health.message).not.toContain(envKey);
      expect(health.message).not.toContain(fileKey);
      expect(health.details).toEqual({
        keySource: "env",
        keyFilePath: keyPath,
        envKeyFingerprint: "a8ae6e6ee929",
        fileKeyFingerprint: "7b9d07f2404b",
      });
    });
  });

  describe("enforceKeyPathIsolation with env key set (SUP-12990)", () => {
    it("createSecret rejects when env key is set and the resolved key path is inside the Paperclip home volume", async () => {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
        resolvePaperclipHomeDir(),
        "secrets",
        "master.key",
      );

      const { localEncryptedProvider } = await import("./local-encrypted-provider.js");
      await expect(localEncryptedProvider.createSecret({ value: "x" })).rejects.toThrow(
        /Security violation/,
      );
    });

    it("createSecret and resolveVersion succeed when env key is set and the key file is isolated (outside home)", async () => {
      const envKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      writeFileSync(path.join(tmpDir, "master.key"), envKey, {
        encoding: "utf8",
        mode: 0o600,
      });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;

      const { localEncryptedProvider } = await import("./local-encrypted-provider.js");
      const secret = await localEncryptedProvider.createSecret({ value: "x" });
      expect(secret.material.scheme).toBe("local_encrypted_v1");
      await localEncryptedProvider.resolveVersion({ material: secret.material });
    });
  });
});
