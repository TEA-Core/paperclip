import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
      process.env.PAPERCLIP_HOME = path.join(tmpDir, "isolated-home");

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

  describe("assertKeyPathAtBoot orphan sweep (SUP-13136)", () => {
    const envKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    function writeOrphanUnderHome(homeDir: string, content: string): string {
      const orphanPath = path.join(homeDir, ".paperclip", "instances", "default", "secrets", "master.key");
      mkdirSync(path.dirname(orphanPath), { recursive: true });
      writeFileSync(orphanPath, content, { encoding: "utf8", mode: 0o600 });
      return orphanPath;
    }

    it("throws on a readable master.key under PAPERCLIP_HOME at a path different from the configured key path", async () => {
      const homeDir = path.join(tmpDir, "orphan-home");
      const configuredKeyPath = path.join(tmpDir, "configured", "master.key");
      mkdirSync(path.dirname(configuredKeyPath), { recursive: true });
      writeFileSync(configuredKeyPath, envKey, { encoding: "utf8", mode: 0o600 });
      process.env.PAPERCLIP_HOME = homeDir;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = configuredKeyPath;
      writeOrphanUnderHome(homeDir, envKey);

      const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
      expect(() => assertKeyPathAtBoot()).toThrow(/Security violation: readable master.key file/);
    });

    it("throws under the production configuration: env key set, configured path outside PAPERCLIP_HOME, orphan inside home", async () => {
      const homeDir = path.join(tmpDir, "orphan-home-prod");
      const configuredKeyPath = path.join(tmpDir, "configured-prod", "master.key");
      mkdirSync(path.dirname(configuredKeyPath), { recursive: true });
      writeFileSync(configuredKeyPath, envKey, { encoding: "utf8", mode: 0o600 });
      process.env.PAPERCLIP_HOME = homeDir;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = configuredKeyPath;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;
      writeOrphanUnderHome(homeDir, envKey);

      const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
      let message = "";
      try {
        assertKeyPathAtBoot();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/Security violation: readable master.key file/);
      const fingerprints = message.match(/sha256:[0-9a-f]{12}/g) ?? [];
      expect(fingerprints.length).toBeGreaterThan(0);
      expect(message).not.toContain(envKey);
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "does not throw on a genuinely unreadable (EACCES) master.key under PAPERCLIP_HOME, and distinguishes it from the absent case",
      async () => {
        const homeDir = path.join(tmpDir, "orphan-home-eacces");
        process.env.PAPERCLIP_HOME = homeDir;
        const orphanPath = writeOrphanUnderHome(homeDir, envKey);
        chmodSync(orphanPath, 0o000);

        const logger = await import("../middleware/logger.js");
        const warnSpy = vi.spyOn(logger.logger, "warn").mockImplementation(() => logger.logger);

        try {
          const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
          expect(() => assertKeyPathAtBoot()).not.toThrow();

          const unreadableWarns = warnSpy.mock.calls.filter(
            (call) => typeof call[1] === "string" && call[1].includes("not readable by this uid"),
          );
          expect(unreadableWarns).toHaveLength(1);
          expect(unreadableWarns[0][0]).toMatchObject({ keyPath: orphanPath });
        } finally {
          chmodSync(orphanPath, 0o600);
        }
      },
    );

    it("treats the configured key path under PAPERCLIP_HOME as the configured key, not an orphan", async () => {
      const keyPath = path.join(tmpDir, "master.key");
      writeFileSync(keyPath, envKey, { encoding: "utf8", mode: 0o600 });
      process.env.PAPERCLIP_HOME = tmpDir;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey;

      const { assertKeyPathAtBoot } = await import("./local-encrypted-provider.js");
      expect(() => assertKeyPathAtBoot()).not.toThrow();
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
      const resolved = await localEncryptedProvider.resolveVersion({
        material: secret.material,
        externalRef: null,
      });
      expect(resolved).toBe("x");
    });
  });
});
