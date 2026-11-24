import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  alertWebhooks,
  apiKeys,
  auditLogs,
  migrationChecks,
  monitoredDatabases,
  queryLatencySamples,
  schemaBaselines,
  targetHealthThresholds,
  telemetryIncidents,
  telemetrySnapshots,
  users,
  workspaceSettings,
} from '../db/schema.ts';
import { encryptSecret } from './crypto.ts';
import { SchemaInspector } from './inspector.ts';
import type {
  ColumnCatalogRow,
  DatabaseHealthSummary,
  IndexBloatRow,
  LockTreeRow,
  MigrationFinding,
} from '../types/telemetry.ts';

export const DEMO_USER = {
  uid: 'demo_driftguard_workspace',
  email: 'demo@driftguard.dev',
  displayName: 'Alex Rivera (Demo)',
} as const;

const DEMO_TOKEN_PREFIX = 'dg_demo.';
const DEMO_TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 hours

function getDemoSigningSecret(): Buffer {
  const seed = [
    process.env.ENCRYPTION_KEY?.trim(),
    process.env.SQL_PASSWORD?.trim(),
    process.env.SQL_HOST?.trim(),
    process.env.SQL_DB_NAME?.trim(),
  ]
    .filter(Boolean)
    .join('|');
  const material = seed || 'driftguard-local-dev-fallback';
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(material, 'utf8'),
      Buffer.from('driftguard-demo-session-salt-v1', 'utf8'),
      Buffer.from('driftguard-demo-hmac-key', 'utf8'),
      32
    )
  );
}

