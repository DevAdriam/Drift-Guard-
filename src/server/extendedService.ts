import crypto from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  apiKeys,
  auditLogs,
  migrationChecks,
  monitoredDatabases,
  schemaBaselines,
  telemetrySnapshots,
  workspaceSettings,
} from '../db/schema.ts';
import {
  buildVacuumAnalyzeSql,
  formatBytesPretty,
  SchemaInspector,
} from './inspector.ts';
import { decryptSecret, validateSafePostgresUrl } from './crypto.ts';
import {
  analyzeMigrationSql,
  generateSyncSqlFromDiff,
} from './migrationLinter.ts';
import type {
  ApiKeyDto,
  AuditLogDto,
  CapacityHistoryPoint,
  CapacityPlanningResponse,
  ColumnCatalogRow,
  ConnectionMode,
  EnvironmentCompareResult,
  EnvironmentType,
  LiveLockContentionResponse,
  MigrationCheckDto,
  QueryPerformanceResponse,
  TableBloatGrowthRow,
  WorkspaceSettingsDto,
} from '../types/telemetry.ts';

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettingsDto = {
  lockThresholdSeconds: 15,
  bloatMbThreshold: 50,
  bloatPctThreshold: 40,
  deadTuplePctThreshold: 20,
  cacheHitMinPct: 95,
  connSaturationPct: 80,
  updatedAt: null,
};

export async function recordAuditLog(params: {
  ownerUid: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityLabel: string;
  summary: string;
}) {
  try {
    await db.insert(auditLogs).values({
      ownerUid: params.ownerUid,
      actorEmail: params.actorEmail,
      action: params.action,
      entityType: params.entityType,
      entityLabel: params.entityLabel.slice(0, 128),
      summary: params.summary,
    });
  } catch (error) {
    console.error('Failed to record audit log:', error);
  }
}

export async function listAuditLogs(ownerUid: string): Promise<AuditLogDto[]> {
  try {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.ownerUid, ownerUid))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100);

    return rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorEmail,
      action: r.action,
      entityType: r.entityType,
      entityLabel: r.entityLabel,
      summary: r.summary,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (error) {
    console.error('Failed to list audit logs:', error);
    throw new Error('Failed to load activity audit log.', { cause: error });
  }
}

export async function getWorkspaceSettings(
  ownerUid: string
): Promise<WorkspaceSettingsDto> {
  try {
    const rows = await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.ownerUid, ownerUid))
      .limit(1);

    if (!rows.length) {
      return DEFAULT_WORKSPACE_SETTINGS;
    }

    const row = rows[0];
    return {
      lockThresholdSeconds: row.lockThresholdSeconds,
      bloatMbThreshold: row.bloatMbThreshold,
      bloatPctThreshold: row.bloatPctThreshold,
      deadTuplePctThreshold: row.deadTuplePctThreshold,
      cacheHitMinPct: row.cacheHitMinPct,
      connSaturationPct: row.connSaturationPct,
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch (error) {
    console.error('Failed to load workspace settings:', error);
    return DEFAULT_WORKSPACE_SETTINGS;
  }
}

