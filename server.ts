import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import {
  CAPACITY_BLOAT_METRICS_QUERY,
  CATALOG_COLUMN_QUERY,
  DATABASE_HEALTH_SUMMARY_QUERY,
  INDEX_BLOAT_QUERY,
  RECURSIVE_LOCK_TREE_QUERY,
  TABLE_HEALTH_QUERY,
  TOP_EXPENSIVE_QUERIES_QUERY,
  UNUSED_INDEXES_QUERY,
} from './src/server/inspector.ts';
import {
  bulkDeleteMonitoredDatabases,
  bulkInspectDatabases,
  captureSchemaBaseline,
  createMonitoredDatabase,
  createWebhook,
  deleteMonitoredDatabase,
  deleteWebhook,
  getDatabaseDetail,
  inspectAllActiveDatabases,
  listIncidents,
  listMonitoredDatabases,
  listWebhooks,
  restoreHistoricalBaseline,
  runDatabaseInspection,
  runTelemetryDrill,
  sendTestWebhookChannel,
  toggleWebhook,
  updateIncidentStatus,
  updateMonitoredDatabase,
} from './src/server/monitorService.ts';
import {
  authenticateApiKey,
  compareEnvironments,
  compareHistoricalBaselines,
  createApiKey,
  deleteApiKey,
  deleteMigrationCheck,
  getCapacityPlanning,
  getLiveLockContention,
  getQueryPerformance,
  getWorkspaceSettings,
  listApiKeys,
  listAuditLogs,
  listMigrationChecks,
  runAndSaveMigrationCheck,
  updateWorkspaceSettings,
} from './src/server/extendedService.ts';
import { generateDatabaseHealthReportPdf } from './src/server/healthReport.ts';
import {
  getHealthTrends,
  promoteTrendAlertToIncident,
} from './src/server/healthTrends.ts';
import { getDatabaseEventTimeline } from './src/server/eventTimeline.ts';
import { getPerformanceTrends } from './src/server/performanceTrends.ts';
import {
  analyzeQueryPlanWithExplain,
  getIndexAdvisorReport,
} from './src/server/indexAdvisor.ts';
import { getDashboardActivityHeatmap } from './src/server/activityHeatmap.ts';
import {
  evaluateOwnerHealthThresholds,
  listTargetHealthThresholds,
  startHealthThresholdWatcher,
  upsertTargetHealthThreshold,
} from './src/server/healthThresholdService.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const uuidParam = z.string().uuid();

const createDatabaseSchema = z.object({
  name: z.string().trim().min(2).max(64),
  environment: z.enum(['production', 'staging', 'development']),
  connectionMode: z.enum(['external', 'workspace_pg']),
  connectionUrl: z.string().trim().max(1024).optional(),
  pollIntervalSeconds: z.coerce.number().int().min(15).max(86400).default(60),
  gitCommitSha: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{7,40}$/, 'Commit SHA must be 7 to 40 hex characters')
    .optional()
    .or(z.literal('')),
  autoCaptureBaseline: z.boolean().optional().default(true),
});

const updateDatabaseSchema = z.object({
  name: z.string().trim().min(2).max(64).optional(),
  isActive: z.boolean().optional(),
  pollIntervalSeconds: z.coerce.number().int().min(15).max(86400).optional(),
  connectionUrl: z.string().trim().min(10).max(1024).optional(),
});

const bulkDatabaseIdsSchema = z.object({
  databaseIds: z
    .array(z.string().uuid())
    .min(1, 'Select at least one target database.')
    .max(50, 'Cannot process more than 50 targets at once.'),
});

const columnCatalogRowSchema = z.object({
  table_schema: z.string().min(1).max(128),
  table_name: z.string().min(1).max(128),
  column_name: z.string().min(1).max(128),
  ordinal_position: z.number().int().optional(),
  column_default: z.string().nullable(),
  is_nullable: z.enum(['YES', 'NO']),
  data_type: z.string().min(1).max(128),
  udt_name: z.string().optional(),
});

const captureBaselineSchema = z.object({
  gitCommitSha: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{7,40}$/, 'Commit SHA must be 7 to 40 hex characters')
    .optional()
    .or(z.literal('')),
  customCatalog: z.array(columnCatalogRowSchema).max(5000).optional(),
});

