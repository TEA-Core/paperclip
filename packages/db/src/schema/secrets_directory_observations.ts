import { bigint, boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Durable record of a secrets-directory scan observation (SUP-13018).
 *
 * Each row captures a single file observed in the control-plane secrets
 * directory, classified against the allowlist of expected key file names.
 * Only unexpected files are persisted: an allowlisted file is never a
 * security-relevant "observation", and persisting it every scan interval
 * would bloat the table without adding signal.
 *
 * No key material is ever stored here — the fingerprint is a truncated
 * sha256 prefix (12 hex chars) of the file bytes, following the same
 * convention as the master-key fingerprint fields in the local encrypted
 * provider. The full hash and the raw bytes never leave the scanner.
 */
export const secretsDirectoryObservations = pgTable(
  "secrets_directory_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    observedFileName: text("observed_file_name").notNull(),
    classification: text("classification").notNull(),
    mode: integer("mode"),
    uid: integer("uid"),
    gid: integer("gid"),
    size: bigint("size", { mode: "number" }),
    mtimeMs: bigint("mtime_ms", { mode: "number" }),
    sha256FingerprintPrefix: text("sha256_fingerprint_prefix"),
    serverPid: integer("server_pid"),
    serverUid: integer("server_uid"),
    serverGid: integer("server_gid"),
    serverComm: text("server_comm"),
    containerStartTimeMs: bigint("container_start_time_ms", { mode: "number" }),
    observedAtMs: bigint("observed_at_ms", { mode: "number" }).notNull(),
    filePredatesContainerStart: boolean("file_predates_container_start"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdIdx: index("secrets_directory_observations_created_idx").on(table.createdAt),
    classificationCreatedIdx: index("secrets_directory_observations_classification_created_idx").on(
      table.classification,
      table.createdAt,
    ),
  }),
);
