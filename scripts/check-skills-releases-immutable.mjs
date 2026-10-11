import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const RULE_ID = "skills-releases-immutable";
const WAIVER_RE = new RegExp(`paperclip:allow-security\\s+${RULE_ID}\\s*:\\s*\\S.*$`);
const RELEASE_PREFIX = "skills-releases/paperclip/";
const MANIFEST_PATH = `${RELEASE_PREFIX}releases.json`;
const PINNED_PATH = "server/src/__tests__/bundled-skill-releases-frozen.test.ts";

export function parseNameStatusDiff(text) {
  const files = [];
  if (text.includes("\0")) {
    const fields = text.split("\0").filter(Boolean);
    for (let index = 0; index < fields.length;) {
      const record = fields[index++].split("\t");
      const status = record[0];
      if (/^[RC]/.test(status)) {
        const oldPath = record[1] || fields[index++];
        const filePath = record[2] || fields[index++];
        files.push({ status: status[0], oldPath, path: filePath });
      } else {
        const filePath = record[1] || fields[index++];
        files.push({ status: status[0], path: filePath });
      }
    }
    return files.filter((file) => file.path);
  }

  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0];
    if (/^[RC]/.test(status)) {
      files.push({ status: status[0], oldPath: parts[1], path: parts[2] });
    } else {
      files.push({ status: status[0], path: parts[1] });
    }
  }
  return files.filter((file) => file.path);
}

function releaseIdentity(manifest) {
  return new Map(manifest.map((release) => [release.id, release.dir]));
}

function changedExistingReleaseIds(baseManifest, headManifest) {
  const headById = releaseIdentity(headManifest);
  return baseManifest
    .filter((release) => headById.get(release.id) !== release.dir)
    .map((release) => release.id);
}

function changedExistingReleaseDirs(baseManifest, headManifest) {
  const headDirs = new Set(headManifest.map((release) => release.dir));
  return baseManifest.filter((release) => !headDirs.has(release.dir)).map((release) => release.dir);
}

function changedPinnedEntries(basePinned, headPinned) {
  return Object.keys(basePinned).filter(
    (releaseId) => JSON.stringify(basePinned[releaseId]) !== JSON.stringify(headPinned[releaseId]),
  );
}

function hasWaiver(addedLines = []) {
  return addedLines.some((line) => WAIVER_RE.test(line));
}

export function checkReleaseDiff({
  baseManifest,
  headManifest,
  basePinned,
  headPinned,
  changedFiles,
  addedLines = [],
}) {
  const findings = [];
  const existingDirs = new Set(baseManifest.map((release) => release.dir));
  const touchedExistingDirs = new Set();

  for (const file of changedFiles) {
    for (const filePath of [file.oldPath, file.path]) {
      if (!filePath || !filePath.startsWith(RELEASE_PREFIX) || filePath === MANIFEST_PATH) continue;
      const relative = filePath.slice(RELEASE_PREFIX.length);
      const releaseDir = relative.split("/")[0];
      if (existingDirs.has(releaseDir)) touchedExistingDirs.add(releaseDir);
    }
  }

  if (touchedExistingDirs.size > 0 && !hasWaiver(addedLines)) {
    findings.push(
      `Existing release contents are immutable: ${[...touchedExistingDirs].sort().join(", ")}. ` +
        `Add a new release directory instead; deliberate operator re-seeds require ` +
        `paperclip:allow-security ${RULE_ID}: <reason>.`,
    );
  }

  const removedIds = changedExistingReleaseIds(baseManifest, headManifest);
  if (removedIds.length > 0 && !hasWaiver(addedLines)) {
    findings.push(`Existing release id was removed or its dir changed: ${removedIds.join(", ")}.`);
  }

  const removedDirs = changedExistingReleaseDirs(baseManifest, headManifest);
  if (removedDirs.length > 0 && !hasWaiver(addedLines)) {
    findings.push(`Existing release dir was removed or renamed: ${removedDirs.join(", ")}.`);
  }

  const changedPins = changedPinnedEntries(basePinned, headPinned);
  if (changedPins.length > 0 && !hasWaiver(addedLines)) {
    findings.push(`Existing release pin changed: ${changedPins.join(", ")}. Existing hashes are immutable.`);
  }

  return [...new Set(findings)];
}

function readTextAt(root, relativePath, revision) {
  if (!revision) return readFileSync(path.join(root, relativePath), "utf8");
  return execFileSync("git", ["show", `${revision}:${relativePath}`], { cwd: root, encoding: "utf8" });
}

function readJsonAt(root, relativePath, revision) {
  return JSON.parse(readTextAt(root, relativePath, revision));
}

export function loadPinnedReleaseFiles(root, revision) {
  const source = readTextAt(root, PINNED_PATH, revision);
  const match = source.match(/const PINNED_RELEASE_FILES[^=]*= (\{[\s\S]*?\n\});/);
  if (!match) throw new Error(`Could not find PINNED_RELEASE_FILES in ${PINNED_PATH}`);
  const pinned = {};
  for (const releaseMatch of match[1].matchAll(/(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*:\s*\{([\s\S]*?)\}/g)) {
    const releaseId = releaseMatch[1] || releaseMatch[2];
    const files = {};
    for (const fileMatch of releaseMatch[3].matchAll(/"([^"]+)"\s*:\s*"([a-f0-9]{64})"/g)) {
      files[fileMatch[1]] = fileMatch[2];
    }
    pinned[releaseId] = files;
  }
  return pinned;
}

export function checkRepository({
  root,
  baseRoot = root,
  baseRevision,
  headRevision,
  changedFiles,
  addedLines = [],
}) {
  const baseManifest = readJsonAt(baseRoot, "skills-releases/paperclip/releases.json", baseRevision);
  const basePinned = loadPinnedReleaseFiles(baseRoot, baseRevision);
  const headManifest = readJsonAt(root, "skills-releases/paperclip/releases.json", headRevision);
  const headPinned = loadPinnedReleaseFiles(root, headRevision);
  return checkReleaseDiff({
    baseManifest,
    headManifest,
    basePinned,
    headPinned,
    changedFiles,
    addedLines,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const baseSha = process.env.GITHUB_BASE_SHA;
  const diff = readFileSync(0, "utf8");
  const changedFiles = baseSha
    ? parseNameStatusDiff(
        execFileSync("git", ["diff", "--name-status", "-z", `${baseSha}...HEAD`], {
          cwd: root,
          encoding: "utf8",
        }),
      )
    : parseNameStatusDiff(diff);
  const findings = checkRepository({
    root,
    baseRoot: root,
    baseRevision: baseSha,
    headRevision: process.env.GITHUB_HEAD_SHA,
    changedFiles,
    addedLines: diff.includes("\0")
      ? []
      : diff.split("\n").filter((line) => line.startsWith("+")),
  });
  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  }
}