const drillSchema = z.object({
  scenario: z.enum(['drift', 'lock', 'bloat']),
});

const updateIncidentSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
});

const createWebhookSchema = z.object({
  name: z.string().trim().min(2).max(64),
  provider: z.enum(['slack', 'discord', 'webhook']),
  webhookUrl: z.string().trim().url().max(1024),
  minSeverity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('WARNING'),
});

const toggleWebhookSchema = z.object({
  isActive: z.boolean(),
});

const compareEnvironmentsSchema = z.object({
  sourceDatabaseId: z.string().uuid(),
  targetDatabaseId: z.string().uuid(),
});

const migrationAnalyzeSchema = z.object({
  title: z.string().trim().min(2).max(120),
  sqlText: z.string().trim().min(5).max(50000),
  databaseId: z.string().uuid().optional().or(z.literal('')),
});

const workspaceSettingsSchema = z.object({
  lockThresholdSeconds: z.coerce.number().int().min(3).max(600),
  bloatMbThreshold: z.coerce.number().int().min(1).max(10000),
  bloatPctThreshold: z.coerce.number().int().min(5).max(99),
  deadTuplePctThreshold: z.coerce.number().int().min(5).max(95),
  cacheHitMinPct: z.coerce.number().int().min(50).max(100),
  connSaturationPct: z.coerce.number().int().min(20).max(100),
});

const targetHealthThresholdSchema = z.object({
  enabled: z.boolean(),
  minHealthScore: z.coerce.number().int().min(10).max(99),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440),
  evaluateImmediately: z.boolean().optional().default(true),
});

const evaluateThresholdsSchema = z.object({
  databaseId: z.string().uuid().optional(),
});

const createApiKeySchema = z.object({
  name: z.string().trim().min(2).max(64),
});

const ciDriftGateSchema = z.object({
  databaseId: z.string().uuid(),
  promoteBaseline: z.boolean().optional().default(false),
  gitCommitSha: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{7,40}$/)
    .optional(),
});

const promoteTrendAlertSchema = z.object({
  databaseId: z.string().uuid(),
  incidentType: z.enum(['VACUUM_HEALTH', 'INDEX_BLOAT']),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  fingerprint: z.string().trim().min(8).max(64),
  summary: z.string().trim().min(5).max(400),
  schemaname: z.string().trim().min(1).max(128),
  tablename: z.string().trim().min(1).max(128),
  indexname: z.string().trim().max(128).optional(),
  n_live_tup: z.number().nonnegative().optional(),
  n_dead_tup: z.number().nonnegative().optional(),
  dead_tuple_pct: z.number().min(0).max(100).optional(),
  index_bytes: z.number().nonnegative().optional(),
  index_size_pretty: z.string().trim().max(48).optional(),
  estimated_bloat_pct: z.number().min(0).max(100).optional(),
});

const explainQueryPlanSchema = z.object({
  databaseId: z.string().uuid().optional().or(z.literal('')),
  sql: z.string().trim().min(6).max(4000),
});

function getActorEmail(req: AuthRequest): string {
  return req.user?.email ?? `${req.user?.uid ?? 'unknown'}@users.local`;
}

