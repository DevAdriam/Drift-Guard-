import { Client } from 'pg';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/index.ts';
import { monitoredDatabases } from '../db/schema.ts';
import { decryptSecret, validateSafePostgresUrl } from './crypto.ts';
import { formatBytesPretty } from './inspector.ts';
import { DEMO_USER } from './demoWorkspace.ts';
import type {
  BgWriterStats,
  DatabaseThroughputStats,
  EnvironmentType,
  LiveMonitorResponse,
  LiveSessionRow,
  PgSettingAuditRow,
  VacuumProgressRow,
  XidWraparoundTableRow,
} from '../types/telemetry.ts';

const SAFE_PG_SETTINGS_ALLOWLIST = [
  'shared_buffers',
  'work_mem',
  'maintenance_work_mem',
  'effective_cache_size',
  'max_connections',
  'checkpoint_completion_target',
  'max_wal_size',
  'wal_buffers',
  'autovacuum',
  'autovacuum_max_workers',
  'autovacuum_freeze_max_age',
  'log_min_duration_statement',
  'idle_in_transaction_session_timeout',
  'lock_timeout',
  'statement_timeout',
  'ssl',
  'synchronous_commit',
  'random_page_cost',
] as const;

function sanitizeSqlPreview(sqlText: string): string {
  // Mask string literals following password/secret/token keywords to prevent accidental credential exposure
  return sqlText
    .replace(/\s+/g, ' ')
    .replace(
      /(password|passwd|secret|token|api_key)\s*(=|:|\s)\s*'[^']*'/gi,
      "$1$2'***'"
    )
    .trim()
    .slice(0, 600);
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function parsePgIntArray(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => Number(item))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      return inner
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
  }
  return [];
}

