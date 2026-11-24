import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  alertWebhooks,
  monitoredDatabases,
  schemaBaselines,
  telemetryIncidents,
  telemetrySnapshots,
} from '../db/schema.ts';
import {
  canDecryptSecret,
  decryptSecret,
  encryptSecret,
  maskPostgresUrl,
  maskWebhookUrl,
  validateSafePostgresUrl,
  validateSafeWebhookUrl,
} from './crypto.ts';
import {
  buildRemediationReindexSql,
  redactSqlQuery,
  SchemaInspector,
} from './inspector.ts';
import {
  dispatchIncidentAlerts,
  sendTestWebhookChannel,
} from './webhookDispatcher.ts';
import {
  getWorkspaceSettings,
  recordAuditLog,
} from './extendedService.ts';
import {
  computeTargetHealthScore,
  handlePostInspectionThresholdCheck,
} from './healthThresholdService.ts';
import { generateSyncSqlFromDiff } from './migrationLinter.ts';
import type {
  AlertWebhookDto,
  ColumnCatalogRow,
  ConnectionMode,
  ConnectionSaturationDetails,
  EnvironmentType,
  HealthStatus,
  HealthTrendDayPoint,
  IncidentDetails,
  IncidentStatus,
  IncidentType,
  IndexBloatDetails,
  LockContentionDetails,
  MonitoredDatabaseDto,
  SchemaBaselineDto,
  SchemaDriftDetails,
  SeverityLevel,
  TelemetryIncidentDto,
  TelemetrySnapshotDto,
  VacuumHealthDetails,
  WebhookProvider,
} from '../types/telemetry.ts';

function countTables(rows: ColumnCatalogRow[]): number {
  return new Set(rows.map((r) => `${r.table_schema}.${r.table_name}`)).size;
}

export async function listMonitoredDatabases(
  ownerUid: string
): Promise<MonitoredDatabaseDto[]> {
  try {
    const dbs = await db
      .select()
      .from(monitoredDatabases)
      .where(eq(monitoredDatabases.ownerUid, ownerUid))
      .orderBy(desc(monitoredDatabases.createdAt));

    if (!dbs.length) return [];

    const dbIds = dbs.map((d) => d.id);

    const DAY_MS = 86_400_000;
    const now = new Date();
    const todayUtcStartMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    );
    const window7dStart = new Date(todayUtcStartMs - 6 * DAY_MS);
    const dayKeys = Array.from({ length: 7 }, (_, i) =>
      new Date(todayUtcStartMs - (6 - i) * DAY_MS).toISOString().slice(0, 10)
    );

    const [baselines, openIncidents, snapshots7d, incidents7d] =
      await Promise.all([
        db
          .select()
          .from(schemaBaselines)
          .where(inArray(schemaBaselines.databaseId, dbIds))
          .orderBy(desc(schemaBaselines.createdAt)),
        db
          .select()
          .from(telemetryIncidents)
          .where(
            and(
              inArray(telemetryIncidents.databaseId, dbIds),
              ne(telemetryIncidents.status, 'RESOLVED')
            )
          ),
        db
          .select({
            databaseId: telemetrySnapshots.databaseId,
            activeLocksCount: telemetrySnapshots.activeLocksCount,
            bloatedIndexesCount: telemetrySnapshots.bloatedIndexesCount,
            inspectedAt: telemetrySnapshots.inspectedAt,
          })
          .from(telemetrySnapshots)
          .where(
            and(
              inArray(telemetrySnapshots.databaseId, dbIds),
              gte(telemetrySnapshots.inspectedAt, window7dStart)
            )
          ),
        db
          .select({
            databaseId: telemetryIncidents.databaseId,
            incidentType: telemetryIncidents.incidentType,
            severity: telemetryIncidents.severity,
            createdAt: telemetryIncidents.createdAt,
          })
          .from(telemetryIncidents)
          .where(
            and(
              inArray(telemetryIncidents.databaseId, dbIds),
              gte(telemetryIncidents.createdAt, window7dStart)
            )
          ),
      ]);

    const latestBaselineMap = new Map<
      string,
      typeof schemaBaselines.$inferSelect
    >();
    for (const b of baselines) {
      if (!latestBaselineMap.has(b.databaseId)) {
        latestBaselineMap.set(b.databaseId, b);
      }
    }

    const openCountMap = new Map<string, number>();
    const criticalCountMap = new Map<string, number>();
    for (const inc of openIncidents) {
      openCountMap.set(
        inc.databaseId,
        (openCountMap.get(inc.databaseId) ?? 0) + 1
      );
      if (inc.severity === 'CRITICAL') {
        criticalCountMap.set(
          inc.databaseId,
          (criticalCountMap.get(inc.databaseId) ?? 0) + 1
        );
      }
    }

    interface DailyHealthAcc {
      inspectionsCount: number;
      maxLocks: number;
      maxBloated: number;
      incidentsCount: number;
      criticalCount: number;
      warningCount: number;
      infoCount: number;
      hasDrift: boolean;
    }

    const trendAccByDb = new Map<string, Map<string, DailyHealthAcc>>();
    for (const d of dbs) {
      const dayMap = new Map<string, DailyHealthAcc>();
      for (const dk of dayKeys) {
        dayMap.set(dk, {
          inspectionsCount: 0,
          maxLocks: 0,
          maxBloated: 0,
          incidentsCount: 0,
          criticalCount: 0,
          warningCount: 0,
          infoCount: 0,
          hasDrift: false,
        });
      }
      trendAccByDb.set(d.id, dayMap);
    }

    for (const snap of snapshots7d) {
      const dk = snap.inspectedAt.toISOString().slice(0, 10);
      const acc = trendAccByDb.get(snap.databaseId)?.get(dk);
      if (!acc) continue;
      acc.inspectionsCount += 1;
      acc.maxLocks = Math.max(acc.maxLocks, snap.activeLocksCount);
      acc.maxBloated = Math.max(acc.maxBloated, snap.bloatedIndexesCount);
    }

    for (const inc of incidents7d) {
      const dk = inc.createdAt.toISOString().slice(0, 10);
      const acc = trendAccByDb.get(inc.databaseId)?.get(dk);
      if (!acc) continue;
      acc.incidentsCount += 1;
      if (inc.incidentType === 'SCHEMA_DRIFT') acc.hasDrift = true;
      if (inc.severity === 'CRITICAL') acc.criticalCount += 1;
      else if (inc.severity === 'WARNING') acc.warningCount += 1;
      else acc.infoCount += 1;
    }

    const buildTrend7d = (
      dbId: string,
      currentStatus: HealthStatus
    ): HealthTrendDayPoint[] => {
      const dayMap = trendAccByDb.get(dbId);
      return dayKeys.map((dateKey, idx) => {
        const acc = dayMap?.get(dateKey);
        const isToday = idx === dayKeys.length - 1;
        const hasActivity =
          !!acc && (acc.inspectionsCount > 0 || acc.incidentsCount > 0);

        if (!hasActivity) {
          if (isToday && currentStatus !== 'PENDING') {
            const fallbackScore =
              currentStatus === 'HEALTHY'
                ? 100
                : currentStatus === 'WARNING'
                  ? 74
                  : currentStatus === 'DRIFT'
                    ? 45
                    : 20;
            return {
              dateKey,
              score: fallbackScore,
              status: currentStatus,
              inspectionsCount: 0,
              incidentsCount: 0,
              criticalCount: 0,
              warningCount: 0,
            };
          }
          return {
            dateKey,
            score: null,
            status: 'PENDING',
            inspectionsCount: 0,
            incidentsCount: 0,
            criticalCount: 0,
            warningCount: 0,
          };
        }

        let score = 100;
        if (acc.hasDrift) score -= 42;
        score -= acc.criticalCount * 26;
        score -= acc.warningCount * 14;
        score -= acc.infoCount * 5;
        if (acc.maxLocks > 0) score -= Math.min(16, acc.maxLocks * 6);
        if (acc.maxBloated > 0) score -= Math.min(12, acc.maxBloated * 3);
        if (isToday && currentStatus === 'ERROR') {
          score = Math.min(score, 22);
        }
        score = Math.max(5, Math.min(100, Math.round(score)));

        let status: HealthStatus = 'HEALTHY';
        if (isToday && currentStatus === 'ERROR') {
          status = 'ERROR';
        } else if (acc.hasDrift) {
          status = 'DRIFT';
        } else if (acc.criticalCount > 0 || score < 50) {
          status = 'ERROR';
        } else if (acc.warningCount > 0 || acc.maxLocks > 0 || score < 85) {
          status = 'WARNING';
        }

        return {
          dateKey,
          score,
          status,
          inspectionsCount: acc.inspectionsCount,
          incidentsCount: acc.incidentsCount,
          criticalCount: acc.criticalCount,
          warningCount: acc.warningCount,
        };
      });
    };

    return dbs.map((d) => {
      const b = latestBaselineMap.get(d.id);
      const currentStatus = d.lastHealthStatus as HealthStatus;
      return {
        id: d.id,
        name: d.name,
        environment: d.environment as EnvironmentType,
        connectionMode: d.connectionMode as ConnectionMode,
        maskedTarget: d.maskedTarget,
        pollIntervalSeconds: d.pollIntervalSeconds,
        isActive: d.isActive,
        lastPolledAt: d.lastPolledAt ? d.lastPolledAt.toISOString() : null,
        lastSchemaHash: d.lastSchemaHash ?? null,
        lastHealthStatus: currentStatus,
        createdAt: d.createdAt.toISOString(),
        latestBaseline: b
          ? {
              id: b.id,
              gitCommitSha: b.gitCommitSha ?? null,
              schemaHash: b.schemaHash,
              columnCount: b.tablesJson.length,
              tableCount: countTables(b.tablesJson),
              createdAt: b.createdAt.toISOString(),
            }
          : null,
        openIncidentsCount: openCountMap.get(d.id) ?? 0,
        criticalIncidentsCount: criticalCountMap.get(d.id) ?? 0,
        credentialsValid:
          d.connectionMode === 'workspace_pg'
            ? true
            : canDecryptSecret(d.connectionUrlEncrypted),
        healthTrend7d: buildTrend7d(d.id, currentStatus),
      };
    });
  } catch (error) {
    console.error('Failed to list monitored databases:', error);
    throw new Error('Failed to load monitored databases.', { cause: error });
  }
}

