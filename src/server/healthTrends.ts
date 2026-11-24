import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  monitoredDatabases,
  telemetryIncidents,
  telemetrySnapshots,
} from '../db/schema.ts';
import { decryptSecret, validateSafePostgresUrl } from './crypto.ts';
import {
  buildRemediationReindexSql,
  buildVacuumAnalyzeSql,
  formatBytesPretty,
  SchemaInspector,
} from './inspector.ts';
import { dispatchIncidentAlerts } from './webhookDispatcher.ts';
import { recordAuditLog } from './extendedService.ts';
import type {
  ConnectionMode,
  HealthTrendPoint,
  HealthTrendsResponse,
  IncidentDetails,
  IndexBloatDetails,
  SeverityLevel,
  SuggestedTrendAlert,
  VacuumHealthDetails,
} from '../types/telemetry.ts';

function computeTrailingStats(values: number[]): {
  mean: number;
  stdDev: number;
} {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length < 2) return { mean, stdDev: 0 };
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

function formatShortTimeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export async function getHealthTrends(
  ownerUid: string,
  options: {
    databaseId?: string;
    windowSize?: number;
    sigmaThreshold?: number;
  }
): Promise<HealthTrendsResponse> {
  const windowSize = Math.min(14, Math.max(3, Math.round(options.windowSize ?? 5)));
  const sigmaThreshold = Math.min(
    3.5,
    Math.max(1.2, Number(options.sigmaThreshold ?? 2.0))
  );

  let targetLabel = 'Workspace PostgreSQL (Live)';
  let resolvedDbId: string | null = null;
  let mode: ConnectionMode = 'workspace_pg';
  let connectionUrl: string | undefined;

  if (options.databaseId) {
    const rows = await db
      .select()
      .from(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.id, options.databaseId),
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
      try {
        connectionUrl = decryptSecret(target.connectionUrlEncrypted);
        await validateSafePostgresUrl(connectionUrl);
      } catch {
        // Fallback to historical snapshots if available below
        connectionUrl = undefined;
      }
    }
  } else {
    const wsRows = await db
      .select({ id: monitoredDatabases.id, name: monitoredDatabases.name })
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

  const [snapshots, openIncidents] = await Promise.all([
    resolvedDbId
      ? db
          .select()
          .from(telemetrySnapshots)
          .where(eq(telemetrySnapshots.databaseId, resolvedDbId))
          .orderBy(asc(telemetrySnapshots.inspectedAt))
          .limit(40)
      : Promise.resolve([]),
    resolvedDbId
      ? db
          .select({ fingerprint: telemetryIncidents.fingerprint })
          .from(telemetryIncidents)
          .where(
            and(
              eq(telemetryIncidents.databaseId, resolvedDbId),
              ne(telemetryIncidents.status, 'RESOLVED')
            )
          )
      : Promise.resolve([]),
  ]);

  let liveStats: Awaited<
    ReturnType<typeof SchemaInspector.fetchLiveVacuumAndBloatStats>
  > | null = null;
  let liveProbeSucceeded = false;

  if (mode === 'workspace_pg' || connectionUrl) {
    try {
      liveStats = await SchemaInspector.fetchLiveVacuumAndBloatStats(
        mode,
        connectionUrl
      );
      liveProbeSucceeded = true;
    } catch (err) {
      if (snapshots.length === 0) {
        throw err;
      }
    }
  } else if (snapshots.length === 0) {
    throw new Error(
      'Unable to connect to external target and no historical snapshots are available yet.'
    );
  }

  if (!liveStats) {
    const lastSnap = snapshots[snapshots.length - 1];
    liveStats = {
      tables: (lastSnap?.healthJson?.table_health ?? []).map((t) => ({
        schemaname: t.schemaname,
        relname: t.relname,
        n_live_tup: t.n_live_tup ?? 0,
        n_dead_tup: t.n_dead_tup ?? 0,
        dead_tuple_pct: t.dead_tuple_pct ?? 0,
        vacuum_count: 0,
        autovacuum_count: t.last_autovacuum ? 1 : 0,
        last_autovacuum: t.last_autovacuum ?? null,
      })),
      indexes: (lastSnap?.bloatJson ?? []).map((b) => ({
        schemaname: b.schemaname,
        tablename: b.tablename,
        indexname: b.indexname,
        index_bytes: b.index_bytes ?? 0,
        index_size_pretty: b.index_size_pretty ?? '0 bytes',
        estimated_bloat_pct: b.estimated_bloat_pct ?? 0,
      })),
    };
  }

  const openFingerprints = new Set(openIncidents.map((i) => i.fingerprint));

  interface RawPoint {
    timestamp: string;
    deadTuplePct: number;
    deadTuples: number;
    vacuumEvents: number;
    indexBloatPct: number;
    bloatedIndexBytes: number;
    bloatedIndexCount: number;
  }

  const rawPoints: RawPoint[] = [];

  for (const snap of snapshots) {
    const tables = snap.healthJson?.table_health ?? [];
    const totalLive = tables.reduce((s, t) => s + (t.n_live_tup ?? 0), 0);
    const totalDead = tables.reduce((s, t) => s + (t.n_dead_tup ?? 0), 0);
    const weightedDeadPct =
      totalLive + totalDead > 0
        ? (totalDead / (totalLive + totalDead)) * 100
        : 0;
    const peakDeadPct = tables.reduce(
      (max, t) => Math.max(max, t.dead_tuple_pct ?? 0),
      0
    );
    const combinedDeadPct = Math.round(Math.max(weightedDeadPct, peakDeadPct) * 100) / 100;

    // Count tables whose last_autovacuum fell within 24h prior to snapshot
    const snapMs = snap.inspectedAt.getTime();
    const recentVacCount = tables.filter((t) => {
      if (!t.last_autovacuum) return false;
      const diff = snapMs - new Date(t.last_autovacuum).getTime();
      return diff >= 0 && diff <= 24 * 3600 * 1000;
    }).length;

    const bloatRows = snap.bloatJson ?? [];
    const bloatedBytes = bloatRows.reduce((s, b) => s + (b.index_bytes ?? 0), 0);
    const maxBloatPct = bloatRows.reduce(
      (max, b) => Math.max(max, b.estimated_bloat_pct ?? 0),
      0
    );

    rawPoints.push({
      timestamp: snap.inspectedAt.toISOString(),
      deadTuplePct: combinedDeadPct,
      deadTuples: totalDead,
      vacuumEvents: recentVacCount,
      indexBloatPct: Math.round(maxBloatPct * 100) / 100,
      bloatedIndexBytes: bloatedBytes,
      bloatedIndexCount: snap.bloatedIndexesCount,
    });
  }

  // Append current live reading if live probe succeeded and no recent snapshot within 20 seconds
  const liveTotalLive = liveStats.tables.reduce((s, t) => s + t.n_live_tup, 0);
  const liveTotalDead = liveStats.tables.reduce((s, t) => s + t.n_dead_tup, 0);
  const liveWeightedDeadPct =
    liveTotalLive + liveTotalDead > 0
      ? (liveTotalDead / (liveTotalLive + liveTotalDead)) * 100
      : 0;
  const livePeakDeadPct = liveStats.tables.reduce(
    (max, t) => Math.max(max, t.dead_tuple_pct),
    0
  );
  const liveDeadPct =
    Math.round(Math.max(liveWeightedDeadPct, livePeakDeadPct) * 100) / 100;
  const totalVacuumCycles = liveStats.tables.reduce(
    (s, t) => s + t.vacuum_count + t.autovacuum_count,
    0
  );
  const liveRecentVac = liveStats.tables.filter((t) => {
    if (!t.last_autovacuum) return false;
    return Date.now() - new Date(t.last_autovacuum).getTime() <= 24 * 3600 * 1000;
  }).length;

  const liveBloatedIndexes = liveStats.indexes.filter(
    (i) => i.estimated_bloat_pct >= 20
  );
  const liveMaxBloatPct = liveStats.indexes.reduce(
    (max, i) => Math.max(max, i.estimated_bloat_pct),
    0
  );
  const liveBloatedBytes = liveBloatedIndexes.reduce(
    (s, i) => s + i.index_bytes,
    0
  );

  const nowIso = new Date().toISOString();
  if (
    liveProbeSucceeded &&
    (rawPoints.length === 0 ||
      Date.now() - new Date(rawPoints[rawPoints.length - 1].timestamp).getTime() >
        20_000)
  ) {
    rawPoints.push({
      timestamp: nowIso,
      deadTuplePct: liveDeadPct,
      deadTuples: liveTotalDead,
      vacuumEvents: liveRecentVac,
      indexBloatPct: Math.round(liveMaxBloatPct * 100) / 100,
      bloatedIndexBytes: liveBloatedBytes,
      bloatedIndexCount: liveBloatedIndexes.length,
    });
  }

  // Sliding-window anomaly detection across chronological points
  const points: HealthTrendPoint[] = rawPoints.map((pt, idx) => {
    const startIdx = Math.max(0, idx - windowSize);
    const trailing = rawPoints.slice(startIdx, idx);

    let vacuumBaselineMean: number | null = null;
    let vacuumUpperBound: number | null = null;
    let vacuumZScore: number | null = null;
    let vacuumAnomaly = false;

    let bloatBaselineMean: number | null = null;
    let bloatUpperBound: number | null = null;
    let bloatZScore: number | null = null;
    let bloatAnomaly = false;

    if (trailing.length >= 3) {
      const vacStats = computeTrailingStats(trailing.map((x) => x.deadTuplePct));
      const effectiveVacStd = Math.max(vacStats.stdDev, 1.25);
      const vacUpper = vacStats.mean + sigmaThreshold * effectiveVacStd;
      const vacZ = (pt.deadTuplePct - vacStats.mean) / effectiveVacStd;

      vacuumBaselineMean = Math.round(vacStats.mean * 100) / 100;
      vacuumUpperBound = Math.round(vacUpper * 100) / 100;
      vacuumZScore = Math.round(vacZ * 100) / 100;
      vacuumAnomaly =
        pt.deadTuplePct > vacUpper &&
        pt.deadTuplePct - vacStats.mean >= 4 &&
        pt.deadTuplePct >= 10;

      const bloatStats = computeTrailingStats(
        trailing.map((x) => x.indexBloatPct)
      );
      const effectiveBloatStd = Math.max(bloatStats.stdDev, 1.5);
      const bloatUpper = bloatStats.mean + sigmaThreshold * effectiveBloatStd;
      const bloatZ = (pt.indexBloatPct - bloatStats.mean) / effectiveBloatStd;

      bloatBaselineMean = Math.round(bloatStats.mean * 100) / 100;
      bloatUpperBound = Math.round(bloatUpper * 100) / 100;
      bloatZScore = Math.round(bloatZ * 100) / 100;
      bloatAnomaly =
        pt.indexBloatPct > bloatUpper &&
        pt.indexBloatPct - bloatStats.mean >= 5 &&
        pt.indexBloatPct >= 20;
    }

    return {
      ...pt,
      label: formatShortTimeLabel(pt.timestamp),
      vacuumBaselineMean,
      vacuumUpperBound,
      vacuumZScore,
      vacuumAnomaly,
      bloatBaselineMean,
      bloatUpperBound,
      bloatZScore,
      bloatAnomaly,
    };
  });

  // Build Suggested Incident Alerts from:
  // 1) Sliding-window flagged anomalies on latest point or recent window
  // 2) Per-table dead tuple spikes / per-index bloat spikes vs sliding window baseline
  const suggestedAlerts: SuggestedTrendAlert[] = [];
  const latestPoint = points[points.length - 1];

  // Evaluate per-table vacuum spikes against trailing snapshots
  const trailingSnaps = snapshots.slice(Math.max(0, snapshots.length - windowSize));
  const tableHistoryMap = new Map<string, number[]>();
  for (const s of trailingSnaps) {
    for (const th of s.healthJson?.table_health ?? []) {
      const k = `${th.schemaname}.${th.relname}`;
      const list = tableHistoryMap.get(k) ?? [];
      list.push(th.dead_tuple_pct ?? 0);
      tableHistoryMap.set(k, list);
    }
  }

  for (const tbl of liveStats.tables) {
    const key = `${tbl.schemaname}.${tbl.relname}`;
    const hist = tableHistoryMap.get(key) ?? [];
    const histStats =
      hist.length >= 2
        ? computeTrailingStats(hist)
        : { mean: Math.min(tbl.dead_tuple_pct, 8), stdDev: 2 };
    const std = Math.max(histStats.stdDev, 1.5);
    const z = (tbl.dead_tuple_pct - histStats.mean) / std;

    const isWindowSpike =
      hist.length >= 2 &&
      tbl.dead_tuple_pct > histStats.mean + sigmaThreshold * std &&
      tbl.dead_tuple_pct >= 12;
    const isAcuteLivePressure =
      tbl.dead_tuple_pct >= 20 && tbl.n_dead_tup >= 200;

    if (isWindowSpike || isAcuteLivePressure) {
      const fingerprint = SchemaInspector.computeFingerprint([
        'TREND_VACUUM_SPIKE',
        tbl.schemaname,
        tbl.relname,
      ]);
      const severity: SeverityLevel =
        tbl.dead_tuple_pct >= 35 || z >= 3.0 ? 'CRITICAL' : 'WARNING';

      suggestedAlerts.push({
        id: `vac-${key}`,
        fingerprint,
        category: 'VACUUM_SPIKE',
        incidentType: 'VACUUM_HEALTH',
        severity,
        title: `Vacuum Activity & Dead-Tuple Spike on ${key}`,
        targetObject: key,
        observedLabel: `${tbl.dead_tuple_pct.toFixed(1)}% dead tuples (${tbl.n_dead_tup.toLocaleString()} rows)`,
        baselineLabel:
          hist.length >= 2
            ? `${histStats.mean.toFixed(1)}% window avg`
            : '<10% healthy baseline',
        deviationLabel:
          hist.length >= 2
            ? `+${z.toFixed(1)}σ above window`
            : `${tbl.autovacuum_count + tbl.vacuum_count} vacuum cycles`,
        plainEnglishReason:
          hist.length >= 2
            ? `Dead tuple ratio jumped to ${tbl.dead_tuple_pct.toFixed(1)}% versus a ${windowSize}-sample trailing mean of ${histStats.mean.toFixed(1)}%, indicating autovacuum is falling behind write churn.`
            : `${tbl.n_dead_tup.toLocaleString()} unvacuumed dead tuples (${tbl.dead_tuple_pct.toFixed(1)}%) are inflating table scans and disk pages.`,
        remediationSql: buildVacuumAnalyzeSql(tbl.schemaname, tbl.relname),
        detectedAt: nowIso,
        alreadyPromoted: openFingerprints.has(fingerprint),
        metrics: {
          schemaname: tbl.schemaname,
          tablename: tbl.relname,
          n_live_tup: tbl.n_live_tup,
          n_dead_tup: tbl.n_dead_tup,
          dead_tuple_pct: tbl.dead_tuple_pct,
        },
      });
    }
  }

  // Evaluate per-index bloat growth spikes
  const indexHistoryMap = new Map<string, number[]>();
  for (const s of trailingSnaps) {
    for (const bl of s.bloatJson ?? []) {
      const k = `${bl.schemaname}.${bl.indexname}`;
      const list = indexHistoryMap.get(k) ?? [];
      list.push(bl.estimated_bloat_pct ?? 0);
      indexHistoryMap.set(k, list);
    }
  }

  for (const idx of liveStats.indexes) {
    const key = `${idx.schemaname}.${idx.indexname}`;
    const hist = indexHistoryMap.get(key) ?? [];
    const histStats =
      hist.length >= 2
        ? computeTrailingStats(hist)
        : { mean: Math.min(idx.estimated_bloat_pct, 15), stdDev: 3 };
    const std = Math.max(histStats.stdDev, 2.0);
    const z = (idx.estimated_bloat_pct - histStats.mean) / std;

    const isWindowSpike =
      hist.length >= 2 &&
      idx.estimated_bloat_pct > histStats.mean + sigmaThreshold * std &&
      idx.estimated_bloat_pct >= 25;
    const isAcuteIndexBloat =
      idx.estimated_bloat_pct >= 40 && idx.index_bytes >= 512 * 1024;

    if (isWindowSpike || isAcuteIndexBloat) {
      const fingerprint = SchemaInspector.computeFingerprint([
        'TREND_INDEX_BLOAT',
        idx.schemaname,
        idx.indexname,
      ]);
      const severity: SeverityLevel =
        idx.estimated_bloat_pct >= 60 ? 'WARNING' : 'INFO';

      suggestedAlerts.push({
        id: `bloat-${key}`,
        fingerprint,
        category: 'INDEX_BLOAT_GROWTH',
        incidentType: 'INDEX_BLOAT',
        severity,
        title: `Anomalous Index Bloat Growth on ${key}`,
        targetObject: `${idx.schemaname}.${idx.indexname} (${idx.tablename})`,
        observedLabel: `${idx.estimated_bloat_pct.toFixed(1)}% bloat (${idx.index_size_pretty})`,
        baselineLabel:
          hist.length >= 2
            ? `${histStats.mean.toFixed(1)}% window avg`
            : '<25% healthy baseline',
        deviationLabel:
          hist.length >= 2
            ? `+${z.toFixed(1)}σ above window`
            : `${idx.index_size_pretty} footprint`,
        plainEnglishReason:
          hist.length >= 2
            ? `Estimated index bloat surged to ${idx.estimated_bloat_pct.toFixed(1)}% vs a ${windowSize}-sample trailing average of ${histStats.mean.toFixed(1)}%, degrading B-tree lookup efficiency.`
            : `Index ${idx.indexname} shows ${idx.estimated_bloat_pct.toFixed(1)}% estimated bloat across ${idx.index_size_pretty}, wasting buffer cache and slowing index scans.`,
        remediationSql: buildRemediationReindexSql(idx.schemaname, idx.indexname),
        detectedAt: nowIso,
        alreadyPromoted: openFingerprints.has(fingerprint),
        metrics: {
          schemaname: idx.schemaname,
          tablename: idx.tablename,
          indexname: idx.indexname,
          index_bytes: idx.index_bytes,
          index_size_pretty: idx.index_size_pretty,
          estimated_bloat_pct: idx.estimated_bloat_pct,
        },
      });
    }
  }

  const vacuumAnomalyCount = points.filter((p) => p.vacuumAnomaly).length;
  const bloatAnomalyCount = points.filter((p) => p.bloatAnomaly).length;

  return {
    targetLabel,
    databaseId: resolvedDbId,
    canPromoteAlerts: resolvedDbId !== null,
    collectedAt: nowIso,
    windowSize,
    sigmaThreshold,
    snapshotCount: snapshots.length,
    points,
    vacuumAnomalyCount,
    bloatAnomalyCount,
    latestDeadTuplePct: latestPoint?.deadTuplePct ?? liveDeadPct,
    latestIndexBloatPct: latestPoint?.indexBloatPct ?? liveMaxBloatPct,
    totalVacuumCycles,
    suggestedAlerts: suggestedAlerts.slice(0, 8),
  };
}

