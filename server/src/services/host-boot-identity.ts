import * as fs from "node:fs";
import * as os from "node:os";

export const HOST_BOOT_ID_CONTEXT_KEY = "hostBootId";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export interface HostBootIdReaders {
  readBootIdFile: () => string | null | Promise<string | null>;
  readUptimeSeconds: () => number;
  nowMs?: () => number;
}

export function deriveUptimeBootIdentity(uptimeSeconds: number, nowMs: number): string | null {
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return null;
  const bootWallClockMs = nowMs - Math.round(uptimeSeconds * 1000);
  const bootWallClockSec = Math.round(bootWallClockMs / 1000);
  return `boot-wall-clock:${new Date(bootWallClockSec * 1000).toISOString()}`;
}

export async function resolveHostBootIdWithReaders(readers: HostBootIdReaders): Promise<string | null> {
  let bootId: string | null = null;
  try {
    const raw = await readers.readBootIdFile();
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > 0) bootId = trimmed;
    }
  } catch {
    bootId = null;
  }
  if (bootId) return bootId;
  try {
    const uptimeSeconds = readers.readUptimeSeconds();
    const nowMs = readers.nowMs ? readers.nowMs() : Date.now();
    return deriveUptimeBootIdentity(uptimeSeconds, nowMs);
  } catch {
    return null;
  }
}

let cachedHostBootId: string | null | undefined = undefined;

export async function resolveHostBootId(): Promise<string | null> {
  if (cachedHostBootId !== undefined) return cachedHostBootId;
  const value = await resolveHostBootIdWithReaders({
    readBootIdFile: () => {
      try {
        return fs.readFileSync(BOOT_ID_PATH, "utf8");
      } catch {
        return null;
      }
    },
    readUptimeSeconds: () => {
      try {
        return os.uptime();
      } catch {
        return Number.NaN;
      }
    },
  });
  cachedHostBootId = value;
  return value;
}

export function __resetHostBootIdCacheForTests(): void {
  cachedHostBootId = undefined;
}

export type HostRestartMarker = {
  detected: true;
  runBootId: string;
  currentBootId: string;
  detectedAt: string;
};

export function readHostRestartMarker(
  resultJson: Record<string, unknown> | null | undefined,
): HostRestartMarker | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const raw = resultJson.hostRestart;
  if (!raw || typeof raw !== "object") return null;
  const marker = raw as Record<string, unknown>;
  if (marker.detected !== true) return null;
  const runBootId =
    typeof marker.runBootId === "string" && marker.runBootId.length > 0 ? marker.runBootId : null;
  const currentBootId =
    typeof marker.currentBootId === "string" && marker.currentBootId.length > 0 ? marker.currentBootId : null;
  const detectedAt =
    typeof marker.detectedAt === "string" && marker.detectedAt.length > 0 ? marker.detectedAt : null;
  if (!runBootId || !currentBootId || !detectedAt) return null;
  return { detected: true, runBootId, currentBootId, detectedAt };
}

export function detectHostRestart(input: {
  recordedBootId: string | null | undefined;
  currentBootId: string | null | undefined;
  detectedAt?: string;
}): HostRestartMarker | null {
  const recorded =
    typeof input.recordedBootId === "string" && input.recordedBootId.length > 0
      ? input.recordedBootId
      : null;
  const current =
    typeof input.currentBootId === "string" && input.currentBootId.length > 0
      ? input.currentBootId
      : null;
  if (!recorded || !current) return null;
  if (recorded === current) return null;
  return {
    detected: true,
    runBootId: recorded,
    currentBootId: current,
    detectedAt: input.detectedAt ?? new Date().toISOString(),
  };
}

export function buildHostRestartMessage(marker: HostRestartMarker): string {
  return (
    `Host restart detected -- run was recorded on boot ${marker.runBootId} ` +
    `but was reaped on boot ${marker.currentBootId}; ` +
    `the host went down while this run was in flight`
  );
}

export function withHostBootIdInRunContext(
  contextSnapshot: Record<string, unknown>,
  hostBootId: string | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...contextSnapshot };
  if (hostBootId) {
    next[HOST_BOOT_ID_CONTEXT_KEY] = hostBootId;
  } else {
    delete next[HOST_BOOT_ID_CONTEXT_KEY];
  }
  return next;
}
