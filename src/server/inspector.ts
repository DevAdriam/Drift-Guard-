import crypto from 'crypto';
import { Client } from 'pg';
import { pool } from '../db/index.ts';
import type {
  ColumnCatalogRow,
  ColumnDiffItem,
  ConnectionMode,
  DatabaseHealthSummary,
  ExpensiveQueryRow,
  IndexBloatRow,
  LiveLockEdge,
  LockTreeRow,
  TableHealthRow,
  UnusedIndexRow,
} from '../types/telemetry.ts';

export const CATALOG_COLUMN_QUERY = `
SELECT
  c.table_schema,
  c.table_name,
  c.column_name,
  c.ordinal_position,
  c.column_default,
  c.is_nullable,
  c.data_type,
  c.udt_name
FROM information_schema.columns c
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position;
`;

export const RECURSIVE_LOCK_TREE_QUERY = `
WITH RECURSIVE lock_tree AS (
  SELECT
    blocked_locks.pid AS blocked_pid,
    blocked_activity.usename AS blocked_user,
    blocking_locks.pid AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocked_activity.query AS blocked_statement,
    blocking_activity.query AS blocking_statement,
    now() - blocked_activity.query_start AS wait_duration
  FROM pg_catalog.pg_locks blocked_locks
  JOIN pg_catalog.pg_stat_activity blocked_activity
    ON blocked_activity.pid = blocked_locks.pid
  JOIN pg_catalog.pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.granted = true
  JOIN pg_catalog.pg_stat_activity blocking_activity
    ON blocking_activity.pid = blocking_locks.pid
  WHERE NOT blocked_locks.granted
)
SELECT
  blocked_pid,
  blocked_user,
  blocking_pid,
  blocking_user,
  blocked_statement,
  blocking_statement,
  ROUND(EXTRACT(EPOCH FROM wait_duration)::numeric, 2)::float8 AS wait_duration_seconds,
  wait_duration::text AS wait_duration_display
FROM lock_tree
WHERE wait_duration > INTERVAL '5 seconds';
`;

export const INDEX_BLOAT_QUERY = `
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size_pretty,
  pg_relation_size(i.indexrelid)::bigint AS index_bytes,
  ROUND(
    CASE WHEN idx_scan = 0 THEN 100.0
         ELSE (1.0 - (idx_tup_fetch::numeric / NULLIF(idx_tup_read, 0))) * 100.0
    END,
    2
  )::float8 AS estimated_bloat_pct
FROM pg_stat_user_indexes i
JOIN pg_index USING (indexrelid)
WHERE pg_relation_size(i.indexrelid) > 10 * 1024 * 1024
  AND (idx_tup_read - idx_tup_fetch) > 5000
ORDER BY index_bytes DESC;
`;

export const TABLE_HEALTH_QUERY = `
SELECT
  schemaname,
  relname,
  COALESCE(n_live_tup, 0)::bigint AS n_live_tup,
  COALESCE(n_dead_tup, 0)::bigint AS n_dead_tup,
  ROUND(
    CASE WHEN (COALESCE(n_live_tup, 0) + COALESCE(n_dead_tup, 0)) = 0 THEN 0.0
         ELSE (COALESCE(n_dead_tup, 0)::numeric / (COALESCE(n_live_tup, 0) + COALESCE(n_dead_tup, 0))) * 100.0
    END,
    2
  )::float8 AS dead_tuple_pct,
  COALESCE(seq_scan, 0)::bigint AS seq_scan,
  COALESCE(idx_scan, 0)::bigint AS idx_scan,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size_pretty,
  pg_total_relation_size(relid)::bigint AS total_bytes,
  last_autovacuum,
  last_autoanalyze
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 50;
`;

export const UNUSED_INDEXES_QUERY = `
SELECT
  s.schemaname,
  s.relname AS tablename,
  s.indexrelname AS indexname,
  COALESCE(s.idx_scan, 0)::bigint AS idx_scan,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size_pretty,
  pg_relation_size(s.indexrelid)::bigint AS index_bytes
FROM pg_stat_user_indexes s
JOIN pg_index i ON s.indexrelid = i.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisprimary
  AND NOT i.indisunique
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 30;
`;

