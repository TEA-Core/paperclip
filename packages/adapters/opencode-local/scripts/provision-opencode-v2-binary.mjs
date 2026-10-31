#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Provisions the exact OpenCode V2 CLI version that
// `OPENCODE_V2_CLI_VERSION` pins, so `real-binary.acceptance.test.ts` can be
// reproduced from a clean checkout with one command instead of a manually
// supplied binary.
//
// The pin file is the only place a digest appears, and `src/server/
// v2-acceptance-pin.test.ts` fails the default suite when its version drifts
// from `OPENCODE_V2_CLI_VERSION`. Tarballs are fetched with `npm pack` and the
// sha512 of the received tarball must equal the pinned integrity before the
// binary is ever executed — the digest-verified fetch that `SANDBOX_INSTALL_
// COMMAND` (`curl | bash`) cannot do.
//
// musl and any platform not listed in the pin file are refused rather than
// guessed at; an operator on such a host points the suite at their own binary
// with PAPERCLIP_OPENCODE_V2_BINARY, which takes precedence over this module.

const PIN = JSON.parse(
  readFileSync(join(import.meta.dirname, "opencode-v2-acceptance-pin.json"), "utf8"),
);

const DEFAULT_TIMEOUT_MS = 600_000;

function currentPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function defaultCacheDir() {
  const override = process.env.PAPERCLIP_OPENCODE_V2_CACHE_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".cache", "paperclip", "opencode-v2-acceptance");
}

function tarballIntegrity(tarballPath) {
  const digest = createHash("sha512").update(readFileSync(tarballPath)).digest("base64");
  return `sha512-${digest}`;
}

function binarySha256(binaryPath) {
  return createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
}

function probeReportsVersion(binaryPath, version, timeoutMs) {
  const probe = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: Math.min(timeoutMs, 60_000),
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) return false;
  // Same shape `parseOpenCodeCliVersion` accepts; the binary reports
  // `opencode v2.2.4`, not a bare number.
  const observed = `${String(probe.stdout)}\n${String(probe.stderr)}`
    .match(/(?:^|\s|v)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
  return observed === version;
}

function runNpmPack(packageName, version, destination, timeoutMs) {
  const result = spawnSync(
    "npm",
    [
      "pack",
      `${packageName}@${version}`,
      "--pack-destination",
      destination,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
  );
  if (result.error) {
    throw new Error(`Could not run npm to fetch ${packageName}@${version}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(0, 2_000);
    throw new Error(`npm pack ${packageName}@${version} failed: ${detail || `exit ${result.status}`}`);
  }
  const tarballName = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
  if (!tarballName) {
    throw new Error(`npm pack ${packageName}@${version} did not report a tarball filename.`);
  }
  return join(destination, tarballName);
}

function extractTarball(tarballPath, destination, packageName, version, timeoutMs) {
  mkdirSync(destination, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", tarballPath, "-C", destination], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (untar.error || untar.status !== 0) {
    const detail = `${untar.stderr ?? ""}${untar.stdout ?? ""}`.trim().slice(0, 2_000);
    throw new Error(`Could not extract ${packageName}@${version}: ${detail || `exit ${untar.status}`}`);
  }
  return join(destination, "package");
}

function packageBinPath(packageRoot, packageName, version) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== packageName || packageJson.version !== version) {
    throw new Error(
      `Expected ${packageName}@${version}, received ${String(packageJson.name)}@${String(packageJson.version)}`,
    );
  }
  const bin = packageJson.bin;
  const relative =
    typeof bin === "string" ? bin : Object.values(bin ?? {})[0] ?? "bin/opencode";
  const source = join(packageRoot, relative);
  if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${packageName}@${version} did not contain an executable at ${relative}`);
  }
  return source;
}

export function provisionOpenCodeV2AcceptanceBinary(options = {}) {
  const version = options.version ?? PIN.version;
  if (version !== PIN.version) {
    throw new Error(
      `opencode-v2-acceptance-pin.json pins ${PIN.version}; refusing to provision ${version}. Update the pin file and OPENCODE_V2_CLI_VERSION together.`,
    );
  }
  const platformKey = options.platformKey ?? currentPlatformKey();
  const entry = PIN.platforms?.[platformKey];
  if (!entry) {
    throw new Error(
      `No pinned OpenCode ${version} release for ${platformKey}. Set PAPERCLIP_OPENCODE_V2_BINARY to an absolute path to a verified ${version} binary.`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const versionDir = join(options.cacheDir ?? defaultCacheDir(), version, platformKey);
  const binary = join(versionDir, "bin", "opencode");

  if (lstatSync(binary, { throwIfNoEntry: false })?.isFile()) {
    chmodSync(binary, 0o755);
    if (probeReportsVersion(binary, version, timeoutMs)) {
      return {
        binary,
        version,
        package: entry.package,
        platform: platformKey,
        cached: true,
        binarySha256: binarySha256(binary),
      };
    }
    rmSync(binary, { force: true });
  }

  mkdirSync(join(versionDir, "bin"), { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "paperclip-opencode-v2-provision-"));
  const staged = join(versionDir, `opencode.staged-${process.pid}`);
  try {
    const tarball = runNpmPack(entry.package, version, workDir, timeoutMs);
    const observed = tarballIntegrity(tarball);
    if (observed !== entry.integrity) {
      throw new Error(
        `Tarball integrity mismatch for ${entry.package}@${version}: pinned ${entry.integrity}, received ${observed}`,
      );
    }
    const packageRoot = extractTarball(tarball, join(workDir, "extract"), entry.package, version, timeoutMs);
    const source = packageBinPath(packageRoot, entry.package, version);
    copyFileSync(source, staged);
    chmodSync(staged, 0o755);
    if (!probeReportsVersion(staged, version, timeoutMs)) {
      throw new Error(`Provisioned OpenCode binary did not report ${version} from --version.`);
    }
    renameSync(staged, binary);
    const result = {
      binary,
      version,
      package: entry.package,
      platform: platformKey,
      cached: false,
      tarballIntegrity: observed,
      binarySha256: binarySha256(binary),
    };
    writeFileSync(
      join(versionDir, "provision-manifest.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return result;
  } finally {
    rmSync(staged, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : null;

if (invokedPath === import.meta.url) {
  try {
    const result = provisionOpenCodeV2AcceptanceBinary();
    if (process.argv.includes("--print-path")) {
      process.stdout.write(`${result.binary}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
