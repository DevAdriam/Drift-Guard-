import { and, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { db, pool } from '../db/index.ts';
import { monitoredDatabases } from '../db/schema.ts';
import { decryptSecret, validateSafePostgresUrl } from './crypto.ts';
import { SchemaInspector } from './inspector.ts';
import type {
  ConnectionMode,
  ExplainPlanAnalysisResponse,
  IndexAdvisorRecommendation,
  IndexAdvisorResponse,
  QueryPlanNodeDto,
  SeqScanHotspotRow,
  SeverityLevel,
} from '../types/telemetry.ts';

const SEQ_SCAN_HOTSPOTS_QUERY = `
SELECT
  t.schemaname,
  t.relname,
  COALESCE(t.seq_scan, 0)::bigint AS seq_scan,
  COALESCE(t.seq_tup_read, 0)::bigint AS seq_tup_read,
  COALESCE(t.idx_scan, 0)::bigint AS idx_scan,
  ROUND(
    CASE
      WHEN (COALESCE(t.seq_scan, 0) + COALESCE(t.idx_scan, 0)) = 0 THEN 0.0
      ELSE (COALESCE(t.seq_scan, 0)::numeric / (COALESCE(t.seq_scan, 0) + COALESCE(t.idx_scan, 0))) * 100.0
    END,
    1
  )::float8 AS seq_scan_pct,
  COALESCE(t.n_live_tup, 0)::bigint AS n_live_tup,
  pg_size_pretty(pg_total_relation_size(t.relid)) AS table_size_pretty,
  pg_total_relation_size(t.relid)::bigint AS table_bytes,
  (
    SELECT count(*)::int
    FROM pg_indexes pi
    WHERE pi.schemaname = t.schemaname
      AND pi.tablename = t.relname
  ) AS existing_index_count
FROM pg_stat_user_tables t
WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY COALESCE(t.seq_tup_read, 0) DESC, COALESCE(t.seq_scan, 0) DESC
LIMIT 30;
`;

const EXISTING_INDEXES_QUERY = `
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename, indexname;
`;

const TABLE_COLUMNS_QUERY = `
SELECT
  table_schema,
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, ordinal_position;
`;

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function sanitizeIndexName(
  tableName: string,
  rawColumns: string[]
): string {
  const cleanCols = rawColumns
    .map((c) => c.replace(/\s+(ASC|DESC)$/i, '').replace(/[^a-zA-Z0-9_]/g, ''))
    .filter(Boolean)
    .slice(0, 4);
  const cleanTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const base = `idx_${cleanTable}_${cleanCols.join('_')}`.toLowerCase();
  return base.slice(0, 60);
}

function formatCreateIndexSql(
  schemaName: string,
  tableName: string,
  indexName: string,
  columns: string[]
): string {
  const colList = columns
    .map((c) => {
      const m = c.match(/^([a-zA-Z0-9_]+)(\s+(ASC|DESC))?$/i);
      if (!m) return quoteIdent(c);
      return m[3]
        ? `${quoteIdent(m[1])} ${m[3].toUpperCase()}`
        : quoteIdent(m[1]);
    })
    .join(', ');

  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(indexName)}\n  ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)} (${colList});`;
}

function parseIndexedColumnsFromDef(indexdef: string): string[] {
  const match = indexdef.match(/\(([^()]+)\)\s*(?:WHERE|INCLUDE|WITH|TABLESPACE|$)/i);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^"([^"]+)"/, '$1')
        .replace(/\s+(ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST).*$/i, '')
        .replace(/::[a-zA-Z0-9_ ]+$/, '')
        .trim()
        .toLowerCase()
    )
    .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
}

function isCoveredByExistingIndexes(
  existingIndexCols: string[][],
  proposedCols: string[]
): boolean {
  const normalized = proposedCols.map((c) =>
    c.replace(/\s+(ASC|DESC)$/i, '').toLowerCase()
  );
  if (!normalized.length) return true;
  return existingIndexCols.some((idxCols) => {
    if (idxCols.length < normalized.length) return false;
    return normalized.every((col, i) => idxCols[i] === col);
  });
}

async function resolveTargetConnection(
  ownerUid: string,
  databaseId?: string
): Promise<{
  targetLabel: string;
  resolvedDbId: string | null;
  mode: ConnectionMode;
  connectionUrl?: string;
}> {
  if (!databaseId) {
    return {
      targetLabel: 'Workspace PostgreSQL (Live)',
      resolvedDbId: null,
      mode: 'workspace_pg',
    };
  }

  const rows = await db
    .select()
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.id, databaseId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!rows.length) {
    throw new Error('Target database not found.');
  }

  const target = rows[0];
  const mode = target.connectionMode as ConnectionMode;
  let connectionUrl: string | undefined;

  if (mode === 'external') {
    if (!target.connectionUrlEncrypted) {
      throw new Error('Target database connection string is not configured.');
    }
    connectionUrl = decryptSecret(target.connectionUrlEncrypted);
    await validateSafePostgresUrl(connectionUrl);
  }

  return {
    targetLabel: `${target.name} (${target.environment})`,
    resolvedDbId: target.id,
    mode,
    connectionUrl,
  };
}

async function withTargetQueryRunner<T>(
  mode: ConnectionMode,
  connectionUrl: string | undefined,
  fn: (query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>
): Promise<T> {
  if (mode === 'workspace_pg') {
    const client = await pool.connect();
    try {
      return await fn((sql) =>
        client.query(sql) as Promise<{ rows: Record<string, unknown>[] }>
      );
    } finally {
      client.release();
    }
  }

  if (!connectionUrl) {
    throw new Error('Target database connection string is missing.');
  }

  const client = new Client({
    connectionString: connectionUrl,
    statement_timeout: 4000,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    return await fn((sql) =>
      client.query(sql) as Promise<{ rows: Record<string, unknown>[] }>
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

interface CatalogContext {
  hotspots: SeqScanHotspotRow[];
  columnsByTable: Map<string, Map<string, string>>; // schema.table -> (col -> data_type)
  schemaByBareTable: Map<string, string>; // table -> schema
  existingIndexesByTable: Map<string, string[][]>; // schema.table -> array of column arrays
}

async function loadCatalogContext(
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>
): Promise<CatalogContext> {
  const hotspotsRes = await query(SEQ_SCAN_HOTSPOTS_QUERY);
  const indexesRes = await query(EXISTING_INDEXES_QUERY);
  const colsRes = await query(TABLE_COLUMNS_QUERY);

  const hotspots: SeqScanHotspotRow[] = hotspotsRes.rows.map((r) => ({
    schemaname: String(r.schemaname ?? 'public'),
    relname: String(r.relname ?? ''),
    seq_scan: Number(r.seq_scan ?? 0),
    seq_tup_read: Number(r.seq_tup_read ?? 0),
    idx_scan: Number(r.idx_scan ?? 0),
    seq_scan_pct: Number(r.seq_scan_pct ?? 0),
    n_live_tup: Number(r.n_live_tup ?? 0),
    table_size_pretty: String(r.table_size_pretty ?? '0 bytes'),
    table_bytes: Number(r.table_bytes ?? 0),
    existing_index_count: Number(r.existing_index_count ?? 0),
  }));

  const columnsByTable = new Map<string, Map<string, string>>();
  const schemaByBareTable = new Map<string, string>();
  for (const r of colsRes.rows) {
    const schema = String(r.table_schema ?? 'public');
    const table = String(r.table_name ?? '');
    const col = String(r.column_name ?? '');
    const dtype = String(r.data_type ?? '');
    const key = `${schema}.${table}`.toLowerCase();
    let map = columnsByTable.get(key);
    if (!map) {
      map = new Map<string, string>();
      columnsByTable.set(key, map);
    }
    map.set(col.toLowerCase(), dtype);
    if (!schemaByBareTable.has(table.toLowerCase()) || schema === 'public') {
      schemaByBareTable.set(table.toLowerCase(), schema);
    }
  }

  const existingIndexesByTable = new Map<string, string[][]>();
  for (const r of indexesRes.rows) {
    const schema = String(r.schemaname ?? 'public');
    const table = String(r.tablename ?? '');
    const def = String(r.indexdef ?? '');
    const parsedCols = parseIndexedColumnsFromDef(def);
    if (parsedCols.length > 0) {
      const key = `${schema}.${table}`.toLowerCase();
      const list = existingIndexesByTable.get(key) ?? [];
      list.push(parsedCols);
      existingIndexesByTable.set(key, list);
    }
  }

  return {
    hotspots,
    columnsByTable,
    schemaByBareTable,
    existingIndexesByTable,
  };
}

interface ExtractedPredicates {
  tableSchema: string;
  tableName: string;
  equalityCols: string[];
  sortCols: { col: string; dir?: 'ASC' | 'DESC' }[];
  rangeCols: string[];
}

function extractSqlPredicates(
  sql: string,
  ctx: CatalogContext
): ExtractedPredicates[] {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!/^(SELECT|WITH)\b/i.test(cleaned)) return [];

  // Extract FROM / JOIN table references with optional aliases
  const tableRefRegex =
    /\b(?:FROM|JOIN)\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  const reservedAliases = new Set([
    'where',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'cross',
    'on',
    'group',
    'order',
    'limit',
    'offset',
    'having',
    'union',
    'set',
    'as',
    'lateral',
  ]);

  const tables: { schema: string; table: string; alias: string | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tableRefRegex.exec(cleaned)) !== null) {
    const rawSchema = m[1]?.toLowerCase();
    const rawTable = m[2]?.toLowerCase();
    const rawAlias = m[3]?.toLowerCase();
    if (!rawTable) continue;
    const resolvedSchema = rawSchema ?? ctx.schemaByBareTable.get(rawTable);
    if (!resolvedSchema) continue;
    const key = `${resolvedSchema}.${rawTable}`;
    if (!ctx.columnsByTable.has(key)) continue;
    const alias = rawAlias && !reservedAliases.has(rawAlias) ? rawAlias : null;
    if (!tables.some((t) => t.schema === resolvedSchema && t.table === rawTable)) {
      tables.push({ schema: resolvedSchema, table: rawTable, alias });
    }
  }

  if (tables.length === 0) return [];

  // Extract WHERE / ON clause fragment and ORDER BY fragment
  const whereMatch = cleaned.match(
    /\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|\bHAVING\b|$)/i
  );
  const whereText = whereMatch?.[1] ?? '';

  const orderMatch = cleaned.match(
    /\bORDER\s+BY\b([\s\S]*?)(?:\bLIMIT\b|\bOFFSET\b|\bFOR\s+UPDATE\b|$)/i
  );
  const orderText = orderMatch?.[1] ?? '';

  const results: ExtractedPredicates[] = [];

  for (const tbl of tables) {
    const key = `${tbl.schema}.${tbl.table}`;
    const validCols = ctx.columnsByTable.get(key);
    if (!validCols) continue;

    const eqSet = new Set<string>();
    const rangeSet = new Set<string>();
    const sortCols: { col: string; dir?: 'ASC' | 'DESC' }[] = [];
    const sortSeen = new Set<string>();

    const matchesTablePrefix = (prefix: string | undefined) => {
      if (!prefix) return tables.length === 1;
      const p = prefix.toLowerCase();
      return p === tbl.table || (tbl.alias !== null && p === tbl.alias);
    };

    // Equality conditions: col = ... or col IN (...)
    const eqRegex =
      /(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?)\s*(?:=(?!=)|\bIN\s*\(|\bIS\s+NULL\b)/gi;
    let eqM: RegExpExecArray | null;
    while ((eqM = eqRegex.exec(whereText)) !== null) {
      const prefix = eqM[1];
      const col = eqM[2]?.toLowerCase();
      if (!col || !validCols.has(col)) continue;
      if (!matchesTablePrefix(prefix)) continue;
      eqSet.add(col);
    }

    // Range conditions: col > / >= / < / <= / BETWEEN / LIKE / ILIKE
    const rangeRegex =
      /(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?)\s*(?:>=|<=|>|<|\bBETWEEN\b|\bI?LIKE\b)/gi;
    let rM: RegExpExecArray | null;
    while ((rM = rangeRegex.exec(whereText)) !== null) {
      const prefix = rM[1];
      const col = rM[2]?.toLowerCase();
      if (!col || !validCols.has(col)) continue;
      if (!matchesTablePrefix(prefix)) continue;
      if (!eqSet.has(col)) rangeSet.add(col);
    }

    // ORDER BY columns
    if (orderText) {
      const parts = orderText.split(',');
      for (const part of parts) {
        const ordM = part
          .trim()
          .match(
            /^(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\s+(ASC|DESC))?/i
          );
        if (!ordM) continue;
        const prefix = ordM[1];
        const col = ordM[2]?.toLowerCase();
        const dir = ordM[3]?.toUpperCase() as 'ASC' | 'DESC' | undefined;
        if (!col || !validCols.has(col)) continue;
        if (!matchesTablePrefix(prefix)) continue;
        if (!sortSeen.has(col)) {
          sortSeen.add(col);
          sortCols.push({ col, dir });
        }
      }
    }

    if (eqSet.size > 0 || rangeSet.size > 0 || sortCols.length > 0) {
      results.push({
        tableSchema: tbl.schema,
        tableName: tbl.table,
        equalityCols: Array.from(eqSet),
        sortCols,
        rangeCols: Array.from(rangeSet),
      });
    }
  }

  return results;
}

/**
 * Applies PostgreSQL B-Tree ESR rule: Equality -> Sort -> Range
 */
function buildEsrColumns(pred: ExtractedPredicates): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();

  for (const eqCol of pred.equalityCols) {
    if (!seen.has(eqCol)) {
      seen.add(eqCol);
      cols.push(eqCol);
    }
  }
  for (const s of pred.sortCols) {
    if (!seen.has(s.col)) {
      seen.add(s.col);
      cols.push(s.dir === 'DESC' ? `${s.col} DESC` : s.col);
    }
  }
  for (const rCol of pred.rangeCols) {
    if (!seen.has(rCol)) {
      seen.add(rCol);
      cols.push(rCol);
    }
  }
  return cols.slice(0, 4);
}

/**
 * Strictly validates that user-supplied SQL for EXPLAIN is a single read-only SELECT/WITH query.
 */
export function validateExplainOnlySelectSql(rawSql: string): string {
  const trimmed = rawSql.trim().replace(/;\s*$/, '').trim();
  if (!trimmed) {
    throw new Error('Enter a SELECT query to analyze its PostgreSQL query plan.');
  }
  if (trimmed.length > 4000) {
    throw new Error('SQL query must be 4,000 characters or fewer.');
  }

  // Strip comments and single-quoted string literals for structural safety checks
  const stripped = trimmed
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .trim();

  if (stripped.includes(';')) {
    throw new Error(
      'Only a single SELECT statement may be analyzed at a time (stacked statements are not allowed).'
    );
  }

  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    throw new Error(
      'Index Advisor EXPLAIN only accepts read-only SELECT or WITH ... SELECT queries.'
    );
  }

  const forbiddenPattern =
    /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|PREPARE|DEALLOCATE|VACUUM|ANALYZE|REINDEX|CLUSTER|LOCK|SET|RESET|DISCARD|LISTEN|NOTIFY|pg_terminate_backend|pg_cancel_backend|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_sleep|dblink|lo_import|lo_export)\b/i;

  const badMatch = stripped.match(forbiddenPattern);
  if (badMatch) {
    throw new Error(
      `Disallowed SQL keyword or function "${badMatch[1]}" detected. Only pure read-only SELECT queries are permitted.`
    );
  }

  return trimmed;
}

interface PgExplainRawNode {
  'Node Type': string;
  'Relation Name'?: string;
  Schema?: string;
  Alias?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  Filter?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Sort Key'?: string[];
  'Join Type'?: string;
  'Hash Cond'?: string;
  Plans?: PgExplainRawNode[];
}

function mapExplainNode(raw: PgExplainRawNode): QueryPlanNodeDto {
  const nodeType = String(raw['Node Type'] ?? 'Unknown');
  const children = Array.isArray(raw.Plans)
    ? raw.Plans.map(mapExplainNode)
    : [];
  const isSeqScanBottleneck =
    nodeType === 'Seq Scan' &&
    (Boolean(raw.Filter) || Number(raw['Total Cost'] ?? 0) >= 10);

  return {
    nodeType,
    relationName: raw['Relation Name'],
    schema: raw.Schema,
    alias: raw.Alias,
    startupCost: Math.round(Number(raw['Startup Cost'] ?? 0) * 100) / 100,
    totalCost: Math.round(Number(raw['Total Cost'] ?? 0) * 100) / 100,
    planRows: Math.round(Number(raw['Plan Rows'] ?? 0)),
    planWidth: Math.round(Number(raw['Plan Width'] ?? 0)),
    filter: raw.Filter,
    indexName: raw['Index Name'],
    indexCond: raw['Index Cond'],
    sortKey: Array.isArray(raw['Sort Key']) ? raw['Sort Key'] : undefined,
    joinType: raw['Join Type'],
    hashCond: raw['Hash Cond'],
    isSeqScanBottleneck,
    children,
  };
}

function extractColumnsFromPlanExpr(
  expr: string,
  validCols: Map<string, string>,
  alias?: string
): { eqCols: string[]; rangeCols: string[] } {
  const eqCols: string[] = [];
  const rangeCols: string[] = [];
  const eqSeen = new Set<string>();
  const rangeSeen = new Set<string>();

  const aliasPrefix = alias
    ? `(?:${alias}\\.)?`
    : '(?:[a-zA-Z_][a-zA-Z0-9_]*\\.)?';
  // Handles PostgreSQL EXPLAIN Filter forms like:
  //   (action = 'OPEN')
  //   ((action)::text = 'INSPECTION_RUN'::text)
  //   (created_at >= (now() - '30 days'::interval))
  const colToken = `\\(*(?:${aliasPrefix}"?([a-zA-Z_][a-zA-Z0-9_]*)"?)\\)*(?:::[a-zA-Z0-9_ \\[\\]]+)*\\)*`;

  const eqRegex = new RegExp(
    `${colToken}\\s*(?:=(?!=)|~~|\\bIS\\s+NULL\\b|=\\s*ANY\\b)`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = eqRegex.exec(expr)) !== null) {
    const col = m[1]?.toLowerCase();
    if (col && validCols.has(col) && !eqSeen.has(col)) {
      eqSeen.add(col);
      eqCols.push(col);
    }
  }

  const rangeRegex = new RegExp(
    `${colToken}\\s*(?:>=|<=|>|<|~~\\*|!~~)`,
    'gi'
  );
  while ((m = rangeRegex.exec(expr)) !== null) {
    const col = m[1]?.toLowerCase();
    if (col && validCols.has(col) && !eqSeen.has(col) && !rangeSeen.has(col)) {
      rangeSeen.add(col);
      rangeCols.push(col);
    }
  }

  return { eqCols, rangeCols };
}

function extractSortColsFromPlanKeys(
  sortKeys: string[] | undefined,
  validCols: Map<string, string>
): { col: string; dir?: 'ASC' | 'DESC' }[] {
  if (!sortKeys?.length) return [];
  const out: { col: string; dir?: 'ASC' | 'DESC' }[] = [];
  const seen = new Set<string>();
  for (const key of sortKeys) {
    const m = key
      .trim()
      .match(
        /^(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\s+(ASC|DESC))?/i
      );
    if (!m) continue;
    const col = m[1].toLowerCase();
    const dir = m[2]?.toUpperCase() as 'ASC' | 'DESC' | undefined;
    if (validCols.has(col) && !seen.has(col)) {
      seen.add(col);
      out.push({ col, dir });
    }
  }
  return out;
}

export async function getIndexAdvisorReport(
  ownerUid: string,
  databaseId?: string
): Promise<IndexAdvisorResponse> {
  const target = await resolveTargetConnection(ownerUid, databaseId);

  const [ctx, perfRes] = await Promise.all([
    withTargetQueryRunner(target.mode, target.connectionUrl, loadCatalogContext),
    SchemaInspector.fetchTopExpensiveQueries(
      target.mode,
      target.connectionUrl
    ).catch(() => ({
      extensionAvailable: false,
      queries: [],
      unavailableReason: undefined,
    })),
  ]);

  const hotspotByTable = new Map<string, SeqScanHotspotRow>();
  for (const h of ctx.hotspots) {
    hotspotByTable.set(`${h.schemaname}.${h.relname}`.toLowerCase(), h);
  }

  const recommendations: IndexAdvisorRecommendation[] = [];
  const seenRecKeys = new Set<string>();

  const pushRec = (rec: IndexAdvisorRecommendation) => {
    const dedupeKey = `${rec.schemaName}.${rec.tableName}:${rec.columns.join(',')}`.toLowerCase();
    if (seenRecKeys.has(dedupeKey)) return;
    seenRecKeys.add(dedupeKey);
    recommendations.push(rec);
  };

  // 1. Analyze high-latency SELECT queries from pg_stat_statements
  let analyzedQueries = 0;
  for (const q of perfRes.queries) {
    if (!/^(SELECT|WITH)\b/i.test(q.query.trim())) continue;
    analyzedQueries += 1;
    const extracted = extractSqlPredicates(q.query, ctx);

    for (const pred of extracted) {
      const tableKey = `${pred.tableSchema}.${pred.tableName}`.toLowerCase();
      const existing = ctx.existingIndexesByTable.get(tableKey) ?? [];
      const columns = buildEsrColumns(pred);
      if (columns.length === 0) continue;
      if (isCoveredByExistingIndexes(existing, columns)) continue;

      const hotspot = hotspotByTable.get(tableKey);
      const isComposite = columns.length >= 2;
      const indexName = sanitizeIndexName(pred.tableName, columns);
      const severity: SeverityLevel =
        q.mean_exec_time_ms >= 50 || (hotspot && hotspot.seq_scan_pct >= 75)
          ? 'CRITICAL'
          : q.mean_exec_time_ms >= 15 || isComposite
            ? 'WARNING'
            : 'INFO';

      pushRec({
        id: `qstat-${tableKey}-${columns.join('_')}`,
        kind: isComposite ? 'COMPOSITE' : 'SINGLE_COLUMN',
        severity,
        source: 'QUERY_PLAN',
        schemaName: pred.tableSchema,
        tableName: pred.tableName,
        columns,
        indexName,
        createIndexSql: formatCreateIndexSql(
          pred.tableSchema,
          pred.tableName,
          indexName,
          columns
        ),
        rationale: isComposite
          ? `High-latency query (${q.mean_exec_time_ms.toFixed(1)} ms avg across ${q.calls.toLocaleString()} calls) filters and sorts on (${columns.join(', ')}) without a matching composite B-Tree index. Ordering columns by Equality → Sort → Range enables an index-only or single-pass scan.`
          : `Query averaging ${q.mean_exec_time_ms.toFixed(1)} ms filters on ${columns[0]} without a leading index on ${pred.tableSchema}.${pred.tableName}.`,
        estimatedSpeedupLabel: isComposite
          ? '~4–15× faster · Eliminates Seq Scan & Sort'
          : '~3–8× faster · Replaces Seq Scan',
        evidence: {
          meanLatencyMs: q.mean_exec_time_ms,
          seqScans: hotspot?.seq_scan,
          seqTupRead: hotspot?.seq_tup_read,
          idxScans: hotspot?.idx_scan,
          seqScanPct: hotspot?.seq_scan_pct,
          tableSizePretty: hotspot?.table_size_pretty,
          sampleQuery: q.query,
        },
      });
    }
  }

  // 2. Analyze sequential scan hotspots from pg_stat_user_tables for missing filter/sort indexes
  for (const h of ctx.hotspots) {
    if (h.seq_scan < 5 || h.seq_scan_pct < 50) continue;
    const tableKey = `${h.schemaname}.${h.relname}`.toLowerCase();
    const validCols = ctx.columnsByTable.get(tableKey);
    const existing = ctx.existingIndexesByTable.get(tableKey) ?? [];
    if (!validCols) continue;

    // Look for common high-selectivity filter/FK + timestamp composite candidates not covered by existing indexes
    const filterCandidates = Array.from(validCols.keys()).filter(
      (col) =>
        col !== 'id' &&
        (col.endsWith('_id') ||
          col.endsWith('_uid') ||
          col === 'status' ||
          col === 'environment' ||
          col === 'action' ||
          col === 'fingerprint' ||
          col === 'email')
    );
    const timeCandidates = Array.from(validCols.keys()).filter(
      (col) =>
        col === 'created_at' ||
        col === 'inspected_at' ||
        col === 'sampled_at' ||
        col === 'updated_at'
    );

    let suggestedCols: string[] = [];
    for (const fc of filterCandidates) {
      for (const tc of timeCandidates) {
        const pair = [fc, `${tc} DESC`];
        if (!isCoveredByExistingIndexes(existing, pair)) {
          suggestedCols = pair;
          break;
        }
      }
      if (suggestedCols.length > 0) break;
    }

    if (suggestedCols.length === 0) {
      for (const fc of filterCandidates) {
        if (!isCoveredByExistingIndexes(existing, [fc])) {
          suggestedCols = [fc];
          break;
        }
      }
    }

    if (suggestedCols.length === 0) continue;

    const isComposite = suggestedCols.length >= 2;
    const indexName = sanitizeIndexName(h.relname, suggestedCols);
    const severity: SeverityLevel =
      h.seq_tup_read >= 50_000 || (h.seq_scan >= 100 && h.seq_scan_pct >= 80)
        ? 'CRITICAL'
        : h.seq_scan >= 20 && h.seq_scan_pct >= 65
          ? 'WARNING'
          : 'INFO';

    pushRec({
      id: `seq-${tableKey}-${suggestedCols.join('_')}`,
      kind: isComposite ? 'COMPOSITE' : 'SINGLE_COLUMN',
      severity,
      source: 'SEQ_SCAN_STATS',
      schemaName: h.schemaname,
      tableName: h.relname,
      columns: suggestedCols,
      indexName,
      createIndexSql: formatCreateIndexSql(
        h.schemaname,
        h.relname,
        indexName,
        suggestedCols
      ),
      rationale: isComposite
        ? `${h.schemaname}.${h.relname} relies on sequential scans for ${h.seq_scan_pct.toFixed(1)}% of reads (${h.seq_scan.toLocaleString()} seq scans reading ${h.seq_tup_read.toLocaleString()} tuples). Adding a composite index on (${suggestedCols.join(', ')}) covers filtered chronological lookups without scanning the full heap.`
        : `${h.schemaname}.${h.relname} performed ${h.seq_scan.toLocaleString()} sequential scans (${h.seq_scan_pct.toFixed(1)}% of all scans) while lookup column "${suggestedCols[0]}" has no leading index.`,
      estimatedSpeedupLabel: isComposite
        ? 'Eliminates heap scans on filtered time-ordered queries'
        : 'Converts repeated full-table scans into B-Tree lookups',
      evidence: {
        seqScans: h.seq_scan,
        seqTupRead: h.seq_tup_read,
        idxScans: h.idx_scan,
        seqScanPct: h.seq_scan_pct,
        tableSizePretty: h.table_size_pretty,
      },
    });
  }

  // Build ready-to-run sample SELECT queries from actual tables on this target for the EXPLAIN analyzer
  const sampleQueriesForExplain: { label: string; sql: string }[] = [];
  for (const h of ctx.hotspots.slice(0, 6)) {
    const tableKey = `${h.schemaname}.${h.relname}`.toLowerCase();
    const cols = ctx.columnsByTable.get(tableKey);
    if (!cols) continue;
    const colList = Array.from(cols.keys());
    const statusOrAction = colList.find((c) =>
      ['status', 'action', 'environment', 'incident_type', 'entity_type', 'email'].includes(c)
    );
    const timeCol = colList.find((c) =>
      ['created_at', 'inspected_at', 'sampled_at', 'updated_at'].includes(c)
    );
    if (statusOrAction && timeCol) {
      sampleQueriesForExplain.push({
        label: `Filter + Sort on ${h.relname}`,
        sql: `SELECT *\nFROM ${quoteIdent(h.schemaname)}.${quoteIdent(h.relname)}\nWHERE ${quoteIdent(statusOrAction)} = 'OPEN'\nORDER BY ${quoteIdent(timeCol)} DESC\nLIMIT 50;`,
      });
    } else if (timeCol) {
      sampleQueriesForExplain.push({
        label: `Recent rows on ${h.relname}`,
        sql: `SELECT *\nFROM ${quoteIdent(h.schemaname)}.${quoteIdent(h.relname)}\nWHERE ${quoteIdent(timeCol)} >= NOW() - INTERVAL '30 days'\nORDER BY ${quoteIdent(timeCol)} DESC\nLIMIT 50;`,
      });
    }
    if (sampleQueriesForExplain.length >= 3) break;
  }

  // Sort recommendations by severity then composite first
  const sevRank: Record<SeverityLevel, number> = {
    CRITICAL: 0,
    WARNING: 1,
    INFO: 2,
  };
  recommendations.sort((a, b) => {
    const diff = sevRank[a.severity] - sevRank[b.severity];
    if (diff !== 0) return diff;
    return a.kind === 'COMPOSITE' && b.kind !== 'COMPOSITE' ? -1 : 0;
  });

  return {
    targetLabel: target.targetLabel,
    databaseId: target.resolvedDbId,
    collectedAt: new Date().toISOString(),
    tablesAnalyzed: ctx.hotspots.length,
    highLatencyQueriesAnalyzed: analyzedQueries,
    seqScanHotspots: ctx.hotspots.slice(0, 12),
    recommendations: recommendations.slice(0, 12),
    sampleQueriesForExplain,
  };
}

export async function analyzeQueryPlanWithExplain(
  ownerUid: string,
  sql: string,
  databaseId?: string
): Promise<ExplainPlanAnalysisResponse> {
  const validatedSql = validateExplainOnlySelectSql(sql);
  const target = await resolveTargetConnection(ownerUid, databaseId);

  const { planRoot, ctx } = await withTargetQueryRunner(
    target.mode,
    target.connectionUrl,
    async (query) => {
      const catalogCtx = await loadCatalogContext(query);

      await query('BEGIN TRANSACTION READ ONLY');
      try {
        await query("SET LOCAL statement_timeout = '4000ms'");
        const explainRes = await query(
          `EXPLAIN (FORMAT JSON, COSTS true) ${validatedSql}`
        );
        await query('ROLLBACK');

        const rawPlanPayload = explainRes.rows[0]?.['QUERY PLAN'];
        const parsedArray =
          typeof rawPlanPayload === 'string'
            ? JSON.parse(rawPlanPayload)
            : rawPlanPayload;
        const firstEntry = Array.isArray(parsedArray) ? parsedArray[0] : null;
        const rawPlan: PgExplainRawNode | undefined = firstEntry?.Plan;

        if (!rawPlan) {
          throw new Error('PostgreSQL returned an empty query plan.');
        }

        return { planRoot: mapExplainNode(rawPlan), ctx: catalogCtx };
      } catch (err) {
        await query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }
  );

  // Walk the plan tree to count Seq Scans & Sort nodes and derive missing/composite index recommendations
  let seqScanCount = 0;
  let sortNodeCount = 0;
  const recommendations: IndexAdvisorRecommendation[] = [];
  const seenKeys = new Set<string>();

  const walkPlan = (node: QueryPlanNodeDto, ancestorSortKeys?: string[]) => {
    if (node.nodeType === 'Sort') {
      sortNodeCount += 1;
    }
    const activeSortKeys =
      node.nodeType === 'Sort' && node.sortKey?.length
        ? node.sortKey
        : ancestorSortKeys;

    if (node.nodeType === 'Seq Scan' && node.relationName) {
      seqScanCount += 1;
      const relLower = node.relationName.toLowerCase();
      const schema =
        node.schema?.toLowerCase() ??
        ctx.schemaByBareTable.get(relLower) ??
        'public';
      const tableKey = `${schema}.${relLower}`;
      const validCols = ctx.columnsByTable.get(tableKey);
      const existing = ctx.existingIndexesByTable.get(tableKey) ?? [];

      if (validCols) {
        const filterExtracted = node.filter
          ? extractColumnsFromPlanExpr(node.filter, validCols, node.alias)
          : { eqCols: [], rangeCols: [] };
        const sortExtracted = extractSortColsFromPlanKeys(
          activeSortKeys,
          validCols
        );

        const cols: string[] = [];
        const seen = new Set<string>();
        for (const c of filterExtracted.eqCols) {
          if (!seen.has(c)) {
            seen.add(c);
            cols.push(c);
          }
        }
        for (const s of sortExtracted) {
          if (!seen.has(s.col)) {
            seen.add(s.col);
            cols.push(s.dir === 'DESC' ? `${s.col} DESC` : s.col);
          }
        }
        for (const c of filterExtracted.rangeCols) {
          if (!seen.has(c)) {
            seen.add(c);
            cols.push(c);
          }
        }

        const finalCols = cols.slice(0, 4);
        const dedupeKey = `${tableKey}:${finalCols.join(',')}`;

        if (
          finalCols.length > 0 &&
          !seenKeys.has(dedupeKey) &&
          !isCoveredByExistingIndexes(existing, finalCols)
        ) {
          seenKeys.add(dedupeKey);
          const isComposite = finalCols.length >= 2;
          const indexName = sanitizeIndexName(relLower, finalCols);
          const severity: SeverityLevel =
            node.totalCost >= 500 || (isComposite && Boolean(activeSortKeys))
              ? 'CRITICAL'
              : node.totalCost >= 20 || Boolean(node.filter)
                ? 'WARNING'
                : 'INFO';

          recommendations.push({
            id: `explain-${tableKey}-${finalCols.join('_')}`,
            kind: isComposite ? 'COMPOSITE' : 'SINGLE_COLUMN',
            severity,
            source: 'EXPLAIN_ANALYZER',
            schemaName: schema,
            tableName: relLower,
            columns: finalCols,
            indexName,
            createIndexSql: formatCreateIndexSql(
              schema,
              relLower,
              indexName,
              finalCols
            ),
            rationale:
              isComposite && activeSortKeys?.length
                ? `PostgreSQL planned a Seq Scan (cost ${node.totalCost.toFixed(1)}) followed by an explicit Sort on (${activeSortKeys.join(', ')}). A composite B-Tree index on (${finalCols.join(', ')}) satisfies the filter and returns pre-sorted rows directly.`
                : isComposite
                  ? `PostgreSQL planned a Seq Scan with multi-column filter (${node.filter ?? 'predicate'}) at cost ${node.totalCost.toFixed(1)}. A composite index on (${finalCols.join(', ')}) eliminates full-table page reads.`
                  : `PostgreSQL planned a Seq Scan on ${schema}.${relLower} (cost ${node.totalCost.toFixed(1)}) filtering on ${node.filter ?? finalCols[0]}. Adding a B-Tree index enables an Index Scan.`,
            estimatedSpeedupLabel:
              isComposite && activeSortKeys?.length
                ? 'Eliminates Seq Scan + external/quicksort Sort'
                : 'Replaces Seq Scan with B-Tree Index Scan',
            evidence: {
              planCost: node.totalCost,
              filterPreview: node.filter,
              sortKeyPreview: activeSortKeys?.join(', '),
              sampleQuery: validatedSql,
            },
          });
        }
      }
    }

    for (const child of node.children) {
      walkPlan(child, activeSortKeys);
    }
  };

  walkPlan(planRoot);

  // Fallback SQL predicate extraction if planner folded filter into Hash Cond / Join Filter
  if (recommendations.length === 0 && seqScanCount > 0) {
    const preds = extractSqlPredicates(validatedSql, ctx);
    for (const pred of preds) {
      const tableKey = `${pred.tableSchema}.${pred.tableName}`.toLowerCase();
      const existing = ctx.existingIndexesByTable.get(tableKey) ?? [];
      const finalCols = buildEsrColumns(pred);
      if (finalCols.length === 0 || isCoveredByExistingIndexes(existing, finalCols)) {
        continue;
      }
      const isComposite = finalCols.length >= 2;
      const indexName = sanitizeIndexName(pred.tableName, finalCols);
      recommendations.push({
        id: `explain-sql-${tableKey}-${finalCols.join('_')}`,
        kind: isComposite ? 'COMPOSITE' : 'SINGLE_COLUMN',
        severity: planRoot.totalCost >= 100 ? 'CRITICAL' : 'WARNING',
        source: 'EXPLAIN_ANALYZER',
        schemaName: pred.tableSchema,
        tableName: pred.tableName,
        columns: finalCols,
        indexName,
        createIndexSql: formatCreateIndexSql(
          pred.tableSchema,
          pred.tableName,
          indexName,
          finalCols
        ),
        rationale: `Query plan executes ${seqScanCount} sequential scan(s) with total cost ${planRoot.totalCost.toFixed(1)}. Creating a ${isComposite ? 'composite' : 'single-column'} index on (${finalCols.join(', ')}) aligns with the query's filter and ordering predicates.`,
        estimatedSpeedupLabel: isComposite
          ? 'Composite B-Tree index for filter + ordering'
          : 'B-Tree lookup index for filter predicate',
        evidence: {
          planCost: planRoot.totalCost,
          sampleQuery: validatedSql,
        },
      });
    }
  }

  return {
    targetLabel: target.targetLabel,
    databaseId: target.resolvedDbId,
    analyzedSql: validatedSql,
    totalCost: planRoot.totalCost,
    estimatedRows: planRoot.planRows,
    seqScanCount,
    sortNodeCount,
    planRoot,
    recommendations,
  };
}