export const DATABASE_HEALTH_SUMMARY_QUERY = `
SELECT
  pg_size_pretty(pg_database_size(current_database())) AS database_size_pretty,
  pg_database_size(current_database())::bigint AS database_size_bytes,
  ROUND(
    COALESCE(
      (SELECT blks_hit::numeric / NULLIF(blks_hit + blks_read, 0) * 100.0
       FROM pg_stat_database WHERE datname = current_database()),
      100.0
    ),
    2
  )::float8 AS cache_hit_ratio_pct,
  (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active_connections,
  (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') AS idle_connections,
  (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction') AS idle_in_transaction,
  current_setting('max_connections')::int AS max_connections,
  split_part(version(), ' ', 1) || ' ' || split_part(version(), ' ', 2) AS pg_version;
`;

export const TOP_EXPENSIVE_QUERIES_QUERY = `
SELECT
  queryid::text AS query_id,
  LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 1000) AS query,
  calls::bigint AS calls,
  ROUND(mean_exec_time::numeric, 3)::float8 AS mean_exec_time_ms,
  ROUND(total_exec_time::numeric, 3)::float8 AS total_exec_time_ms,
  ROUND(max_exec_time::numeric, 3)::float8 AS max_exec_time_ms,
  rows::bigint AS total_rows,
  ROUND(
    CASE WHEN (shared_blks_hit + shared_blks_read) = 0 THEN 100.0
         ELSE (shared_blks_hit::numeric / (shared_blks_hit + shared_blks_read)) * 100.0
    END,
    2
  )::float8 AS cache_hit_pct
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND calls > 0
  AND query NOT ILIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC
LIMIT 5;
`;

export const LIVE_LOCK_CONTENTION_QUERY = `
SELECT
  blocked_locks.pid::int AS blocked_pid,
  COALESCE(blocked_activity.usename, 'unknown') AS blocked_user,
  COALESCE(blocked_activity.application_name, '') AS blocked_app,
  COALESCE(blocked_activity.state, 'active') AS blocked_state,
  blocked_activity.query AS blocked_statement,
  blocking_locks.pid::int AS blocking_pid,
  COALESCE(blocking_activity.usename, 'unknown') AS blocking_user,
  COALESCE(blocking_activity.application_name, '') AS blocking_app,
  COALESCE(blocking_activity.state, 'unknown') AS blocking_state,
  blocking_activity.query AS blocking_statement,
  blocked_locks.locktype AS lock_type,
  blocked_locks.mode AS waiting_mode,
  blocking_locks.mode AS held_mode,
  COALESCE(blocked_locks.relation::regclass::text, blocked_locks.locktype) AS target_relation,
  ROUND(
    EXTRACT(EPOCH FROM (now() - COALESCE(blocked_activity.query_start, now())))::numeric,
    2
  )::float8 AS wait_duration_seconds,
  (now() - COALESCE(blocked_activity.query_start, now()))::text AS wait_duration_display
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity
  ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
  AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
  AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
  AND blocking_locks.pid != blocked_locks.pid
  AND blocking_locks.granted = true
JOIN pg_catalog.pg_stat_activity blocking_activity
  ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted
ORDER BY wait_duration_seconds DESC
LIMIT 100;
`;

export const CAPACITY_BLOAT_METRICS_QUERY = `
SELECT
  s.schemaname,
  s.relname,
  pg_total_relation_size(s.relid)::bigint AS total_bytes,
  pg_size_pretty(pg_total_relation_size(s.relid)) AS total_size_pretty,
  pg_table_size(s.relid)::bigint AS table_bytes,
  pg_indexes_size(s.relid)::bigint AS index_bytes,
  COALESCE(s.n_live_tup, 0)::bigint AS n_live_tup,
  COALESCE(s.n_dead_tup, 0)::bigint AS n_dead_tup,
  ROUND(
    CASE WHEN (COALESCE(s.n_live_tup, 0) + COALESCE(s.n_dead_tup, 0)) = 0 THEN 0.0
         ELSE (COALESCE(s.n_dead_tup, 0)::numeric / (COALESCE(s.n_live_tup, 0) + COALESCE(s.n_dead_tup, 0))) * 100.0
    END,
    2
  )::float8 AS dead_tuple_pct,
  COALESCE(s.n_tup_ins, 0)::bigint AS n_tup_ins,
  COALESCE(s.n_tup_upd, 0)::bigint AS n_tup_upd,
  COALESCE(s.n_tup_del, 0)::bigint AS n_tup_del,
  pg_database_size(current_database())::bigint AS db_total_bytes,
  pg_size_pretty(pg_database_size(current_database())) AS db_total_pretty,
  ROUND(
    GREATEST(
      EXTRACT(EPOCH FROM (now() - COALESCE(
        (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
        pg_postmaster_start_time()
      ))) / 86400.0,
      0.04
    )::numeric,
    4
  )::float8 AS stats_window_days
FROM pg_stat_user_tables s
ORDER BY pg_total_relation_size(s.relid) DESC
LIMIT 30;
`;