export interface CreateDatabaseInput {
  name: string;
  environment: EnvironmentType;
  connectionMode: ConnectionMode;
  connectionUrl?: string;
  pollIntervalSeconds: number;
  gitCommitSha?: string;
  autoCaptureBaseline?: boolean;
}

export async function createMonitoredDatabase(
  ownerUid: string,
  actorEmail: string,
  input: CreateDatabaseInput
): Promise<MonitoredDatabaseDto> {
  let encryptedUrl: string;
  let maskedTarget: string;

  if (input.connectionMode === 'workspace_pg') {
    encryptedUrl = encryptSecret('workspace_pg://managed-control-plane');
    maskedTarget =
      'postgresql://drift_monitor:***@managed-cloudsql:5432/app_db';
  } else {
    if (!input.connectionUrl) {
      throw new Error(
        'PostgreSQL connection URI is required for external targets.'
      );
    }
    await validateSafePostgresUrl(input.connectionUrl);
    encryptedUrl = encryptSecret(input.connectionUrl.trim());
    maskedTarget = maskPostgresUrl(input.connectionUrl.trim());
  }

  let created: typeof monitoredDatabases.$inferSelect;
  try {
    const rows = await db
      .insert(monitoredDatabases)
      .values({
        ownerUid,
        name: input.name.trim(),
        environment: input.environment,
        connectionMode: input.connectionMode,
        connectionUrlEncrypted: encryptedUrl,
        maskedTarget,
        pollIntervalSeconds: input.pollIntervalSeconds,
        isActive: true,
        lastHealthStatus: 'PENDING',
      })
      .returning();
    created = rows[0];
  } catch (error) {
    console.error('Failed to create monitored database:', error);
    throw new Error('Failed to register target database.', { cause: error });
  }

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'TARGET_REGISTERED',
    entityType: 'database',
    entityLabel: created.name,
    summary: `Registered ${created.environment} PostgreSQL target "${created.name}" (${created.connectionMode === 'workspace_pg' ? 'Workspace Live' : 'External URI'}).`,
  });

  if (input.autoCaptureBaseline !== false) {
    try {
      await captureSchemaBaseline(
        ownerUid,
        actorEmail,
        created.id,
        input.gitCommitSha
      );
    } catch (inspectError) {
      console.warn(
        'Initial baseline inspection skipped or failed:',
        inspectError
      );
    }
  }

  const all = await listMonitoredDatabases(ownerUid);
  const found = all.find((d) => d.id === created.id);
  if (!found) {
    throw new Error('Registered database could not be retrieved.');
  }
  return found;
}

