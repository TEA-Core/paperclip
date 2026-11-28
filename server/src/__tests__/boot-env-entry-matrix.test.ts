import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ledgerUrl = pathToFileURL(path.join(ROOT, "packages/shared/src/boot-env.ts")).href;
const configUrl = pathToFileURL(path.join(ROOT, "server/src/config.ts")).href;
const cliUrl = pathToFileURL(path.join(ROOT, "cli/src/index.ts")).href;
const tsx = createRequire(import.meta.url).resolve("tsx");
const commanderUrl = pathToFileURL(createRequire(cliUrl).resolve("commander")).href;
const shapes = ["clean", "missing-config", "undeclared", "instance", "plain", "nested", "uid"] as const;
const flags = ["none", "config", "data-dir", "instance"] as const;
const trustShapes = [
  "identity", "redirect", "sibling", "custom", "layout", "registry",
  "refused", "directory", "unreadable", "vault", "ancestor", "operator",
] as const;
type Shape = typeof shapes[number] | typeof trustShapes[number];
const protectedKeys = ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
  "PAPERCLIP_SECRETS_PROVIDER", "PAPERCLIP_STORAGE_LOCAL_DIR", "PAPERCLIP_ZZ_UNLISTED"];
const originKeys = Array.from({ length: 16 }, (_, index) => `ZZ_ORIGIN_${index}`);