export const LIVE_VACUUM_ACTIVITY_QUERY = `
SELECT
  schemaname,
  relname,
  COALESCE(n_live_tup, 0)::bigint AS n_live_tup,
  COALESCE(n_dead_tup, 0)::bigint AS n_dead_tup,
  ROUND(
    CASE WHEN (COALESCE(n_live_tup, 0) + COALESCE(n_dead_tup, 0)) = 0 THEN 0.0
         ELSE (COALESCE(n_dead_tup, 0)::numeric / (COALESCE(n_live_tup, 0) + COALESCE(n_dead_tup, 0))) * 100.0
    END,
    2
  )::float8 AS dead_tuple_pct,
  COALESCE(vacuum_count, 0)::bigint AS vacuum_count,
  COALESCE(autovacuum_count, 0)::bigint AS autovacuum_count,
  COALESCE(analyze_count, 0)::bigint AS analyze_count,
  COALESCE(autoanalyze_count, 0)::bigint AS autoanalyze_count,
  last_autovacuum,
  last_vacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC, (COALESCE(vacuum_count, 0) + COALESCE(autovacuum_count, 0)) DESC
LIMIT 25;
`;

export const LIVE_INDEX_BLOAT_TREND_QUERY = `
SELECT
  s.schemaname,
  s.relname AS tablename,
  s.indexrelname AS indexname,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size_pretty,
  pg_relation_size(s.indexrelid)::bigint AS index_bytes,
  ROUND(
    CASE WHEN COALESCE(s.idx_scan, 0) = 0 THEN 0.0
         WHEN COALESCE(s.idx_tup_read, 0) = 0 THEN 0.0
         ELSE GREATEST(0.0, (1.0 - (s.idx_tup_fetch::numeric / NULLIF(s.idx_tup_read, 0))) * 100.0)
    END,
    2
  )::float8 AS estimated_bloat_pct
FROM pg_stat_user_indexes s
JOIN pg_index i ON s.indexrelid = i.indexrelid
WHERE pg_relation_size(s.indexrelid) >= 32 * 1024
ORDER BY estimated_bloat_pct DESC, index_bytes DESC
LIMIT 25;
`;

export function formatBytesPretty(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function redactSqlQuery(rawSql: string | null | undefined): string {
  if (!rawSql) return '<unavailable>';
  return rawSql
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 480);
}

export function sanitizeStatementSql(rawSql: string | null | undefined): string {
  if (!rawSql) return '<unavailable>';
  return rawSql
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 960);
}