export async function updateWorkspaceSettings(
  ownerUid: string,
  actorEmail: string,
  input: Omit<WorkspaceSettingsDto, 'updatedAt'>
): Promise<WorkspaceSettingsDto> {
  try {
    const [saved] = await db
      .insert(workspaceSettings)
      .values({
        ownerUid,
        lockThresholdSeconds: input.lockThresholdSeconds,
        bloatMbThreshold: input.bloatMbThreshold,
        bloatPctThreshold: input.bloatPctThreshold,
        deadTuplePctThreshold: input.deadTuplePctThreshold,
        cacheHitMinPct: input.cacheHitMinPct,
        connSaturationPct: input.connSaturationPct,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceSettings.ownerUid,
        set: {
          lockThresholdSeconds: input.lockThresholdSeconds,
          bloatMbThreshold: input.bloatMbThreshold,
          bloatPctThreshold: input.bloatPctThreshold,
          deadTuplePctThreshold: input.deadTuplePctThreshold,
          cacheHitMinPct: input.cacheHitMinPct,
          connSaturationPct: input.connSaturationPct,
          updatedAt: new Date(),
        },
      })
      .returning();

    await recordAuditLog({
      ownerUid,
      actorEmail,
      action: 'SETTINGS_UPDATED',
      entityType: 'workspace_settings',
      entityLabel: 'Alert Thresholds',
      summary: `Updated thresholds: lock > ${saved.lockThresholdSeconds}s, bloat > ${saved.bloatMbThreshold}MB & ${saved.bloatPctThreshold}%, dead tuples > ${saved.deadTuplePctThreshold}%, connections > ${saved.connSaturationPct}%.`,
    });

    return {
      lockThresholdSeconds: saved.lockThresholdSeconds,
      bloatMbThreshold: saved.bloatMbThreshold,
      bloatPctThreshold: saved.bloatPctThreshold,
      deadTuplePctThreshold: saved.deadTuplePctThreshold,
      cacheHitMinPct: saved.cacheHitMinPct,
      connSaturationPct: saved.connSaturationPct,
      updatedAt: saved.updatedAt.toISOString(),
    };
  } catch (error) {
    console.error('Failed to update workspace settings:', error);
    throw new Error('Failed to save threshold rules.', { cause: error });
  }
}