// Public health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// CI/CD Machine-to-Machine Drift Gate (API Key auth via X-DriftGuard-Key)
app.post('/api/ci/check-drift', async (req, res) => {
  const apiKeyHeader = req.header('x-driftguard-key');
  if (!apiKeyHeader) {
    res.status(401).json({ error: 'Missing X-DriftGuard-Key header.' });
    return;
  }

  const keyInfo = await authenticateApiKey(apiKeyHeader);
  if (!keyInfo) {
    res.status(401).json({ error: 'Invalid or revoked DriftGuard API key.' });
    return;
  }

  const parsed = ciDriftGateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'Invalid CI gate payload.',
    });
    return;
  }

  try {
    if (parsed.data.promoteBaseline) {
      const baseline = await captureSchemaBaseline(
        keyInfo.ownerUid,
        `ci:${keyInfo.keyName}`,
        parsed.data.databaseId,
        parsed.data.gitCommitSha
      );
      res.json({
        pass: true,
        action: 'baseline_promoted',
        schemaHash: baseline.schemaHash,
        gitCommitSha: baseline.gitCommitSha,
        columnCount: baseline.tablesJson.length,
      });
      return;
    }

    const result = await runDatabaseInspection(
      keyInfo.ownerUid,
      parsed.data.databaseId,
      `ci:${keyInfo.keyName}`
    );
    const pass = result.healthStatus !== 'DRIFT' && result.diffs.length === 0;
    res.status(pass ? 200 : 409).json({
      pass,
      healthStatus: result.healthStatus,
      schemaHash: result.snapshot.schemaHash,
      tableCount: result.snapshot.tableCount,
      columnCount: result.snapshot.columnCount,
      diffCount: result.diffs.length,
      diffs: result.diffs,
    });
  } catch (error) {
    res.status(400).json({
      pass: false,
      error: error instanceof Error ? error.message : 'CI drift gate failed.',
    });
  }
});

// 24-Hour Dashboard Target Activity & Error Rate Heat Map
app.get(
  '/api/dashboard/activity-heatmap',
  requireAuth,
  async (req: AuthRequest, res) => {
    const tzRaw =
      typeof req.query.tzOffsetMinutes === 'string'
        ? Number(req.query.tzOffsetMinutes)
        : undefined;
    const tzOffsetMinutes =
      tzRaw !== undefined && Number.isFinite(tzRaw) ? tzRaw : 0;

    try {
      const heatmap = await getDashboardActivityHeatmap(
        req.user!.uid,
        tzOffsetMinutes
      );
      res.json(heatmap);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load 24-hour activity heat map.',
      });
    }
  }
);

// SQL telemetry reference suite
app.get('/api/telemetry-suite', requireAuth, (_req, res) => {
  res.json({
    provisioningSql: `CREATE USER drift_monitor WITH PASSWORD 'strong_password';\nGRANT CONNECT ON DATABASE production TO drift_monitor;\nGRANT pg_read_all_stats TO drift_monitor; -- For pg_stat_activity, pg_stat_statements & lock monitoring`,
    catalogQuery: CATALOG_COLUMN_QUERY.trim(),
    lockTreeQuery: RECURSIVE_LOCK_TREE_QUERY.trim(),
    indexBloatQuery: INDEX_BLOAT_QUERY.trim(),
    tableHealthQuery: TABLE_HEALTH_QUERY.trim(),
    unusedIndexesQuery: UNUSED_INDEXES_QUERY.trim(),
    databaseHealthQuery: DATABASE_HEALTH_SUMMARY_QUERY.trim(),
    topExpensiveQueriesQuery: TOP_EXPENSIVE_QUERIES_QUERY.trim(),
    capacityBloatQuery: CAPACITY_BLOAT_METRICS_QUERY.trim(),
  });
});

// Live pg_stat_statements Top-5 Expensive Queries by Average Latency
app.get(
  '/api/telemetry-suite/performance',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbParam =
      typeof req.query.databaseId === 'string' && req.query.databaseId.trim()
        ? req.query.databaseId.trim()
        : undefined;

    if (dbParam && !uuidParam.safeParse(dbParam).success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      const performance = await getQueryPerformance(req.user!.uid, dbParam);
      res.json(performance);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load query performance stats.',
      });
    }
  }
);

// 30-Day Query Latency Performance Trends vs. Historical Baselines
app.get(
  '/api/telemetry-suite/performance-trends',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbParam =
      typeof req.query.databaseId === 'string' && req.query.databaseId.trim()
        ? req.query.databaseId.trim()
        : undefined;

    if (dbParam && !uuidParam.safeParse(dbParam).success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    const daysRaw =
      typeof req.query.days === 'string' ? Number(req.query.days) : undefined;
    const days =
      daysRaw !== undefined && Number.isFinite(daysRaw) ? daysRaw : 30;
    const captureLive = req.query.capture === 'true';

    try {
      const trends = await getPerformanceTrends(req.user!.uid, {
        databaseId: dbParam,
        days,
        captureLive,
      });
      res.json(trends);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load query performance trends.',
      });
    }
  }
);

