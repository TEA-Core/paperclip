import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePaperclipHomeDir } from "@paperclipai/shared/home-paths";
import { checkSecretProviders, listSecretProviders } from "../secrets/provider-registry.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

describe("secret provider registry", () => {
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const previousAllowKeyGeneration = process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
  const tmpDirs: string[] = [];

  afterEach(() => {
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    if (previousMasterKey === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
    if (previousAllowKeyGeneration === undefined) {
      delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;
    } else {
      process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = previousAllowKeyGeneration;
    }
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describes managed and external-reference provider capabilities", () => {
    const descriptors = listSecretProviders();

    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local_encrypted",
          supportsManagedValues: true,
          supportsExternalReferences: false,
          configured: true,
        }),
        expect.objectContaining({
          id: "aws_secrets_manager",
          supportsManagedValues: true,
          supportsExternalReferences: true,
          configured: false,
        }),
      ]),
    );
  });

  it("warns when the local encrypted key file is readable by group or others", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    writeFileSync(keyFile, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o644 });
    chmodSync(keyFile, 0o644);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "warn",
      details: { keyFilePath: keyFile },
    });
    expect(local?.warnings?.join("\n")).toContain("chmod 600");
    expect(local?.backupGuidance?.join("\n")).toContain("database");
  });

  it("rejects an explicit PAPERCLIP_SECRETS_MASTER_KEY_FILE inside the Paperclip home dir", async () => {
    const insideHome = path.join(resolvePaperclipHomeDir(), "secrets", "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = insideHome;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "error",
      details: { keySource: "file", keyFilePath: insideHome },
    });
    expect(local?.message).toContain("Security violation");
  });

  it("accepts an explicit PAPERCLIP_SECRETS_MASTER_KEY_FILE outside the Paperclip home dir", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const outsideKey = path.join(dir, "master.key");
    writeFileSync(outsideKey, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = outsideKey;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "ok",
      details: { keySource: "file", keyFilePath: outsideKey },
    });
  });

  it("refuses to auto-generate a master key when PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION is not set", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;

    await expect(
      localEncryptedProvider.createSecret({
        value: "test-secret",
        context: { companyId: "test", secretKey: "key", secretName: "name", version: 1 },
      }),
    ).rejects.toThrow(/PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION/);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("generates a master key when PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION is set to 1", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = "1";

    const result = await localEncryptedProvider.createSecret({
      value: "test-secret",
      context: { companyId: "test", secretKey: "key", secretName: "name", version: 1 },
    });
    expect(result.material).toHaveProperty("scheme", "local_encrypted_v1");
    expect(result.valueSha256).toBeTruthy();

    const resolved = await localEncryptedProvider.resolveVersion({
      material: result.material,
      externalRef: null,
      context: { companyId: "test", secretId: "secret-1", secretKey: "key", version: 1 },
    });
    expect(resolved).toBe("test-secret");
  });

  it("health check reports warn with allowKeyGeneration=false when key file is missing", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "warn",
      details: { keySource: "file", keyFilePath: keyFile, allowKeyGeneration: false },
    });
    expect(local?.warnings?.join("\n")).toContain("PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION");
  });

  it("refuses to auto-generate a master key when PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION is not set", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;

    await expect(
      localEncryptedProvider.createSecret({
        value: "test-secret",
        context: { companyId: "test", secretKey: "key", secretName: "name", version: 1 },
      }),
    ).rejects.toThrow(/PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION/);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("generates a master key when PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION is set to 1", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = "1";

    const result = await localEncryptedProvider.createSecret({
      value: "test-secret",
      context: { companyId: "test", secretKey: "key", secretName: "name", version: 1 },
    });
    expect(result.material).toHaveProperty("scheme", "local_encrypted_v1");
    expect(result.valueSha256).toBeTruthy();

    const resolved = await localEncryptedProvider.resolveVersion({
      material: result.material,
      externalRef: null,
      context: { companyId: "test", secretId: "secret-1", secretKey: "key", version: 1 },
    });
    expect(resolved).toBe("test-secret");
  });

  it("health check reports warn with allowKeyGeneration=false when key file is missing", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION;

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "warn",
      details: { keySource: "file", keyFilePath: keyFile, allowKeyGeneration: false },
    });
    expect(local?.warnings?.join("\n")).toContain("PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION");
  });

  it("health check reports warn with allowKeyGeneration=true when key file is missing and generation is enabled", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION = "1";

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "warn",
      details: { keySource: "file", keyFilePath: keyFile, allowKeyGeneration: true },
    });
    expect(local?.warnings?.join("\n")).toContain("PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION is enabled");
  });
});
