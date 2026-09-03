import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * SUP-14582 — periodic TOAST readability sweep.
 *
 * Corrupt pglz TOAST values (observed in production, SUP-14272) are otherwise
 * discovered only when the exact row happens to be read. This sweep discovers
 * them proactively: on a configurable cadence (default daily) it enumerates
 * every column that can carry pglz-compressed TOAST data (`typstorage IN
 * ('m','x')`) across `public` tables, forces a full detoast of every row of
 * every such column, and reports the
 * (table, column, ctid) of each value that cannot be read. Detection only: it
 * never repairs, rewrites, or otherwise mutates any data.
 *
 * Probe shape: a session-local PL/pgSQL function in `pg_temp` iterates ctids
 * and runs a per-row `length(column::text)` probe inside a
 * `BEGIN ... EXCEPTION WHEN OTHERS` block, so a corrupt row is recorded and
 * the scan of the remaining rows continues. (A PL/pgSQL FOR-loop fetch error
 * propagates to the *enclosing* block handler, so the per-row isolation must
 * live inside the loop body.) A table-level probe failure rejects that one
 * call; the Node loop records it in `failedTables` and continues with the
 * remaining tables. The sweep entry point never rejects — it resolves a
 * result even when the connection itself fails.
 *
 * Registration: fired from the 30s heartbeat tick through
 * `trackHeartbeatSchedulerWork` (liveness name `toastReadability`, SUP-14227);
 * the min-interval gate inside `sweep` makes non-due ticks cheap no-ops, and
 * `TOAST_READABILITY_SWEEP_DISABLED=true` skips the wrapper entirely so the
 * tick is unchanged while the sweep is disabled.
 */

const DISABLED_ENV = "TOAST_READABILITY_SWEEP_DISABLED";
const INTERVAL_ENV = "TOAST_READABILITY_SWEEP_INTERVAL_MS";
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ToastReadabilitySweepOptions {
  /** Minimum spacing between actual scans. Defaults to `TOAST_READABILITY_SWEEP_INTERVAL_MS` or 24 h. */
  sweepIntervalMs?: number;
  now?: () => Date;
}

export interface ToastReadabilityUnreadableRow {
  /** Schema-qualified table name, e.g. `public.issues`. */
  table: string;
  column: string;
  /** Ctid of the row whose TOAST value cannot be read, e.g. `(0,3)`. */
  ctid: string;
  error: string;
}

export interface ToastReadabilityFailedTable {
  /** Schema-qualified table name whose probe call failed before or between rows. */
  table: string;
  error: string;
}

export interface ToastReadabilitySweepResult {
  /** False when the sweep is disabled, a scan is already in flight, or the min-interval gate short-circuited the tick (no-op). */
  due: boolean;
  /** Distinct tables scanned on this run. */
  tablesScanned: number;
  /** TOAST-bearing columns probed on this run. */
  columnsProbed: number;
  unreadableRows: ToastReadabilityUnreadableRow[];
  failedTables: ToastReadabilityFailedTable[];
  /** Set when the sweep infrastructure (connection, enumeration, function DDL) failed; null on a normal run. */
  sweepError: string | null;
}

interface ProbeTarget {
  schema_name: string;
  table_name: string;
  column_name: string;
}

interface ProbeFailureRow {
  ctid: string;
  probe_error: string;
}

/**
 * Enumerates every column that can carry pglz-compressed TOAST data: MAIN or
 * EXTENDED storage (`typstorage IN ('m','x')`). EXTERNAL storage (`'e'`) is
 * also TOAST-bearing but uncompressed, so it cannot carry pglz corruption and
 * is excluded on purpose.
 */
const ENUMERATE_TARGETS_SQL = `
  SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  JOIN pg_type ty ON ty.oid = a.atttypid
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND ty.typstorage IN ('m', 'x')
  ORDER BY c.relname, a.attnum
`;

/**
 * Session-local probe function. For each row of one table and one column it
 * forces a full detoast and pglz decompression: `length(column::text)`
 * materializes the entire value. `pg_column_size` must not be used here — it
 * reports the stored/compressed size and never runs `pglz_decompress`, so a
 * corrupt pglz value (the in-scope failure, SUP-14272) would probe clean. The
 * per-row exception handler turns an unreadable value into a failure row and
 * keeps the scan of the remaining rows going.
 */
const PROBE_FUNCTION_SQL = `
  CREATE OR REPLACE FUNCTION pg_temp.paperclip_toast_probe(schema_name text, table_name text, column_name text)
  RETURNS TABLE (ctid text, probe_error text)
  LANGUAGE plpgsql
AS $paperclip_toast_probe$
DECLARE
  row record;
  probe_result record;
BEGIN
  FOR row IN
    EXECUTE format('SELECT ctid FROM %I.%I', schema_name, table_name)
  LOOP
    BEGIN
      EXECUTE format('SELECT length(%I::text) FROM %I.%I WHERE ctid = $1', column_name, schema_name, table_name)
        INTO probe_result
        USING row.ctid;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT row.ctid::text, SQLERRM;
    END;
  END LOOP;
END;
$paperclip_toast_probe$;
`;

const PROBE_CALL_SQL = `SELECT ctid, probe_error FROM pg_temp.paperclip_toast_probe($1, $2, $3)`;
const PROBE_DROP_SQL = `DROP FUNCTION IF EXISTS pg_temp.paperclip_toast_probe(text, text, text)`;