// Index Advisor: Sequential-Scan Hotspots & Missing/Composite Index Recommendations
app.get(
  '/api/telemetry-suite/index-advisor',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbParam =
      typeof req.query.databaseId === 'string' && req.query.databaseId.trim()
        ? req.query.databaseId.trim()
        : undefined;

    if (dbParam && !uuidParam.safeParse(dbParam).success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      const report = await getIndexAdvisorReport(req.user!.uid, dbParam);
      res.json(report);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to run Index Advisor analysis.',
      });
    }
  }
);

// Index Advisor: Safe Read-Only EXPLAIN (FORMAT JSON) Query Plan Analyzer
app.post(
  '/api/telemetry-suite/index-advisor/explain',
  requireAuth,
  async (req: AuthRequest, res) => {
    const parsed = explainQueryPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Please provide a valid read-only SELECT query to analyze.',
      });
      return;
    }

    try {
      const analysis = await analyzeQueryPlanWithExplain(
        req.user!.uid,
        parsed.data.sql,
        parsed.data.databaseId || undefined
      );
      res.json(analysis);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to analyze PostgreSQL query plan.',
      });
    }
  }
);

// Live Real-Time Lock Contention Hierarchy (pg_locks + pg_stat_activity)
app.get(
  '/api/telemetry-suite/locks',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbParam =
      typeof req.query.databaseId === 'string' && req.query.databaseId.trim()
        ? req.query.databaseId.trim()
        : undefined;

    if (dbParam && !uuidParam.safeParse(dbParam).success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      const contention = await getLiveLockContention(req.user!.uid, dbParam);
      res.json(contention);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to inspect live lock contention.',
      });
    }
  }
);

// Capacity Planning & Storage Bloat Growth Projection
app.get(
  '/api/telemetry-suite/capacity',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbParam =
      typeof req.query.databaseId === 'string' && req.query.databaseId.trim()
        ? req.query.databaseId.trim()
        : undefined;

    if (dbParam && !uuidParam.safeParse(dbParam).success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      const projection = await getCapacityPlanning(req.user!.uid, dbParam);
      res.json(projection);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to calculate storage capacity projection.',
      });
    }
  }
);

// Sliding-Window Health Trends (Vacuum Spikes & Index Bloat Growth)
app.get(
  '/api/telemetry-suite/trends',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbParam =
      typeof req.query.databaseId === 'string' && req.query.databaseId.trim()
        ? req.query.databaseId.trim()
        : undefined;

    if (dbParam && !uuidParam.safeParse(dbParam).success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    const windowSize = req.query.windowSize
      ? Number(req.query.windowSize)
      : undefined;
    const sigmaThreshold = req.query.sigmaThreshold
      ? Number(req.query.sigmaThreshold)
      : undefined;

    try {
      const trends = await getHealthTrends(req.user!.uid, {
        databaseId: dbParam,
        windowSize:
          windowSize !== undefined && Number.isFinite(windowSize)
            ? windowSize
            : undefined,
        sigmaThreshold:
          sigmaThreshold !== undefined && Number.isFinite(sigmaThreshold)
            ? sigmaThreshold
            : undefined,
      });
      res.json(trends);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to analyze health trends.',
      });
    }
  }
);

app.post(
  '/api/telemetry-suite/trends/promote',
  requireAuth,
  async (req: AuthRequest, res) => {
    const parsed = promoteTrendAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ?? 'Invalid suggested alert payload.',
      });
      return;
    }

    try {
      const outcome = await promoteTrendAlertToIncident(
        req.user!.uid,
        getActorEmail(req),
        parsed.data
      );
      res.status(outcome.alreadyExists ? 200 : 201).json(outcome);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to promote suggested alert.',
      });
    }
  }
);

// Monitored Databases
app.get('/api/databases', requireAuth, async (req: AuthRequest, res) => {
  try {
    const data = await listMonitoredDatabases(req.user!.uid);
    res.json({ databases: data });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to load databases',
    });
  }
});

app.post('/api/databases', requireAuth, async (req: AuthRequest, res) => {
  const parsed = createDatabaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ??
        'Invalid target database configuration.',
    });
    return;
  }

  try {
    const created = await createMonitoredDatabase(
      req.user!.uid,
      getActorEmail(req),
      {
        ...parsed.data,
        gitCommitSha: parsed.data.gitCommitSha || undefined,
      }
    );
    res.status(201).json({ database: created });
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create database target.',
    });
  }
});