export async function promoteTrendAlertToIncident(
  ownerUid: string,
  actorEmail: string,
  payload: {
    databaseId: string;
    incidentType: 'VACUUM_HEALTH' | 'INDEX_BLOAT';
    severity: SeverityLevel;
    fingerprint: string;
    summary: string;
    schemaname: string;
    tablename: string;
    indexname?: string;
    n_live_tup?: number;
    n_dead_tup?: number;
    dead_tuple_pct?: number;
    index_bytes?: number;
    index_size_pretty?: string;
    estimated_bloat_pct?: number;
  }
): Promise<{ incidentId: string; alreadyExists: boolean }> {
  const targetRows = await db
    .select()
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.id, payload.databaseId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!targetRows.length) {
    throw new Error('Target database not found.');
  }

  const target = targetRows[0];

  const existing = await db
    .select({ id: telemetryIncidents.id })
    .from(telemetryIncidents)
    .where(
      and(
        eq(telemetryIncidents.databaseId, target.id),
        eq(telemetryIncidents.fingerprint, payload.fingerprint),
        ne(telemetryIncidents.status, 'RESOLVED')
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return { incidentId: existing[0].id, alreadyExists: true };
  }

  let details: IncidentDetails;
  if (payload.incidentType === 'VACUUM_HEALTH') {
    const vacDetails: VacuumHealthDetails = {
      summary: payload.summary,
      schemaname: payload.schemaname,
      relname: payload.tablename,
      n_live_tup: payload.n_live_tup ?? 0,
      n_dead_tup: payload.n_dead_tup ?? 0,
      dead_tuple_pct: payload.dead_tuple_pct ?? 0,
      remediation_sql: buildVacuumAnalyzeSql(
        payload.schemaname,
        payload.tablename
      ),
    };
    details = vacDetails;
  } else {
    const idxName = payload.indexname || `${payload.tablename}_idx`;
    const bloatDetails: IndexBloatDetails = {
      summary: payload.summary,
      schemaname: payload.schemaname,
      tablename: payload.tablename,
      indexname: idxName,
      index_size_pretty:
        payload.index_size_pretty ??
        formatBytesPretty(payload.index_bytes ?? 0),
      index_bytes: payload.index_bytes ?? 0,
      estimated_bloat_pct: payload.estimated_bloat_pct ?? 0,
      remediation_sql: buildRemediationReindexSql(payload.schemaname, idxName),
    };
    details = bloatDetails;
  }

  const [created] = await db
    .insert(telemetryIncidents)
    .values({
      databaseId: target.id,
      incidentType: payload.incidentType,
      severity: payload.severity,
      fingerprint: payload.fingerprint,
      details,
      status: 'OPEN',
    })
    .returning();

  await dispatchIncidentAlerts(ownerUid, {
    databaseName: target.name,
    environment: target.environment,
    incidentType: payload.incidentType,
    severity: payload.severity,
    summary: payload.summary,
    details,
    timestamp: created.createdAt.toISOString(),
  }).catch(() => undefined);

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'TREND_ANOMALY_PROMOTED',
    entityType: 'telemetry_incident',
    entityLabel: `${target.name} · ${payload.incidentType}`,
    summary: `Promoted sliding-window trend anomaly to ${payload.severity} incident: ${payload.summary}`,
  });

  return { incidentId: created.id, alreadyExists: false };
}
