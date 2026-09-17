import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Immutability guard for the bundled Paperclip skill releases.
 *
 * Every release under skills-releases/paperclip/<dir>/ is a frozen snapshot.
 * The first time a company lists its skills, ensureBundledSkillReleases seeds
 * each release into company_skill_versions. On every later run it hashes the
 * shipped files again and throws "Bundled skill release <id> does not match its
 * seeded snapshot." when they differ. That throw aborts run setup, so changing
 * one byte of an existing release fails EVERY agent run on every database that
 * was seeded before the change, with setup_failed. Fresh CI databases seed from
 * the edited files, so CI stays green. This happened in production on
 * 2026-09-17: a one-sentence note added to v0/SKILL.md and v7-roster/SKILL.md
 * stopped all agent work until the files were restored.
 *
 * If this test fails because you edited a release: revert the release files.
 * Put new guidance in skills/paperclip/ (the live skill) or ship it as a NEW
 * release directory plus a releases.json entry. Do NOT update the hashes below
 * to match an edit. The only legitimate change to PINNED_RELEASE_FILES is adding
 * a block for a brand-new release.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const releasesRoot = path.join(repoRoot, "skills-releases", "paperclip");

const PINNED_RELEASE_FILES: Record<string, Record<string, string>> = {
  v0: {
    "SKILL.md": "5d5d6c01fa558870768fd2ab1250476912b9c7002099664b0ebdb3d0df283279",
    "references/api-reference.md": "44aa30764c85dbf3d231c4947b7a5d256a9282c6060d7f5da3d939a02b8d1fab",
    "references/artifacts.md": "ad0850fe6ad03cbea5c32d2f50e65a801e2b178623591950c24fdf1f4f6f8740",
    "references/cases.md": "4b2a64820f5e5a54878abfddcc8dc5a201fd91d5cb6d955da00228535259c424",
    "references/company-skills.md": "b6f921df316423444cfc11691fa34beef6581a63c549e0e08342958a20bf0c00",
    "references/issue-workspaces.md": "0bb8d7c077d04bd1e330428ee1b3201ca3fb35357758771d5af16e9de4a4efa4",
    "references/routines.md": "b8ee3c6c085813760a65dfd2bfda1a2308c1b3eb1f702fc228aba970505bc936",
    "references/workflows.md": "b3d9f86ed9e59048957d65b528ef173bd3c629dff4229e319498e0a5b6bf54f2",
    "scripts/paperclip-upload-artifact.sh": "8513625cc8851c15b24f1cbf68d44f9b6f488dbfd1c372f3c4599b846770cda8",
  },
  "v7-roster": {
    "SKILL.md": "53ab290489684cbf116fdd1406a95f6b6f53c9c36358b1bf8bfeae481e253575",
    "references/api-reference.md": "44aa30764c85dbf3d231c4947b7a5d256a9282c6060d7f5da3d939a02b8d1fab",
    "references/artifacts.md": "ad0850fe6ad03cbea5c32d2f50e65a801e2b178623591950c24fdf1f4f6f8740",
    "references/cases.md": "3b821f59064a7761091020a14819a8d787131f24029748563d6c0e1be7e6eaec",
    "references/company-skills.md": "b6f921df316423444cfc11691fa34beef6581a63c549e0e08342958a20bf0c00",
    "references/issue-workspaces.md": "0bb8d7c077d04bd1e330428ee1b3201ca3fb35357758771d5af16e9de4a4efa4",
    "references/routines.md": "b8ee3c6c085813760a65dfd2bfda1a2308c1b3eb1f702fc228aba970505bc936",
    "references/workflows.md": "69747bd6e05f7e3673d1e67b07ff295df1869c05e1fd029804d5fa9177db92cd",
    "scripts/paperclip-upload-artifact.sh": "8513625cc8851c15b24f1cbf68d44f9b6f488dbfd1c372f3c4599b846770cda8",
  },
};

function hashReleaseDir(releaseDir: string, current = releaseDir, out: Record<string, string> = {}) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      hashReleaseDir(releaseDir, absolutePath, out);
    } else if (entry.isFile()) {
      const relativePath = path.relative(releaseDir, absolutePath).split(path.sep).join("/");
      out[relativePath] = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
    }
  }
  return out;
}

const registry = JSON.parse(readFileSync(path.join(releasesRoot, "releases.json"), "utf8")) as Array<{
  id: string;
  dir: string;
}>;

describe("bundled skill releases are frozen", () => {
  it("pins every release listed in releases.json", () => {
    expect(registry.map((release) => release.id).sort()).toEqual(Object.keys(PINNED_RELEASE_FILES).sort());
  });

  it.each(Object.keys(PINNED_RELEASE_FILES))("release %s is byte-identical to its seeded snapshot", (releaseId) => {
    const release = registry.find((entry) => entry.id === releaseId);
    expect(release, `releases.json no longer lists pinned release ${releaseId}`).toBeDefined();
    const actual = hashReleaseDir(path.join(releasesRoot, release!.dir));
    expect(
      actual,
      `skills-releases/paperclip/${release!.dir} changed. Existing releases are immutable: revert the edit `
        + "(see the comment at the top of this file). Do not update the pinned hashes.",
    ).toEqual(PINNED_RELEASE_FILES[releaseId]);
  });
});