app.post(
  '/api/databases/inspect-all',
  requireAuth,
  async (req: AuthRequest, res) => {
    try {
      const summary = await inspectAllActiveDatabases(
        req.user!.uid,
        getActorEmail(req)
      );
      res.json(summary);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Fleet inspection failed.',
      });
    }
  }
);

app.post(
  '/api/databases/bulk-inspect',
  requireAuth,
  async (req: AuthRequest, res) => {
    const parsed = bulkDatabaseIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Provide one or more valid database IDs.',
      });
      return;
    }

    try {
      const summary = await bulkInspectDatabases(
        req.user!.uid,
        getActorEmail(req),
        parsed.data.databaseIds
      );
      res.json(summary);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Bulk inspection failed.',
      });
    }
  }
);

app.post(
  '/api/databases/bulk-delete',
  requireAuth,
  async (req: AuthRequest, res) => {
    const parsed = bulkDatabaseIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Provide one or more valid database IDs.',
      });
      return;
    }

    try {
      const outcome = await bulkDeleteMonitoredDatabases(
        req.user!.uid,
        getActorEmail(req),
        parsed.data.databaseIds
      );
      res.json(outcome);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Bulk deletion failed.',
      });
    }
  }
);

app.get('/api/databases/:id', requireAuth, async (req: AuthRequest, res) => {
  const idCheck = uuidParam.safeParse(req.params.id);
  if (!idCheck.success) {
    res.status(400).json({ error: 'Invalid database identifier.' });
    return;
  }

    try {
      const detail = await getDatabaseDetail(req.user!.uid, idCheck.data);
      res.json(detail);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 500;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load target details.',
      });
    }
  }
);

app.get(
  '/api/databases/:id/timeline',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      const timeline = await getDatabaseEventTimeline(
        req.user!.uid,
        idCheck.data
      );
      res.json(timeline);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 500;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load database event timeline.',
      });
    }
  }
);

app.get(
  '/api/databases/:id/health-report',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      const { filename, buffer } = await generateDatabaseHealthReportPdf(
        req.user!.uid,
        getActorEmail(req),
        idCheck.data
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 500;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to generate health report PDF.',
      });
    }
  }
);

app.patch('/api/databases/:id', requireAuth, async (req: AuthRequest, res) => {
  const idCheck = uuidParam.safeParse(req.params.id);
  if (!idCheck.success) {
    res.status(400).json({ error: 'Invalid database identifier.' });
    return;
  }
  const parsed = updateDatabaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'Invalid update payload.',
    });
    return;
  }

  try {
    await updateMonitoredDatabase(
      req.user!.uid,
      idCheck.data,
      parsed.data,
      getActorEmail(req)
    );
    const updated = await listMonitoredDatabases(req.user!.uid);
    res.json({ database: updated.find((d) => d.id === idCheck.data) });
  } catch (error) {
    const status =
      error instanceof Error && error.message === 'Target database not found.'
        ? 404
        : 400;
    res.status(status).json({
      error:
        error instanceof Error ? error.message : 'Failed to update target.',
    });
  }
});

app.delete(
  '/api/databases/:id',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      await deleteMonitoredDatabase(
        req.user!.uid,
        getActorEmail(req),
        idCheck.data
      );
      res.json({ ok: true });
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'Target database not found.'
          ? 404
          : 500;
      res.status(status).json({
        error:
          error instanceof Error ? error.message : 'Failed to delete target.',
      });
    }
  }
);

app.post(
  '/api/databases/:id/inspect',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    try {
      const outcome = await runDatabaseInspection(
        req.user!.uid,
        idCheck.data,
        getActorEmail(req)
      );
      res.json(outcome);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : 'Telemetry inspection failed.',
      });
    }
  }
);

app.post(
  '/api/databases/:id/baselines',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    const parsed = captureBaselineSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid baseline payload.',
      });
      return;
    }

    try {
      const baseline = await captureSchemaBaseline(
        req.user!.uid,
        getActorEmail(req),
        idCheck.data,
        parsed.data.gitCommitSha || undefined,
        parsed.data.customCatalog
      );
      res.status(201).json({ baseline });
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to capture baseline.',
      });
    }
  }
);