export async function updateMonitoredDatabase(
  ownerUid: string,
  databaseId: string,
  updates: {
    isActive?: boolean;
    pollIntervalSeconds?: number;
    name?: string;
    connectionUrl?: string;
  },
  actorEmail?: string
) {
  const existing = await getOwnedDatabase(ownerUid, databaseId);

  const patch: Partial<typeof monitoredDatabases.$inferInsert> = {};
  if (typeof updates.isActive === 'boolean') patch.isActive = updates.isActive;
  if (typeof updates.pollIntervalSeconds === 'number') {
    patch.pollIntervalSeconds = updates.pollIntervalSeconds;
  }
  if (typeof updates.name === 'string' && updates.name.trim()) {
    patch.name = updates.name.trim();
  }

  let updatedMaskedTarget: string | null = null;
  if (typeof updates.connectionUrl === 'string' && updates.connectionUrl.trim()) {
    if (existing.connectionMode !== 'external') {
      throw new Error(
        'Connection URI can only be updated for external PostgreSQL targets.'
      );
    }
    const trimmedUrl = updates.connectionUrl.trim();
    await validateSafePostgresUrl(trimmedUrl);
    patch.connectionUrlEncrypted = encryptSecret(trimmedUrl);
    updatedMaskedTarget = maskPostgresUrl(trimmedUrl);
    patch.maskedTarget = updatedMaskedTarget;
    if (existing.lastHealthStatus === 'ERROR') {
      patch.lastHealthStatus = 'PENDING';
    }
  }

  if (Object.keys(patch).length === 0) {
    return existing;
  }

  try {
    const rows = await db
      .update(monitoredDatabases)
      .set(patch)
      .where(
        and(
          eq(monitoredDatabases.id, databaseId),
          eq(monitoredDatabases.ownerUid, ownerUid)
        )
      )
      .returning();

    if (!rows.length) {
      throw new Error('Target database not found.');
    }

    if (updatedMaskedTarget) {
      await recordAuditLog({
        ownerUid,
        actorEmail: actorEmail ?? 'workspace-operator',
        action: 'TARGET_CREDENTIALS_UPDATED',
        entityType: 'database',
        entityLabel: rows[0].name,
        summary: `Updated encrypted PostgreSQL connection URI for "${rows[0].name}" (${updatedMaskedTarget}).`,
      });
    }

    return rows[0];
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Target database not found.'
    ) {
      throw error;
    }
    console.error('Failed to update monitored database:', error);
    throw new Error('Failed to update target database.', { cause: error });
  }
}

export async function deleteMonitoredDatabase(
  ownerUid: string,
  actorEmail: string,
  databaseId: string
): Promise<void> {
  try {
    const deleted = await db
      .delete(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.id, databaseId),
          eq(monitoredDatabases.ownerUid, ownerUid)
        )
      )
      .returning({ id: monitoredDatabases.id, name: monitoredDatabases.name });

    if (!deleted.length) {
      throw new Error('Target database not found.');
    }

    await recordAuditLog({
      ownerUid,
      actorEmail,
      action: 'TARGET_REMOVED',
      entityType: 'database',
      entityLabel: deleted[0].name,
      summary: `Removed monitored target "${deleted[0].name}" and its snapshot history.`,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Target database not found.'
    ) {
      throw error;
    }
    console.error('Failed to delete monitored database:', error);
    throw new Error('Failed to remove target database.', { cause: error });
  }
}

export async function bulkDeleteMonitoredDatabases(
  ownerUid: string,
  actorEmail: string,
  databaseIds: string[]
): Promise<{
  deletedCount: number;
  deletedIds: string[];
  deletedNames: string[];
}> {
  const uniqueIds = Array.from(new Set(databaseIds));
  if (uniqueIds.length === 0) {
    return { deletedCount: 0, deletedIds: [], deletedNames: [] };
  }

  try {
    const deleted = await db
      .delete(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.ownerUid, ownerUid),
          inArray(monitoredDatabases.id, uniqueIds)
        )
      )
      .returning({ id: monitoredDatabases.id, name: monitoredDatabases.name });

    if (deleted.length > 0) {
      await recordAuditLog({
        ownerUid,
        actorEmail,
        action: 'TARGET_REMOVED',
        entityType: 'database',
        entityLabel:
          deleted.length === 1
            ? deleted[0].name
            : `${deleted.length} targets`,
        summary: `Removed ${deleted.length} monitored target${deleted.length === 1 ? '' : 's'} (${deleted.map((d) => d.name).join(', ')}) and associated snapshot history.`,
      });
    }

    return {
      deletedCount: deleted.length,
      deletedIds: deleted.map((d) => d.id),
      deletedNames: deleted.map((d) => d.name),
    };
  } catch (error) {
    console.error('Failed to bulk delete monitored databases:', error);
    throw new Error('Failed to remove selected target databases.', {
      cause: error,
    });
  }
}

async function getOwnedDatabase(ownerUid: string, databaseId: string) {
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
  return rows[0];
}

