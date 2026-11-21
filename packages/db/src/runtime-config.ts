import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  expandHomePrefix,
  resolveDefaultEmbeddedPostgresDir,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipEnvPathForConfig,
} from "@paperclipai/shared/home-paths";
import { vetEnvFileContents } from "@paperclipai/shared/env-file";
import { captureOperatorEnv, resolveBootEnvPlan, stageEnvSource, stagedOwnValue } from "@paperclipai/shared/boot-env";

const CONFIG_BASENAME = "config.json";

type PartialConfig = {
  database?: {
    mode?: "embedded-postgres" | "postgres";
    connectionString?: string;
    embeddedPostgresDataDir?: string;
    embeddedPostgresPort?: number;
    pgliteDataDir?: string;
    pglitePort?: number;
  };
};

export type ResolvedDatabaseTarget =
  | {
      mode: "postgres";
      connectionString: string;
      source: "DATABASE_URL" | "paperclip-env" | "config.database.connectionString";
      configPath: string;
      envPath: string;
    }
  | {
      mode: "embedded-postgres";
      dataDir: string;
      port: number;
      source: `embedded-postgres@${number}`;
      configPath: string;
      envPath: string;
    };

function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

function findConfigFileFromAncestors(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", CONFIG_BASENAME);
    if (existsSync(candidate)) return candidate;

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) return null;
    currentDir = nextDir;
  }
}

function resolvePaperclipConfigPath(): string {
  if (process.env.PAPERCLIP_CONFIG?.trim()) {
    return path.resolve(process.env.PAPERCLIP_CONFIG.trim());
  }
  return findConfigFileFromAncestors(process.cwd()) ?? resolvePaperclipConfigPathForInstance();
}

function resolvePaperclipEnvPath(configPath: string): string {
  return resolvePaperclipEnvPathForConfig(configPath);
}

// Reads DATABASE_URL from the instance env file only when the boot ledger
// stages that file clean. A refused (unvetted, unreadable, not-a-file) env
// file never supplies a database target.
export function vettedEnvEntries(envPath: string): Record<string, string> | null {
  if (!existsSync(envPath)) return {};
  try {
    if (!statSync(envPath).isFile()) return null;
    vetEnvFileContents(readFileSync(envPath, "utf8"));
  } catch {
    return null;
  }
  captureOperatorEnv();
  resolveBootEnvPlan({ cwd: process.cwd() });
  const staged = stageEnvSource({ kind: "own", path: envPath });
  if (staged.status !== "staged") return null;
  const databaseUrl = stagedOwnValue("DATABASE_URL");
  return databaseUrl ? { DATABASE_URL: databaseUrl } : {};
}


function migrateLegacyConfig(raw: unknown): PartialConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const config = { ...(raw as Record<string, unknown>) };
  const databaseRaw = config.database;
  if (typeof databaseRaw !== "object" || databaseRaw === null || Array.isArray(databaseRaw)) {
    return config;
  }

  const database = { ...(databaseRaw as Record<string, unknown>) };
  if (database.mode === "pglite") {
    database.mode = "embedded-postgres";

    if (
      typeof database.embeddedPostgresDataDir !== "string" &&
      typeof database.pgliteDataDir === "string"
    ) {
      database.embeddedPostgresDataDir = database.pgliteDataDir;
    }
    if (
      typeof database.embeddedPostgresPort !== "number" &&
      typeof database.pglitePort === "number" &&
      Number.isFinite(database.pglitePort)
    ) {
      database.embeddedPostgresPort = database.pglitePort;
    }
  }

  config.database = database;
  return config as PartialConfig;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function readConfig(configPath: string): PartialConfig | null {
  if (!existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const migrated = migrateLegacyConfig(parsed);
  if (migrated === null || typeof migrated !== "object" || Array.isArray(migrated)) {
    throw new Error(`Invalid config at ${configPath}: expected a JSON object`);
  }

  const database =
    typeof migrated.database === "object" &&
    migrated.database !== null &&
    !Array.isArray(migrated.database)
      ? migrated.database
      : undefined;

  return {
    database: database
      ? {
          mode: database.mode === "postgres" ? "postgres" : "embedded-postgres",
          connectionString:
            typeof database.connectionString === "string" ? database.connectionString : undefined,
          embeddedPostgresDataDir:
            typeof database.embeddedPostgresDataDir === "string"
              ? database.embeddedPostgresDataDir
              : undefined,
          embeddedPostgresPort: asPositiveInt(database.embeddedPostgresPort) ?? undefined,
          pgliteDataDir: typeof database.pgliteDataDir === "string" ? database.pgliteDataDir : undefined,
          pglitePort: asPositiveInt(database.pglitePort) ?? undefined,
        }
      : undefined,
  };
}

export function resolveDatabaseTarget(): ResolvedDatabaseTarget {
  const configPath = resolvePaperclipConfigPath();
  const envPath = resolvePaperclipEnvPath(configPath);
  const vettedEntries = vettedEnvEntries(envPath);

  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) {
    return {
      mode: "postgres",
      connectionString: envUrl,
      source: "DATABASE_URL",
      configPath,
      envPath,
    };
  }

  const fileEnvUrl = vettedEntries?.DATABASE_URL?.trim();
  if (fileEnvUrl) {
    return {
      mode: "postgres",
      connectionString: fileEnvUrl,
      source: "paperclip-env",
      configPath,
      envPath,
    };
  }

  const config = readConfig(configPath);
  const connectionString = config?.database?.connectionString?.trim();
  if (config?.database?.mode === "postgres" && connectionString) {
    return {
      mode: "postgres",
      connectionString,
      source: "config.database.connectionString",
      configPath,
      envPath,
    };
  }

  const port = config?.database?.embeddedPostgresPort ?? 54329;
  const dataDir = resolveHomeAwarePath(
    config?.database?.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
  );

  return {
    mode: "embedded-postgres",
    dataDir,
    port,
    source: `embedded-postgres@${port}`,
    configPath,
    envPath,
  };
}
