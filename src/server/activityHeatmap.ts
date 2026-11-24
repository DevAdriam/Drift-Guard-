import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  monitoredDatabases,
  queryLatencySamples,
  telemetryIncidents,
  telemetrySnapshots,
} from '../db/schema.ts';
import type {
  ActivityHeatmapBucketMeta,
  ActivityHeatmapCell,
  ActivityHeatmapResponse,
  ActivityHeatmapTargetRow,
  EnvironmentType,
  HealthStatus,
  IncidentType,
} from '../types/telemetry.ts';

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 24;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatHourRange(
  bucketStartUtcMs: number,
  tzOffsetMinutes: number
): { hourLabel: string; rangeLabel: string } {
  // JS getTimezoneOffset() is UTC - local in minutes (e.g., +480 for UTC-8, -390 for UTC+6:30)
  const localStart = new Date(bucketStartUtcMs - tzOffsetMinutes * 60_000);
  const localEnd = new Date(
    bucketStartUtcMs + HOUR_MS - tzOffsetMinutes * 60_000
  );
  const startH = pad2(localStart.getUTCHours());
  const startM = pad2(localStart.getUTCMinutes());
  const endH = pad2(localEnd.getUTCHours());
  const endM = pad2(localEnd.getUTCMinutes());
  const hourLabel = startM === '00' ? `${startH}:00` : `${startH}:${startM}`;
  const rangeLabel = `${startH}:${startM} – ${endH}:${endM}`;
  return { hourLabel, rangeLabel };
}

