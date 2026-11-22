import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatDatabaseBackupResult, runDatabaseBackup } from "./backup-lib.js";
import { vettedEnvEntries } from "./runtime-config.js";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolvePaperclipEnvPathForConfig,
} from "@paperclipai/shared/home-paths";
import { captureOperatorEnv, loadBootEnv } from "@paperclipai/shared/boot-env";

captureOperatorEnv();
const { plan } = loadBootEnv({ cwd: process.cwd() });

type PartialConfig = {
  database?: {
    mode?: "embedded-postgres" | "postgres";
    connectionString?: string;
    embeddedPostgresPort?: number;
    backup?: {
      dir?: string;
      retentionDays?: number;
    };
  };
};

function readConfig(configPath: string): PartialConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed ? (parsed as PartialConfig) : null;
  } catch {
    return null;
  }
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function resolveConnectionString(configPath: string, config: PartialConfig | null): string {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;
  const envPath = resolvePaperclipEnvPathForConfig(configPath);
  const fileEnvUrl = vettedEnvEntries(envPath)?.DATABASE_URL?.trim();
  if (fileEnvUrl) return fileEnvUrl;

  if (config?.database?.mode === "postgres" && typeof config.database.connectionString === "string") {
    const trimmed = config.database.connectionString.trim();
    if (trimmed) return trimmed;
  }

  throw new Error(
    "No database connection resolved. Tried:\n" +
      "  1. DATABASE_URL environment variable (not set)\n" +
      `  2. paperclip-env file (.env) at ${envPath} (not found or no DATABASE_URL)\n` +
      `  3. config.json database.connectionString at ${configPath} (config not found or no connectionString)\n` +
      "Set DATABASE_URL to your instance's connection string and retry.",
  );
}

function resolveBackupDir(config: PartialConfig | null): string {
  const raw = config?.database?.backup?.dir;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return path.resolve(expandHomePrefix(raw.trim()));
  }
  return resolveDefaultBackupDir();
}

function resolveRetentionDays(config: PartialConfig | null): number {
  return asPositiveInt(config?.database?.backup?.retentionDays) ?? 7;
}

async function main() {
  const configPath = plan.configPath;
  const config = readConfig(configPath);
  const connectionString = resolveConnectionString(configPath, config);
  const backupDir = resolveBackupDir(config);
  const retentionDays = resolveRetentionDays(config);

  console.log(`Config path: ${configPath}`);
  console.log(`Backing up database to: ${backupDir}`);
  console.log(`Retention window: ${retentionDays} day(s)`);

  try {
    const result = await runDatabaseBackup({
      connectionString,
      backupDir,
      retention: { dailyDays: retentionDays, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "paperclip",
    });

    console.log(`Backup saved: ${formatDatabaseBackupResult(result)}`);
  } catch (err) {
    console.error("Backup failed.");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

await main();