async function upsertIncidentIfNew(params: {
  ownerUid: string;
  databaseId: string;
  databaseName: string;
  environment: string;
  incidentType: IncidentType;
  severity: SeverityLevel;
  fingerprint: string;
  details: IncidentDetails;
}) {
  const existing = await db
    .select()
    .from(telemetryIncidents)
    .where(
      and(
        eq(telemetryIncidents.databaseId, params.databaseId),
        eq(telemetryIncidents.fingerprint, params.fingerprint),
        ne(telemetryIncidents.status, 'RESOLVED')
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return { incident: existing[0], isNew: false };
  }

  const inserted = await db
    .insert(telemetryIncidents)
    .values({
      databaseId: params.databaseId,
      incidentType: params.incidentType,
      severity: params.severity,
      fingerprint: params.fingerprint,
      details: params.details,
      status: 'OPEN',
    })
    .returning();

  await dispatchIncidentAlerts(params.ownerUid, {
    databaseName: params.databaseName,
    environment: params.environment,
    incidentType: params.incidentType,
    severity: params.severity,
    summary: params.details.summary,
    details: params.details,
    timestamp: new Date().toISOString(),
  });

  return { incident: inserted[0], isNew: true };
}

export async function runDatabaseInspection(
  ownerUid: string,
  databaseId: string,
  actorEmail?: string,
  options?: { isAutoReinspect?: boolean }
) {
  const target = await getOwnedDatabase(ownerUid, databaseId);
  const settings = await getWorkspaceSettings(ownerUid);

  let connectionString: string | undefined;
  if (target.connectionMode === 'external') {
    connectionString = decryptSecret(target.connectionUrlEncrypted);
    await validateSafePostgresUrl(connectionString);
  }

  let result;
  try {
    result = await SchemaInspector.inspectTarget(
      target.connectionMode as ConnectionMode,
      connectionString
    );
  } catch (error) {
    await db
      .update(monitoredDatabases)
      .set({
        lastPolledAt: new Date(),
        lastHealthStatus: 'ERROR',
      })
      .where(eq(monitoredDatabases.id, target.id))
      .catch(() => undefined);

    const msg =
      error instanceof Error
        ? error.message
        : 'Unable to reach target PostgreSQL instance.';
    throw new Error(`Inspection failed: ${msg}`);
  }

  const [snapshotRow] = await db
    .insert(telemetrySnapshots)
    .values({
      databaseId: target.id,
      schemaHash: result.schemaHash,
      tableCount: result.tableCount,
      columnCount: result.columnCount,
      activeLocksCount: result.locks.length,
      bloatedIndexesCount: result.bloat.length,
      catalogJson: result.catalog,
      locksJson: result.locks,
      bloatJson: result.bloat,
      healthJson: result.health,
      durationMs: result.durationMs,
    })
    .returning();

  const latestBaselines = await db
    .select()
    .from(schemaBaselines)
    .where(eq(schemaBaselines.databaseId, target.id))
    .orderBy(desc(schemaBaselines.createdAt))
    .limit(1);

  const baseline = latestBaselines[0] ?? null;
  let newIncidentsCount = 0;
  let healthStatus: HealthStatus = 'HEALTHY';
  let liveDiffs = baseline
    ? SchemaInspector.diffCatalogs(baseline.tablesJson, result.catalog)
    : [];

  // 1. SCHEMA_DRIFT evaluation (CRITICAL)
  if (baseline) {
    if (baseline.schemaHash !== result.schemaHash) {
      healthStatus = 'DRIFT';
      const addedCount = liveDiffs.filter((d) => d.kind === 'ADDED').length;
      const removedCount = liveDiffs.filter((d) => d.kind === 'REMOVED').length;
      const modifiedCount = liveDiffs.filter(
        (d) => d.kind === 'MODIFIED'
      ).length;

      const details: SchemaDriftDetails = {
        summary: `Live catalog hash diverged from baseline (${addedCount} added, ${removedCount} removed, ${modifiedCount} modified columns).`,
        baseline_hash: baseline.schemaHash,
        live_hash: result.schemaHash,
        git_commit_sha: baseline.gitCommitSha ?? null,
        added_count: addedCount,
        removed_count: removedCount,
        modified_count: modifiedCount,
        diffs: liveDiffs,
      };

      const fp = SchemaInspector.computeFingerprint([
        'SCHEMA_DRIFT',
        baseline.schemaHash,
        result.schemaHash,
      ]);

      const { isNew } = await upsertIncidentIfNew({
        ownerUid,
        databaseId: target.id,
        databaseName: target.name,
        environment: target.environment,
        incidentType: 'SCHEMA_DRIFT',
        severity: 'CRITICAL',
        fingerprint: fp,
        details,
      });
      if (isNew) newIncidentsCount += 1;
    } else {
      await db
        .update(telemetryIncidents)
        .set({ status: 'RESOLVED', resolvedAt: new Date() })
        .where(
          and(
            eq(telemetryIncidents.databaseId, target.id),
            eq(telemetryIncidents.incidentType, 'SCHEMA_DRIFT'),
            ne(telemetryIncidents.status, 'RESOLVED')
          )
        );
    }
  }

  // 2. LOCK_CONTENTION evaluation (WARNING: wait > workspace lockThresholdSeconds)
  for (const lock of result.locks) {
    if (lock.wait_duration_seconds > settings.lockThresholdSeconds) {
      if (healthStatus === 'HEALTHY') healthStatus = 'WARNING';
      const details: LockContentionDetails = {
        summary: `PID ${lock.blocking_pid} (${lock.blocking_user}) blocking PID ${lock.blocked_pid} for ${lock.wait_duration_seconds}s.`,
        blocked_pid: lock.blocked_pid,
        blocked_user: lock.blocked_user,
        blocking_pid: lock.blocking_pid,
        blocking_user: lock.blocking_user,
        wait_duration_seconds: lock.wait_duration_seconds,
        wait_duration_display: lock.wait_duration_display,
        blocked_statement_redacted: lock.blocked_statement,
        blocking_statement_redacted: lock.blocking_statement,
      };

      const fp = SchemaInspector.computeFingerprint([
        'LOCK_CONTENTION',
        String(lock.blocking_pid),
        String(lock.blocked_pid),
      ]);

      const { isNew } = await upsertIncidentIfNew({
        ownerUid,
        databaseId: target.id,
        databaseName: target.name,
        environment: target.environment,
        incidentType: 'LOCK_CONTENTION',
        severity: 'WARNING',
        fingerprint: fp,
        details,
      });
      if (isNew) newIncidentsCount += 1;
    }
  }

  // 3. INDEX_BLOAT evaluation (INFO: size > bloatMbThreshold and bloat > bloatPctThreshold)
  const bloatBytesLimit = settings.bloatMbThreshold * 1024 * 1024;
  for (const idx of result.bloat) {
    if (
      idx.index_bytes > bloatBytesLimit &&
      idx.estimated_bloat_pct > settings.bloatPctThreshold
    ) {
      if (healthStatus === 'HEALTHY') healthStatus = 'WARNING';
      const details: IndexBloatDetails = {
        summary: `Index ${idx.schemaname}.${idx.indexname} is ${idx.index_size_pretty} with ${idx.estimated_bloat_pct}% estimated bloat.`,
        schemaname: idx.schemaname,
        tablename: idx.tablename,
        indexname: idx.indexname,
        index_size_pretty: idx.index_size_pretty,
        index_bytes: idx.index_bytes,
        estimated_bloat_pct: idx.estimated_bloat_pct,
        remediation_sql: idx.remediation_sql,
      };

      const fp = SchemaInspector.computeFingerprint([
        'INDEX_BLOAT',
        idx.schemaname,
        idx.tablename,
        idx.indexname,
      ]);

      const { isNew } = await upsertIncidentIfNew({
        ownerUid,
        databaseId: target.id,
        databaseName: target.name,
        environment: target.environment,
        incidentType: 'INDEX_BLOAT',
        severity: 'INFO',
        fingerprint: fp,
        details,
      });
      if (isNew) newIncidentsCount += 1;
    }
  }

  // 4. VACUUM_HEALTH evaluation (INFO/WARNING: dead tuples > deadTuplePctThreshold and > 10,000 dead tuples)
  if (result.health) {
    for (const tbl of result.health.table_health) {
      if (
        tbl.n_dead_tup > 10000 &&
        tbl.dead_tuple_pct > settings.deadTuplePctThreshold
      ) {
        if (healthStatus === 'HEALTHY') healthStatus = 'WARNING';
        const details: VacuumHealthDetails = {
          summary: `Table ${tbl.schemaname}.${tbl.relname} has ${tbl.n_dead_tup.toLocaleString()} dead tuples (${tbl.dead_tuple_pct}% dead ratio).`,
          schemaname: tbl.schemaname,
          relname: tbl.relname,
          n_live_tup: tbl.n_live_tup,
          n_dead_tup: tbl.n_dead_tup,
          dead_tuple_pct: tbl.dead_tuple_pct,
          remediation_sql: tbl.remediation_sql,
        };

        const fp = SchemaInspector.computeFingerprint([
          'VACUUM_HEALTH',
          tbl.schemaname,
          tbl.relname,
        ]);

        const { isNew } = await upsertIncidentIfNew({
          ownerUid,
          databaseId: target.id,
          databaseName: target.name,
          environment: target.environment,
          incidentType: 'VACUUM_HEALTH',
          severity: 'WARNING',
          fingerprint: fp,
          details,
        });
        if (isNew) newIncidentsCount += 1;
      }
    }

    // 5. CONNECTION_SATURATION evaluation
    if (result.health.connection_usage_pct >= settings.connSaturationPct) {
      if (healthStatus === 'HEALTHY') healthStatus = 'WARNING';
      const details: ConnectionSaturationDetails = {
        summary: `Connection pool at ${result.health.connection_usage_pct}% capacity (${result.health.active_connections} active / ${result.health.max_connections} max, ${result.health.idle_in_transaction} idle in transaction).`,
        active_connections: result.health.active_connections,
        max_connections: result.health.max_connections,
        connection_usage_pct: result.health.connection_usage_pct,
        idle_in_transaction: result.health.idle_in_transaction,
      };
      const fp = SchemaInspector.computeFingerprint([
        'CONNECTION_SATURATION',
        target.id,
      ]);
      const { isNew } = await upsertIncidentIfNew({
        ownerUid,
        databaseId: target.id,
        databaseName: target.name,
        environment: target.environment,
        incidentType: 'CONNECTION_SATURATION',
        severity: 'WARNING',
        fingerprint: fp,
        details,
      });
      if (isNew) newIncidentsCount += 1;
    }
  }

  await db
    .update(monitoredDatabases)
    .set({
      lastPolledAt: new Date(),
      lastSchemaHash: result.schemaHash,
      lastHealthStatus: healthStatus,
    })
    .where(eq(monitoredDatabases.id, target.id));

  // Query current open incidents on this target to compute an accurate 0-100 health score
  const currentOpenIncidents = await db
    .select({
      incidentType: telemetryIncidents.incidentType,
      severity: telemetryIncidents.severity,
    })
    .from(telemetryIncidents)
    .where(
      and(
        eq(telemetryIncidents.databaseId, target.id),
        ne(telemetryIncidents.status, 'RESOLVED')
      )
    );

  let openCriticalCount = 0;
  let openWarningCount = 0;
  let openInfoCount = 0;
  let hasOpenDrift = healthStatus === 'DRIFT';
  for (const inc of currentOpenIncidents) {
    if (inc.incidentType === 'SCHEMA_DRIFT') hasOpenDrift = true;
    if (inc.severity === 'CRITICAL') openCriticalCount += 1;
    else if (inc.severity === 'WARNING') openWarningCount += 1;
    else openInfoCount += 1;
  }

  const healthScore = computeTargetHealthScore({
    lastHealthStatus: healthStatus,
    hasSchemaDrift: hasOpenDrift,
    openCriticalCount,
    openWarningCount,
    openInfoCount,
    activeLocksCount: result.locks.length,
    bloatedIndexesCount: result.bloat.length,
    healthSummary: result.health,
    settings,
  });

  if (actorEmail) {
    await recordAuditLog({
      ownerUid,
      actorEmail,
      action: options?.isAutoReinspect
        ? 'AUTO_REINSPECTION_RUN'
        : 'INSPECTION_RUN',
      entityType: 'database',
      entityLabel: target.name,
      summary: `Scanned ${result.tableCount} tables / ${result.columnCount} columns in ${result.durationMs}ms · Score: ${healthScore}/100 · Status: ${healthStatus}${newIncidentsCount > 0 ? ` · ${newIncidentsCount} new alert(s)` : ''}.`,
    });
  }

  const thresholdOutcome = await handlePostInspectionThresholdCheck({
    ownerUid,
    databaseId: target.id,
    databaseName: target.name,
    healthScore,
    isAutoReinspect: options?.isAutoReinspect,
    triggerFollowUpInspection: async () => {
      await runDatabaseInspection(
        ownerUid,
        target.id,
        'system:auto-reinspect',
        { isAutoReinspect: true }
      );
    },
  });

  return {
    snapshot: serializeSnapshot(snapshotRow),
    healthStatus,
    healthScore,
    newIncidentsCount,
    diffs: liveDiffs,
    autoReinspectTriggered: thresholdOutcome.autoReinspectTriggered,
  };
}

export async function inspectAllActiveDatabases(
  ownerUid: string,
  actorEmail: string
) {
  const activeDbs = await db
    .select()
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.ownerUid, ownerUid),
        eq(monitoredDatabases.isActive, true)
      )
    );

  const results: {
    databaseId: string;
    name: string;
    ok: boolean;
    healthStatus?: HealthStatus;
    newIncidentsCount?: number;
    error?: string;
  }[] = [];

  for (const target of activeDbs) {
    try {
      const outcome = await runDatabaseInspection(
        ownerUid,
        target.id,
        actorEmail
      );
      results.push({
        databaseId: target.id,
        name: target.name,
        ok: true,
        healthStatus: outcome.healthStatus,
        newIncidentsCount: outcome.newIncidentsCount,
      });
    } catch (err) {
      results.push({
        databaseId: target.id,
        name: target.name,
        ok: false,
        error: err instanceof Error ? err.message : 'Inspection failed',
      });
    }
  }

  return {
    scannedCount: results.length,
    succeededCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length,
    results,
  };
}