function computeActivityLevel(score: number, maxScore: number): 0 | 1 | 2 | 3 | 4 {
  if (score <= 0 || maxScore <= 0) return 0;
  const ratio = score / maxScore;
  if (ratio <= 0.22) return 1;
  if (ratio <= 0.48) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function computeErrorLevel(
  errorRatePct: number,
  incidentsCount: number,
  criticalCount: number
): 0 | 1 | 2 | 3 | 4 {
  if (incidentsCount === 0 && errorRatePct <= 0) return 0;
  if (criticalCount >= 2 || errorRatePct >= 60) return 4;
  if (criticalCount >= 1 || errorRatePct >= 35) return 3;
  if (incidentsCount >= 2 || errorRatePct >= 15) return 2;
  return 1;
}

interface RawBucketAccumulator {
  inspectionsCount: number;
  querySamplesCount: number;
  queryCalls: number;
  auditEventsCount: number;
  activeLocksSum: number;
  connPctSum: number;
  connPctSamples: number;
  incidentsCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  incidentTypeCounts: Map<IncidentType, number>;
}

function createEmptyAccumulator(): RawBucketAccumulator {
  return {
    inspectionsCount: 0,
    querySamplesCount: 0,
    queryCalls: 0,
    auditEventsCount: 0,
    activeLocksSum: 0,
    connPctSum: 0,
    connPctSamples: 0,
    incidentsCount: 0,
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    incidentTypeCounts: new Map(),
  };
}

function pickTopIncidentType(
  counts: Map<IncidentType, number>
): IncidentType | null {
  let bestType: IncidentType | null = null;
  let bestCount = 0;
  for (const [type, count] of counts.entries()) {
    if (count > bestCount) {
      bestType = type;
      bestCount = count;
    }
  }
  return bestType;
}

export async function getDashboardActivityHeatmap(
  ownerUid: string,
  tzOffsetMinutesRaw?: number
): Promise<ActivityHeatmapResponse> {
  const tzOffsetMinutes =
    typeof tzOffsetMinutesRaw === 'number' && Number.isFinite(tzOffsetMinutesRaw)
      ? Math.max(-840, Math.min(840, Math.round(tzOffsetMinutesRaw)))
      : 0;

  const nowMs = Date.now();
  const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const windowStartMs = currentHourStartMs - (WINDOW_HOURS - 1) * HOUR_MS;
  const windowStartDate = new Date(windowStartMs);

  const buckets: ActivityHeatmapBucketMeta[] = Array.from(
    { length: WINDOW_HOURS },
    (_, index) => {
      const startMs = windowStartMs + index * HOUR_MS;
      const endMs = startMs + HOUR_MS;
      const { hourLabel, rangeLabel } = formatHourRange(
        startMs,
        tzOffsetMinutes
      );
      return {
        index,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
        hourLabel,
        rangeLabel,
      };
    }
  );

  const dbs = await db
    .select()
    .from(monitoredDatabases)
    .where(eq(monitoredDatabases.ownerUid, ownerUid))
    .orderBy(desc(monitoredDatabases.createdAt));

  if (dbs.length === 0) {
    const emptyFleetCells: ActivityHeatmapCell[] = buckets.map((b) => ({
      bucketIndex: b.index,
      activityCount: 0,
      activityLevel: 0,
      inspectionsCount: 0,
      queryCalls: 0,
      avgConnectionPct: null,
      incidentsCount: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      errorRatePct: 0,
      errorLevel: 0,
      topIncidentType: null,
    }));

    return {
      generatedAt: new Date(nowMs).toISOString(),
      windowHours: WINDOW_HOURS,
      buckets,
      targets: [],
      fleetTotals: emptyFleetCells,
      summary: {
        totalActivityEvents24h: 0,
        totalInspections24h: 0,
        totalIncidents24h: 0,
        totalCritical24h: 0,
        overallErrorRatePct: 0,
        activeTargetsCount: 0,
        peakIncidentBucketIndex: null,
        peakIncidentRangeLabel: null,
        peakIncidentCount: 0,
        peakErrorRatePct: 0,
        peakActivityBucketIndex: null,
        peakActivityRangeLabel: null,
        peakActivityCount: 0,
        hasLiveData: false,
      },
    };
  }

  const dbIds = dbs.map((d) => d.id);
  const dbNameToId = new Map<string, string>();
  for (const d of dbs) {
    dbNameToId.set(d.name, d.id);
  }

  const [snapshots, incidents, latencySamples, recentAudits] =
    await Promise.all([
      db
        .select({
          databaseId: telemetrySnapshots.databaseId,
          activeLocksCount: telemetrySnapshots.activeLocksCount,
          bloatedIndexesCount: telemetrySnapshots.bloatedIndexesCount,
          healthJson: telemetrySnapshots.healthJson,
          inspectedAt: telemetrySnapshots.inspectedAt,
        })
        .from(telemetrySnapshots)
        .where(
          and(
            inArray(telemetrySnapshots.databaseId, dbIds),
            gte(telemetrySnapshots.inspectedAt, windowStartDate)
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
            gte(telemetryIncidents.createdAt, windowStartDate)
          )
        ),
      db
        .select({
          databaseId: queryLatencySamples.databaseId,
          calls: queryLatencySamples.calls,
          sampledAt: queryLatencySamples.sampledAt,
        })
        .from(queryLatencySamples)
        .where(
          and(
            eq(queryLatencySamples.ownerUid, ownerUid),
            gte(queryLatencySamples.sampledAt, windowStartDate)
          )
        ),
      db
        .select({
          entityLabel: auditLogs.entityLabel,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.ownerUid, ownerUid),
            gte(auditLogs.createdAt, windowStartDate)
          )
        ),
    ]);

  const toBucketIndex = (dt: Date): number => {
    const idx = Math.floor((dt.getTime() - windowStartMs) / HOUR_MS);
    if (idx < 0 || idx >= WINDOW_HOURS) return -1;
    return idx;
  };

  const targetAccMap = new Map<string, RawBucketAccumulator[]>();
  for (const d of dbs) {
    targetAccMap.set(
      d.id,
      Array.from({ length: WINDOW_HOURS }, () => createEmptyAccumulator())
    );
  }
  const fleetAcc = Array.from({ length: WINDOW_HOURS }, () =>
    createEmptyAccumulator()
  );

  for (const snap of snapshots) {
    const idx = toBucketIndex(snap.inspectedAt);
    if (idx < 0) continue;
    const tAcc = targetAccMap.get(snap.databaseId)?.[idx];
    const fAcc = fleetAcc[idx];
    if (!tAcc) continue;

    const connPct = snap.healthJson?.connection_usage_pct;
    for (const acc of [tAcc, fAcc]) {
      acc.inspectionsCount += 1;
      acc.activeLocksSum += snap.activeLocksCount;
      if (typeof connPct === 'number' && Number.isFinite(connPct)) {
        acc.connPctSum += connPct;
        acc.connPctSamples += 1;
      }
    }
  }

  for (const inc of incidents) {
    const idx = toBucketIndex(inc.createdAt);
    if (idx < 0) continue;
    const tAcc = targetAccMap.get(inc.databaseId)?.[idx];
    const fAcc = fleetAcc[idx];
    if (!tAcc) continue;

    const incType = inc.incidentType as IncidentType;
    for (const acc of [tAcc, fAcc]) {
      acc.incidentsCount += 1;
      if (inc.severity === 'CRITICAL') acc.criticalCount += 1;
      else if (inc.severity === 'WARNING') acc.warningCount += 1;
      else acc.infoCount += 1;
      acc.incidentTypeCounts.set(
        incType,
        (acc.incidentTypeCounts.get(incType) ?? 0) + 1
      );
    }
  }

  const workspaceDb = dbs.find((d) => d.connectionMode === 'workspace_pg');
  for (const sample of latencySamples) {
    const idx = toBucketIndex(sample.sampledAt);
    if (idx < 0) continue;
    const resolvedDbId = sample.databaseId ?? workspaceDb?.id ?? null;
    const tAcc = resolvedDbId ? targetAccMap.get(resolvedDbId)?.[idx] : null;
    const fAcc = fleetAcc[idx];

    if (tAcc) {
      tAcc.querySamplesCount += 1;
      tAcc.queryCalls += Math.max(0, sample.calls);
    }
    fAcc.querySamplesCount += 1;
    fAcc.queryCalls += Math.max(0, sample.calls);
  }

  for (const audit of recentAudits) {
    const idx = toBucketIndex(audit.createdAt);
    if (idx < 0) continue;
    const matchedDbId = dbNameToId.get(audit.entityLabel);
    if (matchedDbId) {
      const tAcc = targetAccMap.get(matchedDbId)?.[idx];
      if (tAcc) tAcc.auditEventsCount += 1;
    }
    fleetAcc[idx].auditEventsCount += 1;
  }

  // Compute activity scores to normalize intensity consistently across targets
  const activityScoreOf = (acc: RawBucketAccumulator): number => {
    const baseEvents =
      acc.inspectionsCount +
      acc.querySamplesCount +
      acc.auditEventsCount +
      acc.incidentsCount;
    const queryWeight =
      acc.queryCalls > 0 ? Math.min(6, Math.ceil(Math.log10(acc.queryCalls + 1))) : 0;
    const connWeight =
      acc.connPctSamples > 0
        ? Math.round(acc.connPctSum / acc.connPctSamples / 25)
        : 0;
    return baseEvents + queryWeight + connWeight;
  };

  let maxTargetScore = 0;
  for (const accList of targetAccMap.values()) {
    for (const acc of accList) {
      const s = activityScoreOf(acc);
      if (s > maxTargetScore) maxTargetScore = s;
    }
  }

  let maxFleetScore = 0;
  for (const acc of fleetAcc) {
    const s = activityScoreOf(acc);
    if (s > maxFleetScore) maxFleetScore = s;
  }

  const buildCell = (
    acc: RawBucketAccumulator,
    bucketIndex: number,
    maxScore: number
  ): ActivityHeatmapCell => {
    const activityCount =
      acc.inspectionsCount +
      acc.querySamplesCount +
      acc.auditEventsCount +
      acc.incidentsCount;
    const score = activityScoreOf(acc);
    const denominator = Math.max(
      1,
      acc.inspectionsCount + acc.querySamplesCount + acc.incidentsCount
    );
    const errorRatePct =
      acc.incidentsCount > 0
        ? Math.min(
            100,
            Math.round((acc.incidentsCount / denominator) * 1000) / 10
          )
        : 0;

    return {
      bucketIndex,
      activityCount,
      activityLevel: computeActivityLevel(score, maxScore),
      inspectionsCount: acc.inspectionsCount,
      queryCalls: acc.queryCalls,
      avgConnectionPct:
        acc.connPctSamples > 0
          ? Math.round((acc.connPctSum / acc.connPctSamples) * 10) / 10
          : null,
      incidentsCount: acc.incidentsCount,
      criticalCount: acc.criticalCount,
      warningCount: acc.warningCount,
      infoCount: acc.infoCount,
      errorRatePct,
      errorLevel: computeErrorLevel(
        errorRatePct,
        acc.incidentsCount,
        acc.criticalCount
      ),
      topIncidentType: pickTopIncidentType(acc.incidentTypeCounts),
    };
  };

  const targetRows: ActivityHeatmapTargetRow[] = dbs.map((d) => {
    const accList = targetAccMap.get(d.id)!;
    const cells = accList.map((acc, idx) =>
      buildCell(acc, idx, Math.max(1, maxTargetScore))
    );
    const totalActivity24h = cells.reduce((s, c) => s + c.activityCount, 0);
    const totalIncidents24h = cells.reduce((s, c) => s + c.incidentsCount, 0);
    const totalInspections24h = cells.reduce(
      (s, c) => s + c.inspectionsCount,
      0
    );
    const totalSamples = accList.reduce((s, a) => s + a.querySamplesCount, 0);
    const denom = Math.max(
      1,
      totalInspections24h + totalSamples + totalIncidents24h
    );
    const avgErrorRatePct =
      totalIncidents24h > 0
        ? Math.min(100, Math.round((totalIncidents24h / denom) * 1000) / 10)
        : 0;

    let peakErrorBucketIndex: number | null = null;
    let peakScore = 0;
    for (const c of cells) {
      const weight = c.incidentsCount * 100 + c.criticalCount * 50 + c.errorRatePct;
      if (c.incidentsCount > 0 && weight > peakScore) {
        peakScore = weight;
        peakErrorBucketIndex = c.bucketIndex;
      }
    }

    return {
      databaseId: d.id,
      name: d.name,
      environment: d.environment as EnvironmentType,
      lastHealthStatus: d.lastHealthStatus as HealthStatus,
      totalActivity24h,
      totalIncidents24h,
      avgErrorRatePct,
      peakErrorBucketIndex,
      cells,
    };
  });

  const fleetTotals = fleetAcc.map((acc, idx) =>
    buildCell(acc, idx, Math.max(1, maxFleetScore))
  );

  const totalActivityEvents24h = fleetTotals.reduce(
    (s, c) => s + c.activityCount,
    0
  );
  const totalInspections24h = fleetTotals.reduce(
    (s, c) => s + c.inspectionsCount,
    0
  );
  const totalIncidents24h = fleetTotals.reduce(
    (s, c) => s + c.incidentsCount,
    0
  );
  const totalCritical24h = fleetTotals.reduce((s, c) => s + c.criticalCount, 0);
  const fleetQuerySamples = fleetAcc.reduce(
    (s, a) => s + a.querySamplesCount,
    0
  );
  const overallDenom = Math.max(
    1,
    totalInspections24h + fleetQuerySamples + totalIncidents24h
  );
  const overallErrorRatePct =
    totalIncidents24h > 0
      ? Math.min(100, Math.round((totalIncidents24h / overallDenom) * 1000) / 10)
      : 0;

  let peakIncidentBucketIndex: number | null = null;
  let peakIncidentScore = 0;
  let peakIncidentCount = 0;
  let peakErrorRatePct = 0;

  let peakActivityBucketIndex: number | null = null;
  let peakActivityCount = 0;

  for (const cell of fleetTotals) {
    const incWeight =
      cell.incidentsCount * 100 + cell.criticalCount * 50 + cell.errorRatePct;
    if (cell.incidentsCount > 0 && incWeight > peakIncidentScore) {
      peakIncidentScore = incWeight;
      peakIncidentBucketIndex = cell.bucketIndex;
      peakIncidentCount = cell.incidentsCount;
      peakErrorRatePct = cell.errorRatePct;
    }

    if (cell.activityCount > peakActivityCount) {
      peakActivityCount = cell.activityCount;
      peakActivityBucketIndex = cell.bucketIndex;
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: WINDOW_HOURS,
    buckets,
    targets: targetRows,
    fleetTotals,
    summary: {
      totalActivityEvents24h,
      totalInspections24h,
      totalIncidents24h,
      totalCritical24h,
      overallErrorRatePct,
      activeTargetsCount: targetRows.filter((r) => r.totalActivity24h > 0).length,
      peakIncidentBucketIndex,
      peakIncidentRangeLabel:
        peakIncidentBucketIndex !== null
          ? buckets[peakIncidentBucketIndex].rangeLabel
          : null,
      peakIncidentCount,
      peakErrorRatePct,
      peakActivityBucketIndex,
      peakActivityRangeLabel:
        peakActivityBucketIndex !== null
          ? buckets[peakActivityBucketIndex].rangeLabel
          : null,
      peakActivityCount,
      hasLiveData: totalActivityEvents24h > 0 || totalIncidents24h > 0,
    },
  };
}