export function buildRemediationReindexSql(
  schemaname: string,
  indexname: string
): string {
  const safeSchema = schemaname.replace(/"/g, '""');
  const safeIndex = indexname.replace(/"/g, '""');
  return `REINDEX INDEX CONCURRENTLY "${safeSchema}"."${safeIndex}";`;
}

export function buildVacuumAnalyzeSql(
  schemaname: string,
  relname: string
): string {
  const safeSchema = schemaname.replace(/"/g, '""');
  const safeTable = relname.replace(/"/g, '""');
  return `VACUUM (VERBOSE, ANALYZE) "${safeSchema}"."${safeTable}";`;
}

export function buildDropUnusedIndexSql(
  schemaname: string,
  indexname: string
): string {
  const safeSchema = schemaname.replace(/"/g, '""');
  const safeIndex = indexname.replace(/"/g, '""');
  return `DROP INDEX CONCURRENTLY IF EXISTS "${safeSchema}"."${safeIndex}";`;
}

export interface TelemetryInspectionResult {
  catalog: ColumnCatalogRow[];
  schemaHash: string;
  tableCount: number;
  columnCount: number;
  locks: LockTreeRow[];
  bloat: IndexBloatRow[];
  health: DatabaseHealthSummary | null;
  durationMs: number;
}

export class SchemaInspector {
  static async fetchTargetCatalog(
    connectionString: string
  ): Promise<ColumnCatalogRow[]> {
    const client = new Client({
      connectionString,
      statement_timeout: 4000,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const res = await client.query<ColumnCatalogRow>(CATALOG_COLUMN_QUERY);
      return res.rows;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  static async fetchTopExpensiveQueries(
    mode: ConnectionMode,
    connectionString?: string
  ): Promise<{
    extensionAvailable: boolean;
    queries: ExpensiveQueryRow[];
    unavailableReason?: string;
  }> {
    const mapRows = (
      rows: Record<string, unknown>[]
    ): ExpensiveQueryRow[] =>
      rows.map((r) => ({
        query_id: String(r.query_id ?? '0'),
        query: sanitizeStatementSql(String(r.query ?? '')),
        calls: Number(r.calls ?? 0),
        mean_exec_time_ms: Number(r.mean_exec_time_ms ?? 0),
        total_exec_time_ms: Number(r.total_exec_time_ms ?? 0),
        max_exec_time_ms: Number(r.max_exec_time_ms ?? 0),
        total_rows: Number(r.total_rows ?? 0),
        cache_hit_pct: Number(r.cache_hit_pct ?? 100),
      }));

    const classifyExtensionError = (err: unknown): {
      extensionAvailable: false;
      queries: [];
      unavailableReason: string;
    } | null => {
      const pgErr = err as { code?: string; message?: string };
      const code = pgErr?.code ?? '';
      const msg = pgErr?.message ?? '';
      if (
        code === '42P01' ||
        code === '55000' ||
        code === '42501' ||
        /pg_stat_statements/i.test(msg)
      ) {
        if (code === '42501') {
          return {
            extensionAvailable: false,
            queries: [],
            unavailableReason:
              'Connected role lacks permission to read pg_stat_statements. Grant pg_read_all_stats to the monitoring role.',
          };
        }
        return {
          extensionAvailable: false,
          queries: [],
          unavailableReason:
            'The pg_stat_statements extension is not enabled on this database yet.',
        };
      }
      return null;
    };

    if (mode === 'workspace_pg') {
      try {
        const res = await pool.query(TOP_EXPENSIVE_QUERIES_QUERY);
        return {
          extensionAvailable: true,
          queries: mapRows(res.rows as Record<string, unknown>[]),
        };
      } catch (err) {
        const handled = classifyExtensionError(err);
        if (handled) return handled;
        throw err;
      }
    }

    if (!connectionString) {
      throw new Error('Target database connection string is missing.');
    }

    const client = new Client({
      connectionString,
      statement_timeout: 4000,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const res = await client.query(TOP_EXPENSIVE_QUERIES_QUERY);
      return {
        extensionAvailable: true,
        queries: mapRows(res.rows as Record<string, unknown>[]),
      };
    } catch (err) {
      const handled = classifyExtensionError(err);
      if (handled) return handled;
      throw err;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  static async fetchLiveLockContention(
    mode: ConnectionMode,
    connectionString?: string
  ): Promise<{
    edges: LiveLockEdge[];
    permissionWarning?: string;
  }> {
    const mapAndDedupe = (
      rows: Record<string, unknown>[]
    ): LiveLockEdge[] => {
      const pairMap = new Map<string, LiveLockEdge>();
      for (const r of rows) {
        const blockingPid = Number(r.blocking_pid ?? 0);
        const blockedPid = Number(r.blocked_pid ?? 0);
        if (!blockingPid || !blockedPid || blockingPid === blockedPid) continue;
        const key = `${blockingPid}->${blockedPid}`;
        const waitSec = Math.max(0, Number(r.wait_duration_seconds ?? 0));
        const existing = pairMap.get(key);
        if (existing && existing.wait_duration_seconds >= waitSec) continue;

        pairMap.set(key, {
          blocked_pid: blockedPid,
          blocked_user: String(r.blocked_user ?? 'unknown'),
          blocked_app: String(r.blocked_app ?? ''),
          blocked_state: String(r.blocked_state ?? 'active'),
          blocked_statement: redactSqlQuery(String(r.blocked_statement ?? '')),
          blocking_pid: blockingPid,
          blocking_user: String(r.blocking_user ?? 'unknown'),
          blocking_app: String(r.blocking_app ?? ''),
          blocking_state: String(r.blocking_state ?? 'active'),
          blocking_statement: redactSqlQuery(
            String(r.blocking_statement ?? '')
          ),
          lock_type: String(r.lock_type ?? 'relation'),
          waiting_mode: String(r.waiting_mode ?? 'AccessShareLock'),
          held_mode: String(r.held_mode ?? 'AccessExclusiveLock'),
          target_relation: String(r.target_relation ?? 'unknown'),
          wait_duration_seconds: waitSec,
          wait_duration_display: String(r.wait_duration_display ?? '0s'),
        });
      }
      return Array.from(pairMap.values()).sort(
        (a, b) => b.wait_duration_seconds - a.wait_duration_seconds
      );
    };

    const handleErr = (
      err: unknown
    ): { edges: []; permissionWarning: string } | null => {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '42501') {
        return {
          edges: [],
          permissionWarning:
            'Monitoring role lacks pg_read_all_stats privileges to inspect pg_stat_activity and pg_locks.',
        };
      }
      return null;
    };

    if (mode === 'workspace_pg') {
      try {
        const res = await pool.query(LIVE_LOCK_CONTENTION_QUERY);
        return { edges: mapAndDedupe(res.rows as Record<string, unknown>[]) };
      } catch (err) {
        const handled = handleErr(err);
        if (handled) return handled;
        throw err;
      }
    }

    if (!connectionString) {
      throw new Error('Target database connection string is missing.');
    }

    const client = new Client({
      connectionString,
      statement_timeout: 4000,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const res = await client.query(LIVE_LOCK_CONTENTION_QUERY);
      return { edges: mapAndDedupe(res.rows as Record<string, unknown>[]) };
    } catch (err) {
      const handled = handleErr(err);
      if (handled) return handled;
      throw err;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  static async fetchCapacityMetrics(
    mode: ConnectionMode,
    connectionString?: string
  ): Promise<{
    dbTotalBytes: number;
    dbTotalPretty: string;
    statsWindowDays: number;
    tables: {
      schemaname: string;
      relname: string;
      total_bytes: number;
      total_size_pretty: string;
      table_bytes: number;
      index_bytes: number;
      n_live_tup: number;
      n_dead_tup: number;
      dead_tuple_pct: number;
      n_tup_ins: number;
      n_tup_upd: number;
      n_tup_del: number;
    }[];
  }> {
    const parseRows = (
      rows: Record<string, unknown>[],
      fallbackDbRow?: Record<string, unknown>
    ) => {
      const first = rows[0] ?? fallbackDbRow ?? {};
      const dbTotalBytes = Number(
        first.db_total_bytes ?? first.database_size_bytes ?? 0
      );
      const dbTotalPretty = String(
        first.db_total_pretty ??
          first.database_size_pretty ??
          formatBytesPretty(dbTotalBytes)
      );
      const statsWindowDays = Math.max(
        0.04,
        Number(first.stats_window_days ?? 1)
      );

      const tables = rows.map((r) => ({
        schemaname: String(r.schemaname ?? 'public'),
        relname: String(r.relname ?? ''),
        total_bytes: Number(r.total_bytes ?? 0),
        total_size_pretty: String(
          r.total_size_pretty ?? formatBytesPretty(Number(r.total_bytes ?? 0))
        ),
        table_bytes: Number(r.table_bytes ?? 0),
        index_bytes: Number(r.index_bytes ?? 0),
        n_live_tup: Number(r.n_live_tup ?? 0),
        n_dead_tup: Number(r.n_dead_tup ?? 0),
        dead_tuple_pct: Number(r.dead_tuple_pct ?? 0),
        n_tup_ins: Number(r.n_tup_ins ?? 0),
        n_tup_upd: Number(r.n_tup_upd ?? 0),
        n_tup_del: Number(r.n_tup_del ?? 0),
      }));

      return { dbTotalBytes, dbTotalPretty, statsWindowDays, tables };
    };

    if (mode === 'workspace_pg') {
      const res = await pool.query(CAPACITY_BLOAT_METRICS_QUERY);
      if (res.rows.length > 0) {
        return parseRows(res.rows as Record<string, unknown>[]);
      }
      const fallback = await pool.query(DATABASE_HEALTH_SUMMARY_QUERY);
      return parseRows(
        [],
        (fallback.rows[0] as Record<string, unknown>) ?? undefined
      );
    }

    if (!connectionString) {
      throw new Error('Target database connection string is missing.');
    }

    const client = new Client({
      connectionString,
      statement_timeout: 4000,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const res = await client.query(CAPACITY_BLOAT_METRICS_QUERY);
      if (res.rows.length > 0) {
        return parseRows(res.rows as Record<string, unknown>[]);
      }
      const fallback = await client.query(DATABASE_HEALTH_SUMMARY_QUERY);
      return parseRows(
        [],
        (fallback.rows[0] as Record<string, unknown>) ?? undefined
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  static async fetchLiveVacuumAndBloatStats(
    mode: ConnectionMode,
    connectionString?: string
  ): Promise<{
    tables: {
      schemaname: string;
      relname: string;
      n_live_tup: number;
      n_dead_tup: number;
      dead_tuple_pct: number;
      vacuum_count: number;
      autovacuum_count: number;
      last_autovacuum: string | null;
    }[];
    indexes: {
      schemaname: string;
      tablename: string;
      indexname: string;
      index_size_pretty: string;
      index_bytes: number;
      estimated_bloat_pct: number;
    }[];
  }> {
    const parse = (
      tableRows: Record<string, unknown>[],
      idxRows: Record<string, unknown>[]
    ) => ({
      tables: tableRows.map((r) => ({
        schemaname: String(r.schemaname ?? 'public'),
        relname: String(r.relname ?? ''),
        n_live_tup: Number(r.n_live_tup ?? 0),
        n_dead_tup: Number(r.n_dead_tup ?? 0),
        dead_tuple_pct: Number(r.dead_tuple_pct ?? 0),
        vacuum_count: Number(r.vacuum_count ?? 0),
        autovacuum_count: Number(r.autovacuum_count ?? 0),
        last_autovacuum: r.last_autovacuum
          ? new Date(String(r.last_autovacuum)).toISOString()
          : null,
      })),
      indexes: idxRows.map((r) => ({
        schemaname: String(r.schemaname ?? 'public'),
        tablename: String(r.tablename ?? ''),
        indexname: String(r.indexname ?? ''),
        index_size_pretty: String(r.index_size_pretty ?? '0 B'),
        index_bytes: Number(r.index_bytes ?? 0),
        estimated_bloat_pct: Number(r.estimated_bloat_pct ?? 0),
      })),
    });

    if (mode === 'workspace_pg') {
      const [tRes, iRes] = await Promise.all([
        pool.query(LIVE_VACUUM_ACTIVITY_QUERY).catch(() => ({ rows: [] })),
        pool.query(LIVE_INDEX_BLOAT_TREND_QUERY).catch(() => ({ rows: [] })),
      ]);
      return parse(
        tRes.rows as Record<string, unknown>[],
        iRes.rows as Record<string, unknown>[]
      );
    }

    if (!connectionString) {
      throw new Error('Target database connection string is missing.');
    }

    const client = new Client({
      connectionString,
      statement_timeout: 4000,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const tRes = await client
        .query(LIVE_VACUUM_ACTIVITY_QUERY)
        .catch(() => ({ rows: [] }));
      const iRes = await client
        .query(LIVE_INDEX_BLOAT_TREND_QUERY)
        .catch(() => ({ rows: [] }));
      return parse(
        tRes.rows as Record<string, unknown>[],
        iRes.rows as Record<string, unknown>[]
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  static computeCanonicalHash(rows: ColumnCatalogRow[]): string {
    const sorted = [...rows].sort((a, b) => {
      const schemaCmp = a.table_schema.localeCompare(b.table_schema);
      if (schemaCmp !== 0) return schemaCmp;
      const tableCmp = a.table_name.localeCompare(b.table_name);
      if (tableCmp !== 0) return tableCmp;
      const posA = a.ordinal_position ?? 0;
      const posB = b.ordinal_position ?? 0;
      if (posA !== posB) return posA - posB;
      return a.column_name.localeCompare(b.column_name);
    });

    const serialized = sorted
      .map(
        (r) =>
          `${r.table_schema}.${r.table_name}:${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default || ''}`
      )
      .join('\n');

    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  static computeFingerprint(parts: string[]): string {
    return crypto
      .createHash('sha256')
      .update(parts.join('::'))
      .digest('hex');
  }

  static diffCatalogs(
    baselineRows: ColumnCatalogRow[],
    liveRows: ColumnCatalogRow[]
  ): ColumnDiffItem[] {
    const toKey = (r: ColumnCatalogRow) =>
      `${r.table_schema}.${r.table_name}.${r.column_name}`;

    const baselineMap = new Map<string, ColumnCatalogRow>();
    for (const row of baselineRows) {
      baselineMap.set(toKey(row), row);
    }

    const liveMap = new Map<string, ColumnCatalogRow>();
    for (const row of liveRows) {
      liveMap.set(toKey(row), row);
    }

    const diffs: ColumnDiffItem[] = [];

    for (const [key, live] of liveMap.entries()) {
      const base = baselineMap.get(key);
      if (!base) {
        diffs.push({
          kind: 'ADDED',
          table_schema: live.table_schema,
          table_name: live.table_name,
          column_name: live.column_name,
          live: {
            data_type: live.data_type,
            is_nullable: live.is_nullable,
            column_default: live.column_default ?? null,
          },
        });
      } else if (
        base.data_type !== live.data_type ||
        base.is_nullable !== live.is_nullable ||
        (base.column_default ?? '') !== (live.column_default ?? '')
      ) {
        diffs.push({
          kind: 'MODIFIED',
          table_schema: live.table_schema,
          table_name: live.table_name,
          column_name: live.column_name,
          baseline: {
            data_type: base.data_type,
            is_nullable: base.is_nullable,
            column_default: base.column_default ?? null,
          },
          live: {
            data_type: live.data_type,
            is_nullable: live.is_nullable,
            column_default: live.column_default ?? null,
          },
        });
      }
    }

    for (const [key, base] of baselineMap.entries()) {
      if (!liveMap.has(key)) {
        diffs.push({
          kind: 'REMOVED',
          table_schema: base.table_schema,
          table_name: base.table_name,
          column_name: base.column_name,
          baseline: {
            data_type: base.data_type,
            is_nullable: base.is_nullable,
            column_default: base.column_default ?? null,
          },
        });
      }
    }

    return diffs.sort((a, b) =>
      `${a.table_schema}.${a.table_name}.${a.column_name}`.localeCompare(
        `${b.table_schema}.${b.table_name}.${b.column_name}`
      )
    );
  }

  static async inspectTarget(
    mode: ConnectionMode,
    connectionString?: string
  ): Promise<TelemetryInspectionResult> {
    const startedAt = Date.now();

    if (mode === 'workspace_pg') {
      const [
        catalogRes,
        locksRes,
        bloatRes,
        tableHealthRes,
        unusedIdxRes,
        dbHealthRes,
      ] = await Promise.all([
        pool.query<ColumnCatalogRow>(CATALOG_COLUMN_QUERY),
        pool.query(RECURSIVE_LOCK_TREE_QUERY).catch(() => ({ rows: [] })),
        pool.query(INDEX_BLOAT_QUERY).catch(() => ({ rows: [] })),
        pool.query(TABLE_HEALTH_QUERY).catch(() => ({ rows: [] })),
        pool.query(UNUSED_INDEXES_QUERY).catch(() => ({ rows: [] })),
        pool.query(DATABASE_HEALTH_SUMMARY_QUERY).catch(() => ({ rows: [] })),
      ]);

      return this.formatResult(
        catalogRes.rows,
        locksRes.rows,
        bloatRes.rows,
        tableHealthRes.rows,
        unusedIdxRes.rows,
        dbHealthRes.rows[0] ?? null,
        Date.now() - startedAt
      );
    }

    if (!connectionString) {
      throw new Error('Target database connection string is missing.');
    }

    const client = new Client({
      connectionString,
      statement_timeout: 4000,
      connectionTimeoutMillis: 5000,
    });

    await client.connect();
    try {
      const catalogRes =
        await client.query<ColumnCatalogRow>(CATALOG_COLUMN_QUERY);
      const locksRes = await client
        .query(RECURSIVE_LOCK_TREE_QUERY)
        .catch(() => ({ rows: [] }));
      const bloatRes = await client
        .query(INDEX_BLOAT_QUERY)
        .catch(() => ({ rows: [] }));
      const tableHealthRes = await client
        .query(TABLE_HEALTH_QUERY)
        .catch(() => ({ rows: [] }));
      const unusedIdxRes = await client
        .query(UNUSED_INDEXES_QUERY)
        .catch(() => ({ rows: [] }));
      const dbHealthRes = await client
        .query(DATABASE_HEALTH_SUMMARY_QUERY)
        .catch(() => ({ rows: [] }));

      return this.formatResult(
        catalogRes.rows,
        locksRes.rows,
        bloatRes.rows,
        tableHealthRes.rows,
        unusedIdxRes.rows,
        dbHealthRes.rows[0] ?? null,
        Date.now() - startedAt
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private static formatResult(
    catalog: ColumnCatalogRow[],
    rawLocks: Record<string, unknown>[],
    rawBloat: Record<string, unknown>[],
    rawTableHealth: Record<string, unknown>[],
    rawUnusedIdx: Record<string, unknown>[],
    rawDbSummary: Record<string, unknown> | null,
    durationMs: number
  ): TelemetryInspectionResult {
    const tableSet = new Set(
      catalog.map((row) => `${row.table_schema}.${row.table_name}`)
    );

    const locks: LockTreeRow[] = rawLocks.map((r) => ({
      blocked_pid: Number(r.blocked_pid ?? 0),
      blocked_user: String(r.blocked_user ?? 'unknown'),
      blocking_pid: Number(r.blocking_pid ?? 0),
      blocking_user: String(r.blocking_user ?? 'unknown'),
      blocked_statement: redactSqlQuery(String(r.blocked_statement ?? '')),
      blocking_statement: redactSqlQuery(String(r.blocking_statement ?? '')),
      wait_duration_seconds: Number(r.wait_duration_seconds ?? 0),
      wait_duration_display: String(r.wait_duration_display ?? '0s'),
    }));

    const bloat: IndexBloatRow[] = rawBloat.map((r) => {
      const schemaname = String(r.schemaname ?? 'public');
      const indexname = String(r.indexname ?? '');
      return {
        schemaname,
        tablename: String(r.tablename ?? ''),
        indexname,
        index_size_pretty: String(r.index_size_pretty ?? '0 bytes'),
        index_bytes: Number(r.index_bytes ?? 0),
        estimated_bloat_pct: Number(r.estimated_bloat_pct ?? 0),
        remediation_sql: buildRemediationReindexSql(schemaname, indexname),
      };
    });

    const tableHealth: TableHealthRow[] = rawTableHealth.map((r) => {
      const schemaname = String(r.schemaname ?? 'public');
      const relname = String(r.relname ?? '');
      return {
        schemaname,
        relname,
        n_live_tup: Number(r.n_live_tup ?? 0),
        n_dead_tup: Number(r.n_dead_tup ?? 0),
        dead_tuple_pct: Number(r.dead_tuple_pct ?? 0),
        seq_scan: Number(r.seq_scan ?? 0),
        idx_scan: Number(r.idx_scan ?? 0),
        total_size_pretty: String(r.total_size_pretty ?? '0 bytes'),
        total_bytes: Number(r.total_bytes ?? 0),
        last_autovacuum: r.last_autovacuum
          ? new Date(String(r.last_autovacuum)).toISOString()
          : null,
        last_autoanalyze: r.last_autoanalyze
          ? new Date(String(r.last_autoanalyze)).toISOString()
          : null,
        remediation_sql: buildVacuumAnalyzeSql(schemaname, relname),
      };
    });

    const unusedIndexes: UnusedIndexRow[] = rawUnusedIdx.map((r) => {
      const schemaname = String(r.schemaname ?? 'public');
      const indexname = String(r.indexname ?? '');
      return {
        schemaname,
        tablename: String(r.tablename ?? ''),
        indexname,
        idx_scan: Number(r.idx_scan ?? 0),
        index_size_pretty: String(r.index_size_pretty ?? '0 bytes'),
        index_bytes: Number(r.index_bytes ?? 0),
        remediation_sql: buildDropUnusedIndexSql(schemaname, indexname),
      };
    });

    let health: DatabaseHealthSummary | null = null;
    if (rawDbSummary) {
      const active = Number(rawDbSummary.active_connections ?? 0);
      const idle = Number(rawDbSummary.idle_connections ?? 0);
      const idleInTx = Number(rawDbSummary.idle_in_transaction ?? 0);
      const maxConn = Math.max(1, Number(rawDbSummary.max_connections ?? 100));
      const totalUsed = active + idle + idleInTx;
      health = {
        database_size_pretty: String(
          rawDbSummary.database_size_pretty ?? '0 MB'
        ),
        database_size_bytes: Number(rawDbSummary.database_size_bytes ?? 0),
        cache_hit_ratio_pct: Number(rawDbSummary.cache_hit_ratio_pct ?? 100),
        active_connections: active,
        idle_connections: idle,
        idle_in_transaction: idleInTx,
        max_connections: maxConn,
        connection_usage_pct: Math.round((totalUsed / maxConn) * 1000) / 10,
        pg_version: String(rawDbSummary.pg_version ?? 'PostgreSQL'),
        table_health: tableHealth,
        unused_indexes: unusedIndexes,
      };
    }

    return {
      catalog,
      schemaHash: this.computeCanonicalHash(catalog),
      tableCount: tableSet.size,
      columnCount: catalog.length,
      locks,
      bloat,
      health,
      durationMs,
    };
  }
}