export async function bulkInspectDatabases(
  ownerUid: string,
  actorEmail: string,
  databaseIds: string[]
) {
  const uniqueIds = Array.from(new Set(databaseIds));
  if (uniqueIds.length === 0) {
    return {
      scannedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      results: [] as {
        databaseId: string;
        name: string;
        ok: boolean;
        healthStatus?: HealthStatus;
        newIncidentsCount?: number;
        error?: string;
      }[],
    };
  }

  const ownedTargets = await db
    .select({
      id: monitoredDatabases.id,
      name: monitoredDatabases.name,
    })
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.ownerUid, ownerUid),
        inArray(monitoredDatabases.id, uniqueIds)
      )
    );

  const settled = await Promise.all(
    ownedTargets.map(async (target) => {
      try {
        const outcome = await runDatabaseInspection(
          ownerUid,
          target.id,
          actorEmail
        );
        return {
          databaseId: target.id,
          name: target.name,
          ok: true,
          healthStatus: outcome.healthStatus,
          newIncidentsCount: outcome.newIncidentsCount,
        };
      } catch (err) {
        return {
          databaseId: target.id,
          name: target.name,
          ok: false,
          error: err instanceof Error ? err.message : 'Inspection failed',
        };
      }
    })
  );

  return {
    scannedCount: settled.length,
    succeededCount: settled.filter((r) => r.ok).length,
    failedCount: settled.filter((r) => !r.ok).length,
    results: settled,
  };
}