export async function listMigrationChecks(
  ownerUid: string
): Promise<MigrationCheckDto[]> {
  try {
    const rows = await db
      .select()
      .from(migrationChecks)
      .where(eq(migrationChecks.ownerUid, ownerUid))
      .orderBy(desc(migrationChecks.createdAt))
      .limit(30);

    return rows.map((r) => ({
      id: r.id,
      databaseId: r.databaseId ?? null,
      title: r.title,
      sqlText: r.sqlText,
      riskLevel: r.riskLevel as 'SAFE' | 'WARNING' | 'BLOCKED',
      findings: r.findingsJson,
      wrappedSafeSql: r.wrappedSafeSql,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (error) {
    console.error('Failed to load migration checks:', error);
    throw new Error('Failed to load migration review history.', {
      cause: error,
    });
  }
}

export async function runAndSaveMigrationCheck(
  ownerUid: string,
  actorEmail: string,
  input: { title: string; sqlText: string; databaseId?: string }
): Promise<MigrationCheckDto> {
  const analysis = analyzeMigrationSql(input.sqlText);

  let validDatabaseId: string | null = null;
  if (input.databaseId) {
    const owned = await db
      .select({ id: monitoredDatabases.id })
      .from(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.id, input.databaseId),
          eq(monitoredDatabases.ownerUid, ownerUid)
        )
      )
      .limit(1);
    if (owned.length > 0) {
      validDatabaseId = owned[0].id;
    }
  }

  try {
    const [created] = await db
      .insert(migrationChecks)
      .values({
        ownerUid,
        databaseId: validDatabaseId,
        title: input.title.trim(),
        sqlText: input.sqlText,
        riskLevel: analysis.riskLevel,
        findingsJson: analysis.findings,
        wrappedSafeSql: analysis.wrappedSafeSql,
      })
      .returning();

    await recordAuditLog({
      ownerUid,
      actorEmail,
      action: 'MIGRATION_LINTED',
      entityType: 'migration_check',
      entityLabel: created.title,
      summary: `Pre-flight SQL safety check completed with verdict ${created.riskLevel} (${analysis.findings.length} finding${analysis.findings.length === 1 ? '' : 's'}).`,
    });

    return {
      id: created.id,
      databaseId: created.databaseId ?? null,
      title: created.title,
      sqlText: created.sqlText,
      riskLevel: created.riskLevel as 'SAFE' | 'WARNING' | 'BLOCKED',
      findings: created.findingsJson,
      wrappedSafeSql: created.wrappedSafeSql,
      createdAt: created.createdAt.toISOString(),
    };
  } catch (error) {
    console.error('Failed to save migration check:', error);
    throw new Error('Failed to save migration analysis.', { cause: error });
  }
}

export async function deleteMigrationCheck(
  ownerUid: string,
  checkId: string
): Promise<void> {
  const deleted = await db
    .delete(migrationChecks)
    .where(
      and(
        eq(migrationChecks.id, checkId),
        eq(migrationChecks.ownerUid, ownerUid)
      )
    )
    .returning({ id: migrationChecks.id });

  if (!deleted.length) {
    throw new Error('Migration check record not found.');
  }
}

async function loadLatestCatalogForTarget(databaseId: string): Promise<{
  catalog: ColumnCatalogRow[];
  schemaHash: string;
  capturedAt: string;
} | null> {
  const snaps = await db
    .select()
    .from(telemetrySnapshots)
    .where(eq(telemetrySnapshots.databaseId, databaseId))
    .orderBy(desc(telemetrySnapshots.inspectedAt))
    .limit(1);

  if (snaps.length > 0) {
    return {
      catalog: snaps[0].catalogJson,
      schemaHash: snaps[0].schemaHash,
      capturedAt: snaps[0].inspectedAt.toISOString(),
    };
  }

  const baselines = await db
    .select()
    .from(schemaBaselines)
    .where(eq(schemaBaselines.databaseId, databaseId))
    .orderBy(desc(schemaBaselines.createdAt))
    .limit(1);

  if (baselines.length > 0) {
    return {
      catalog: baselines[0].tablesJson,
      schemaHash: baselines[0].schemaHash,
      capturedAt: baselines[0].createdAt.toISOString(),
    };
  }

  return null;
}

export async function compareEnvironments(
  ownerUid: string,
  sourceDbId: string,
  targetDbId: string
): Promise<EnvironmentCompareResult> {
  const [sourceRows, targetRows] = await Promise.all([
    db
      .select()
      .from(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.id, sourceDbId),
          eq(monitoredDatabases.ownerUid, ownerUid)
        )
      )
      .limit(1),
    db
      .select()
      .from(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.id, targetDbId),
          eq(monitoredDatabases.ownerUid, ownerUid)
        )
      )
      .limit(1),
  ]);

  if (!sourceRows.length || !targetRows.length) {
    throw new Error('Both selected database targets must exist in your workspace.');
  }

  const sourceDb = sourceRows[0];
  const targetDb = targetRows[0];

  const [sourceSnap, targetSnap] = await Promise.all([
    loadLatestCatalogForTarget(sourceDb.id),
    loadLatestCatalogForTarget(targetDb.id),
  ]);

  if (!sourceSnap || !targetSnap) {
    throw new Error(
      'Both targets need at least one catalog inspection or baseline before comparing.'
    );
  }

  const diffs = SchemaInspector.diffCatalogs(
    targetSnap.catalog,
    sourceSnap.catalog
  );
  const syncSql = generateSyncSqlFromDiff(diffs, sourceDb.name, targetDb.name);

  const countTables = (rows: ColumnCatalogRow[]) =>
    new Set(rows.map((r) => `${r.table_schema}.${r.table_name}`)).size;

  return {
    source: {
      id: sourceDb.id,
      name: sourceDb.name,
      environment: sourceDb.environment as EnvironmentType,
      schemaHash: sourceSnap.schemaHash,
      tableCount: countTables(sourceSnap.catalog),
      columnCount: sourceSnap.catalog.length,
      capturedAt: sourceSnap.capturedAt,
    },
    target: {
      id: targetDb.id,
      name: targetDb.name,
      environment: targetDb.environment as EnvironmentType,
      schemaHash: targetSnap.schemaHash,
      tableCount: countTables(targetSnap.catalog),
      columnCount: targetSnap.catalog.length,
      capturedAt: targetSnap.capturedAt,
    },
    identical: sourceSnap.schemaHash === targetSnap.schemaHash,
    addedCount: diffs.filter((d) => d.kind === 'ADDED').length,
    removedCount: diffs.filter((d) => d.kind === 'REMOVED').length,
    modifiedCount: diffs.filter((d) => d.kind === 'MODIFIED').length,
    diffs,
    syncSql,
  };
}

