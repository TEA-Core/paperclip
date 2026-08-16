import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { secretsDirectoryObservations, type Db } from "@paperclipai/db";
import { resolveSecretsKeyDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/**
 * Expected key file names in the control-plane secrets directory. Anything
 * else is unexpected and is logged + persisted (SUP-13018).
 *
 * `master.key` is the local-encrypted master key; `decision-signing.key` is
 * the decision-signing key written beside it (see `ensureDecisionSigningSecret`).
 * This list must be kept in lockstep with what the server actually writes; a
 * new server-written key file that is not added here will surface as an
 * unexpected-file observation rather than silently disappearing.
 */
export const ALLOWED_SECRET_FILE_NAMES = new Set(["master.key", "decision-signing.key"]);

const FINGERPRINT_PREFIX_LENGTH = 12;

export type SecretsFileClassification = "expected" | "unexpected";

export interface SecretsDirectoryObservation {
  observedFileName: string;
  classification: SecretsFileClassification;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  size: number | null;
  mtimeMs: number | null;
  /** Truncated sha256 prefix (12 hex chars) of the file bytes — never key material or a full hash. */
  sha256FingerprintPrefix: string | null;
  serverPid: number | null;
  serverUid: number | null;
  serverGid: number | null;
  serverComm: string | null;
  containerStartTimeMs: number | null;
  observedAtMs: number;
  filePredatesContainerStart: boolean | null;
}

export interface SecretDirScanResult {
  dir: string;
  observedAtMs: number;
  files: SecretsDirectoryObservation[];
  unexpected: SecretsDirectoryObservation[];
}

function computeFingerprintPrefix(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, FINGERPRINT_PREFIX_LENGTH);
}

