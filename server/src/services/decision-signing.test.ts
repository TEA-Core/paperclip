import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = path.join(os.tmpdir(), `paperclip-decision-signing-test-${randomUUID()}`);

describe("decision-signing", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    delete process.env.PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("generate-if-missing gate (SUP-13017)", () => {
    it("throws and writes no file when the opt-in is unset (NODE_ENV unset)", async () => {
      delete process.env.NODE_ENV;
      delete process.env.PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION;

      const { resolveDecisionSigningSecret } = await import("./decision-signing.js");
      let message = "";
      try {
        resolveDecisionSigningSecret();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/Refusing to auto-generate a signing key/);
      expect(message).toMatch(/PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION is not set to "1"/);

      const keyPath = path.join(tmpDir, "decision-signing.key");
      expect(() => require("node:fs").statSync(keyPath)).toThrow();
    });

    it("throws and writes no file when the opt-in is unset (NODE_ENV=development)", async () => {
      process.env.NODE_ENV = "development";
      delete process.env.PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION;

      const { resolveDecisionSigningSecret } = await import("./decision-signing.js");
      let message = "";
      try {
        resolveDecisionSigningSecret();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/Refusing to auto-generate a signing key/);

      const keyPath = path.join(tmpDir, "decision-signing.key");
      expect(() => require("node:fs").statSync(keyPath)).toThrow();
    });

    it("allows generation when the opt-in is set to '1'", async () => {
      process.env.PAPERCLIP_DECISION_SIGNING_ALLOW_KEY_GENERATION = "1";

      const { resolveDecisionSigningSecret } = await import("./decision-signing.js");
      const secret = resolveDecisionSigningSecret();
      expect(secret.length).toBeGreaterThanOrEqual(32);

      const keyPath = path.join(tmpDir, "decision-signing.key");
      expect(require("node:fs").existsSync(keyPath)).toBe(true);
    });
  });

  describe("verifyDecisionSpec key-rotation detection (SUP-13017)", () => {
    it("reports key_rotation when the signing secret is replaced (secret A signs, secret B verifies)", async () => {
      const secretA = "a".repeat(60);
      const secretB = "b".repeat(60);

      process.env.PAPERCLIP_DECISION_SIGNING_SECRET = secretA;

      const { signDecisionSpec, verifyDecisionSpec } = await import("./decision-signing.js");
      const spec = { id: "test-decision", options: [{ id: "opt1", effects: [] }] };
      const signature = signDecisionSpec(spec);

      process.env.PAPERCLIP_DECISION_SIGNING_SECRET = secretB;

      const result = verifyDecisionSpec(spec, signature);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("key_rotation");
      expect(result.message).toMatch(/rotated|rotation/i);
    });

    it("reports tampered when the same key is used but the spec is modified", async () => {
      const secret = "a".repeat(60);
      process.env.PAPERCLIP_DECISION_SIGNING_SECRET = secret;

      const { signDecisionSpec, verifyDecisionSpec } = await import("./decision-signing.js");
      const spec = { id: "test-decision", options: [{ id: "opt1", effects: [] }] };
      const signature = signDecisionSpec(spec);

      const tamperedSpec = { id: "test-decision", options: [{ id: "opt2", effects: [] }] };
      const result = verifyDecisionSpec(tamperedSpec, signature);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("tampered");
      expect(result.message).toMatch(/does not match its signature/);
    });

    it("reports tampered when no env secret is set and the file key is the only source", async () => {
      process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "a".repeat(60);

      const { signDecisionSpec, verifyDecisionSpec } = await import("./decision-signing.js");

      const spec = { id: "test-decision", options: [{ id: "opt1", effects: [] }] };
      const signature = signDecisionSpec(spec);

      const result = verifyDecisionSpec(spec, "decision-spec-v1.deadbeef");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("tampered");
      expect(result.message).toMatch(/does not match its signature/);
    });

    it("succeeds when the same key is used to sign and verify", async () => {
      process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "a".repeat(60);

      const { signDecisionSpec, verifyDecisionSpec } = await import("./decision-signing.js");

      const spec = { id: "test-decision", options: [{ id: "opt1", effects: [] }] };
      const signature = signDecisionSpec(spec);

      const result = verifyDecisionSpec(spec, signature);
      expect(result.ok).toBe(true);
    });
  });

  describe("assertDecisionSigningKeyPathAtBoot (SUP-13017)", () => {
    it("logs the resolved key path and fingerprints", async () => {
      process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      const logger = await import("../middleware/logger.js");
      const spy = vi.spyOn(logger.logger, "info").mockImplementation(() => logger.logger);

      const { assertDecisionSigningKeyPathAtBoot } = await import("./decision-signing.js");
      assertDecisionSigningKeyPathAtBoot();

      expect(spy).toHaveBeenCalled();
      const callArg = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.keySource).toBe("env");
      expect(callArg.envKeyFingerprint).toBeTruthy();
      expect(callArg.envKeyFingerprint).not.toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("logs fileKeyFingerprint when a key file exists", async () => {
      const keyPath = path.join(tmpDir, "decision-signing.key");
      writeFileSync(keyPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        encoding: "utf8",
        mode: 0o600,
      });

      const logger = await import("../middleware/logger.js");
      const spy = vi.spyOn(logger.logger, "info").mockImplementation(() => logger.logger);

      const { assertDecisionSigningKeyPathAtBoot } = await import("./decision-signing.js");
      assertDecisionSigningKeyPathAtBoot();

      expect(spy).toHaveBeenCalled();
      const callArg = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.fileKeyFingerprint).toBeTruthy();
      expect(callArg.fileKeyFingerprint).not.toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });
  });

  describe("countStaleSignedDecisions (SUP-13017)", () => {
    it("returns null when the DB query throws", async () => {
      const db = {
        select: vi.fn(() => {
          throw new Error("connection refused");
        }),
      };

      const { countStaleSignedDecisions } = await import("./decision-signing.js");
      const result = await countStaleSignedDecisions(db as any);
      expect(result).toBeNull();
    });

    it("returns the count of decisions older than container start", async () => {
      const fakeRows = [{ count: 42 }];
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(fakeRows)),
          })),
        })),
      };

      const { countStaleSignedDecisions } = await import("./decision-signing.js");
      const result = await countStaleSignedDecisions(db as any);
      expect(result).not.toBeNull();
      expect(result!.count).toBe(42);
      expect(result!.containerStart).toBeInstanceOf(Date);
    });

    it("returns 0 when no stale decisions exist", async () => {
      const fakeRows = [{ count: 0 }];
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(fakeRows)),
          })),
        })),
      };

      const { countStaleSignedDecisions } = await import("./decision-signing.js");
      const result = await countStaleSignedDecisions(db as any);
      expect(result).not.toBeNull();
      expect(result!.count).toBe(0);
    });
  });
});