export async function compareHistoricalBaselines(
  ownerUid: string,
  databaseId: string,
  fromBaselineId: string,
  toBaselineId: string
) {
  const owned = await db
    .select()
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.id, databaseId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!owned.length) {
    throw new Error('Target database not found.');
  }

  const [fromRows, toRows] = await Promise.all([
    db
      .select()
      .from(schemaBaselines)
      .where(
        and(
          eq(schemaBaselines.id, fromBaselineId),
          eq(schemaBaselines.databaseId, databaseId)
        )
      )
      .limit(1),
    db
      .select()
      .from(schemaBaselines)
      .where(
        and(
          eq(schemaBaselines.id, toBaselineId),
          eq(schemaBaselines.databaseId, databaseId)
        )
      )
      .limit(1),
  ]);

  if (!fromRows.length || !toRows.length) {
    throw new Error('Selected baselines were not found for this target.');
  }

  const diffs = SchemaInspector.diffCatalogs(
    fromRows[0].tablesJson,
    toRows[0].tablesJson
  );
  const syncSql = generateSyncSqlFromDiff(
    diffs,
    `baseline ${toRows[0].schemaHash.slice(0, 8)}`,
    `baseline ${fromRows[0].schemaHash.slice(0, 8)}`
  );

  return {
    fromHash: fromRows[0].schemaHash,
    toHash: toRows[0].schemaHash,
    diffs,
    syncSql,
  };
}

export async function listApiKeys(ownerUid: string): Promise<ApiKeyDto[]> {
  try {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.ownerUid, ownerUid))
      .orderBy(desc(apiKeys.createdAt));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (error) {
    console.error('Failed to list API keys:', error);
    throw new Error('Failed to load CI/CD API keys.', { cause: error });
  }
}

export async function createApiKey(
  ownerUid: string,
  actorEmail: string,
  name: string
): Promise<{ key: ApiKeyDto; plaintextKey: string }> {
  const randomSecret = crypto.randomBytes(24).toString('hex');
  const plaintextKey = `dg_live_${randomSecret}`;
  const keyPrefix = plaintextKey.slice(0, 14);
  const keyHash = crypto
    .createHash('sha256')
    .update(plaintextKey)
    .digest('hex');

  try {
    const [created] = await db
      .insert(apiKeys)
      .values({
        ownerUid,
        name: name.trim(),
        keyPrefix,
        keyHash,
      })
      .returning();

    await recordAuditLog({
      ownerUid,
      actorEmail,
      action: 'API_KEY_CREATED',
      entityType: 'api_key',
      entityLabel: created.name,
      summary: `Created CI/CD API key "${created.name}" (${created.keyPrefix}…).`,
    });

    return {
      plaintextKey,
      key: {
        id: created.id,
        name: created.name,
        keyPrefix: created.keyPrefix,
        lastUsedAt: null,
        createdAt: created.createdAt.toISOString(),
      },
    };
  } catch (error) {
    console.error('Failed to create API key:', error);
    throw new Error('Failed to create CI/CD API key.', { cause: error });
  }
}

export async function deleteApiKey(
  ownerUid: string,
  actorEmail: string,
  keyId: string
): Promise<void> {
  const deleted = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.ownerUid, ownerUid)))
    .returning();

  if (!deleted.length) {
    throw new Error('API key not found.');
  }

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'API_KEY_REVOKED',
    entityType: 'api_key',
    entityLabel: deleted[0].name,
    summary: `Revoked CI/CD API key "${deleted[0].name}" (${deleted[0].keyPrefix}…).`,
  });
}

export async function authenticateApiKey(
  rawKey: string
): Promise<{ ownerUid: string; keyId: string; keyName: string } | null> {
  const trimmed = rawKey.trim();
  if (!trimmed.startsWith('dg_live_') || trimmed.length < 24) {
    return null;
  }

  const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  if (!rows.length) {
    return null;
  }

  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, rows[0].id))
    .catch(() => undefined);

  return {
    ownerUid: rows[0].ownerUid,
    keyId: rows[0].id,
    keyName: rows[0].name,
  };
}