app.post(
  '/api/databases/:id/baselines/:baselineId/restore',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbCheck = uuidParam.safeParse(req.params.id);
    const blCheck = uuidParam.safeParse(req.params.baselineId);
    if (!dbCheck.success || !blCheck.success) {
      res.status(400).json({ error: 'Invalid identifier.' });
      return;
    }

    try {
      const baseline = await restoreHistoricalBaseline(
        req.user!.uid,
        getActorEmail(req),
        dbCheck.data,
        blCheck.data
      );
      res.status(201).json({ baseline });
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to restore baseline.',
      });
    }
  }
);

app.get(
  '/api/databases/:id/compare-baselines',
  requireAuth,
  async (req: AuthRequest, res) => {
    const dbCheck = uuidParam.safeParse(req.params.id);
    const fromCheck = uuidParam.safeParse(req.query.from);
    const toCheck = uuidParam.safeParse(req.query.to);
    if (!dbCheck.success || !fromCheck.success || !toCheck.success) {
      res.status(400).json({ error: 'Valid database, from, and to UUIDs are required.' });
      return;
    }

    try {
      const comparison = await compareHistoricalBaselines(
        req.user!.uid,
        dbCheck.data,
        fromCheck.data,
        toCheck.data
      );
      res.json(comparison);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to compare baselines.',
      });
    }
  }
);

app.post(
  '/api/databases/:id/drill',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    const parsed = drillSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Scenario must be drift, lock, or bloat.' });
      return;
    }

    try {
      const incident = await runTelemetryDrill(
        req.user!.uid,
        getActorEmail(req),
        idCheck.data,
        parsed.data.scenario
      );
      res.status(201).json({ incident });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Drill failed.',
      });
    }
  }
);

// Multi-Environment Comparator
app.post('/api/compare', requireAuth, async (req: AuthRequest, res) => {
  const parsed = compareEnvironmentsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Select two valid database targets to compare.',
    });
    return;
  }

  try {
    const result = await compareEnvironments(
      req.user!.uid,
      parsed.data.sourceDatabaseId,
      parsed.data.targetDatabaseId
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : 'Failed to compare environments.',
    });
  }
});

// Pre-Flight SQL Migration Linter
app.get('/api/migrations', requireAuth, async (req: AuthRequest, res) => {
  try {
    const checks = await listMigrationChecks(req.user!.uid);
    res.json({ checks });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : 'Failed to load migration history.',
    });
  }
});

app.post(
  '/api/migrations/analyze',
  requireAuth,
  async (req: AuthRequest, res) => {
    const parsed = migrationAnalyzeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Provide a migration title and SQL script.',
      });
      return;
    }

    try {
      const check = await runAndSaveMigrationCheck(
        req.user!.uid,
        getActorEmail(req),
        {
          title: parsed.data.title,
          sqlText: parsed.data.sqlText,
          databaseId: parsed.data.databaseId || undefined,
        }
      );
      res.status(201).json({ check });
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to analyze migration SQL.',
      });
    }
  }
);

app.delete(
  '/api/migrations/:id',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid migration check identifier.' });
      return;
    }

    try {
      await deleteMigrationCheck(req.user!.uid, idCheck.data);
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({
        error:
          error instanceof Error ? error.message : 'Migration check not found.',
      });
    }
  }
);

// Incidents
app.get('/api/incidents', requireAuth, async (req: AuthRequest, res) => {
  const statusQuery =
    typeof req.query.status === 'string' ? req.query.status : undefined;
  const typeQuery =
    typeof req.query.type === 'string' ? req.query.type : undefined;
  const dbQuery =
    typeof req.query.databaseId === 'string' ? req.query.databaseId : undefined;

  const validStatuses = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
  const validTypes = [
    'SCHEMA_DRIFT',
    'LOCK_CONTENTION',
    'INDEX_BLOAT',
    'VACUUM_HEALTH',
    'CONNECTION_SATURATION',
  ] as const;

  try {
    const incidents = await listIncidents(req.user!.uid, {
      status: validStatuses.includes(
        statusQuery as (typeof validStatuses)[number]
      )
        ? (statusQuery as (typeof validStatuses)[number])
        : undefined,
      incidentType: validTypes.includes(
        typeQuery as (typeof validTypes)[number]
      )
        ? (typeQuery as (typeof validTypes)[number])
        : undefined,
      databaseId:
        dbQuery && uuidParam.safeParse(dbQuery).success ? dbQuery : undefined,
    });
    res.json({ incidents });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : 'Failed to load incidents.',
    });
  }
});