function readFileLineOrNull(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort container start time in epoch milliseconds. In a container the
 * kernel boot clock (`btime` from /proc/stat) is shared with the host, and
 * /proc/1 is the container's own PID 1, so container start = btime + the PID 1
 * starttime (in clock ticks). HZ is assumed to be 100 (the common Linux
 * default); if either procfs read fails this returns null and the caller omits
 * the `filePredatesContainerStart` signal rather than guessing.
 */
function readContainerStartTimeMs(): number | null {
  try {
    const statRaw = readFileSync("/proc/stat", "utf8");
    const btimeMatch = statRaw.match(/^btime\s+(\d+)/m);
    const btimeSeconds = btimeMatch ? Number(btimeMatch[1]) : null;
    if (btimeSeconds == null || !Number.isFinite(btimeSeconds)) return null;

    const proc1 = readFileSync("/proc/1/stat", "utf8");
    const afterComm = proc1.slice(proc1.lastIndexOf(")") + 2).trim().split(/\s+/);
    // Field 22 (starttime) is 1-based; afterComm[0] is field 3 (state), so
    // starttime is at index 22 - 3 = 19.
    const startTicks = Number(afterComm[19]);
    if (!Number.isFinite(startTicks)) return null;

    const hertz = 100;
    return Math.round((btimeSeconds + startTicks / hertz) * 1000);
  } catch {
    return null;
  }
}

function readAttributionContext(): {
  serverPid: number | null;
  serverUid: number | null;
  serverGid: number | null;
  serverComm: string | null;
  containerStartTimeMs: number | null;
  observedAtMs: number;
} {
  let serverUid: number | null = null;
  let serverGid: number | null = null;
  try {
    if (typeof process.getuid === "function") serverUid = process.getuid();
  } catch {
    // not available on this platform
  }
  try {
    if (typeof process.getgid === "function") serverGid = process.getgid();
  } catch {
    // not available on this platform
  }
  return {
    serverPid: process.pid,
    serverUid,
    serverGid,
    serverComm: readFileLineOrNull("/proc/self/comm"),
    containerStartTimeMs: readContainerStartTimeMs(),
    observedAtMs: Date.now(),
  };
}

/**
 * Enumerate and classify every file in the resolved secrets directory.
 *
 * Pure with respect to the filesystem: it reads the directory listing and, for
 * unexpected files only, a truncated sha256 fingerprint of the bytes. The
 * contents of allowlisted key files are never read or hashed here.
 */
export function scanSecretsDirectory(): SecretDirScanResult {
  const dir = resolveSecretsKeyDir();
  const attribution = readAttributionContext();

  const files: SecretsDirectoryObservation[] = [];
  if (existsSync(dir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch {
      // Directory unreadable; return an empty scan rather than throwing — the
      // boot path already surfaces key-file read problems via health checks.
      entries = [];
    }
    entries.sort();

    for (const name of entries) {
      const classification: SecretsFileClassification = ALLOWED_SECRET_FILE_NAMES.has(name)
        ? "expected"
        : "unexpected";
      const fullPath = path.join(dir, name);

      let mode: number | null = null;
      let uid: number | null = null;
      let gid: number | null = null;
      let size: number | null = null;
      let mtimeMs: number | null = null;
      let filePredatesContainerStart: boolean | null = null;
      try {
        const st = statSync(fullPath);
        mode = st.mode & 0o777;
        uid = st.uid;
        gid = st.gid;
        size = st.size;
        mtimeMs = st.mtimeMs;
        if (attribution.containerStartTimeMs != null) {
          filePredatesContainerStart = mtimeMs < attribution.containerStartTimeMs;
        }
      } catch {
        // stat failed (e.g. dangling symlink); the observation is still emitted
        // with null metadata because an unclassifiable file is exactly the
        // anomaly this watcher exists to surface.
      }

      let sha256FingerprintPrefix: string | null = null;
      if (classification === "unexpected") {
        try {
          sha256FingerprintPrefix = computeFingerprintPrefix(readFileSync(fullPath));
        } catch {
          sha256FingerprintPrefix = null;
        }
      }

      files.push({
        observedFileName: name,
        classification,
        mode,
        uid,
        gid,
        size,
        mtimeMs,
        sha256FingerprintPrefix,
        serverPid: attribution.serverPid,
        serverUid: attribution.serverUid,
        serverGid: attribution.serverGid,
        serverComm: attribution.serverComm,
        containerStartTimeMs: attribution.containerStartTimeMs,
        observedAtMs: attribution.observedAtMs,
        filePredatesContainerStart,
      });
    }
  }

  return {
    dir,
    observedAtMs: attribution.observedAtMs,
    files,
    unexpected: files.filter((file) => file.classification === "unexpected"),
  };
}

function logSafeObservation(observation: SecretsDirectoryObservation): Record<string, unknown> {
  return {
    fileName: observation.observedFileName,
    classification: observation.classification,
    mode: observation.mode,
    uid: observation.uid,
    gid: observation.gid,
    size: observation.size,
    mtimeMs: observation.mtimeMs,
    sha256FingerprintPrefix: observation.sha256FingerprintPrefix,
    serverPid: observation.serverPid,
    serverUid: observation.serverUid,
    serverGid: observation.serverGid,
    serverComm: observation.serverComm,
    containerStartTimeMs: observation.containerStartTimeMs,
    observedAtMs: observation.observedAtMs,
    filePredatesContainerStart: observation.filePredatesContainerStart,
  };
}

/** Emit one warn-level log line per unexpected file. Never logs key material. */
export function logUnexpectedObservations(result: SecretDirScanResult): void {
  for (const observation of result.unexpected) {
    logger.warn(
      { ...logSafeObservation(observation), secretsDir: result.dir },
      "unexpected file detected in secrets directory",
    );
  }
}

/** Persist unexpected-file observations so they survive container replacement. */
export async function persistUnexpectedObservations(
  db: Db,
  result: SecretDirScanResult,
): Promise<number> {
  const rows = result.unexpected.map((observation) => ({
    observedFileName: observation.observedFileName,
    classification: observation.classification,
    mode: observation.mode,
    uid: observation.uid,
    gid: observation.gid,
    size: observation.size,
    mtimeMs: observation.mtimeMs,
    sha256FingerprintPrefix: observation.sha256FingerprintPrefix,
    serverPid: observation.serverPid,
    serverUid: observation.serverUid,
    serverGid: observation.serverGid,
    serverComm: observation.serverComm,
    containerStartTimeMs: observation.containerStartTimeMs,
    observedAtMs: observation.observedAtMs,
    filePredatesContainerStart: observation.filePredatesContainerStart,
  }));
  if (rows.length === 0) return 0;
  await db.insert(secretsDirectoryObservations).values(rows);
  return rows.length;
}

/** Scan, log unexpected files at warn level, and persist them to the DB. */
export async function runSecretsDirectoryWatch(db: Db): Promise<SecretDirScanResult> {
  const result = scanSecretsDirectory();
  logUnexpectedObservations(result);
  await persistUnexpectedObservations(db, result);
  return result;
}

/**
 * Start a periodic secrets-directory watch. Returns a stop function. The first
 * tick fires after `initialDelayMs` (default: one interval) so boot already
 * covers the immediate check without a double-run.
 */
export function startSecretsDirectoryWatch(
  db: Db,
  opts: { intervalMs: number; initialDelayMs?: number },
): () => void {
  let inFlight = false;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = true;
    void runSecretsDirectoryWatch(db)
      .catch((err) => {
        logger.error({ err }, "secrets directory watch tick failed");
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const initialTimer = setTimeout(tick, opts.initialDelayMs ?? opts.intervalMs);
  initialTimer.unref?.();
  const timer = setInterval(tick, opts.intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