export async function captureSchemaBaseline(
  ownerUid: string,
  actorEmail: string,
  databaseId: string,
  gitCommitSha?: string,
  customCatalog?: ColumnCatalogRow[]
): Promise<SchemaBaselineDto> {
  const target = await getOwnedDatabase(ownerUid, databaseId);

  let catalogRows: ColumnCatalogRow[];
  let schemaHash: string;

  if (customCatalog && customCatalog.length > 0) {
    catalogRows = customCatalog;
    schemaHash = SchemaInspector.computeCanonicalHash(customCatalog);
  } else {
    let connectionString: string | undefined;
    if (target.connectionMode === 'external') {
      connectionString = decryptSecret(target.connectionUrlEncrypted);
      await validateSafePostgresUrl(connectionString);
    }
    const inspected = await SchemaInspector.inspectTarget(
      target.connectionMode as ConnectionMode,
      connectionString
    );
    catalogRows = inspected.catalog;
    schemaHash = inspected.schemaHash;

    await db.insert(telemetrySnapshots).values({
      databaseId: target.id,
      schemaHash: inspected.schemaHash,
      tableCount: inspected.tableCount,
      columnCount: inspected.columnCount,
      activeLocksCount: inspected.locks.length,
      bloatedIndexesCount: inspected.bloat.length,
      catalogJson: inspected.catalog,
      locksJson: inspected.locks,
      bloatJson: inspected.bloat,
      healthJson: inspected.health,
      durationMs: inspected.durationMs,
    });
  }

  const [created] = await db
    .insert(schemaBaselines)
    .values({
      databaseId: target.id,
      gitCommitSha: gitCommitSha?.trim() || null,
      schemaHash,
      tablesJson: catalogRows,
    })
    .returning();

  if (!customCatalog || target.lastSchemaHash === schemaHash) {
    await db
      .update(telemetryIncidents)
      .set({ status: 'RESOLVED', resolvedAt: new Date() })
      .where(
        and(
          eq(telemetryIncidents.databaseId, target.id),
          eq(telemetryIncidents.incidentType, 'SCHEMA_DRIFT'),
          ne(telemetryIncidents.status, 'RESOLVED')
        )
      );

    await db
      .update(monitoredDatabases)
      .set({
        lastPolledAt: new Date(),
        lastSchemaHash: schemaHash,
        lastHealthStatus: 'HEALTHY',
      })
      .where(eq(monitoredDatabases.id, target.id));
  }

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'BASELINE_PROMOTED',
    entityType: 'schema_baseline',
    entityLabel: target.name,
    summary: `Promoted schema baseline ${schemaHash.slice(0, 12)} (${catalogRows.length} columns)${gitCommitSha ? ` linked to commit ${gitCommitSha}` : ''}.`,
  });

  return {
    id: created.id,
    databaseId: created.databaseId,
    gitCommitSha: created.gitCommitSha ?? null,
    schemaHash: created.schemaHash,
    tablesJson: created.tablesJson,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function restoreHistoricalBaseline(
  ownerUid: string,
  actorEmail: string,
  databaseId: string,
  baselineId: string
): Promise<SchemaBaselineDto> {
  const target = await getOwnedDatabase(ownerUid, databaseId);
  const rows = await db
    .select()
    .from(schemaBaselines)
    .where(
      and(
        eq(schemaBaselines.id, baselineId),
        eq(schemaBaselines.databaseId, target.id)
      )
    )
    .limit(1);

  if (!rows.length) {
    throw new Error('Historical baseline not found.');
  }

  const source = rows[0];
  return captureSchemaBaseline(
    ownerUid,
    actorEmail,
    target.id,
    source.gitCommitSha ?? undefined,
    source.tablesJson
  );
}

export async function runTelemetryDrill(
  ownerUid: string,
  actorEmail: string,
  databaseId: string,
  scenario: 'drift' | 'lock' | 'bloat'
) {
  const target = await getOwnedDatabase(ownerUid, databaseId);

  const latestBaselines = await db
    .select()
    .from(schemaBaselines)
    .where(eq(schemaBaselines.databaseId, target.id))
    .orderBy(desc(schemaBaselines.createdAt))
    .limit(1);

  if (scenario === 'drift') {
    const baseRows: ColumnCatalogRow[] =
      latestBaselines[0]?.tablesJson ?? [
        {
          table_schema: 'public',
          table_name: 'monitored_databases',
          column_name: 'id',
          ordinal_position: 1,
          column_default: 'gen_random_uuid()',
          is_nullable: 'NO',
          data_type: 'uuid',
        },
        {
          table_schema: 'public',
          table_name: 'monitored_databases',
          column_name: 'environment',
          ordinal_position: 2,
          column_default: null,
          is_nullable: 'NO',
          data_type: 'character varying',
        },
      ];

    const mutatedRows: ColumnCatalogRow[] = [
      ...baseRows.map((row, idx) =>
        idx === 1 ? { ...row, data_type: 'text', is_nullable: 'YES' } : row
      ),
      {
        table_schema: 'public',
        table_name: baseRows[0]?.table_name ?? 'orders',
        column_name: 'hotfix_bypass_flag',
        ordinal_position: 99,
        column_default: 'false',
        is_nullable: 'YES',
        data_type: 'boolean',
      },
    ];

    const baseHash =
      latestBaselines[0]?.schemaHash ??
      SchemaInspector.computeCanonicalHash(baseRows);
    const liveHash = SchemaInspector.computeCanonicalHash(mutatedRows);
    const diffs = SchemaInspector.diffCatalogs(baseRows, mutatedRows);

    const details: SchemaDriftDetails = {
      summary: `[Drill] Out-of-band DDL drift detected: ${diffs.filter((d) => d.kind === 'ADDED').length} added, ${diffs.filter((d) => d.kind === 'MODIFIED').length} modified column against stored SHA-256 baseline.`,
      baseline_hash: baseHash,
      live_hash: liveHash,
      git_commit_sha: latestBaselines[0]?.gitCommitSha ?? 'a9f4c21',
      added_count: diffs.filter((d) => d.kind === 'ADDED').length,
      removed_count: diffs.filter((d) => d.kind === 'REMOVED').length,
      modified_count: diffs.filter((d) => d.kind === 'MODIFIED').length,
      diffs,
    };

    const fp = SchemaInspector.computeFingerprint([
      'DRILL_SCHEMA_DRIFT',
      target.id,
      String(Date.now()),
    ]);

    const { incident } = await upsertIncidentIfNew({
      ownerUid,
      databaseId: target.id,
      databaseName: target.name,
      environment: target.environment,
      incidentType: 'SCHEMA_DRIFT',
      severity: 'CRITICAL',
      fingerprint: fp,
      details,
    });

    await db
      .update(monitoredDatabases)
      .set({ lastHealthStatus: 'DRIFT', lastSchemaHash: liveHash })
      .where(eq(monitoredDatabases.id, target.id));

    await recordAuditLog({
      ownerUid,
      actorEmail,
      action: 'DRILL_EXECUTED',
      entityType: 'database',
      entityLabel: target.name,
      summary: `Executed Schema Drift (CRITICAL) alert drill on "${target.name}".`,
    });

    return incident;
  }

  if (scenario === 'lock') {
    const rawBlocker =
      "ALTER TABLE public.invoices ADD COLUMN tax_jurisdiction VARCHAR(32) NOT NULL DEFAULT 'US-CA';";
    const rawBlocked =
      "UPDATE public.invoices SET status = 'SETTLED', amount_cents = 149500 WHERE customer_email = 'billing@acme.io' AND id = 98124;";

    const details: LockContentionDetails = {
      summary:
        '[Drill] Exclusive AccessExclusiveLock held by PID 48219 (migrator_svc) blocking PID 48304 for 27.4s.',
      blocked_pid: 48304,
      blocked_user: 'api_writer',
      blocking_pid: 48219,
      blocking_user: 'migrator_svc',
      wait_duration_seconds: 27.4,
      wait_duration_display: '00:00:27.4',
      blocked_statement_redacted: redactSqlQuery(rawBlocked),
      blocking_statement_redacted: redactSqlQuery(rawBlocker),
    };

    const fp = SchemaInspector.computeFingerprint([
      'DRILL_LOCK_CONTENTION',
      target.id,
      String(Date.now()),
    ]);

    const { incident } = await upsertIncidentIfNew({
      ownerUid,
      databaseId: target.id,
      databaseName: target.name,
      environment: target.environment,
      incidentType: 'LOCK_CONTENTION',
      severity: 'WARNING',
      fingerprint: fp,
      details,
    });

    if (
      target.lastHealthStatus === 'HEALTHY' ||
      target.lastHealthStatus === 'PENDING'
    ) {
      await db
        .update(monitoredDatabases)
        .set({ lastHealthStatus: 'WARNING' })
        .where(eq(monitoredDatabases.id, target.id));
    }

    await recordAuditLog({
      ownerUid,
      actorEmail,
      action: 'DRILL_EXECUTED',
      entityType: 'database',
      entityLabel: target.name,
      summary: `Executed Lock Contention (WARNING) alert drill on "${target.name}".`,
    });

    return incident;
  }

  const indexName = 'idx_events_tenant_created_at';
  const details: IndexBloatDetails = {
    summary: `[Drill] Index public.${indexName} is 148 MB with 54.8% estimated bloat (>50MB & >40% threshold).`,
    schemaname: 'public',
    tablename: 'audit_events',
    indexname: indexName,
    index_size_pretty: '148 MB',
    index_bytes: 148 * 1024 * 1024,
    estimated_bloat_pct: 54.8,
    remediation_sql: buildRemediationReindexSql('public', indexName),
  };

  const fp = SchemaInspector.computeFingerprint([
    'DRILL_INDEX_BLOAT',
    target.id,
    String(Date.now()),
  ]);

  const { incident } = await upsertIncidentIfNew({
    ownerUid,
    databaseId: target.id,
    databaseName: target.name,
    environment: target.environment,
    incidentType: 'INDEX_BLOAT',
    severity: 'INFO',
    fingerprint: fp,
    details,
  });

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'DRILL_EXECUTED',
    entityType: 'database',
    entityLabel: target.name,
    summary: `Executed Index Bloat (INFO) alert drill on "${target.name}".`,
  });

  return incident;
}