app.patch('/api/incidents/:id', requireAuth, async (req: AuthRequest, res) => {
  const idCheck = uuidParam.safeParse(req.params.id);
  if (!idCheck.success) {
    res.status(400).json({ error: 'Invalid incident identifier.' });
    return;
  }

  const parsed = updateIncidentSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'Status must be OPEN, ACKNOWLEDGED, or RESOLVED.' });
    return;
  }

  try {
    const incident = await updateIncidentStatus(
      req.user!.uid,
      getActorEmail(req),
      idCheck.data,
      parsed.data.status
    );
    res.json({ incident });
  } catch (error) {
    const status =
      error instanceof Error && error.message === 'Incident not found.'
        ? 404
        : 500;
    res.status(status).json({
      error:
        error instanceof Error ? error.message : 'Failed to update incident.',
    });
  }
});

// Alert Webhooks
app.get('/api/webhooks', requireAuth, async (req: AuthRequest, res) => {
  try {
    const webhooks = await listWebhooks(req.user!.uid);
    res.json({ webhooks });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : 'Failed to load webhooks.',
    });
  }
});

app.post('/api/webhooks', requireAuth, async (req: AuthRequest, res) => {
  const parsed = createWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ?? 'Invalid webhook configuration.',
    });
    return;
  }

  try {
    const webhook = await createWebhook(
      req.user!.uid,
      getActorEmail(req),
      parsed.data
    );
    res.status(201).json({ webhook });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to add webhook.',
    });
  }
});

app.patch('/api/webhooks/:id', requireAuth, async (req: AuthRequest, res) => {
  const idCheck = uuidParam.safeParse(req.params.id);
  if (!idCheck.success) {
    res.status(400).json({ error: 'Invalid webhook identifier.' });
    return;
  }
  const parsed = toggleWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid toggle payload.' });
    return;
  }

  try {
    await toggleWebhook(req.user!.uid, idCheck.data, parsed.data.isActive);
    const webhooks = await listWebhooks(req.user!.uid);
    res.json({ webhook: webhooks.find((w) => w.id === idCheck.data) });
  } catch (error) {
    const status =
      error instanceof Error && error.message === 'Webhook channel not found.'
        ? 404
        : 500;
    res.status(status).json({
      error:
        error instanceof Error ? error.message : 'Failed to update webhook.',
    });
  }
});

app.delete('/api/webhooks/:id', requireAuth, async (req: AuthRequest, res) => {
  const idCheck = uuidParam.safeParse(req.params.id);
  if (!idCheck.success) {
    res.status(400).json({ error: 'Invalid webhook identifier.' });
    return;
  }

  try {
    await deleteWebhook(req.user!.uid, getActorEmail(req), idCheck.data);
    res.json({ ok: true });
  } catch (error) {
    const status =
      error instanceof Error && error.message === 'Webhook channel not found.'
        ? 404
        : 500;
    res.status(status).json({
      error:
        error instanceof Error ? error.message : 'Failed to delete webhook.',
    });
  }
});

app.post(
  '/api/webhooks/:id/test',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid webhook identifier.' });
      return;
    }

    try {
      const result = await sendTestWebhookChannel(req.user!.uid, idCheck.data);
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error ? error.message : 'Webhook test failed.',
      });
    }
  }
);

// Workspace Alert Threshold Settings
app.get('/api/settings', requireAuth, async (req: AuthRequest, res) => {
  try {
    const settings = await getWorkspaceSettings(req.user!.uid);
    res.json({ settings });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : 'Failed to load settings.',
    });
  }
});