export async function getQueryPerformance(
  ownerUid: string,
  databaseId?: string
): Promise<QueryPerformanceResponse> {
  const enableExtensionSql = `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\nGRANT pg_read_all_stats TO drift_monitor;`;

  if (!databaseId) {
    const result = await SchemaInspector.fetchTopExpensiveQueries('workspace_pg');
    return {
      targetLabel: 'Workspace PostgreSQL (Live)',
      databaseId: null,
      extensionAvailable: result.extensionAvailable,
      collectedAt: new Date().toISOString(),
      queries: result.queries,
      unavailableReason: result.unavailableReason,
      enableExtensionSql: result.extensionAvailable
        ? undefined
        : enableExtensionSql,
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

  const result = await SchemaInspector.fetchTopExpensiveQueries(
    mode,
    connectionUrl
  );

  return {
    targetLabel: `${target.name} (${target.environment})`,
    databaseId: target.id,
    extensionAvailable: result.extensionAvailable,
    collectedAt: new Date().toISOString(),
    queries: result.queries,
    unavailableReason: result.unavailableReason,
    enableExtensionSql: result.extensionAvailable
      ? undefined
      : enableExtensionSql,
  };
}

export async function getLiveLockContention(
  ownerUid: string,
  databaseId?: string
): Promise<LiveLockContentionResponse> {
  const summarize = (
    targetLabel: string,
    dbId: string | null,
    res: { edges: LiveLockContentionResponse['edges']; permissionWarning?: string }
  ): LiveLockContentionResponse => {
    const blockedSet = new Set(res.edges.map((e) => e.blocked_pid));
    const blockerSet = new Set(res.edges.map((e) => e.blocking_pid));
    const rootBlockers = Array.from(blockerSet).filter(
      (pid) => !blockedSet.has(pid)
    );
    const maxWaitSeconds = res.edges.reduce(
      (max, e) => Math.max(max, e.wait_duration_seconds),
      0
    );

    return {
      targetLabel,
      databaseId: dbId,
      collectedAt: new Date().toISOString(),
      edges: res.edges,
      totalBlockedPids: blockedSet.size,
      rootBlockerCount:
        rootBlockers.length > 0
          ? rootBlockers.length
          : blockerSet.size > 0
            ? 1
            : 0,
      maxWaitSeconds,
      permissionWarning: res.permissionWarning,
    };
  };

  if (!databaseId) {
    const result = await SchemaInspector.fetchLiveLockContention('workspace_pg');
    return summarize('Workspace PostgreSQL (Live)', null, result);
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

  const result = await SchemaInspector.fetchLiveLockContention(
    mode,
    connectionUrl
  );

  return summarize(`${target.name} (${target.environment})`, target.id, result);
}

function chooseDefaultMaxCapacityGb(currentBytes: number): number {
  const currentGb = currentBytes / (1024 ** 3);
  if (currentGb < 0.4) return 1;
  if (currentGb < 4) return 10;
  if (currentGb < 20) return 50;
  if (currentGb < 60) return 100;
  if (currentGb < 250) return 500;
  if (currentGb < 600) return 1000;
  return Math.ceil((currentGb * 2) / 500) * 500;
}

function computeLinearSlopeBytesPerDay(
  points: { timeMs: number; value: number }[]
): number | null {
  if (points.length < 2) return null;
  const t0 = points[0].timeMs;
  const xs = points.map((p) => (p.timeMs - t0) / 86_400_000);
  const spanDays = xs[xs.length - 1] - xs[0];
  if (spanDays < 0.005) return null; // < ~7 minutes span too noisy

  const n = points.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = points.reduce((a, p) => a + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (points[i].value - meanY);
    den += dx * dx;
  }
  if (den <= 0) return null;
  return num / den;
}

export async function getCapacityPlanning(
  ownerUid: string,
  databaseId?: string
): Promise<CapacityPlanningResponse> {
  let targetLabel = 'Workspace PostgreSQL (Live)';
  let resolvedDbId: string | null = null;
  let mode: ConnectionMode = 'workspace_pg';
  let connectionUrl: string | undefined;

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
    resolvedDbId = target.id;
    targetLabel = `${target.name} (${target.environment})`;
    mode = target.connectionMode as ConnectionMode;

    if (mode === 'external') {
      if (!target.connectionUrlEncrypted) {
        throw new Error('Target database connection string is not configured.');
      }
      connectionUrl = decryptSecret(target.connectionUrlEncrypted);
      await validateSafePostgresUrl(connectionUrl);
    }
  } else {
    // Check if workspace_pg is already registered by this user so we can reuse its historical snapshots
    const wsRows = await db
      .select({ id: monitoredDatabases.id })
      .from(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.ownerUid, ownerUid),
          eq(monitoredDatabases.connectionMode, 'workspace_pg')
        )
      )
      .limit(1);
    if (wsRows.length > 0) {
      resolvedDbId = wsRows[0].id;
    }
  }

  const liveMetrics = await SchemaInspector.fetchCapacityMetrics(
    mode,
    connectionUrl
  );

  // Load historical telemetry snapshots if available for this database
  const historyPoints: CapacityHistoryPoint[] = [];
  if (resolvedDbId) {
    const snaps = await db
      .select({
        inspectedAt: telemetrySnapshots.inspectedAt,
        healthJson: telemetrySnapshots.healthJson,
      })
      .from(telemetrySnapshots)
      .where(eq(telemetrySnapshots.databaseId, resolvedDbId))
      .orderBy(asc(telemetrySnapshots.inspectedAt))
      .limit(40);

    for (const snap of snaps) {
      const h = snap.healthJson;
      if (!h || !h.database_size_bytes) continue;
      const snapBloat = (h.table_health ?? []).reduce((sum, t) => {
        const ratio = Math.min(1, Math.max(0, (t.dead_tuple_pct ?? 0) / 100));
        return sum + Math.round((t.total_bytes ?? 0) * ratio);
      }, 0);
      historyPoints.push({
        timestamp: snap.inspectedAt.toISOString(),
        usedBytes: h.database_size_bytes,
        bloatBytes: snapBloat,
      });
    }
  }

  // Compute per-table bloat & daily growth rates from live pg_stat_user_tables turnover
  const statsDays = Math.max(0.04, liveMetrics.statsWindowDays);
  const rawTables = liveMetrics.tables.map((t) => {
    const totalTuples = t.n_live_tup + t.n_dead_tup;
    const avgTupleBytes =
      totalTuples > 0
        ? Math.max(64, Math.min(16384, Math.round(t.table_bytes / totalTuples)))
        : 160;
    const indexMultiplier =
      1 + Math.min(1.5, t.index_bytes / Math.max(t.table_bytes, 1));
    const deadRatio =
      totalTuples > 0 ? Math.min(1, t.n_dead_tup / totalTuples) : 0;
    const estimatedBloatBytes = Math.round(
      t.table_bytes * deadRatio + t.index_bytes * deadRatio * 0.65
    );

    // Recurring daily bloat from current dead tuple retention + update/delete churn
    const churnBytesPerDay =
      ((t.n_tup_upd + t.n_tup_del) *
        avgTupleBytes *
        Math.max(deadRatio, 0.08) *
        indexMultiplier) /
      statsDays;
    const retainedBloatPerDay = estimatedBloatBytes / statsDays;
    const dailyBloatBytes = Math.round(
      Math.max(retainedBloatPerDay, churnBytesPerDay * 0.45)
    );

    // Organic net row growth per day
    const netInserts = Math.max(0, t.n_tup_ins - t.n_tup_del);
    const organicBytesPerDay = Math.round(
      (netInserts * avgTupleBytes * indexMultiplier) / statsDays
    );

    const dailyGrowthBytes = organicBytesPerDay + dailyBloatBytes;

    return {
      ...t,
      estimated_bloat_bytes: estimatedBloatBytes,
      estimated_bloat_pretty: formatBytesPretty(estimatedBloatBytes),
      daily_bloat_bytes: dailyBloatBytes,
      daily_growth_bytes: dailyGrowthBytes,
      remediation_sql: buildVacuumAnalyzeSql(t.schemaname, t.relname),
    };
  });

  const totalEstimatedBloatBytes = rawTables.reduce(
    (sum, t) => sum + t.estimated_bloat_bytes,
    0
  );
  const statDailyGrowthBytes = rawTables.reduce(
    (sum, t) => sum + t.daily_growth_bytes,
    0
  );
  const statDailyBloatBytes = rawTables.reduce(
    (sum, t) => sum + t.daily_bloat_bytes,
    0
  );

  // Calibrate against historical snapshots when >= 2 snapshots span measurable elapsed time
  const historicalGrowthSlope = computeLinearSlopeBytesPerDay(
    historyPoints.map((p) => ({
      timeMs: new Date(p.timestamp).getTime(),
      value: p.usedBytes,
    }))
  );
  const historicalBloatSlope = computeLinearSlopeBytesPerDay(
    historyPoints.map((p) => ({
      timeMs: new Date(p.timestamp).getTime(),
      value: p.bloatBytes,
    }))
  );

  const useHistorical =
    historicalGrowthSlope !== null && historicalGrowthSlope > 1024;

  const dailyGrowthBytes = Math.round(
    useHistorical
      ? historicalGrowthSlope!
      : Math.max(statDailyGrowthBytes, 0)
  );
  const dailyBloatBytes = Math.round(
    useHistorical && historicalBloatSlope !== null && historicalBloatSlope > 0
      ? Math.min(dailyGrowthBytes, historicalBloatSlope)
      : Math.min(dailyGrowthBytes, statDailyBloatBytes)
  );

  const mitigatedDailyGrowthBytes = Math.max(
    0,
    Math.round(dailyGrowthBytes - dailyBloatBytes * 0.75)
  );

  const sumTableGrowth = rawTables.reduce(
    (sum, t) => sum + t.daily_growth_bytes,
    0
  );

  const topTables: TableBloatGrowthRow[] = rawTables
    .sort((a, b) => b.daily_growth_bytes - a.daily_growth_bytes || b.total_bytes - a.total_bytes)
    .slice(0, 12)
    .map((t) => ({
      ...t,
      growth_share_pct:
        sumTableGrowth > 0
          ? Math.round((t.daily_growth_bytes / sumTableGrowth) * 1000) / 10
          : 0,
    }));

  const currentDbBytes = liveMetrics.dbTotalBytes;
  const bloatRatioPct =
    currentDbBytes > 0
      ? Math.round((totalEstimatedBloatBytes / currentDbBytes) * 1000) / 10
      : 0;

  // Append current live reading as final history point if snapshots exist
  const finalHistory = [...historyPoints];
  const nowIso = new Date().toISOString();
  if (
    finalHistory.length === 0 ||
    Date.now() - new Date(finalHistory[finalHistory.length - 1].timestamp).getTime() >
      30_000
  ) {
    finalHistory.push({
      timestamp: nowIso,
      usedBytes: currentDbBytes,
      bloatBytes: totalEstimatedBloatBytes,
    });
  }

  return {
    targetLabel,
    databaseId: databaseId ?? null,
    collectedAt: nowIso,
    dataSource: useHistorical
      ? 'historical_snapshots'
      : 'pg_stat_bloat_velocity',
    snapshotCount: historyPoints.length,
    statsWindowDays: Math.round(statsDays * 100) / 100,
    currentDbBytes,
    currentDbPretty: liveMetrics.dbTotalPretty,
    estimatedBloatBytes: totalEstimatedBloatBytes,
    estimatedBloatPretty: formatBytesPretty(totalEstimatedBloatBytes),
    bloatRatioPct,
    defaultMaxCapacityGb: chooseDefaultMaxCapacityGb(currentDbBytes),
    dailyGrowthBytes,
    dailyBloatBytes,
    mitigatedDailyGrowthBytes,
    monthlyGrowthBytes: Math.round(dailyGrowthBytes * 30.4375),
    historyPoints: finalHistory,
    topTables,
  };
}



