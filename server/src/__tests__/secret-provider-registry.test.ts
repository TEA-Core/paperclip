import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePaperclipHomeDir } from "@paperclipai/shared/home-paths";
import { checkSecretProviders, listSecretProviders } from "../secrets/provider-registry.js";

describe("secret provider registry", () => {
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
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
});
