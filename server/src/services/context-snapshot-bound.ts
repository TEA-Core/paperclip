/**
 * Defensive byte-bound for the `heartbeat_runs.context_snapshot` column.
 *
 * `context_snapshot` is an unbounded `jsonb`. During dispatch the context object grows (issue
 * description, secret-binding inventory, environment, workspace, runtime services) and is
 * re-written at several `heartbeat_runs` update sites. An oversized value combined with a
 * transient driver failure was observed to flip an issue-bound run to `setup_failed` before the
 * agent process even started (INC-... / SUP-15254 window). This bound guarantees the value sent
 * to the column always fits under a cap, so an oversized snapshot degrades instead of becoming
 * the fatal step for the run.
 *
 * The guarantee: for any record input, the returned object's UTF-8 JSON length is at or under
 * {@link CONTEXT_SNAPSHOT_MAX_BYTES}. Inputs already under the cap pass through unchanged (same
 * reference). The degradation preserves the identity fields a downstream reader needs
 * (issueId / taskId / agentId / companyId / wakeReason) and marks the snapshot as truncated.
 */

export const CONTEXT_SNAPSHOT_MAX_BYTES = 512 * 1024; // 512 KiB
export const CONTEXT_SNAPSHOT_TRUNCATION_MARKER = "__contextSnapshotTruncated__";

/** Per-string-leaf cap applied to the heaviest leaves when degrading. */
export const STRING_LEAF_CAP_BYTES = 8 * 1024;
/** Array leaf cap (item count) applied when degrading. */
export const ARRAY_LEAF_CAP_ITEMS = 16;

/** Top-level keys always preserved (even when dropping to the minimal skeleton). */
export const CONTEXT_SNAPSHOT_PRESERVED_KEYS: readonly string[] = [
  "issueId",
  "taskId",
  "agentId",
  "companyId",
  "wakeReason",
];

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    // A value that cannot be serialized cannot be written to jsonb anyway. Treat it as unbounded
    // so the caller degrades it to the skeleton rather than passing a non-serializable value to
    // the column and letting the write become the fatal step.
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headBytes(input: string, maxBytes: number): string {
  // Byte-safe prefix that never splits a multi-byte UTF-8 codepoint.
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let out = "";
  for (const char of input) {
    const next = out + char;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    out = next;
  }
  return out;
}

/** Cap a single oversized string leaf (byte-accurate prefix + explicit omitted-byte count). */
function capStringLeaf(value: string): string {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= STRING_LEAF_CAP_BYTES) return value;
  const head = headBytes(value, STRING_LEAF_CAP_BYTES);
  const omittedBytes = byteLength - Buffer.byteLength(head, "utf8");
  return `${head}...[${CONTEXT_SNAPSHOT_TRUNCATION_MARKER} omitted ${omittedBytes} bytes]`;
}

/** Replace every string longer than {@link STRING_LEAF_CAP_BYTES} with a capped + marked form. */
function capStringLeaves(value: unknown): unknown {
  if (typeof value === "string") return capStringLeaf(value);
  if (Array.isArray(value)) {
    const items = value.length > ARRAY_LEAF_CAP_ITEMS ? value.slice(0, ARRAY_LEAF_CAP_ITEMS) : value;
    const cappedItems = items.map(capStringLeaves);
    if (value.length > ARRAY_LEAF_CAP_ITEMS) {
      cappedItems.push(`${CONTEXT_SNAPSHOT_TRUNCATION_MARKER} omitted ${value.length - ARRAY_LEAF_CAP_ITEMS} array items`);
    }
    return cappedItems;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = capStringLeaves(child);
    }
    return out;
  }
  return value;
}

function pickPreservedKeys(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTEXT_SNAPSHOT_PRESERVED_KEYS) {
    if (!(key in source)) continue;
    const child = source[key];
    // Cap oversized preserved string leaves (e.g. a huge wakeReason) so a single preserved value
    // cannot push the degraded form back over the cap; identity is retained via the byte-accurate
    // head. Non-string preserved values are copied verbatim (pass 1 already caps their leaves).
    out[key] = typeof child === "string" ? capStringLeaf(child) : child;
  }
  return out;
}

function marker(reason: string, originalBytes: number, capBytes: number): Record<string, unknown> {
  return {
    [CONTEXT_SNAPSHOT_TRUNCATION_MARKER]: true,
    __contextSnapshotTruncatedDetail: {
      reason,
      capBytes,
      originalBytes,
    },
  };
}

function skeletonWith(
  source: Record<string, unknown>,
  originalBytes: number,
  capBytes: number,
): Record<string, unknown> {
  return {
    ...pickPreservedKeys(source),
    ...marker("context_snapshot_minimal_skeleton", originalBytes, capBytes),
  };
}

/**
 * Return a guaranteed-bounded `context_snapshot` value.
 *
 * - Under the cap: returned unchanged (same reference), so the common small-context path pays
 *   nothing.
 * - Over the cap: degraded by capping heavy string/array leaves, then (if still over) dropping
 *   non-essential top-level keys by serialized size, then (if still over) falling back to a
 *   minimal skeleton that is always well under the cap.
 */
export function boundContextSnapshot(
  value: unknown,
  capBytes: number = CONTEXT_SNAPSHOT_MAX_BYTES,
): Record<string, unknown> {
  if (!isRecord(value)) {
    // The column expects an object. Coerce non-record inputs to a small bounded object rather
    // than passing a scalar/array straight to jsonb.
    const fallback: Record<string, unknown> = { value };
    const fallbackLength = jsonByteLength(fallback);
    if (Number.isFinite(fallbackLength) && fallbackLength <= capBytes) return fallback;
    return skeletonWith({}, 0, capBytes);
  }

  const length = jsonByteLength(value);
  if (length <= capBytes) return value;

  // A value JSON.stringify cannot serialize (e.g. a circular reference) cannot be written to jsonb
  // at all. Do not attempt the leaf-capping pass (which would recurse into the cycle); degrade
  // straight to a bounded skeleton that preserves the identity fields.
  if (!Number.isFinite(length)) return skeletonWith(value, 0, capBytes);

  const originalBytes = length;

  // Pass 1: cap heavy string/array leaves.
  const pass1: Record<string, unknown> = {
    ...(capStringLeaves(value) as Record<string, unknown>),
    ...marker("context_snapshot_oversized", originalBytes, capBytes),
  };
  if (jsonByteLength(pass1) <= capBytes) return pass1;

  // Pass 2: drop non-essential top-level keys by serialized size, largest first.
  const preserved = new Set(CONTEXT_SNAPSHOT_PRESERVED_KEYS);
  const kept: Record<string, unknown> = { ...pickPreservedKeys(value), ...marker("context_snapshot_keys_dropped", originalBytes, capBytes) };
  const droppable = Object.keys(value).filter((key) => !preserved.has(key));
  droppable.sort((a, b) => jsonByteLength(value[b]) - jsonByteLength(value[a]));
  for (const key of droppable) {
    kept[key] = capStringLeaves(value[key]);
    if (jsonByteLength(kept) > capBytes) {
      delete kept[key];
      kept.__contextSnapshotDroppedKeys = [...(Array.isArray(kept.__contextSnapshotDroppedKeys) ? kept.__contextSnapshotDroppedKeys as string[] : []), key];
    }
  }
  if (jsonByteLength(kept) <= capBytes) return kept;

  // Pass 3: minimal skeleton (always under the cap).
  return skeletonWith(value, originalBytes, capBytes);
}
