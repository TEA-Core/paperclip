import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { OPENCODE_V2_CLI_VERSION } from "../index.js";

type PinFile = {
  version: string;
  platforms: Record<string, { package: string; integrity: string }>;
};

// The pin file is the only place a V2 release digest is recorded, so it must
// never drift from the version the adapter actually drives, and the suite it
// provisions for must stay wired into a command someone can run. These checks
// are the guard against the failure mode where a real-binary acceptance suite
// exists but nothing invokes it.
const pinPath = new URL("../../scripts/opencode-v2-acceptance-pin.json", import.meta.url);
const provisionerPath = new URL(
  "../../scripts/provision-opencode-v2-binary.mjs",
  import.meta.url,
);
const rootPackagePath = new URL("../../../../../package.json", import.meta.url);
const workflowPath = new URL(
  "../../../../../.github/workflows/opencode-v2-acceptance.yml",
  import.meta.url,
);

let pin: PinFile;
let rootPackage: { scripts?: Record<string, string> };
let workflow: string;

beforeAll(() => {
  pin = JSON.parse(readFileSync(pinPath, "utf8")) as PinFile;
  rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  workflow = readFileSync(workflowPath, "utf8");
});

describe("OpenCode V2 acceptance pin", () => {
  it("pins the same version the adapter drives", () => {
    expect(pin.version).toBe(OPENCODE_V2_CLI_VERSION);
  });

  it("records a digest-verified platform package for every host it supports", () => {
    const entries = Object.entries(pin.platforms);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map(([key]) => key)).toContain("linux-x64");
    for (const [key, entry] of entries) {
      expect(entry.package).toBe(`@opencode/cli-${key}`);
      // A sha512 integrity is the base64 of 64 digest bytes.
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
  });

  it("ships the provisioner that materializes the pinned binary", () => {
    expect(existsSync(provisionerPath)).toBe(true);
  });

  it("is invoked by a repository command and a CI workflow", () => {
    const command = rootPackage.scripts?.["test:opencode-v2-acceptance"];
    expect(command).toContain("PAPERCLIP_OPENCODE_V2_ACCEPTANCE=1");
    expect(command).toContain("real-binary.acceptance.test.ts");
    expect(workflow).toContain("test:opencode-v2-acceptance");
  });
});
