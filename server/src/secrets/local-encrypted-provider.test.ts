import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      await expect(localEncryptedProvider.createSecret({ value: "test" })).rejects.toThrow(
        /Refusing to start: the master key file at.*disagrees with PAPERCLIP_SECRETS_MASTER_KEY/,
      );
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
      expect(health.message).toMatch(/disagrees with PAPERCLIP_SECRETS_MASTER_KEY/);
    });
  });
});