// Real CLI preAction and runCommand up to its startup UI, followed by the
// in-process server config import. An options getter stops runCommand before
// doctor, seeding or server startup. Each child has its own HOME and snapshot.
// Dynamic imports deliberately exercise the production module-load boundary.
function probe(shape: Shape, flag: typeof flags[number], entry: "server" | "cli") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-entry-matrix-"));
  try {
    const home = path.join(root, "home");
    const checkout = shape === "layout"
      ? path.join(root, "repo", ".paperclip", "worktrees", "checkout")
      : path.join(root, "checkout");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    fs.mkdirSync(home);
    let cwd = checkout;
    if (shape === "nested") {
      cwd = path.join(checkout, "nested");
      fs.mkdirSync(cwd);
    }
    const stateDir = shape === "uid"
      ? path.join(checkout, ".paperclip", `uid-${process.getuid?.() ?? -1}`)
      : path.join(checkout, ".paperclip");
    if (shape !== "plain" && shape !== "ancestor") {
      fs.mkdirSync(stateDir, { recursive: true });
      const declaration = ["instance", "undeclared", "layout", "registry"].includes(shape) ? "" : "PAPERCLIP_IN_WORKTREE=true\n";
      fs.writeFileSync(path.join(stateDir, ".env"), `${declaration}PAPERCLIP_AGENT_JWT_SECRET=fixture-own\nPAPERCLIP_SECRETS_MASTER_KEY=fixture-own\nZZ_PLAIN=fixture-own\n`
        + protectedKeys.map(key => `${key}=file-protected`).join("\n") + "\n"
        + originKeys.map(key => `${key}=own-value`).join("\n") + "\n");
      if (shape !== "missing-config") {
        const instanceRoot = path.join(home, ".paperclip", "instances", "default");
        fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
          $meta: { version: 1, updatedAt: "2026-03-26T00:00:00.000Z", source: "configure" },
          database: { mode: "embedded-postgres", embeddedPostgresDataDir: path.join(instanceRoot, "db"), embeddedPostgresPort: 54329,
            backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: path.join(instanceRoot, "backups") } },
          logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
          server: { deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1", port: 3100, allowedHostnames: [], serveUi: true },
          auth: { baseUrlMode: "explicit", publicBaseUrl: "http://127.0.0.1:3100", disableSignUp: false },
          storage: { provider: "local_disk", localDisk: { baseDir: path.join(instanceRoot, "storage") },
            s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false } },
          secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets/master.key") } },
        }));
      }
    }
    fs.writeFileSync(path.join(cwd, ".env"),
      protectedKeys.map(key => `${key}=cwd-protected`).join("\n") + "\n"
      + originKeys.map(key => `${key}_CWD=cwd-value`).join("\n") + "\n");
    const mainConfig = path.join(home, ".paperclip", "instances", "default", "config.json");
    const dataDir = path.join(root, "data");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, NODE_ENV: "test",
      PAPERCLIP_TELEMETRY_ENABLED: "false", PAPERCLIP_UPDATE_CHECK: "0",
      PAPERCLIP_WORKTREES_DIR: path.join(root, "worktrees"),
      ...(shape === "undeclared" ? { PAPERCLIP_IN_WORKTREE: "true" } : {}),
    };
    const argv = ["run"];
    if (flag === "config") {
      if (entry === "cli") argv.push("--config", mainConfig);
      else env.PAPERCLIP_CONFIG = mainConfig;
    }
    if (flag === "data-dir") {
      if (entry === "cli") argv.push("--data-dir", dataDir);
      else {
        env.PAPERCLIP_HOME = dataDir;
        env.PAPERCLIP_INSTANCE_ID = "default";
        env.PAPERCLIP_CONFIG = path.join(dataDir, "instances", "default", "config.json");
      }
    }
    if (flag === "instance") {
      if (entry === "cli") argv.push("--instance", "custom");
      else env.PAPERCLIP_INSTANCE_ID = "custom";
    }
    const ownEnv = path.join(stateDir, ".env");
    const ownConfig = path.join(stateDir, "config.json");
    const customHome = path.join(root, "custom-worktrees");
    const snapshots = new Map<string, Buffer>();
    if (shape === "identity") {
      fs.appendFileSync(ownEnv, `PAPERCLIP_HOME=${path.join(home, ".paperclip")}\nPAPERCLIP_INSTANCE_ID=default\n`);
    }
    if (shape === "custom" || shape === "sibling") {
      fs.appendFileSync(ownEnv, `PAPERCLIP_HOME=${customHome}\nPAPERCLIP_INSTANCE_ID=custom-id\nPAPERCLIP_WORKTREE_NAME=Custom name\n`);
    }
    if (shape === "redirect" || shape === "sibling") {
      const sibling = path.join(root, "sibling", ".paperclip");
      fs.mkdirSync(sibling, { recursive: true });
      const siblingConfig = path.join(sibling, "config.json");
      const siblingEnv = path.join(sibling, ".env");
      const config = JSON.parse(fs.readFileSync(ownConfig, "utf8"));
      config.database.embeddedPostgresDataDir = path.join(customHome, "instances", "custom-id", "db");
      fs.writeFileSync(siblingConfig, JSON.stringify(config));
      fs.writeFileSync(siblingEnv, "PAPERCLIP_IN_WORKTREE=true\n");
      snapshots.set(siblingConfig, fs.readFileSync(siblingConfig));
      snapshots.set(siblingEnv, fs.readFileSync(siblingEnv));
      if (shape === "redirect") fs.appendFileSync(ownEnv, `PAPERCLIP_CONFIG=${siblingConfig}\n`);
    }
    if (shape === "registry") {
      fs.mkdirSync(env.PAPERCLIP_WORKTREES_DIR!, { recursive: true });
      const registry = path.join(env.PAPERCLIP_WORKTREES_DIR!, "worktree-port-reservations.json");
      fs.writeFileSync(registry, JSON.stringify({ version: 1, configPaths: [ownConfig] }));
      snapshots.set(registry, fs.readFileSync(registry));
    }
    if (shape === "ancestor") {
      const ancestor = path.join(root, ".paperclip");
      fs.mkdirSync(ancestor);
      fs.writeFileSync(path.join(ancestor, "config.json"), "{}");
      fs.writeFileSync(path.join(ancestor, ".env"), "DATABASE_URL=ancestor-protected\n");
      env.PAPERCLIP_IN_WORKTREE = "true";
    }
    if (shape === "vault") {
      fs.writeFileSync(path.join(stateDir, ".env.vault"), "ZZ_VAULT_ONLY=fixture-vault\n");
      fs.writeFileSync(path.join(cwd, ".env.vault"), "ZZ_VAULT_ONLY=fixture-vault\n");
      env.DOTENV_KEY = "dotenv:v1:fixture-operator";
      fs.appendFileSync(ownEnv, "DOTENV_KEY=dotenv:v1:fixture-file\n");
    }
    if (shape === "refused") fs.appendFileSync(ownEnv, 'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=fixture-refused\nBAD="unterminated\n');
    if (shape === "directory") {
      fs.unlinkSync(ownEnv);
      fs.mkdirSync(ownEnv);
      env.PAPERCLIP_IN_WORKTREE = "true";
    }
    if (shape === "operator") {
      for (const key of [...protectedKeys, "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_SECRETS_MASTER_KEY"]) {
        env[key] = key === "PAPERCLIP_SECRETS_PROVIDER" ? "local_encrypted" : "operator-value";
      }
    }
    const ownBefore = fs.existsSync(ownEnv) && fs.statSync(ownEnv).isFile() ? fs.readFileSync(ownEnv) : null;
    const configBefore = fs.existsSync(ownConfig) ? fs.readFileSync(ownConfig) : null;
    if (shape === "unreadable") {
      fs.chmodSync(ownEnv, 0o000);
      env.PAPERCLIP_IN_WORKTREE = "true";
    }
    const script = `
      const output = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      const warnings = [];
      process.stderr.write = (value) => { warnings.push(String(value)); return true; };
      process.on('exit', (code) => {
        if (code !== 0) output(JSON.stringify({ failure: warnings.join('') }) + '\\n');
      });
      const ledger = await import(${JSON.stringify(ledgerUrl)});
      let before;
      async function finish() {
        const server = await import(${JSON.stringify(configUrl)});
        const plan = ledger.currentBootEnvPlan();
        const config = server.loadConfig();
        output(JSON.stringify({
          plan, samePlan: !before || before === plan,
          origin: ledger.bootEnvOrigin('PAPERCLIP_AGENT_JWT_SECRET'),
          promoted: ledger.operatorEnvValue('PAPERCLIP_AGENT_JWT_SECRET') !== undefined,
          database: config.databaseUrl !== undefined,
          instanceId: process.env.PAPERCLIP_INSTANCE_ID ?? 'default',
          refusals: ledger.bootEnvReport().refusals.map(r => r.kind),
          protectedPresent: ${JSON.stringify(protectedKeys)}.filter(key => process.env[key] !== undefined),
          filePromotions: ${JSON.stringify(originKeys.flatMap(key => [key, `${key}_CWD`]))}.filter(key => ledger.operatorEnvValue(key) !== undefined),
          plainOrigins: ${JSON.stringify(originKeys.flatMap(key => [key, `${key}_CWD`]))}.map(key => ledger.bootEnvOrigin(key)),
          vaultPresent: process.env.ZZ_VAULT_ONLY !== undefined,
          dataDir: config.embeddedPostgresDataDir,
          keyFile: config.secretsMasterKeyFilePath,
          backupEnabled: config.databaseBackupEnabled,
          mintedSecret: /^[0-9a-f]{64}$/.test(process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET ?? ''),
        }) + '\\n');
      }
      if (${JSON.stringify(entry)} === 'cli') {
        process.argv = [process.execPath, 'paperclip', ...${JSON.stringify(argv)}];
        const { Command } = await import(${JSON.stringify(commanderUrl)});
        const hook = Command.prototype.hook;
        let reachedBoundary = false;
        Command.prototype.hook = function(event, listener) {
          if (event !== 'preAction') return hook.call(this, event, listener);
          return hook.call(this, event, async (...args) => {
            await listener(...args);
            before = ledger.currentBootEnvPlan();
            const opts = args[1].opts();
            opts.skipServiceManagerCheck = true;
            Object.defineProperty(opts, 'introLabel', { get() {
              reachedBoundary = true;
              throw new Error('startup UI boundary');
            } });
          });
        };
        const exit = process.exit.bind(process);
        process.exit = (code) => {
          if (!reachedBoundary || code !== 1) return exit(code);
          finish().then(() => exit(0), error => { warnings.push(error.stack); exit(2); });
        };
        await import(${JSON.stringify(cliUrl)});
      } else {
        await finish();
      }
    `;
    const scriptPath = path.join(root, "boot.mjs");
    fs.writeFileSync(scriptPath, script);
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, ["--import", tsx, scriptPath], {
        cwd, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { stdout?: string; status?: number };
      throw new Error(`Entry probe exited ${failure.status}: ${failure.stdout ?? ""}`);
    }
    if (shape === "unreadable") fs.chmodSync(ownEnv, 0o600);
    return {
      ...JSON.parse(stdout.replaceAll(root, "<fixture>")) as {
        plan: { mode: string; sources: Array<{ kind: string }>; undeclared: boolean };
        samePlan: boolean; origin: string | null; promoted: boolean; database: boolean;
        instanceId: string; refusals: string[]; protectedPresent: string[]; filePromotions: string[];
        plainOrigins: Array<string | null>; vaultPresent: boolean; dataDir: string;
        keyFile: string; backupEnabled: boolean; mintedSecret: boolean;
      },
      ownUnchanged: ownBefore === null || fs.readFileSync(ownEnv).equals(ownBefore),
      configUnchanged: configBefore === null || fs.readFileSync(ownConfig).equals(configBefore),
      otherFilesUnchanged: [...snapshots].every(([file, before]) => fs.readFileSync(file).equals(before)),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("fresh-process server and CLI source-plan equality (T-EQ)", () => {
  for (const shape of shapes) {
    it.each(flags)(`${shape}: %s preserves the same source plan and origins`, (flag) => {
      const server = probe(shape, flag, "server");
      const cli = probe(shape, flag, "cli");
      expect(cli).toEqual(server);
      expect(cli.samePlan).toBe(true);
      expect(cli.promoted).toBe(false);
      expect(cli.filePromotions).toEqual([]);
      expect(cli.plainOrigins).not.toContain("operator");
      if (shape !== "plain" && shape !== "instance") {
        expect(cli.database).toBe(false);
        expect(cli.protectedPresent).toEqual([]);
        expect(cli.plan.sources.map(source => source.kind)).toEqual(["own"]);
      }
      if (cli.plan.mode === "worktree") expect(cli.instanceId).not.toBe("default");
    }, 65_000);
  }
  it.each(trustShapes)("%s has the same trust boundary in real CLI and server boots", (shape) => {
    if (shape === "unreadable" && process.getuid?.() === 0) return;
    const server = probe(shape, "none", "server");
    const cli = probe(shape, "none", "cli");
    expect(cli).toEqual(server);
    expect(cli.samePlan).toBe(true);
    expect(cli.plan.mode).toBe("worktree");
    expect(cli.otherFilesUnchanged).toBe(true);
    expect(cli.filePromotions).toEqual([]);
    expect(cli.plainOrigins).not.toContain("operator");
    expect(cli.vaultPresent).toBe(false);
    expect(cli.database).toBe(shape === "operator");
    expect(cli.protectedPresent).toEqual(shape === "operator" ? protectedKeys : []);
    expect(cli.dataDir).toContain("/instances/");
    expect(cli.dataDir).not.toContain("/instances/default/");
    expect(cli.instanceId).not.toBe("default");
    if (shape !== "operator") expect(cli.keyFile).toContain("/etc/paperclip/worktrees/");
    if (["identity", "sibling"].includes(shape)) expect(cli.refusals).toContain("identity");
    if (["layout", "registry"].includes(shape)) {
      expect(cli.refusals).toContain("undeclared");
      expect(cli.configUnchanged).toBe(true);
    }
    if (shape === "custom") expect(cli.dataDir).toContain("/custom-worktrees/instances/custom-id/");
    if (shape === "refused") expect(cli.refusals).toContain("content");
    if (shape === "directory") expect(cli.refusals).toContain("not-a-file");
    if (shape === "unreadable") expect(cli.refusals).toContain("unreadable");
    if (cli.refusals.length > 0) {
      expect(cli.ownUnchanged).toBe(true);
      expect(cli.mintedSecret).toBe(true);
      expect(cli.backupEnabled).toBe(false);
    }
  }, 65_000);
  it("explicit instance config skips a worktree cwd even when its own file is refused (X11)", () => {
    for (const entry of ["server", "cli"] as const) {
      const result = probe("refused", "config", entry);
      expect(result.plan.mode).toBe("instance");
      expect(result.plan.sources.map(source => source.kind)).toEqual(["own"]);
      expect(result.protectedPresent).toEqual([]);
      expect(result.origin).toBeNull();
      expect(result.ownUnchanged).toBe(true);
    }
  }, 65_000);
});