export function createDemoSessionToken(): { token: string; expiresAt: string } {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + DEMO_TOKEN_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({
      uid: DEMO_USER.uid,
      email: DEMO_USER.email,
      name: DEMO_USER.displayName,
      iat: nowSec,
      exp: expSec,
    }),
    'utf8'
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', getDemoSigningSecret())
    .update(payload)
    .digest('base64url');

  return {
    token: `${DEMO_TOKEN_PREFIX}${payload}.${sig}`,
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}

export function verifyDemoSessionToken(token: string): {
  uid: string;
  email: string;
  name: string;
} | null {
  if (!token.startsWith(DEMO_TOKEN_PREFIX)) return null;
  const body = token.slice(DEMO_TOKEN_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, providedSig] = parts;
  if (!payloadB64 || !providedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getDemoSigningSecret())
    .update(payloadB64)
    .digest('base64url');

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as { uid?: string; email?: string; name?: string; exp?: number };

    if (
      parsed.uid !== DEMO_USER.uid ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return {
      uid: DEMO_USER.uid,
      email: DEMO_USER.email,
      name: DEMO_USER.displayName,
    };
  } catch {
    return null;
  }
}

function buildBaselineCatalog(): ColumnCatalogRow[] {
  return [
    {
      table_schema: 'public',
      table_name: 'accounts',
      column_name: 'id',
      ordinal_position: 1,
      column_default: 'gen_random_uuid()',
      is_nullable: 'NO',
      data_type: 'uuid',
      udt_name: 'uuid',
    },
    {
      table_schema: 'public',
      table_name: 'accounts',
      column_name: 'org_slug',
      ordinal_position: 2,
      column_default: null,
      is_nullable: 'NO',
      data_type: 'character varying',
      udt_name: 'varchar',
    },
    {
      table_schema: 'public',
      table_name: 'accounts',
      column_name: 'plan_tier',
      ordinal_position: 3,
      column_default: "'pro'::character varying",
      is_nullable: 'NO',
      data_type: 'character varying',
      udt_name: 'varchar',
    },
    {
      table_schema: 'public',
      table_name: 'accounts',
      column_name: 'created_at',
      ordinal_position: 4,
      column_default: 'now()',
      is_nullable: 'NO',
      data_type: 'timestamp with time zone',
      udt_name: 'timestamptz',
    },
    {
      table_schema: 'public',
      table_name: 'invoices',
      column_name: 'id',
      ordinal_position: 1,
      column_default: 'gen_random_uuid()',
      is_nullable: 'NO',
      data_type: 'uuid',
      udt_name: 'uuid',
    },
    {
      table_schema: 'public',
      table_name: 'invoices',
      column_name: 'account_id',
      ordinal_position: 2,
      column_default: null,
      is_nullable: 'NO',
      data_type: 'uuid',
      udt_name: 'uuid',
    },
    {
      table_schema: 'public',
      table_name: 'invoices',
      column_name: 'amount_cents',
      ordinal_position: 3,
      column_default: '0',
      is_nullable: 'NO',
      data_type: 'integer',
      udt_name: 'int4',
    },
    {
      table_schema: 'public',
      table_name: 'invoices',
      column_name: 'status',
      ordinal_position: 4,
      column_default: "'open'::character varying",
      is_nullable: 'NO',
      data_type: 'character varying',
      udt_name: 'varchar',
    },
    {
      table_schema: 'public',
      table_name: 'invoices',
      column_name: 'issued_at',
      ordinal_position: 5,
      column_default: 'now()',
      is_nullable: 'NO',
      data_type: 'timestamp with time zone',
      udt_name: 'timestamptz',
    },
    {
      table_schema: 'public',
      table_name: 'payments',
      column_name: 'id',
      ordinal_position: 1,
      column_default: 'gen_random_uuid()',
      is_nullable: 'NO',
      data_type: 'uuid',
      udt_name: 'uuid',
    },
    {
      table_schema: 'public',
      table_name: 'payments',
      column_name: 'invoice_id',
      ordinal_position: 2,
      column_default: null,
      is_nullable: 'NO',
      data_type: 'uuid',
      udt_name: 'uuid',
    },
    {
      table_schema: 'public',
      table_name: 'payments',
      column_name: 'provider_ref',
      ordinal_position: 3,
      column_default: null,
      is_nullable: 'YES',
      data_type: 'text',
      udt_name: 'text',
    },
    {
      table_schema: 'public',
      table_name: 'subscriptions',
      column_name: 'id',
      ordinal_position: 1,
      column_default: 'gen_random_uuid()',
      is_nullable: 'NO',
      data_type: 'uuid',
      udt_name: 'uuid',
    },
    {
      table_schema: 'public',
      table_name: 'subscriptions',
      column_name: 'account_id',
      ordinal_position: 2,
      column_default: null,
      is_nullable: 'NO',
      data_type: 'uuid',
      udt_name: 'uuid',
    },
    {
      table_schema: 'public',
      table_name: 'subscriptions',
      column_name: 'renews_at',
      ordinal_position: 3,
      column_default: null,
      is_nullable: 'NO',
      data_type: 'timestamp with time zone',
      udt_name: 'timestamptz',
    },
  ];
}

function buildDriftedProdCatalog(): ColumnCatalogRow[] {
  const base = buildBaselineCatalog().map((c) => ({ ...c }));
  // Modify amount_cents from integer -> bigint (hotfix type change)
  const amountCol = base.find(
    (c) => c.table_name === 'invoices' && c.column_name === 'amount_cents'
  );
  if (amountCol) {
    amountCol.data_type = 'bigint';
    amountCol.udt_name = 'int8';
  }
  // Add 2 undocumented hotfix columns
  base.push(
    {
      table_schema: 'public',
      table_name: 'invoices',
      column_name: 'tax_jurisdiction',
      ordinal_position: 6,
      column_default: null,
      is_nullable: 'YES',
      data_type: 'character varying',
      udt_name: 'varchar',
    },
    {
      table_schema: 'public',
      table_name: 'payments',
      column_name: 'settlement_batch_id',
      ordinal_position: 4,
      column_default: null,
      is_nullable: 'YES',
      data_type: 'uuid',
      udt_name: 'uuid',
    }
  );
  return base;
}

function buildStagingCatalog(): ColumnCatalogRow[] {
  const base = buildBaselineCatalog().map((c) => ({ ...c }));
  base.push({
    table_schema: 'public',
    table_name: 'subscriptions',
    column_name: 'grace_period_days',
    ordinal_position: 4,
    column_default: '7',
    is_nullable: 'NO',
    data_type: 'integer',
    udt_name: 'int4',
  });
  return base;
}

function buildDemoHealthSummary(params: {
  cacheHit: number;
  activeConn: number;
  idleConn: number;
  idleInTx: number;
  maxConn: number;
  sizePretty: string;
  sizeBytes: number;
  deadPct: number;
  deadTup: number;
}): DatabaseHealthSummary {
  const usagePct = Math.round(
    ((params.activeConn + params.idleConn) / params.maxConn) * 100
  );
  return {
    database_size_pretty: params.sizePretty,
    database_size_bytes: params.sizeBytes,
    cache_hit_ratio_pct: params.cacheHit,
    active_connections: params.activeConn,
    idle_connections: params.idleConn,
    idle_in_transaction: params.idleInTx,
    max_connections: params.maxConn,
    connection_usage_pct: usagePct,
    pg_version: 'PostgreSQL 16.4 (Cloud SQL)',
    table_health: [
      {
        schemaname: 'public',
        relname: 'invoices',
        n_live_tup: 1_842_300,
        n_dead_tup: params.deadTup,
        dead_tuple_pct: params.deadPct,
        seq_scan: 1842,
        idx_scan: 94210,
        total_size_pretty: '4.2 GB',
        total_bytes: 4_509_715_660,
        last_autovacuum: new Date(Date.now() - 4 * 3_600_000).toISOString(),
        last_autoanalyze: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        remediation_sql: 'VACUUM (VERBOSE, ANALYZE) public.invoices;',
      },
      {
        schemaname: 'public',
        relname: 'payments',
        n_live_tup: 924_110,
        n_dead_tup: 38_420,
        dead_tuple_pct: 4.1,
        seq_scan: 312,
        idx_scan: 61820,
        total_size_pretty: '1.9 GB',
        total_bytes: 2_040_109_465,
        last_autovacuum: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        last_autoanalyze: new Date(Date.now() - 1 * 3_600_000).toISOString(),
        remediation_sql: 'VACUUM (VERBOSE, ANALYZE) public.payments;',
      },
      {
        schemaname: 'public',
        relname: 'subscriptions',
        n_live_tup: 215_900,
        n_dead_tup: 6_120,
        dead_tuple_pct: 2.8,
        seq_scan: 84,
        idx_scan: 41205,
        total_size_pretty: '412 MB',
        total_bytes: 432_013_312,
        last_autovacuum: new Date(Date.now() - 6 * 3_600_000).toISOString(),
        last_autoanalyze: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        remediation_sql: 'VACUUM (VERBOSE, ANALYZE) public.subscriptions;',
      },
    ],
    unused_indexes: [
      {
        schemaname: 'public',
        tablename: 'invoices',
        indexname: 'idx_invoices_legacy_memo',
        idx_scan: 0,
        index_size_pretty: '184 MB',
        index_bytes: 192_937_984,
        remediation_sql:
          'DROP INDEX CONCURRENTLY IF EXISTS public.idx_invoices_legacy_memo;',
      },
    ],
  };
}

let seedingPromise: Promise<void> | null = null;

export async function ensureDemoWorkspaceSeeded(): Promise<void> {
  if (seedingPromise) {
    return seedingPromise;
  }
  seedingPromise = seedDemoWorkspaceInternal().finally(() => {
    seedingPromise = null;
  });
  return seedingPromise;
}

async function seedDemoWorkspaceInternal(): Promise<void> {
  // 1. Ensure demo user exists
  await db
    .insert(users)
    .values({
      uid: DEMO_USER.uid,
      email: DEMO_USER.email,
      displayName: DEMO_USER.displayName,
    })
    .onConflictDoNothing();

  // Check if demo targets already exist
  const existingDbs = await db
    .select({ id: monitoredDatabases.id })
    .from(monitoredDatabases)
    .where(eq(monitoredDatabases.ownerUid, DEMO_USER.uid));

  if (existingDbs.length > 0) {
    return;
  }

  const now = Date.now();
  const HOUR_MS = 3_600_000;
  const DAY_MS = 86_400_000;

  // 2. Workspace Settings
  await db
    .insert(workspaceSettings)
    .values({
      ownerUid: DEMO_USER.uid,
      lockThresholdSeconds: 15,
      bloatMbThreshold: 50,
      bloatPctThreshold: 40,
      deadTuplePctThreshold: 20,
      cacheHitMinPct: 95,
      connSaturationPct: 80,
      updatedAt: new Date(now - 2 * DAY_MS),
    })
    .onConflictDoNothing();

  // 3. Create 4 realistic monitored PostgreSQL targets (using workspace_pg mode so live SQL suite works seamlessly)
  const baselineCatalog = buildBaselineCatalog();
  const driftedCatalog = buildDriftedProdCatalog();
  const stagingCatalog = buildStagingCatalog();

  const baselineHash = SchemaInspector.computeCanonicalHash(baselineCatalog);
  const driftedHash = SchemaInspector.computeCanonicalHash(driftedCatalog);
  const stagingHash = SchemaInspector.computeCanonicalHash(stagingCatalog);

  const driftDiffs = SchemaInspector.diffCatalogs(
    baselineCatalog,
    driftedCatalog
  );

  const [prodBilling, prodLedger, stagingOrders, devAnalytics] = await db
    .insert(monitoredDatabases)
    .values([
      {
        ownerUid: DEMO_USER.uid,
        name: 'prod-billing-pg',
        environment: 'production',
        connectionMode: 'workspace_pg',
        connectionUrlEncrypted: 'workspace_pg',
        maskedTarget: 'postgres://driftguard_ro@pg-billing-us-east.internal:5432/billing_prod',
        pollIntervalSeconds: 60,
        isActive: true,
        lastPolledAt: new Date(now - 3 * 60_000),
        lastSchemaHash: driftedHash,
        lastHealthStatus: 'DRIFT',
        createdAt: new Date(now - 18 * DAY_MS),
      },
      {
        ownerUid: DEMO_USER.uid,
        name: 'prod-core-ledger',
        environment: 'production',
        connectionMode: 'workspace_pg',
        connectionUrlEncrypted: 'workspace_pg',
        maskedTarget: 'postgres://driftguard_ro@pg-ledger-us-east.internal:5432/core_ledger',
        pollIntervalSeconds: 60,
        isActive: true,
        lastPolledAt: new Date(now - 2 * 60_000),
        lastSchemaHash: baselineHash,
        lastHealthStatus: 'HEALTHY',
        createdAt: new Date(now - 24 * DAY_MS),
      },
      {
        ownerUid: DEMO_USER.uid,
        name: 'staging-orders-pg',
        environment: 'staging',
        connectionMode: 'workspace_pg',
        connectionUrlEncrypted: 'workspace_pg',
        maskedTarget: 'postgres://driftguard_ro@pg-staging-01.internal:5432/orders_staging',
        pollIntervalSeconds: 120,
        isActive: true,
        lastPolledAt: new Date(now - 5 * 60_000),
        lastSchemaHash: stagingHash,
        lastHealthStatus: 'WARNING',
        createdAt: new Date(now - 14 * DAY_MS),
      },
      {
        ownerUid: DEMO_USER.uid,
        name: 'dev-analytics-pg',
        environment: 'development',
        connectionMode: 'workspace_pg',
        connectionUrlEncrypted: 'workspace_pg',
        maskedTarget: 'postgres://driftguard_ro@pg-dev-analytics.internal:5432/analytics_dev',
        pollIntervalSeconds: 300,
        isActive: true,
        lastPolledAt: new Date(now - 9 * 60_000),
        lastSchemaHash: baselineHash,
        lastHealthStatus: 'HEALTHY',
        createdAt: new Date(now - 10 * DAY_MS),
      },
    ])
    .returning();

  // 4. Schema Baselines
  await db.insert(schemaBaselines).values([
    {
      databaseId: prodBilling.id,
      gitCommitSha: '8c1a9f2',
      schemaHash: baselineHash,
      tablesJson: baselineCatalog.slice(0, 12),
      createdAt: new Date(now - 12 * DAY_MS),
    },
    {
      databaseId: prodBilling.id,
      gitCommitSha: 'a9f4c21',
      schemaHash: baselineHash,
      tablesJson: baselineCatalog,
      createdAt: new Date(now - 3 * DAY_MS),
    },
    {
      databaseId: prodLedger.id,
      gitCommitSha: 'e41b890',
      schemaHash: baselineHash,
      tablesJson: baselineCatalog,
      createdAt: new Date(now - 4 * DAY_MS),
    },
    {
      databaseId: stagingOrders.id,
      gitCommitSha: '7c2d104',
      schemaHash: stagingHash,
      tablesJson: stagingCatalog,
      createdAt: new Date(now - 2 * DAY_MS),
    },
    {
      databaseId: devAnalytics.id,
      gitCommitSha: '3f9a112',
      schemaHash: baselineHash,
      tablesJson: baselineCatalog,
      createdAt: new Date(now - 5 * DAY_MS),
    },
  ]);

  // 5. Realistic Lock & Bloat rows
  const prodLocks: LockTreeRow[] = [
    {
      blocked_pid: 48219,
      blocked_user: 'billing_api',
      blocking_pid: 47904,
      blocking_user: 'etl_reconciler',
      blocked_statement:
        "UPDATE public.invoices SET status = '<REDACTED>' WHERE id = '<REDACTED>'",
      blocking_statement:
        'ALTER TABLE public.invoices ALTER COLUMN amount_cents TYPE bigint',
      wait_duration_seconds: 28,
      wait_duration_display: '00:00:28',
    },
  ];

  const stagingBloat: IndexBloatRow[] = [
    {
      schemaname: 'public',
      tablename: 'invoices',
      indexname: 'idx_invoices_account_status',
      index_size_pretty: '312 MB',
      index_bytes: 327_155_712,
      estimated_bloat_pct: 48.2,
      remediation_sql:
        'REINDEX INDEX CONCURRENTLY public.idx_invoices_account_status;',
    },
    {
      schemaname: 'public',
      tablename: 'payments',
      indexname: 'idx_payments_invoice_created',
      index_size_pretty: '146 MB',
      index_bytes: 153_092_096,
      estimated_bloat_pct: 41.6,
      remediation_sql:
        'REINDEX INDEX CONCURRENTLY public.idx_payments_invoice_created;',
    },
  ];

  const prodHealth = buildDemoHealthSummary({
    cacheHit: 97.8,
    activeConn: 64,
    idleConn: 48,
    idleInTx: 3,
    maxConn: 200,
    sizePretty: '14.8 GB',
    sizeBytes: 15_891_378_995,
    deadPct: 11.4,
    deadTup: 210_000,
  });

  const ledgerHealth = buildDemoHealthSummary({
    cacheHit: 99.4,
    activeConn: 28,
    idleConn: 34,
    idleInTx: 0,
    maxConn: 200,
    sizePretty: '9.2 GB',
    sizeBytes: 9_878_424_780,
    deadPct: 2.1,
    deadTup: 18_400,
  });

  const stagingHealth = buildDemoHealthSummary({
    cacheHit: 94.1,
    activeConn: 42,
    idleConn: 46,
    idleInTx: 2,
    maxConn: 100,
    sizePretty: '6.4 GB',
    sizeBytes: 6_871_947_673,
    deadPct: 26.8,
    deadTup: 492_000,
  });

  const devHealth = buildDemoHealthSummary({
    cacheHit: 99.1,
    activeConn: 8,
    idleConn: 14,
    idleInTx: 0,
    maxConn: 100,
    sizePretty: '1.8 GB',
    sizeBytes: 1_932_735_283,
    deadPct: 1.9,
    deadTup: 4_200,
  });

  // 6. Snapshots across last 7 days + hourly over last 24h (powers 7-day sparklines + 24-hour heat map + Vacuum/Bloat trends)
  const snapshotRows: (typeof telemetrySnapshots.$inferInsert)[] = [];

  // Daily snapshots for days 6..1 ago
  for (let d = 6; d >= 1; d--) {
    const ts = new Date(now - d * DAY_MS + 2 * HOUR_MS);
    snapshotRows.push(
      {
        databaseId: prodBilling.id,
        schemaHash: d <= 1 ? driftedHash : baselineHash,
        tableCount: 4,
        columnCount: d <= 1 ? driftedCatalog.length : baselineCatalog.length,
        activeLocksCount: d === 2 ? 1 : 0,
        bloatedIndexesCount: d <= 3 ? 1 : 0,
        catalogJson: d <= 1 ? driftedCatalog : baselineCatalog,
        locksJson: d === 2 ? prodLocks : [],
        bloatJson: d <= 3 ? [stagingBloat[0]] : [],
        healthJson: prodHealth,
        durationMs: 38 + d * 4,
        inspectedAt: ts,
      },
      {
        databaseId: prodLedger.id,
        schemaHash: baselineHash,
        tableCount: 4,
        columnCount: baselineCatalog.length,
        activeLocksCount: 0,
        bloatedIndexesCount: 0,
        catalogJson: baselineCatalog,
        locksJson: [],
        bloatJson: [],
        healthJson: ledgerHealth,
        durationMs: 29 + d * 2,
        inspectedAt: ts,
      },
      {
        databaseId: stagingOrders.id,
        schemaHash: stagingHash,
        tableCount: 4,
        columnCount: stagingCatalog.length,
        activeLocksCount: d === 4 || d === 1 ? 1 : 0,
        bloatedIndexesCount: d <= 4 ? 2 : 1,
        catalogJson: stagingCatalog,
        locksJson: [],
        bloatJson: stagingBloat,
        healthJson: stagingHealth,
        durationMs: 52 + d * 3,
        inspectedAt: ts,
      },
      {
        databaseId: devAnalytics.id,
        schemaHash: baselineHash,
        tableCount: 4,
        columnCount: baselineCatalog.length,
        activeLocksCount: 0,
        bloatedIndexesCount: 0,
        catalogJson: baselineCatalog,
        locksJson: [],
        bloatJson: [],
        healthJson: devHealth,
        durationMs: 24 + d * 2,
        inspectedAt: ts,
      }
    );
  }

  // Hourly snapshots across last 24h so the 24-Hour Heat Map has realistic density
  const busyHoursOffsets = [22, 20, 18, 16, 15, 14, 12, 10, 9, 8, 6, 5, 4, 3, 2, 1, 0];
  for (const h of busyHoursOffsets) {
    const inspectedAt = new Date(now - h * HOUR_MS - 3 * 60_000);
    const isPeakWindow = h >= 2 && h <= 5;
    const countProd = isPeakWindow ? 2 : 1;
    for (let k = 0; k < countProd; k++) {
      snapshotRows.push({
        databaseId: prodBilling.id,
        schemaHash: h <= 4 ? driftedHash : baselineHash,
        tableCount: 4,
        columnCount: h <= 4 ? driftedCatalog.length : baselineCatalog.length,
        activeLocksCount: h <= 3 ? 1 : 0,
        bloatedIndexesCount: 1,
        catalogJson: h <= 4 ? driftedCatalog : baselineCatalog,
        locksJson: h <= 3 ? prodLocks : [],
        bloatJson: [stagingBloat[0]],
        healthJson: prodHealth,
        durationMs: 41 + (h % 9) * 3,
        inspectedAt: new Date(inspectedAt.getTime() - k * 12 * 60_000),
      });
    }

    if (h % 2 === 0 || h <= 3) {
      snapshotRows.push({
        databaseId: prodLedger.id,
        schemaHash: baselineHash,
        tableCount: 4,
        columnCount: baselineCatalog.length,
        activeLocksCount: 0,
        bloatedIndexesCount: 0,
        catalogJson: baselineCatalog,
        locksJson: [],
        bloatJson: [],
        healthJson: ledgerHealth,
        durationMs: 27 + (h % 5) * 2,
        inspectedAt,
      });
    }

    if (h % 2 === 1 || h <= 6) {
      snapshotRows.push({
        databaseId: stagingOrders.id,
        schemaHash: stagingHash,
        tableCount: 4,
        columnCount: stagingCatalog.length,
        activeLocksCount: h === 5 ? 1 : 0,
        bloatedIndexesCount: 2,
        catalogJson: stagingCatalog,
        locksJson: [],
        bloatJson: stagingBloat,
        healthJson: stagingHealth,
        durationMs: 56 + (h % 7) * 4,
        inspectedAt,
      });
    }

    if (h % 3 === 0 || h === 0) {
      snapshotRows.push({
        databaseId: devAnalytics.id,
        schemaHash: baselineHash,
        tableCount: 4,
        columnCount: baselineCatalog.length,
        activeLocksCount: 0,
        bloatedIndexesCount: 0,
        catalogJson: baselineCatalog,
        locksJson: [],
        bloatJson: [],
        healthJson: devHealth,
        durationMs: 22 + (h % 4) * 2,
        inspectedAt,
      });
    }
  }

  await db.insert(telemetrySnapshots).values(snapshotRows);

  // 7. Telemetry Incidents (Open + Historical resolved for 24h heat map & 7d sparkline variation)
  await db.insert(telemetryIncidents).values([
    {
      databaseId: prodBilling.id,
      incidentType: 'SCHEMA_DRIFT',
      severity: 'CRITICAL',
      fingerprint: SchemaInspector.computeFingerprint([
        'DEMO_DRIFT',
        prodBilling.id,
      ]),
      status: 'OPEN',
      details: {
        summary:
          'Live catalog hash diverged from baseline a9f4c21 (2 added columns, 1 modified type on invoices.amount_cents).',
        baseline_hash: baselineHash,
        live_hash: driftedHash,
        git_commit_sha: 'a9f4c21',
        added_count: 2,
        removed_count: 0,
        modified_count: 1,
        diffs: driftDiffs,
      },
      createdAt: new Date(now - 3 * HOUR_MS - 18 * 60_000),
    },
    {
      databaseId: prodBilling.id,
      incidentType: 'LOCK_CONTENTION',
      severity: 'WARNING',
      fingerprint: SchemaInspector.computeFingerprint([
        'DEMO_LOCK',
        prodBilling.id,
      ]),
      status: 'OPEN',
      details: {
        summary:
          'PID 47904 (etl_reconciler) blocking PID 48219 (billing_api) for 28s on public.invoices.',
        blocked_pid: 48219,
        blocked_user: 'billing_api',
        blocking_pid: 47904,
        blocking_user: 'etl_reconciler',
        wait_duration_seconds: 28,
        wait_duration_display: '00:00:28',
        blocked_statement_redacted:
          "UPDATE public.invoices SET status = '<REDACTED>' WHERE id = '<REDACTED>'",
        blocking_statement_redacted:
          'ALTER TABLE public.invoices ALTER COLUMN amount_cents TYPE bigint',
      },
      createdAt: new Date(now - 3 * HOUR_MS - 10 * 60_000),
    },
    {
      databaseId: stagingOrders.id,
      incidentType: 'VACUUM_HEALTH',
      severity: 'WARNING',
      fingerprint: SchemaInspector.computeFingerprint([
        'DEMO_VACUUM',
        stagingOrders.id,
      ]),
      status: 'OPEN',
      details: {
        summary:
          'Table public.invoices has 492,000 dead tuples (26.8% dead ratio), exceeding the 20% threshold.',
        schemaname: 'public',
        relname: 'invoices',
        n_live_tup: 1_842_300,
        n_dead_tup: 492_000,
        dead_tuple_pct: 26.8,
        remediation_sql: 'VACUUM (VERBOSE, ANALYZE) public.invoices;',
      },
      createdAt: new Date(now - 5 * HOUR_MS - 12 * 60_000),
    },
    {
      databaseId: stagingOrders.id,
      incidentType: 'INDEX_BLOAT',
      severity: 'INFO',
      fingerprint: SchemaInspector.computeFingerprint([
        'DEMO_BLOAT',
        stagingOrders.id,
      ]),
      status: 'ACKNOWLEDGED',
      details: {
        summary:
          'Index public.idx_invoices_account_status is 312 MB with 48.2% estimated bloat.',
        schemaname: 'public',
        tablename: 'invoices',
        indexname: 'idx_invoices_account_status',
        index_size_pretty: '312 MB',
        index_bytes: 327_155_712,
        estimated_bloat_pct: 48.2,
        remediation_sql:
          'REINDEX INDEX CONCURRENTLY public.idx_invoices_account_status;',
      },
      createdAt: new Date(now - 9 * HOUR_MS),
    },
    // Historical resolved incidents for sparkline & heat map realism
    {
      databaseId: prodBilling.id,
      incidentType: 'CONNECTION_SATURATION',
      severity: 'WARNING',
      fingerprint: SchemaInspector.computeFingerprint([
        'DEMO_CONN_HIST',
        prodBilling.id,
      ]),
      status: 'RESOLVED',
      details: {
        summary:
          'Connection pool peaked at 84% capacity (168 active / 200 max) during nightly billing export.',
        active_connections: 168,
        max_connections: 200,
        connection_usage_pct: 84,
        idle_in_transaction: 9,
      },
      createdAt: new Date(now - 2 * DAY_MS),
      resolvedAt: new Date(now - 2 * DAY_MS + HOUR_MS),
    },
    {
      databaseId: stagingOrders.id,
      incidentType: 'LOCK_CONTENTION',
      severity: 'WARNING',
      fingerprint: SchemaInspector.computeFingerprint([
        'DEMO_LOCK_HIST',
        stagingOrders.id,
      ]),
      status: 'RESOLVED',
      details: {
        summary:
          'PID 12490 (deploy_runner) blocked PID 12511 for 19s during staging index rebuild.',
        blocked_pid: 12511,
        blocked_user: 'orders_svc',
        blocking_pid: 12490,
        blocking_user: 'deploy_runner',
        wait_duration_seconds: 19,
        wait_duration_display: '00:00:19',
        blocked_statement_redacted:
          "SELECT id, status FROM public.orders WHERE account_id = '<REDACTED>'",
        blocking_statement_redacted:
          'CREATE INDEX idx_orders_staging_tmp ON public.orders(created_at)',
      },
      createdAt: new Date(now - 4 * DAY_MS),
      resolvedAt: new Date(now - 4 * DAY_MS + 40 * 60_000),
    },
  ]);

  // 8. 30-Day Query Latency Samples (powers Performance Trends chart in SQL Telemetry Suite)
  const demoQueries = [
    {
      queryId: 'q_invoices_tenant_status',
      preview:
        'SELECT id, account_id, amount_cents, status FROM public.invoices WHERE account_id = $1 AND status = $2 ORDER BY issued_at DESC LIMIT 50',
      baseMs: 14.2,
      spikeLastDays: 4,
      spikeMultiplier: 3.4,
      callsBase: 1480,
      cachePct: 96.4,
    },
    {
      queryId: 'q_payments_reconcile_join',
      preview:
        'SELECT p.id, p.provider_ref, i.amount_cents FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id WHERE p.settlement_batch_id = $1',
      baseMs: 28.6,
      spikeLastDays: 3,
      spikeMultiplier: 2.3,
      callsBase: 620,
      cachePct: 92.8,
    },
    {
      queryId: 'q_subscriptions_renewal',
      preview:
        'SELECT s.id, a.org_slug, s.renews_at FROM public.subscriptions s JOIN public.accounts a ON a.id = s.account_id WHERE s.renews_at <= NOW() + INTERVAL $1',
      baseMs: 9.4,
      spikeLastDays: 0,
      spikeMultiplier: 1.0,
      callsBase: 2140,
      cachePct: 99.1,
    },
    {
      queryId: 'q_account_lookup_slug',
      preview:
        'SELECT id, org_slug, plan_tier FROM public.accounts WHERE org_slug = $1 LIMIT 1',
      baseMs: 2.1,
      spikeLastDays: 0,
      spikeMultiplier: 1.0,
      callsBase: 9420,
      cachePct: 99.8,
    },
  ];

  const latencyRows: (typeof queryLatencySamples.$inferInsert)[] = [];
  for (let day = 29; day >= 0; day--) {
    const sampledAt = new Date(now - day * DAY_MS);
    for (const q of demoQueries) {
      const jitter = Math.sin(day * 0.7 + q.baseMs) * 0.12;
      const inSpike = q.spikeLastDays > 0 && day < q.spikeLastDays;
      const mult = inSpike
        ? q.spikeMultiplier * (1 - day * 0.08)
        : 1 + jitter;
      const meanMs = Number(Math.max(0.8, q.baseMs * mult).toFixed(2));
      latencyRows.push({
        ownerUid: DEMO_USER.uid,
        databaseId: prodBilling.id,
        queryId: q.queryId,
        queryPreview: q.preview,
        calls: Math.round(q.callsBase * (0.88 + (day % 5) * 0.06)),
        meanExecTimeMs: meanMs,
        maxExecTimeMs: Number((meanMs * 3.1).toFixed(2)),
        cacheHitPct: q.cachePct,
        sampledAt,
      });
    }
  }
  await db.insert(queryLatencySamples).values(latencyRows);

  // 9. Alert Webhooks
  await db.insert(alertWebhooks).values([
    {
      ownerUid: DEMO_USER.uid,
      name: '#db-alerts-production (Slack)',
      provider: 'slack',
      webhookUrlEncrypted: encryptSecret(
        'https://hooks.slack.com/services/T00DEMO00/B00DEMO00/DriftGuardDemoWebhook01'
      ),
      maskedUrl: 'https://hooks.slack.com/services/T00D••••••/••••••01',
      minSeverity: 'WARNING',
      isActive: true,
      lastTriggeredAt: new Date(now - 3 * HOUR_MS - 18 * 60_000),
      lastStatusCode: 200,
      createdAt: new Date(now - 15 * DAY_MS),
    },
    {
      ownerUid: DEMO_USER.uid,
      name: 'SRE On-Call Channel (Discord)',
      provider: 'discord',
      webhookUrlEncrypted: encryptSecret(
        'https://discord.com/api/webhooks/123456789012345678/DriftGuardDemoToken99'
      ),
      maskedUrl: 'https://discord.com/api/webhooks/1234••••••/••••••99',
      minSeverity: 'CRITICAL',
      isActive: true,
      lastTriggeredAt: new Date(now - 3 * HOUR_MS - 18 * 60_000),
      lastStatusCode: 204,
      createdAt: new Date(now - 11 * DAY_MS),
    },
  ]);

  // 10. Pre-Flight Migration Linter History
  const blockedFindings: MigrationFinding[] = [
    {
      ruleId: 'ADD_COLUMN_NOT_NULL_NO_DEFAULT',
      severity: 'CRITICAL',
      title: 'NOT NULL column without DEFAULT locks table writes',
      plainEnglishImpact:
        'Adding a NOT NULL column without a default fails on populated tables or forces an ACCESS EXCLUSIVE table rewrite.',
      lockLevel: 'ACCESS EXCLUSIVE',
      statementPreview:
        'ALTER TABLE public.invoices ADD COLUMN tax_code TEXT NOT NULL;',
      recommendation:
        'Add the column as nullable first, backfill in batches, then add a NOT VALID check constraint.',
    },
    {
      ruleId: 'MISSING_LOCK_TIMEOUT',
      severity: 'WARNING',
      title: 'Missing SET lock_timeout safety guard',
      plainEnglishImpact:
        'Without lock_timeout, DDL waits indefinitely and queues every application read and write behind it.',
      lockLevel: 'ACCESS EXCLUSIVE',
      statementPreview: 'ALTER TABLE public.invoices ...',
      recommendation: "Prefix migration with SET lock_timeout = '3s';",
    },
  ];

  await db.insert(migrationChecks).values([
    {
      ownerUid: DEMO_USER.uid,
      databaseId: prodBilling.id,
      title: '20261124_add_invoice_tax_code.sql',
      sqlText:
        'ALTER TABLE public.invoices ADD COLUMN tax_code TEXT NOT NULL;\nCREATE INDEX idx_invoices_tax_code ON public.invoices(tax_code);',
      riskLevel: 'BLOCKED',
      findingsJson: blockedFindings,
      wrappedSafeSql:
        "SET lock_timeout = '3s';\nSET statement_timeout = '30s';\nALTER TABLE public.invoices ADD COLUMN tax_code TEXT;\nCREATE INDEX CONCURRENTLY idx_invoices_tax_code ON public.invoices(tax_code);",
      createdAt: new Date(now - 6 * HOUR_MS),
    },
    {
      ownerUid: DEMO_USER.uid,
      databaseId: stagingOrders.id,
      title: '20261123_index_payments_batch.sql',
      sqlText:
        "SET lock_timeout = '3s';\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_batch ON public.payments(settlement_batch_id);",
      riskLevel: 'SAFE',
      findingsJson: [],
      wrappedSafeSql:
        "SET lock_timeout = '3s';\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_batch ON public.payments(settlement_batch_id);",
      createdAt: new Date(now - 1 * DAY_MS),
    },
  ]);

  // 11. CI/CD API Keys
  await db.insert(apiKeys).values([
    {
      ownerUid: DEMO_USER.uid,
      name: 'GitHub Actions — Production Deploy',
      keyPrefix: 'dg_live_9f2a',
      keyHash: crypto
        .createHash('sha256')
        .update('demo-key-prod-01')
        .digest('hex'),
      lastUsedAt: new Date(now - 45 * 60_000),
      createdAt: new Date(now - 14 * DAY_MS),
    },
    {
      ownerUid: DEMO_USER.uid,
      name: 'GitLab CI — Staging Gate',
      keyPrefix: 'dg_live_4c8e',
      keyHash: crypto
        .createHash('sha256')
        .update('demo-key-stg-02')
        .digest('hex'),
      lastUsedAt: new Date(now - 6 * HOUR_MS),
      createdAt: new Date(now - 9 * DAY_MS),
    },
  ]);

  // 12. Per-Target Custom Health Score Thresholds
  await db.insert(targetHealthThresholds).values([
    {
      databaseId: prodBilling.id,
      ownerUid: DEMO_USER.uid,
      enabled: true,
      minHealthScore: 85,
      cooldownMinutes: 10,
      lastEvaluatedScore: 35,
      lastBreachAt: new Date(now - 3 * HOUR_MS),
      lastAutoReinspectAt: new Date(now - 42 * 60_000),
      autoReinspectCount: 3,
      updatedAt: new Date(now - 2 * DAY_MS),
    },
    {
      databaseId: prodLedger.id,
      ownerUid: DEMO_USER.uid,
      enabled: true,
      minHealthScore: 90,
      cooldownMinutes: 10,
      lastEvaluatedScore: 100,
      lastBreachAt: null,
      lastAutoReinspectAt: null,
      autoReinspectCount: 0,
      updatedAt: new Date(now - 5 * DAY_MS),
    },
    {
      databaseId: stagingOrders.id,
      ownerUid: DEMO_USER.uid,
      enabled: true,
      minHealthScore: 80,
      cooldownMinutes: 15,
      lastEvaluatedScore: 57,
      lastBreachAt: new Date(now - 5 * HOUR_MS),
      lastAutoReinspectAt: new Date(now - 4 * 60_000),
      autoReinspectCount: 2,
      updatedAt: new Date(now - 1 * DAY_MS),
    },
    {
      databaseId: devAnalytics.id,
      ownerUid: DEMO_USER.uid,
      enabled: false,
      minHealthScore: 75,
      cooldownMinutes: 30,
      lastEvaluatedScore: 100,
      lastBreachAt: null,
      lastAutoReinspectAt: null,
      autoReinspectCount: 0,
      updatedAt: new Date(now - 6 * DAY_MS),
    },
  ]);

  // 13. Activity Audit Logs
  await db.insert(auditLogs).values([
    {
      ownerUid: DEMO_USER.uid,
      actorEmail: 'system:auto-reinspect',
      action: 'AUTO_REINSPECT_TRIGGERED',
      entityType: 'database',
      entityLabel: 'prod-billing-pg',
      summary:
        'Health score 35/100 breached custom threshold (< 85/100). Triggered automatic verification re-inspection (cooldown 10m).',
      createdAt: new Date(now - 42 * 60_000),
    },
    {
      ownerUid: DEMO_USER.uid,
      actorEmail: 'ci:GitHub Actions — Production Deploy',
      action: 'INSPECTION_RUN',
      entityType: 'database',
      entityLabel: 'prod-billing-pg',
      summary:
        'Scanned 4 tables / 17 columns in 44ms · Score: 35/100 · Status: DRIFT · 1 new alert(s).',
      createdAt: new Date(now - 3 * HOUR_MS - 18 * 60_000),
    },
    {
      ownerUid: DEMO_USER.uid,
      actorEmail: DEMO_USER.email,
      action: 'MIGRATION_CHECKED',
      entityType: 'migration',
      entityLabel: '20261124_add_invoice_tax_code.sql',
      summary:
        'Pre-flight migration lint returned BLOCKED (2 findings: NOT NULL without DEFAULT, missing lock_timeout).',
      createdAt: new Date(now - 6 * HOUR_MS),
    },
    {
      ownerUid: DEMO_USER.uid,
      actorEmail: 'system:auto-reinspect',
      action: 'AUTO_REINSPECT_TRIGGERED',
      entityType: 'database',
      entityLabel: 'staging-orders-pg',
      summary:
        'Health score 57/100 breached custom threshold (< 80/100). Triggered automatic verification re-inspection (cooldown 15m).',
      createdAt: new Date(now - 5 * HOUR_MS),
    },
    {
      ownerUid: DEMO_USER.uid,
      actorEmail: DEMO_USER.email,
      action: 'TARGET_THRESHOLD_UPDATED',
      entityType: 'database',
      entityLabel: 'prod-billing-pg',
      summary:
        'Enabled auto re-inspection when health score drops below 85/100 (cooldown: 10m).',
      createdAt: new Date(now - 2 * DAY_MS),
    },
    {
      ownerUid: DEMO_USER.uid,
      actorEmail: DEMO_USER.email,
      action: 'BASELINE_CAPTURED',
      entityType: 'database',
      entityLabel: 'prod-billing-pg',
      summary: `Promoted canonical SHA-256 baseline ${baselineHash.slice(0, 12)} (commit a9f4c21 · 4 tables / 15 columns).`,
      createdAt: new Date(now - 3 * DAY_MS),
    },
  ]);
}