function serializeSnapshot(
  row: typeof telemetrySnapshots.$inferSelect
): TelemetrySnapshotDto {
  return {
    id: row.id,
    databaseId: row.databaseId,
    schemaHash: row.schemaHash,
    tableCount: row.tableCount,
    columnCount: row.columnCount,
    activeLocksCount: row.activeLocksCount,
    bloatedIndexesCount: row.bloatedIndexesCount,
    catalogJson: row.catalogJson,
    locksJson: row.locksJson,
    bloatJson: row.bloatJson,
    healthJson: row.healthJson ?? null,
    durationMs: row.durationMs,
    inspectedAt: row.inspectedAt.toISOString(),
  };
}

export async function getDatabaseDetail(ownerUid: string, databaseId: string) {
  const target = await getOwnedDatabase(ownerUid, databaseId);

  const [baselines, snapshots, incidents] = await Promise.all([
    db
      .select()
      .from(schemaBaselines)
      .where(eq(schemaBaselines.databaseId, target.id))
      .orderBy(desc(schemaBaselines.createdAt))
      .limit(20),
    db
      .select()
      .from(telemetrySnapshots)
      .where(eq(telemetrySnapshots.databaseId, target.id))
      .orderBy(desc(telemetrySnapshots.inspectedAt))
      .limit(15),
    db
      .select()
      .from(telemetryIncidents)
      .where(eq(telemetryIncidents.databaseId, target.id))
      .orderBy(desc(telemetryIncidents.createdAt))
      .limit(30),
  ]);

  const latestSnapshot = snapshots[0] ? serializeSnapshot(snapshots[0]) : null;
  const latestBaseline = baselines[0] ?? null;
  const liveDiff =
    latestSnapshot && latestBaseline
      ? SchemaInspector.diffCatalogs(
          latestBaseline.tablesJson,
          latestSnapshot.catalogJson
        )
      : [];

  // SQL to revert live database back to match stored baseline
  const revertToBaselineSql =
    latestSnapshot && latestBaseline && liveDiff.length > 0
      ? generateSyncSqlFromDiff(
          SchemaInspector.diffCatalogs(
            latestSnapshot.catalogJson,
            latestBaseline.tablesJson
          ),
          `stored baseline (${latestBaseline.schemaHash.slice(0, 8)})`,
          `${target.name} (live)`
        )
      : '';

  return {
    database: {
      id: target.id,
      name: target.name,
      environment: target.environment as EnvironmentType,
      connectionMode: target.connectionMode as ConnectionMode,
      maskedTarget: target.maskedTarget,
      pollIntervalSeconds: target.pollIntervalSeconds,
      isActive: target.isActive,
      lastPolledAt: target.lastPolledAt
        ? target.lastPolledAt.toISOString()
        : null,
      lastSchemaHash: target.lastSchemaHash ?? null,
      lastHealthStatus: target.lastHealthStatus as HealthStatus,
      createdAt: target.createdAt.toISOString(),
      credentialsValid:
        target.connectionMode === 'workspace_pg'
          ? true
          : canDecryptSecret(target.connectionUrlEncrypted),
    },
    baselines: baselines.map<SchemaBaselineDto>((b) => ({
      id: b.id,
      databaseId: b.databaseId,
      gitCommitSha: b.gitCommitSha ?? null,
      schemaHash: b.schemaHash,
      tablesJson: b.tablesJson,
      createdAt: b.createdAt.toISOString(),
    })),
    latestSnapshot,
    snapshotHistory: snapshots.map((s) => ({
      id: s.id,
      schemaHash: s.schemaHash,
      tableCount: s.tableCount,
      columnCount: s.columnCount,
      activeLocksCount: s.activeLocksCount,
      bloatedIndexesCount: s.bloatedIndexesCount,
      durationMs: s.durationMs,
      inspectedAt: s.inspectedAt.toISOString(),
    })),
    liveDiff,
    revertToBaselineSql,
    incidents: incidents.map<TelemetryIncidentDto>((inc) => ({
      id: inc.id,
      databaseId: inc.databaseId,
      databaseName: target.name,
      environment: target.environment as EnvironmentType,
      incidentType: inc.incidentType as IncidentType,
      severity: inc.severity as SeverityLevel,
      fingerprint: inc.fingerprint,
      details: inc.details,
      status: inc.status as IncidentStatus,
      createdAt: inc.createdAt.toISOString(),
      resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
    })),
  };
}