app.put('/api/settings', requireAuth, async (req: AuthRequest, res) => {
  const parsed = workspaceSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'Invalid threshold values.',
    });
    return;
  }

  try {
    const settings = await updateWorkspaceSettings(
      req.user!.uid,
      getActorEmail(req),
      parsed.data
    );
    res.json({ settings });
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : 'Failed to save settings.',
    });
  }
});

// Per-Target Custom Health Score Thresholds & Auto Re-Inspection
app.get(
  '/api/settings/target-thresholds',
  requireAuth,
  async (req: AuthRequest, res) => {
    try {
      const targets = await listTargetHealthThresholds(req.user!.uid);
      res.json({ targets });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load per-target health score thresholds.',
      });
    }
  }
);

app.post(
  '/api/settings/target-thresholds/evaluate',
  requireAuth,
  async (req: AuthRequest, res) => {
    const parsed = evaluateThresholdsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Invalid threshold evaluation request.',
      });
      return;
    }

    try {
      const evaluation = await evaluateOwnerHealthThresholds(
        req.user!.uid,
        getActorEmail(req),
        runDatabaseInspection,
        { databaseId: parsed.data.databaseId }
      );
      const targets = await listTargetHealthThresholds(req.user!.uid);
      res.json({ evaluation, targets });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to evaluate health score thresholds.',
      });
    }
  }
);

app.put(
  '/api/settings/target-thresholds/:databaseId',
  requireAuth,
  async (req: AuthRequest, res) => {
    const idCheck = uuidParam.safeParse(req.params.databaseId);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Invalid database identifier.' });
      return;
    }

    const parsed = targetHealthThresholdSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Invalid target health score threshold configuration.',
      });
      return;
    }

    try {
      await upsertTargetHealthThreshold(
        req.user!.uid,
        getActorEmail(req),
        idCheck.data,
        {
          enabled: parsed.data.enabled,
          minHealthScore: parsed.data.minHealthScore,
          cooldownMinutes: parsed.data.cooldownMinutes,
        }
      );

      let evaluation = null;
      if (parsed.data.enabled && parsed.data.evaluateImmediately) {
        evaluation = await evaluateOwnerHealthThresholds(
          req.user!.uid,
          getActorEmail(req),
          runDatabaseInspection,
          { databaseId: idCheck.data }
        );
      }

      const targets = await listTargetHealthThresholds(req.user!.uid);
      const target = targets.find((t) => t.databaseId === idCheck.data) ?? null;

      res.json({ target, targets, evaluation });
    } catch (error) {
      const status =
        error instanceof Error &&
        error.message === 'Monitored database not found.'
          ? 404
          : 400;
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to save target health score threshold.',
      });
    }
  }
);

// CI/CD API Keys
app.get('/api/api-keys', requireAuth, async (req: AuthRequest, res) => {
  try {
    const keys = await listApiKeys(req.user!.uid);
    res.json({ keys });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : 'Failed to load API keys.',
    });
  }
});

app.post('/api/api-keys', requireAuth, async (req: AuthRequest, res) => {
  const parsed = createApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'Invalid API key name.',
    });
    return;
  }

  try {
    const created = await createApiKey(
      req.user!.uid,
      getActorEmail(req),
      parsed.data.name
    );
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : 'Failed to create API key.',
    });
  }
});

app.delete('/api/api-keys/:id', requireAuth, async (req: AuthRequest, res) => {
  const idCheck = uuidParam.safeParse(req.params.id);
  if (!idCheck.success) {
    res.status(400).json({ error: 'Invalid API key identifier.' });
    return;
  }

  try {
    await deleteApiKey(req.user!.uid, getActorEmail(req), idCheck.data);
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({
      error: error instanceof Error ? error.message : 'API key not found.',
    });
  }
});

// Activity Audit Log
app.get('/api/audit-logs', requireAuth, async (req: AuthRequest, res) => {
  try {
    const logs = await listAuditLogs(req.user!.uid);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : 'Failed to load audit log.',
    });
  }
});

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`DriftGuard server running on http://0.0.0.0:${port}`);
    startHealthThresholdWatcher(runDatabaseInspection);
  });
}

startServer().catch((error) => {
  console.error('Failed to start DriftGuard server:', error);
  process.exit(1);
});