function formatPgSettingDisplay(setting: string, unit: string | null): string {
  if (!unit) return setting;
  const num = Number(setting);
  if (!Number.isFinite(num)) return `${setting} ${unit}`;
  if (unit === '8kB') {
    const bytes = num * 8192;
    return formatBytesPretty(bytes);
  }
  if (unit === 'kB') {
    return formatBytesPretty(num * 1024);
  }
  if (unit === 'MB') {
    return num >= 1024 ? `${(num / 1024).toFixed(1)} GB` : `${num} MB`;
  }
  if (unit === 'ms') {
    if (num <= 0) return `${num} ms (disabled)`;
    if (num >= 60_000) return `${(num / 60_000).toFixed(1)} min`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)} s`;
    return `${num} ms`;
  }
  return `${setting} ${unit}`;
}

function evaluateSettingAudit(row: {
  name: string;
  setting: string;
  unit: string | null;
  category: string;
  context: string;
  source: string;
}): PgSettingAuditRow {
  const displayValue = formatPgSettingDisplay(row.setting, row.unit);
  let status: PgSettingAuditRow['status'] = 'OPTIMAL';
  let recommendation: string | null = null;
  let tuningSql: string | null = null;

  const num = Number(row.setting);

  switch (row.name) {
    case 'idle_in_transaction_session_timeout':
      if (num === 0) {
        status = 'WARNING';
        recommendation =
          'Disabled (0ms). Abandoned open transactions can block autovacuum and hold locks indefinitely. Recommend 60s–300s.';
        tuningSql =
          "ALTER SYSTEM SET idle_in_transaction_session_timeout = '120s';\nSELECT pg_reload_conf();";
      }
      break;
    case 'log_min_duration_statement':
      if (num < 0) {
        status = 'ADVISORY';
        recommendation =
          'Slow query logging is disabled (-1). Set to 500ms–1000ms to capture latency spikes in server logs.';
        tuningSql =
          "ALTER SYSTEM SET log_min_duration_statement = '500ms';\nSELECT pg_reload_conf();";
      }
      break;
    case 'lock_timeout':
      if (num === 0) {
        status = 'ADVISORY';
        recommendation =
          'No global lock timeout configured. Migrations without explicit SET lock_timeout can queue production reads indefinitely.';
        tuningSql =
          "ALTER SYSTEM SET lock_timeout = '5s';\nSELECT pg_reload_conf();";
      }
      break;
    case 'checkpoint_completion_target':
      if (Number.isFinite(num) && num < 0.7) {
        status = 'WARNING';
        recommendation =
          'Below 0.7 causes sharp checkpoint I/O spikes. PostgreSQL best practice is 0.9 to spread disk writes smoothly.';
        tuningSql =
          "ALTER SYSTEM SET checkpoint_completion_target = '0.9';\nSELECT pg_reload_conf();";
      }
      break;
    case 'autovacuum':
      if (row.setting !== 'on') {
        status = 'WARNING';
        recommendation =
          'Autovacuum is OFF. Risk of severe table bloat and Transaction ID wraparound outage.';
        tuningSql =
          "ALTER SYSTEM SET autovacuum = 'on';\nSELECT pg_reload_conf();";
      }
      break;
    case 'ssl':
      if (row.setting !== 'on') {
        status = 'WARNING';
        recommendation =
          'TLS/SSL transport encryption is disabled. Enable ssl = on to protect credentials and query traffic in transit.';
        tuningSql = "ALTER SYSTEM SET ssl = 'on'; -- requires PostgreSQL restart";
      }
      break;
    case 'random_page_cost':
      if (Number.isFinite(num) && num >= 4) {
        status = 'ADVISORY';
        recommendation =
          'Default 4.0 assumes spinning HDDs. On NVMe/SSD cloud storage, lowering to 1.1–1.5 encourages optimal index scans.';
        tuningSql =
          "ALTER SYSTEM SET random_page_cost = '1.1';\nSELECT pg_reload_conf();";
      }
      break;
    case 'max_connections':
      if (Number.isFinite(num) && num > 300) {
        status = 'ADVISORY';
        recommendation =
          'High max_connections (>300) increases context switching & memory overhead. Prefer PgBouncer connection pooling.';
      }
      break;
    case 'work_mem':
      if (Number.isFinite(num) && num <= 4096 && row.unit === 'kB') {
        status = 'ADVISORY';
        recommendation =
          'Default 4 MB work_mem can cause frequent disk spills on complex sorts/hash joins. Consider 16 MB–32 MB if RAM allows.';
        tuningSql =
          "ALTER SYSTEM SET work_mem = '16MB';\nSELECT pg_reload_conf();";
      }
      break;
    default:
      break;
  }

  return {
    name: row.name,
    setting: row.setting,
    unit: row.unit,
    displayValue,
    category: row.category,
    context: row.context,
    source: row.source,
    status,
    recommendation,
    tuningSql,
  };
}

function buildDemoLiveMonitor(params: {
  targetLabel: string;
  databaseId: string | null;
  environment: EnvironmentType | 'workspace';
}): LiveMonitorResponse {
  // Subtle time-varying jitter so 5s live auto-refresh shows authentic real-time telemetry movement
  const tick = Math.floor(Date.now() / 5000);
  const wave = (tick % 7) - 3; // -3 .. +3
  const isBilling = params.targetLabel.toLowerCase().includes('billing');
  const isAnalytics = params.targetLabel.toLowerCase().includes('analytics');
  const isStaging = params.environment === 'staging';

  const maxConn = isStaging ? 100 : 250;
  const activeConn = Math.max(
    4,
    (isBilling ? 44 : isAnalytics ? 28 : isStaging ? 9 : 31) + wave
  );
  const idleInTx = isBilling ? 4 + (tick % 2) : isAnalytics ? 2 : 0;
  const waitingConn = isBilling ? 3 : 0;
  const idleConn = Math.max(
    10,
    (isBilling ? 112 : isAnalytics ? 74 : isStaging ? 22 : 84) - wave
  );
  const totalConn = activeConn + idleConn + idleInTx;
  const usagePct = Math.min(99, Math.round((totalConn / maxConn) * 1000) / 10);

  const baseTps = isBilling ? 1480 : isAnalytics ? 620 : isStaging ? 145 : 980;
  const estimatedTps = Math.max(25, baseTps + wave * 34);
  const xactCommit = (isBilling ? 48_920_400 : 21_440_120) + (tick % 1000) * 85;
  const xactRollback = isBilling ? 142_810 : 18_420;
  const rollbackRatioPct =
    Math.round((xactRollback / Math.max(1, xactCommit + xactRollback)) * 10000) /
    100;

  const cacheHit = isBilling
    ? 97.4 + (wave % 2) * 0.1
    : isAnalytics
      ? 92.8
      : 99.3;
  const blksHit = 940_220_000 + (tick % 500) * 14_200;
  const blksRead = Math.round(blksHit * ((100 - cacheHit) / cacheHit));

  const throughput: DatabaseThroughputStats = {
    pgVersion: 'PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1)',
    uptimeSeconds: 1_942_800 + (tick % 100) * 5,
    databaseName: params.targetLabel.replace(/[^a-z0-9_]/gi, '_'),
    databaseSizePretty: isBilling
      ? '42.8 GB'
      : isAnalytics
        ? '118.4 GB'
        : isStaging
          ? '6.2 GB'
          : '28.5 GB',
    maxConnections: maxConn,
    activeConnections: activeConn,
    idleConnections: idleConn,
    idleInTransaction: idleInTx,
    waitingConnections: waitingConn,
    totalConnections: totalConn,
    connectionUsagePct: usagePct,
    xactCommit,
    xactRollback,
    rollbackRatioPct,
    estimatedTps,
    blksHit,
    blksRead,
    cacheHitRatioPct: Math.round(cacheHit * 100) / 100,
    tupReturned: 1_840_210_000 + (tick % 100) * 42_000,
    tupFetched: 412_980_500 + (tick % 100) * 9_400,
    tupInserted: 19_420_880 + (tick % 100) * 320,
    tupUpdated: 11_850_400 + (tick % 100) * 210,
    tupDeleted: 2_940_120 + (tick % 100) * 45,
    deadlocks: isBilling ? 4 : 0,
    tempFiles: isAnalytics ? 1842 : isBilling ? 312 : 18,
    tempBytes: isAnalytics ? 9_840_000_000 : isBilling ? 1_420_000_000 : 48_000_000,
    tempBytesPretty: isAnalytics ? '9.16 GB' : isBilling ? '1.32 GB' : '45.8 MB',
    blkReadTimeMs: isAnalytics ? 482_120.4 : 64_810.2,
    blkWriteTimeMs: isBilling ? 91_205.8 : 24_110.5,
  };

  const checkpointsTimed = 2_184;
  const checkpointsReq = isBilling ? 684 : 112;
  const requestedCheckpointPct =
    Math.round(
      (checkpointsReq / Math.max(1, checkpointsTimed + checkpointsReq)) * 1000
    ) / 10;

  const bgwriter: BgWriterStats = {
    checkpointsTimed,
    checkpointsReq,
    requestedCheckpointPct,
    checkpointWriteTimeMs: 14_820_400,
    checkpointSyncTimeMs: 412_900,
    buffersCheckpoint: 8_942_110,
    buffersClean: 1_842_300,
    buffersBackend: isBilling ? 942_100 : 124_500,
    buffersAlloc: 24_810_900,
    maxwrittenClean: isBilling ? 842 : 41,
    statsResetIso: new Date(Date.now() - 22 * 86_400_000).toISOString(),
  };

  const nowMs = Date.now();
  const rootTxDuration = 186 + (tick % 10);
  const child1Duration = 44 + (tick % 6);
  const child2Duration = 34 + (tick % 5);
  const leaf1Duration = 26 + (tick % 4);
  const leaf2Duration = 17 + (tick % 4);
  const ddlRootDuration = 68 + (tick % 8);
  const ddlWaiterDuration = 51 + (tick % 6);

  const sessions: LiveSessionRow[] = [
    // Root Blocker #1: abandoned idle-in-transaction holding row lock on accounts
    {
      pid: 28109,
      usename: 'migration_runner',
      applicationName: 'prisma-migrate',
      clientAddr: '10.24.11.19',
      state: 'idle in transaction',
      waitEventType: 'Client',
      waitEvent: 'ClientRead',
      durationSeconds: rootTxDuration,
      xactDurationSeconds: rootTxDuration + 4,
      xactStartIso: new Date(nowMs - (rootTxDuration + 4) * 1000).toISOString(),
      queryStartIso: new Date(nowMs - rootTxDuration * 1000).toISOString(),
      query:
        'SELECT id, stripe_customer_id, tax_rate_bps FROM public.accounts WHERE id = $1 FOR UPDATE;',
      isBlocked: false,
      blockingPids: [],
    },
    // Level 1 Waiter (also transitive blocker for leaf invoice updates)
    {
      pid: 28412,
      usename: 'billing_worker',
      applicationName: 'invoice-settlement-svc',
      clientAddr: '10.24.14.88',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'transactionid',
      durationSeconds: child1Duration,
      xactDurationSeconds: child1Duration + 3,
      xactStartIso: new Date(nowMs - (child1Duration + 3) * 1000).toISOString(),
      queryStartIso: new Date(nowMs - child1Duration * 1000).toISOString(),
      query:
        "UPDATE public.invoices SET status = 'settled', settled_at = NOW() WHERE account_id = $1 AND billing_cycle = $2 RETURNING id, total_cents;",
      isBlocked: true,
      blockingPids: [28109],
    },
    // Level 2 Transitive Waiter #1 blocked by PID 28412
    {
      pid: 28540,
      usename: 'checkout_svc',
      applicationName: 'stripe-webhook-worker',
      clientAddr: '10.24.18.64',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'tuple',
      durationSeconds: leaf1Duration,
      xactDurationSeconds: leaf1Duration + 1,
      xactStartIso: new Date(nowMs - (leaf1Duration + 1) * 1000).toISOString(),
      queryStartIso: new Date(nowMs - leaf1Duration * 1000).toISOString(),
      query:
        'UPDATE public.invoices SET payment_intent_id = $1, paid_at = NOW() WHERE id = $2;',
      isBlocked: true,
      blockingPids: [28412],
    },
    // Level 2 Transitive Waiter #2 blocked by PID 28412
    {
      pid: 28619,
      usename: 'dunning_job',
      applicationName: 'retry-scheduler',
      clientAddr: '10.24.19.22',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'tuple',
      durationSeconds: leaf2Duration,
      xactDurationSeconds: leaf2Duration + 1,
      xactStartIso: new Date(nowMs - (leaf2Duration + 1) * 1000).toISOString(),
      queryStartIso: new Date(nowMs - leaf2Duration * 1000).toISOString(),
      query:
        'SELECT id, status, total_cents FROM public.invoices WHERE account_id = $1 FOR NO KEY UPDATE;',
      isBlocked: true,
      blockingPids: [28412],
    },
    // Level 1 Waiter #2 directly blocked by Root Blocker 28109
    {
      pid: 28705,
      usename: 'api_gateway',
      applicationName: 'checkout-api-v4',
      clientAddr: '10.24.18.51',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'transactionid',
      durationSeconds: child2Duration,
      xactDurationSeconds: child2Duration + 2,
      xactStartIso: new Date(nowMs - (child2Duration + 2) * 1000).toISOString(),
      queryStartIso: new Date(nowMs - child2Duration * 1000).toISOString(),
      query:
        'UPDATE public.accounts SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE id = $2;',
      isBlocked: true,
      blockingPids: [28109],
    },
    // Root Blocker #2 (on billing/production): long DDL holding AccessExclusiveLock
    ...(isBilling || !isStaging
      ? [
          {
            pid: 28881,
            usename: 'schema_ops',
            applicationName: 'pg-online-ddl',
            clientAddr: '10.24.10.12',
            state: 'active' as const,
            waitEventType: 'IO',
            waitEvent: 'DataFileWrite',
            durationSeconds: ddlRootDuration,
            xactDurationSeconds: ddlRootDuration + 2,
            xactStartIso: new Date(
              nowMs - (ddlRootDuration + 2) * 1000
            ).toISOString(),
            queryStartIso: new Date(
              nowMs - ddlRootDuration * 1000
            ).toISOString(),
            query:
              'ALTER TABLE public.ledger_entries ADD COLUMN settlement_batch_id uuid;',
            isBlocked: false,
            blockingPids: [],
          },
          {
            pid: 28910,
            usename: 'reconciler_job',
            applicationName: 'nightly-ledger-sync',
            clientAddr: '10.24.16.72',
            state: 'active' as const,
            waitEventType: 'Lock',
            waitEvent: 'relation',
            durationSeconds: ddlWaiterDuration,
            xactDurationSeconds: ddlWaiterDuration + 1,
            xactStartIso: new Date(
              nowMs - (ddlWaiterDuration + 1) * 1000
            ).toISOString(),
            queryStartIso: new Date(
              nowMs - ddlWaiterDuration * 1000
            ).toISOString(),
            query:
              "INSERT INTO public.ledger_entries (account_id, amount_cents, currency) VALUES ($1, $2, 'USD');",
            isBlocked: true,
            blockingPids: [28881],
          },
        ]
      : []),
    // Standalone long-running unblocked analytical query
    {
      pid: 29004,
      usename: 'analytics_ro',
      applicationName: 'metabase-bi-pool',
      clientAddr: '10.24.22.104',
      state: 'active',
      waitEventType: 'IO',
      waitEvent: 'DataFileRead',
      durationSeconds: 14.8 + (tick % 4),
      xactDurationSeconds: 15.0 + (tick % 4),
      xactStartIso: new Date(nowMs - 15_000).toISOString(),
      queryStartIso: new Date(nowMs - 14_800).toISOString(),
      query:
        "SELECT date_trunc('day', created_at) AS day, count(*), sum(amount_cents) FROM public.ledger_entries WHERE created_at >= NOW() - INTERVAL '90 days' GROUP BY 1 ORDER BY 1 DESC;",
      isBlocked: false,
      blockingPids: [],
    },
    // Fast active OLTP read
    {
      pid: 29182,
      usename: 'api_gateway',
      applicationName: 'checkout-api-v4',
      clientAddr: '10.24.18.51',
      state: 'active',
      waitEventType: null,
      waitEvent: null,
      durationSeconds: 0.12,
      xactDurationSeconds: 0.2,
      xactStartIso: new Date(nowMs - 200).toISOString(),
      queryStartIso: new Date(nowMs - 120).toISOString(),
      query:
        'SELECT id, status, plan_tier, balance_cents FROM public.accounts WHERE organization_id = $1 LIMIT 25;',
      isBlocked: false,
      blockingPids: [],
    },
    // Idle pooled connection
    {
      pid: 27944,
      usename: 'reconciler_job',
      applicationName: 'nightly-ledger-sync',
      clientAddr: '10.24.16.72',
      state: 'idle',
      waitEventType: 'Client',
      waitEvent: 'ClientRead',
      durationSeconds: 312,
      xactDurationSeconds: null,
      xactStartIso: null,
      queryStartIso: new Date(nowMs - 312_000).toISOString(),
      query: 'COMMIT;',
      isBlocked: false,
      blockingPids: [],
    },
  ];

  // Keep waitingConnections KPI aligned with actual blocked sessions in the demo snapshot
  throughput.waitingConnections = sessions.filter((s) => s.isBlocked).length;

  const autovacuumFreezeMaxAge = 200_000_000;
  const maxXid = 2_147_483_647;
  const wraparoundTables: XidWraparoundTableRow[] = [
    {
      schemaName: 'public',
      tableName: 'ledger_entries',
      xidAge: isBilling ? 176_400_000 : 124_200_000,
      pctTowardFreeze: isBilling ? 88.2 : 62.1,
      pctTowardWraparound: isBilling ? 8.21 : 5.78,
      nDeadTup: 412_900,
      lastAutovacuumIso: new Date(nowMs - 18 * 3_600_000).toISOString(),
      status: isBilling ? 'WARNING' : 'HEALTHY',
      remediationSql:
        'VACUUM (FREEZE, VERBOSE, ANALYZE) "public"."ledger_entries";',
    },
    {
      schemaName: 'public',
      tableName: 'invoices',
      xidAge: 142_850_000,
      pctTowardFreeze: 71.4,
      pctTowardWraparound: 6.65,
      nDeadTup: 184_200,
      lastAutovacuumIso: new Date(nowMs - 6 * 3_600_000).toISOString(),
      status: 'HEALTHY',
      remediationSql: 'VACUUM (FREEZE, VERBOSE, ANALYZE) "public"."invoices";',
    },
    {
      schemaName: 'public',
      tableName: 'webhook_deliveries',
      xidAge: 194_100_000,
      pctTowardFreeze: 97.1,
      pctTowardWraparound: 9.04,
      nDeadTup: 628_400,
      lastAutovacuumIso: new Date(nowMs - 52 * 3_600_000).toISOString(),
      status: 'CRITICAL',
      remediationSql:
        'VACUUM (FREEZE, VERBOSE, ANALYZE) "public"."webhook_deliveries";',
    },
    {
      schemaName: 'public',
      tableName: 'accounts',
      xidAge: 68_420_000,
      pctTowardFreeze: 34.2,
      pctTowardWraparound: 3.19,
      nDeadTup: 14_200,
      lastAutovacuumIso: new Date(nowMs - 2 * 3_600_000).toISOString(),
      status: 'HEALTHY',
      remediationSql: 'VACUUM (FREEZE, VERBOSE, ANALYZE) "public"."accounts";',
    },
  ];

  const activeVacuums: VacuumProgressRow[] = [
    {
      pid: 29410,
      schemaName: 'public',
      tableName: 'webhook_deliveries',
      phase: 'scanning heap',
      heapBlksTotal: 148_200,
      heapBlksScanned: Math.min(148_200, 94_200 + (tick % 20) * 1800),
      heapBlksVacuumed: 42_100,
      progressPct: Math.min(98, 63.6 + (tick % 20) * 1.2),
      indexVacuumCount: 1,
    },
  ];

  const rawSettings = [
    {
      name: 'shared_buffers',
      setting: '524288',
      unit: '8kB',
      category: 'Resource Usage / Memory',
      context: 'postmaster',
      source: 'configuration file',
    },
    {
      name: 'effective_cache_size',
      setting: '1572864',
      unit: '8kB',
      category: 'Query Tuning / Planner Cost Constants',
      context: 'user',
      source: 'configuration file',
    },
    {
      name: 'work_mem',
      setting: '4096',
      unit: 'kB',
      category: 'Resource Usage / Memory',
      context: 'user',
      source: 'default',
    },
    {
      name: 'maintenance_work_mem',
      setting: '524288',
      unit: 'kB',
      category: 'Resource Usage / Memory',
      context: 'user',
      source: 'configuration file',
    },
    {
      name: 'max_connections',
      setting: String(maxConn),
      unit: null,
      category: 'Connections and Authentication',
      context: 'postmaster',
      source: 'configuration file',
    },
    {
      name: 'checkpoint_completion_target',
      setting: isBilling ? '0.5' : '0.9',
      unit: null,
      category: 'Write-Ahead Log / Checkpoints',
      context: 'sighup',
      source: 'configuration file',
    },
    {
      name: 'max_wal_size',
      setting: '4096',
      unit: 'MB',
      category: 'Write-Ahead Log / Checkpoints',
      context: 'sighup',
      source: 'configuration file',
    },
    {
      name: 'autovacuum',
      setting: 'on',
      unit: null,
      category: 'Autovacuum',
      context: 'sighup',
      source: 'default',
    },
    {
      name: 'autovacuum_max_workers',
      setting: '4',
      unit: null,
      category: 'Autovacuum',
      context: 'postmaster',
      source: 'configuration file',
    },
    {
      name: 'idle_in_transaction_session_timeout',
      setting: isBilling ? '0' : '120000',
      unit: 'ms',
      category: 'Client Connection Defaults',
      context: 'user',
      source: isBilling ? 'default' : 'configuration file',
    },
    {
      name: 'lock_timeout',
      setting: '0',
      unit: 'ms',
      category: 'Client Connection Defaults',
      context: 'user',
      source: 'default',
    },
    {
      name: 'log_min_duration_statement',
      setting: '500',
      unit: 'ms',
      category: 'Reporting and Logging',
      context: 'superuser',
      source: 'configuration file',
    },
    {
      name: 'random_page_cost',
      setting: '4',
      unit: null,
      category: 'Query Tuning / Planner Cost Constants',
      context: 'user',
      source: 'default',
    },
    {
      name: 'ssl',
      setting: 'on',
      unit: null,
      category: 'Connections and Authentication / SSL',
      context: 'sighup',
      source: 'configuration file',
    },
  ];

  const databaseXidAge = 194_100_000;
  return {
    targetLabel: params.targetLabel,
    databaseId: params.databaseId,
    environment: params.environment,
    collectedAt: new Date().toISOString(),
    source: 'demo_live',
    throughput,
    bgwriter,
    sessions,
    databaseXidAge,
    databaseXidWraparoundPct:
      Math.round((databaseXidAge / maxXid) * 10000) / 100,
    autovacuumFreezeMaxAge,
    wraparoundTables,
    activeVacuums,
    settingsAudit: rawSettings.map(evaluateSettingAudit),
  };
}

async function runWithReadOnlyClient<T>(
  mode: string,
  encryptedUrl: string | null,
  fn: (
    queryFn: (
      sql: string,
      values?: unknown[]
    ) => Promise<{ rows: Record<string, unknown>[] }>
  ) => Promise<T>
): Promise<T> {
  if (mode === 'workspace_pg' || !encryptedUrl) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '4000ms'");
      const res = await fn((sql, values) => client.query(sql, values));
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  const rawUrl = decryptSecret(encryptedUrl);
  await validateSafePostgresUrl(rawUrl);
  const client = new Client({
    connectionString: rawUrl,
    statement_timeout: 4500,
    connectionTimeoutMillis: 4500,
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const res = await fn((sql, values) => client.query(sql, values));
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function getLiveMonitorSnapshot(
  ownerUid: string,
  databaseId?: string
): Promise<LiveMonitorResponse> {
  let targetLabel = 'Workspace PostgreSQL (Live)';
  let mode = 'workspace_pg';
  let encryptedUrl: string | null = null;
  let environment: EnvironmentType | 'workspace' = 'workspace';
  let resolvedDatabaseId: string | null = null;

  if (databaseId) {
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
    targetLabel = target.name;
    mode = target.connectionMode;
    encryptedUrl = target.connectionUrlEncrypted;
    environment = target.environment as EnvironmentType;
    resolvedDatabaseId = target.id;
  }

  // Provide realistic live-ticking production metrics for the isolated Demo Workspace
  if (ownerUid === DEMO_USER.uid) {
    return buildDemoLiveMonitor({
      targetLabel,
      databaseId: resolvedDatabaseId,
      environment,
    });
  }

  return runWithReadOnlyClient(mode, encryptedUrl, async (query) => {
    // 1. Core Database & Throughput stats (pg_stat_database + connections)
    const [dbStatRes, connRes, verRes] = await Promise.all([
      query(`
        SELECT
          d.datname,
          pg_database_size(d.datname)::bigint AS db_bytes,
          COALESCE(s.xact_commit, 0)::bigint AS xact_commit,
          COALESCE(s.xact_rollback, 0)::bigint AS xact_rollback,
          COALESCE(s.blks_hit, 0)::bigint AS blks_hit,
          COALESCE(s.blks_read, 0)::bigint AS blks_read,
          COALESCE(s.tup_returned, 0)::bigint AS tup_returned,
          COALESCE(s.tup_fetched, 0)::bigint AS tup_fetched,
          COALESCE(s.tup_inserted, 0)::bigint AS tup_inserted,
          COALESCE(s.tup_updated, 0)::bigint AS tup_updated,
          COALESCE(s.tup_deleted, 0)::bigint AS tup_deleted,
          COALESCE(s.deadlocks, 0)::bigint AS deadlocks,
          COALESCE(s.temp_files, 0)::bigint AS temp_files,
          COALESCE(s.temp_bytes, 0)::bigint AS temp_bytes,
          COALESCE(s.blk_read_time, 0)::double precision AS blk_read_time,
          COALESCE(s.blk_write_time, 0)::double precision AS blk_write_time,
          age(d.datfrozenxid)::bigint AS dat_xid_age,
          EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint AS uptime_sec
        FROM pg_database d
        LEFT JOIN pg_stat_database s ON s.datid = d.oid
        WHERE d.datname = current_database()
        LIMIT 1;
      `),
      query(`
        SELECT
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn,
          COUNT(*) FILTER (WHERE state = 'active')::int AS active_conn,
          COUNT(*) FILTER (WHERE state = 'idle')::int AS idle_conn,
          COUNT(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_tx,
          COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting_conn,
          COUNT(*)::int AS total_conn
        FROM pg_stat_activity
        WHERE datname = current_database();
      `),
      query(`
        SELECT
          version() AS pg_ver,
          COALESCE((SELECT setting::bigint FROM pg_settings WHERE name = 'autovacuum_freeze_max_age'), 200000000) AS freeze_max_age;
      `),
    ]);

    const d = dbStatRes.rows[0] ?? {};
    const c = connRes.rows[0] ?? {};
    const v = verRes.rows[0] ?? {};

    const xactCommit = Number(d.xact_commit ?? 0);
    const xactRollback = Number(d.xact_rollback ?? 0);
    const uptimeSeconds = Math.max(1, Number(d.uptime_sec ?? 1));
    const blksHit = Number(d.blks_hit ?? 0);
    const blksRead = Number(d.blks_read ?? 0);
    const cacheHitRatioPct =
      blksHit + blksRead > 0
        ? Math.round((blksHit / (blksHit + blksRead)) * 10000) / 100
        : 100;
    const maxConnections = Math.max(1, Number(c.max_conn ?? 100));
    const totalConnections = Number(c.total_conn ?? 0);

    const throughput: DatabaseThroughputStats = {
      pgVersion: String(v.pg_ver ?? 'PostgreSQL').split(',')[0],
      uptimeSeconds,
      databaseName: String(d.datname ?? 'postgres'),
      databaseSizePretty: formatBytesPretty(Number(d.db_bytes ?? 0)),
      maxConnections,
      activeConnections: Number(c.active_conn ?? 0),
      idleConnections: Number(c.idle_conn ?? 0),
      idleInTransaction: Number(c.idle_in_tx ?? 0),
      waitingConnections: Number(c.waiting_conn ?? 0),
      totalConnections,
      connectionUsagePct:
        Math.round((totalConnections / maxConnections) * 1000) / 10,
      xactCommit,
      xactRollback,
      rollbackRatioPct:
        xactCommit + xactRollback > 0
          ? Math.round((xactRollback / (xactCommit + xactRollback)) * 10000) /
            100
          : 0,
      estimatedTps:
        Math.round(((xactCommit + xactRollback) / uptimeSeconds) * 100) / 100,
      blksHit,
      blksRead,
      cacheHitRatioPct,
      tupReturned: Number(d.tup_returned ?? 0),
      tupFetched: Number(d.tup_fetched ?? 0),
      tupInserted: Number(d.tup_inserted ?? 0),
      tupUpdated: Number(d.tup_updated ?? 0),
      tupDeleted: Number(d.tup_deleted ?? 0),
      deadlocks: Number(d.deadlocks ?? 0),
      tempFiles: Number(d.temp_files ?? 0),
      tempBytes: Number(d.temp_bytes ?? 0),
      tempBytesPretty: formatBytesPretty(Number(d.temp_bytes ?? 0)),
      blkReadTimeMs: Math.round(Number(d.blk_read_time ?? 0) * 100) / 100,
      blkWriteTimeMs: Math.round(Number(d.blk_write_time ?? 0) * 100) / 100,
    };

    // 2. Active & recent sessions (pg_stat_activity) with exact pg_blocking_pids lineage
    const sessionsRes = await query(`
      SELECT
        pid,
        COALESCE(usename, 'system') AS usename,
        COALESCE(NULLIF(application_name, ''), 'client') AS application_name,
        COALESCE(client_addr::text, 'local') AS client_addr,
        COALESCE(state, 'other') AS state,
        wait_event_type,
        wait_event,
        COALESCE(EXTRACT(EPOCH FROM (now() - COALESCE(query_start, xact_start, backend_start))), 0)::double precision AS duration_sec,
        CASE
          WHEN xact_start IS NOT NULL
          THEN COALESCE(EXTRACT(EPOCH FROM (now() - xact_start)), 0)::double precision
          ELSE NULL
        END AS xact_duration_sec,
        xact_start,
        query_start,
        COALESCE(query, '') AS query,
        COALESCE(pg_blocking_pids(pid), ARRAY[]::int[]) AS blocking_pids,
        (cardinality(pg_blocking_pids(pid)) > 0) AS is_blocked
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
      ORDER BY
        CASE
          WHEN cardinality(pg_blocking_pids(pid)) > 0 THEN 0
          WHEN state LIKE 'idle in transaction%' THEN 1
          WHEN state = 'active' THEN 2
          ELSE 3
        END,
        COALESCE(EXTRACT(EPOCH FROM (now() - COALESCE(xact_start, query_start, backend_start))), 0) DESC
      LIMIT 100;
    `);

    const allowedStates = new Set([
      'active',
      'idle',
      'idle in transaction',
      'idle in transaction (aborted)',
      'fastpath function call',
      'disabled',
    ]);

    const sessions: LiveSessionRow[] = sessionsRes.rows.map((r) => {
      const rawState = String(r.state ?? 'other');
      const blockingPids = parsePgIntArray(r.blocking_pids);
      const rawXactDuration =
        r.xact_duration_sec !== null && r.xact_duration_sec !== undefined
          ? Math.max(0, Math.round(Number(r.xact_duration_sec) * 100) / 100)
          : null;
      return {
        pid: Number(r.pid),
        usename: String(r.usename ?? 'unknown'),
        applicationName: String(r.application_name ?? 'client'),
        clientAddr: String(r.client_addr ?? 'local'),
        state: (allowedStates.has(rawState)
          ? rawState
          : 'other') as LiveSessionRow['state'],
        waitEventType: r.wait_event_type ? String(r.wait_event_type) : null,
        waitEvent: r.wait_event ? String(r.wait_event) : null,
        durationSeconds: Math.max(
          0,
          Math.round(Number(r.duration_sec ?? 0) * 100) / 100
        ),
        xactDurationSeconds: rawXactDuration,
        xactStartIso: r.xact_start
          ? new Date(String(r.xact_start)).toISOString()
          : null,
        queryStartIso: r.query_start
          ? new Date(String(r.query_start)).toISOString()
          : null,
        query: sanitizeSqlPreview(String(r.query ?? '')),
        isBlocked: Boolean(r.is_blocked) || blockingPids.length > 0,
        blockingPids,
      };
    });

    // 3. Background Writer & Checkpoints (PG 17+ moved checkpoints to pg_stat_checkpointer; handle both gracefully!)
    let bgwriter: BgWriterStats = {
      checkpointsTimed: 0,
      checkpointsReq: 0,
      requestedCheckpointPct: 0,
      checkpointWriteTimeMs: 0,
      checkpointSyncTimeMs: 0,
      buffersCheckpoint: 0,
      buffersClean: 0,
      buffersBackend: 0,
      buffersAlloc: 0,
      maxwrittenClean: 0,
      statsResetIso: null,
    };

    try {
      // Try PG <= 16 unified pg_stat_bgwriter first
      const bgRes = await query(`
        SELECT
          checkpoints_timed::bigint,
          checkpoints_req::bigint,
          checkpoint_write_time::double precision,
          checkpoint_sync_time::double precision,
          buffers_checkpoint::bigint,
          buffers_clean::bigint,
          buffers_backend::bigint,
          buffers_alloc::bigint,
          maxwritten_clean::bigint,
          stats_reset
        FROM pg_stat_bgwriter
        LIMIT 1;
      `);
      const b = bgRes.rows[0];
      if (b) {
        const timed = Number(b.checkpoints_timed ?? 0);
        const req = Number(b.checkpoints_req ?? 0);
        bgwriter = {
          checkpointsTimed: timed,
          checkpointsReq: req,
          requestedCheckpointPct:
            timed + req > 0 ? Math.round((req / (timed + req)) * 1000) / 10 : 0,
          checkpointWriteTimeMs: Number(b.checkpoint_write_time ?? 0),
          checkpointSyncTimeMs: Number(b.checkpoint_sync_time ?? 0),
          buffersCheckpoint: Number(b.buffers_checkpoint ?? 0),
          buffersClean: Number(b.buffers_clean ?? 0),
          buffersBackend: Number(b.buffers_backend ?? 0),
          buffersAlloc: Number(b.buffers_alloc ?? 0),
          maxwrittenClean: Number(b.maxwritten_clean ?? 0),
          statsResetIso: b.stats_reset
            ? new Date(String(b.stats_reset)).toISOString()
            : null,
        };
      }
    } catch {
      // Fallback for PostgreSQL 17+ split pg_stat_checkpointer + pg_stat_bgwriter
      try {
        const [cpRes, bg17Res] = await Promise.all([
          query(`
            SELECT
              num_timed::bigint AS checkpoints_timed,
              num_requested::bigint AS checkpoints_req,
              write_time::double precision AS checkpoint_write_time,
              sync_time::double precision AS checkpoint_sync_time,
              buffers_written::bigint AS buffers_checkpoint,
              stats_reset
            FROM pg_stat_checkpointer
            LIMIT 1;
          `),
          query(`
            SELECT
              buffers_clean::bigint,
              buffers_alloc::bigint,
              maxwritten_clean::bigint
            FROM pg_stat_bgwriter
            LIMIT 1;
          `),
        ]);
        const cp = cpRes.rows[0] ?? {};
        const bg17 = bg17Res.rows[0] ?? {};
        const timed = Number(cp.checkpoints_timed ?? 0);
        const req = Number(cp.checkpoints_req ?? 0);
        bgwriter = {
          checkpointsTimed: timed,
          checkpointsReq: req,
          requestedCheckpointPct:
            timed + req > 0 ? Math.round((req / (timed + req)) * 1000) / 10 : 0,
          checkpointWriteTimeMs: Number(cp.checkpoint_write_time ?? 0),
          checkpointSyncTimeMs: Number(cp.checkpoint_sync_time ?? 0),
          buffersCheckpoint: Number(cp.buffers_checkpoint ?? 0),
          buffersClean: Number(bg17.buffers_clean ?? 0),
          buffersBackend: 0,
          buffersAlloc: Number(bg17.buffers_alloc ?? 0),
          maxwrittenClean: Number(bg17.maxwritten_clean ?? 0),
          statsResetIso: cp.stats_reset
            ? new Date(String(cp.stats_reset)).toISOString()
            : null,
        };
      } catch {
        // Leave default zeros if permissions restrict stats view
      }
    }

    // 4. XID Wraparound & Active Vacuum Progress
    const freezeMaxAge = Math.max(1, Number(v.freeze_max_age ?? 200_000_000));
    const wrapRes = await query(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        age(c.relfrozenxid)::bigint AS xid_age,
        COALESCE(s.n_dead_tup, 0)::bigint AS n_dead_tup,
        s.last_autovacuum
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind IN ('r', 'm')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY age(c.relfrozenxid) DESC
      LIMIT 15;
    `);

    const maxXid = 2_147_483_647;
    const wraparoundTables: XidWraparoundTableRow[] = wrapRes.rows.map((r) => {
      const schemaName = String(r.schema_name ?? 'public');
      const tableName = String(r.table_name ?? 'unknown');
      const xidAge = Number(r.xid_age ?? 0);
      const pctTowardFreeze =
        Math.round((xidAge / freezeMaxAge) * 1000) / 10;
      const pctTowardWraparound =
        Math.round((xidAge / maxXid) * 10000) / 100;
      const status: XidWraparoundTableRow['status'] =
        pctTowardWraparound >= 50 || pctTowardFreeze >= 95
          ? 'CRITICAL'
          : pctTowardWraparound >= 25 || pctTowardFreeze >= 75
            ? 'WARNING'
            : 'HEALTHY';

      return {
        schemaName,
        tableName,
        xidAge,
        pctTowardFreeze,
        pctTowardWraparound,
        nDeadTup: Number(r.n_dead_tup ?? 0),
        lastAutovacuumIso: r.last_autovacuum
          ? new Date(String(r.last_autovacuum)).toISOString()
          : null,
        status,
        remediationSql: `VACUUM (FREEZE, VERBOSE, ANALYZE) ${quoteIdent(schemaName)}.${quoteIdent(tableName)};`,
      };
    });

    let activeVacuums: VacuumProgressRow[] = [];
    try {
      const vacRes = await query(`
        SELECT
          p.pid,
          n.nspname AS schema_name,
          c.relname AS table_name,
          p.phase,
          p.heap_blks_total::bigint,
          p.heap_blks_scanned::bigint,
          p.heap_blks_vacuumed::bigint,
          p.index_vacuum_count::int
        FROM pg_stat_progress_vacuum p
        JOIN pg_class c ON c.oid = p.relid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LIMIT 10;
      `);
      activeVacuums = vacRes.rows.map((r) => {
        const total = Number(r.heap_blks_total ?? 0);
        const scanned = Number(r.heap_blks_scanned ?? 0);
        return {
          pid: Number(r.pid),
          schemaName: String(r.schema_name ?? 'public'),
          tableName: String(r.table_name ?? 'unknown'),
          phase: String(r.phase ?? 'initializing'),
          heapBlksTotal: total,
          heapBlksScanned: scanned,
          heapBlksVacuumed: Number(r.heap_blks_vacuumed ?? 0),
          progressPct:
            total > 0 ? Math.min(100, Math.round((scanned / total) * 1000) / 10) : 0,
          indexVacuumCount: Number(r.index_vacuum_count ?? 0),
        };
      });
    } catch {
      activeVacuums = [];
    }

    // 5. Allowlisted pg_settings tuning audit (never queries sensitive password/command parameters)
    const settingsRes = await query(
      `
        SELECT name, setting, unit, category, context, source
        FROM pg_settings
        WHERE name = ANY($1::text[])
        ORDER BY name ASC;
      `,
      [Array.from(SAFE_PG_SETTINGS_ALLOWLIST)]
    );

    const settingsAudit: PgSettingAuditRow[] = settingsRes.rows.map((r) =>
      evaluateSettingAudit({
        name: String(r.name),
        setting: String(r.setting ?? ''),
        unit: r.unit ? String(r.unit) : null,
        category: String(r.category ?? ''),
        context: String(r.context ?? ''),
        source: String(r.source ?? ''),
      })
    );

    const databaseXidAge = Number(d.dat_xid_age ?? 0);

    return {
      targetLabel,
      databaseId: resolvedDatabaseId,
      environment,
      collectedAt: new Date().toISOString(),
      source: 'live_pg',
      throughput,
      bgwriter,
      sessions,
      databaseXidAge,
      databaseXidWraparoundPct:
        Math.round((databaseXidAge / maxXid) * 10000) / 100,
      autovacuumFreezeMaxAge: freezeMaxAge,
      wraparoundTables,
      activeVacuums,
      settingsAudit,
    };
  });
}