export async function listIncidents(
  ownerUid: string,
  filters?: {
    status?: IncidentStatus;
    incidentType?: IncidentType;
    databaseId?: string;
  }
): Promise<TelemetryIncidentDto[]> {
  try {
    const ownedDbs = await db
      .select({
        id: monitoredDatabases.id,
        name: monitoredDatabases.name,
        environment: monitoredDatabases.environment,
      })
      .from(monitoredDatabases)
      .where(eq(monitoredDatabases.ownerUid, ownerUid));

    if (!ownedDbs.length) return [];

    const dbMap = new Map(ownedDbs.map((d) => [d.id, d]));
    const dbIds = ownedDbs.map((d) => d.id);

    const conditions = [inArray(telemetryIncidents.databaseId, dbIds)];
    if (filters?.databaseId && dbMap.has(filters.databaseId)) {
      conditions.push(eq(telemetryIncidents.databaseId, filters.databaseId));
    }
    if (filters?.status) {
      conditions.push(eq(telemetryIncidents.status, filters.status));
    }
    if (filters?.incidentType) {
      conditions.push(
        eq(telemetryIncidents.incidentType, filters.incidentType)
      );
    }

    const rows = await db
      .select()
      .from(telemetryIncidents)
      .where(and(...conditions))
      .orderBy(desc(telemetryIncidents.createdAt))
      .limit(100);

    return rows.map((inc) => {
      const target = dbMap.get(inc.databaseId);
      return {
        id: inc.id,
        databaseId: inc.databaseId,
        databaseName: target?.name ?? 'Unknown target',
        environment: (target?.environment as EnvironmentType) ?? 'production',
        incidentType: inc.incidentType as IncidentType,
        severity: inc.severity as SeverityLevel,
        fingerprint: inc.fingerprint,
        details: inc.details,
        status: inc.status as IncidentStatus,
        createdAt: inc.createdAt.toISOString(),
        resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
      };
    });
  } catch (error) {
    console.error('Failed to list telemetry incidents:', error);
    throw new Error('Failed to load telemetry incidents.', { cause: error });
  }
}

export async function updateIncidentStatus(
  ownerUid: string,
  actorEmail: string,
  incidentId: string,
  status: IncidentStatus
): Promise<TelemetryIncidentDto> {
  const existing = await db
    .select({
      incident: telemetryIncidents,
      dbName: monitoredDatabases.name,
      dbEnv: monitoredDatabases.environment,
    })
    .from(telemetryIncidents)
    .innerJoin(
      monitoredDatabases,
      eq(telemetryIncidents.databaseId, monitoredDatabases.id)
    )
    .where(
      and(
        eq(telemetryIncidents.id, incidentId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!existing.length) {
    throw new Error('Incident not found.');
  }

  const [updated] = await db
    .update(telemetryIncidents)
    .set({
      status,
      resolvedAt: status === 'RESOLVED' ? new Date() : null,
    })
    .where(eq(telemetryIncidents.id, incidentId))
    .returning();

  const remaining = await db
    .select()
    .from(telemetryIncidents)
    .where(
      and(
        eq(telemetryIncidents.databaseId, updated.databaseId),
        ne(telemetryIncidents.status, 'RESOLVED')
      )
    );

  const nextHealth: HealthStatus = remaining.some(
    (i) => i.severity === 'CRITICAL'
  )
    ? 'DRIFT'
    : remaining.length > 0
      ? 'WARNING'
      : 'HEALTHY';

  await db
    .update(monitoredDatabases)
    .set({ lastHealthStatus: nextHealth })
    .where(eq(monitoredDatabases.id, updated.databaseId));

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: `INCIDENT_${status}`,
    entityType: 'incident',
    entityLabel: `${updated.incidentType} · ${existing[0].dbName}`,
    summary: `Marked ${updated.incidentType} incident on "${existing[0].dbName}" as ${status}.`,
  });

  return {
    id: updated.id,
    databaseId: updated.databaseId,
    databaseName: existing[0].dbName,
    environment: existing[0].dbEnv as EnvironmentType,
    incidentType: updated.incidentType as IncidentType,
    severity: updated.severity as SeverityLevel,
    fingerprint: updated.fingerprint,
    details: updated.details,
    status: updated.status as IncidentStatus,
    createdAt: updated.createdAt.toISOString(),
    resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : null,
  };
}

export async function listWebhooks(
  ownerUid: string
): Promise<AlertWebhookDto[]> {
  try {
    const rows = await db
      .select()
      .from(alertWebhooks)
      .where(eq(alertWebhooks.ownerUid, ownerUid))
      .orderBy(desc(alertWebhooks.createdAt));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      provider: r.provider as WebhookProvider,
      maskedUrl: r.maskedUrl,
      minSeverity: r.minSeverity as SeverityLevel,
      isActive: r.isActive,
      lastTriggeredAt: r.lastTriggeredAt
        ? r.lastTriggeredAt.toISOString()
        : null,
      lastStatusCode: r.lastStatusCode ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (error) {
    console.error('Failed to list webhooks:', error);
    throw new Error('Failed to load alert channels.', { cause: error });
  }
}

export async function createWebhook(
  ownerUid: string,
  actorEmail: string,
  input: {
    name: string;
    provider: WebhookProvider;
    webhookUrl: string;
    minSeverity: SeverityLevel;
  }
): Promise<AlertWebhookDto> {
  await validateSafeWebhookUrl(input.webhookUrl, input.provider);
  const encrypted = encryptSecret(input.webhookUrl.trim());
  const masked = maskWebhookUrl(input.webhookUrl.trim());

  const [created] = await db
    .insert(alertWebhooks)
    .values({
      ownerUid,
      name: input.name.trim(),
      provider: input.provider,
      webhookUrlEncrypted: encrypted,
      maskedUrl: masked,
      minSeverity: input.minSeverity,
      isActive: true,
    })
    .returning();

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'WEBHOOK_ADDED',
    entityType: 'webhook',
    entityLabel: created.name,
    summary: `Added ${created.provider} alert channel "${created.name}" (min severity: ${created.minSeverity}).`,
  });

  return {
    id: created.id,
    name: created.name,
    provider: created.provider as WebhookProvider,
    maskedUrl: created.maskedUrl,
    minSeverity: created.minSeverity as SeverityLevel,
    isActive: created.isActive,
    lastTriggeredAt: null,
    lastStatusCode: null,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function toggleWebhook(
  ownerUid: string,
  webhookId: string,
  isActive: boolean
) {
  const rows = await db
    .update(alertWebhooks)
    .set({ isActive })
    .where(
      and(eq(alertWebhooks.id, webhookId), eq(alertWebhooks.ownerUid, ownerUid))
    )
    .returning();

  if (!rows.length) {
    throw new Error('Webhook channel not found.');
  }
  return rows[0];
}

export async function deleteWebhook(
  ownerUid: string,
  actorEmail: string,
  webhookId: string
) {
  const deleted = await db
    .delete(alertWebhooks)
    .where(
      and(eq(alertWebhooks.id, webhookId), eq(alertWebhooks.ownerUid, ownerUid))
    )
    .returning({ id: alertWebhooks.id, name: alertWebhooks.name });

  if (!deleted.length) {
    throw new Error('Webhook channel not found.');
  }

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'WEBHOOK_REMOVED',
    entityType: 'webhook',
    entityLabel: deleted[0].name,
    summary: `Removed alert channel "${deleted[0].name}".`,
  });
}

export { sendTestWebhookChannel };