/** Reads a positive-integer millisecond env var, falling back to `fallbackMs` on missing or invalid values. */
function readMsEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

function isDisabledByEnv(): boolean {
  const raw = process.env[DISABLED_ENV]?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the TOAST readability sweep service. `sweep` is meant to be fired by
 * the heartbeat tick every 30 s; the min-interval gate makes non-due ticks
 * cheap no-ops, and a disabled sweep resolves a no-op result without ever
 * touching the database. `sweep` never rejects.
 */
export function createToastReadabilitySweepService(
  db: Db,
  opts: ToastReadabilitySweepOptions = {},
) {
  const sweepIntervalMs = opts.sweepIntervalMs ?? readMsEnv(INTERVAL_ENV, DEFAULT_SWEEP_INTERVAL_MS);
  const now = opts.now ?? (() => new Date());
  let lastRunAt: number | null = null;
  // Guards against a second full scan launching while one is still running. The
  // cadence gate below compares start-to-start elapsed time only, so a scan that
  // outlives `sweepIntervalMs` (plausible on a degraded 6 GB DB, where this
  // sweep exists to help) would otherwise pass the gate on the next due tick and
  // pin a second pool connection into an overlapping scan (SUP-14582 finding 3).
  let inFlight = false;

  /** Runs one sweep pass: gate on cadence, then probe every TOAST-bearing column of every `public` table. */
  async function sweep(): Promise<ToastReadabilitySweepResult> {
    const checkedAt = now();
    const skipped: ToastReadabilitySweepResult = {
      due: false,
      tablesScanned: 0,
      columnsProbed: 0,
      unreadableRows: [],
      failedTables: [],
      sweepError: null,
    };
    if (isDisabledByEnv()) return skipped;
    // A scan in flight wins over the cadence gate: never launch an overlapping
    // full scan just because the start-to-start interval has elapsed.
    if (inFlight) return skipped;
    // The heartbeat tick fires every 30 s; a full scan is expensive, so every
    // non-due tick is a no-op.
    if (lastRunAt !== null && checkedAt.getTime() - lastRunAt < sweepIntervalMs) {
      return skipped;
    }
    lastRunAt = checkedAt.getTime();
    inFlight = true;

    const result: ToastReadabilitySweepResult = {
      due: true,
      tablesScanned: 0,
      columnsProbed: 0,
      unreadableRows: [],
      failedTables: [],
      sweepError: null,
    };

    let reserved: {
      unsafe(sql: string, params?: unknown[]): Promise<unknown>;
      release(): void;
    } | null = null;
    try {
      // Pin one pool connection for the whole scan so the session-local
      // pg_temp function and every probe run on the same session.
      reserved = await db.$client.reserve();
      const targets = (await reserved.unsafe(ENUMERATE_TARGETS_SQL)) as ProbeTarget[];
      result.columnsProbed = targets.length;
      await reserved.unsafe(PROBE_FUNCTION_SQL);
      const scannedTables = new Set<string>();
      for (const target of targets) {
        const tableKey = `${target.schema_name}.${target.table_name}`;
        if (!scannedTables.has(tableKey)) {
          scannedTables.add(tableKey);
          result.tablesScanned += 1;
        }
        let failures: ProbeFailureRow[];
        try {
          failures = (await reserved.unsafe(PROBE_CALL_SQL, [
            target.schema_name,
            target.table_name,
            target.column_name,
          ])) as ProbeFailureRow[];
        } catch (err) {
          // Table-level probe failure: record it and continue with the
          // remaining tables.
          result.failedTables.push({ table: tableKey, error: errorMessage(err) });
          continue;
        }
        for (const row of failures) {
          result.unreadableRows.push({
            table: tableKey,
            column: target.column_name,
            ctid: row.ctid,
            error: row.probe_error,
          });
        }
      }
    } catch (err) {
      result.sweepError = errorMessage(err);
    } finally {
      inFlight = false;
      if (reserved !== null) {
        try {
          await reserved.unsafe(PROBE_DROP_SQL);
        } catch {
          // The function is session-scoped; it dies with the connection.
        }
        reserved.release();
      }
    }

    if (result.sweepError !== null) {
      logger.error(
        { sweepError: result.sweepError, tablesScanned: result.tablesScanned },
        "TOAST readability sweep aborted before completion",
      );
    } else if (result.unreadableRows.length > 0 || result.failedTables.length > 0) {
      for (const row of result.unreadableRows) {
        logger.error(
          { table: row.table, column: row.column, ctid: row.ctid, error: row.error },
          "TOAST readability sweep: unreadable row detected",
        );
      }
      for (const failed of result.failedTables) {
        logger.error(
          { table: failed.table, error: failed.error },
          "TOAST readability sweep: table probe aborted, remaining tables still scanned",
        );
      }
    } else {
      logger.info(
        { tablesScanned: result.tablesScanned, columnsProbed: result.columnsProbed },
        "TOAST readability sweep: all TOAST values readable",
      );
    }

    return result;
  }

  return {
    sweep,
    /** True when the sweep is disabled by env; callers then skip the liveness wrapper so the tick is unchanged. */
    get disabled(): boolean {
      return isDisabledByEnv();
    },
  };
}
