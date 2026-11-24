import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Eye, RefreshCw } from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  ActivityHeatmapBucketMeta,
  ActivityHeatmapCell,
  ActivityHeatmapResponse,
  ActivityHeatmapTargetRow,
  EnvironmentType,
  IncidentType,
  MonitoredDatabaseDto,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

type HeatmapMetricMode = 'combined' | 'activity' | 'errors';

interface ActivityHeatmapCardProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  envFilter: 'all' | EnvironmentType;
  refreshKey: number;
  onSelectDatabase: (databaseId: string) => void;
  onViewIncidents: () => void;
  onInspectAll?: () => void;
}

interface SelectedCellRef {
  rowKey: string; // databaseId or 'fleet'
  bucketIndex: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function buildPreviewHeatmap(
  databases: MonitoredDatabaseDto[]
): ActivityHeatmapResponse {
  const hourMs = 3_600_000;
  const nowMs = Date.now();
  const currentHourStart = Math.floor(nowMs / hourMs) * hourMs;
  const windowStart = currentHourStart - 23 * hourMs;

  const buckets: ActivityHeatmapBucketMeta[] = Array.from(
    { length: 24 },
    (_, index) => {
      const startDate = new Date(windowStart + index * hourMs);
      const endDate = new Date(windowStart + (index + 1) * hourMs);
      const startH = pad2(startDate.getHours());
      const endH = pad2(endDate.getHours());
      return {
        index,
        startIso: startDate.toISOString(),
        endIso: endDate.toISOString(),
        hourLabel: `${startH}:00`,
        rangeLabel: `${startH}:00 – ${endH}:00`,
      };
    }
  );

  const previewSpecs: {
    databaseId: string;
    name: string;
    environment: EnvironmentType;
    peakShift: number;
    incidentTypes: IncidentType[];
  }[] =
    databases.length > 0
      ? databases.slice(0, 5).map((db, idx) => ({
          databaseId: db.id,
          name: db.name,
          environment: db.environment,
          peakShift: idx % 3,
          incidentTypes:
            idx % 2 === 0
              ? ['LOCK_CONTENTION', 'SCHEMA_DRIFT', 'CONNECTION_SATURATION']
              : ['INDEX_BLOAT', 'VACUUM_HEALTH', 'LOCK_CONTENTION'],
        }))
      : [
          {
            databaseId: 'preview-prod-orders',
            name: 'orders-primary-pg',
            environment: 'production',
            peakShift: 0,
            incidentTypes: [
              'LOCK_CONTENTION',
              'SCHEMA_DRIFT',
              'CONNECTION_SATURATION',
            ],
          },
          {
            databaseId: 'preview-prod-billing',
            name: 'billing-ledger-pg',
            environment: 'production',
            peakShift: 1,
            incidentTypes: ['VACUUM_HEALTH', 'INDEX_BLOAT', 'LOCK_CONTENTION'],
          },
          {
            databaseId: 'preview-staging-core',
            name: 'core-api-staging',
            environment: 'staging',
            peakShift: 2,
            incidentTypes: ['SCHEMA_DRIFT', 'INDEX_BLOAT', 'VACUUM_HEALTH'],
          },
        ];

  const targets: ActivityHeatmapTargetRow[] = previewSpecs.map(
    (spec, rowIdx) => {
      const cells: ActivityHeatmapCell[] = buckets.map((b) => {
        const i = b.index;
        // Realistic diurnal business-hour wave with a pronounced incident cluster around hours 17–19
        const diurnal = Math.max(
          1,
          Math.round(
            4 +
              Math.sin(((i - 5 + spec.peakShift) / 24) * Math.PI * 2) * 5 +
              (i >= 14 && i <= 20 ? 5 : 0)
          )
        );
        const inspectionsCount = Math.max(1, Math.round(diurnal * 0.6));
        const queryCalls = Math.round(
          (diurnal * 1450 + rowIdx * 620) * (i >= 15 && i <= 20 ? 1.8 : 1)
        );
        const avgConnectionPct = Math.min(
          94,
          Math.round((28 + diurnal * 4.2 + rowIdx * 3) * 10) / 10
        );

        let incidentsCount = 0;
        let criticalCount = 0;
        let warningCount = 0;
        let infoCount = 0;
        let topIncidentType: IncidentType | null = null;

        if (i === 18 && rowIdx <= 1) {
          incidentsCount = rowIdx === 0 ? 4 : 3;
          criticalCount = rowIdx === 0 ? 2 : 1;
          warningCount = 2;
          topIncidentType = spec.incidentTypes[0];
        } else if (i === 17 && rowIdx === 0) {
          incidentsCount = 3;
          criticalCount = 1;
          warningCount = 2;
          topIncidentType = spec.incidentTypes[1];
        } else if (i === 19 && rowIdx !== 2) {
          incidentsCount = 2;
          warningCount = 2;
          topIncidentType = spec.incidentTypes[2];
        } else if ((i === 11 || i === 22) && rowIdx === 2) {
          incidentsCount = i === 11 ? 2 : 1;
          warningCount = 1;
          infoCount = i === 11 ? 1 : 0;
          topIncidentType = spec.incidentTypes[0];
        } else if (i === 6 && rowIdx === 1) {
          incidentsCount = 1;
          infoCount = 1;
          topIncidentType = 'VACUUM_HEALTH';
        }

        const activityCount = inspectionsCount + incidentsCount + Math.round(diurnal / 3);
        const errorRatePct =
          incidentsCount > 0
            ? Math.min(
                100,
                Math.round(
                  (incidentsCount / Math.max(1, inspectionsCount + incidentsCount)) *
                    1000
                ) / 10
              )
            : 0;
        const activityLevel: 0 | 1 | 2 | 3 | 4 =
          activityCount >= 12
            ? 4
            : activityCount >= 9
              ? 3
              : activityCount >= 6
                ? 2
                : activityCount > 0
                  ? 1
                  : 0;
        const errorLevel: 0 | 1 | 2 | 3 | 4 =
          incidentsCount === 0
            ? 0
            : criticalCount >= 2 || errorRatePct >= 45
              ? 4
              : criticalCount >= 1 || errorRatePct >= 30
                ? 3
                : incidentsCount >= 2 || errorRatePct >= 15
                  ? 2
                  : 1;

        return {
          bucketIndex: i,
          activityCount,
          activityLevel,
          inspectionsCount,
          queryCalls,
          avgConnectionPct,
          incidentsCount,
          criticalCount,
          warningCount,
          infoCount,
          errorRatePct,
          errorLevel,
          topIncidentType,
        };
      });

      const totalActivity24h = cells.reduce((s, c) => s + c.activityCount, 0);
      const totalIncidents24h = cells.reduce((s, c) => s + c.incidentsCount, 0);
      const totalInspections = cells.reduce((s, c) => s + c.inspectionsCount, 0);
      const avgErrorRatePct =
        totalIncidents24h > 0
          ? Math.round(
              (totalIncidents24h /
                Math.max(1, totalInspections + totalIncidents24h)) *
                1000
            ) / 10
          : 0;

      let peakErrorBucketIndex: number | null = null;
      let bestScore = 0;
      for (const c of cells) {
        const w = c.incidentsCount * 100 + c.criticalCount * 50 + c.errorRatePct;
        if (c.incidentsCount > 0 && w > bestScore) {
          bestScore = w;
          peakErrorBucketIndex = c.bucketIndex;
        }
      }

      return {
        databaseId: spec.databaseId,
        name: spec.name,
        environment: spec.environment,
        lastHealthStatus: totalIncidents24h >= 3 ? 'WARNING' : 'HEALTHY',
        totalActivity24h,
        totalIncidents24h,
        avgErrorRatePct,
        peakErrorBucketIndex,
        cells,
      };
    }
  );

  const fleetTotals: ActivityHeatmapCell[] = buckets.map((b) => {
    const col = targets.map((t) => t.cells[b.index]);
    const activityCount = col.reduce((s, c) => s + c.activityCount, 0);
    const inspectionsCount = col.reduce((s, c) => s + c.inspectionsCount, 0);
    const queryCalls = col.reduce((s, c) => s + c.queryCalls, 0);
    const incidentsCount = col.reduce((s, c) => s + c.incidentsCount, 0);
    const criticalCount = col.reduce((s, c) => s + c.criticalCount, 0);
    const warningCount = col.reduce((s, c) => s + c.warningCount, 0);
    const infoCount = col.reduce((s, c) => s + c.infoCount, 0);
    const connVals = col
      .map((c) => c.avgConnectionPct)
      .filter((v): v is number => v !== null);
    const avgConnectionPct =
      connVals.length > 0
        ? Math.round(
            (connVals.reduce((s, v) => s + v, 0) / connVals.length) * 10
          ) / 10
        : null;
    const errorRatePct =
      incidentsCount > 0
        ? Math.min(
            100,
            Math.round(
              (incidentsCount / Math.max(1, inspectionsCount + incidentsCount)) *
                1000
            ) / 10
          )
        : 0;
    const topIncidentType =
      col.find((c) => c.criticalCount > 0)?.topIncidentType ??
      col.find((c) => c.topIncidentType)?.topIncidentType ??
      null;

    return {
      bucketIndex: b.index,
      activityCount,
      activityLevel:
        activityCount >= 32
          ? 4
          : activityCount >= 22
            ? 3
            : activityCount >= 14
              ? 2
              : activityCount > 0
                ? 1
                : 0,
      inspectionsCount,
      queryCalls,
      avgConnectionPct,
      incidentsCount,
      criticalCount,
      warningCount,
      infoCount,
      errorRatePct,
      errorLevel:
        incidentsCount === 0
          ? 0
          : criticalCount >= 2 || errorRatePct >= 35
            ? 4
            : criticalCount >= 1 || errorRatePct >= 22
              ? 3
              : incidentsCount >= 2
                ? 2
                : 1,
      topIncidentType,
    };
  });

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
  const overallErrorRatePct =
    Math.round(
      (totalIncidents24h /
        Math.max(1, totalInspections24h + totalIncidents24h)) *
        1000
    ) / 10;

  let peakIncidentBucketIndex = 18;
  let peakIncidentScore = 0;
  let peakActivityBucketIndex = 18;
  let peakActivityCount = 0;
  for (const c of fleetTotals) {
    const score = c.incidentsCount * 100 + c.criticalCount * 50 + c.errorRatePct;
    if (score > peakIncidentScore) {
      peakIncidentScore = score;
      peakIncidentBucketIndex = c.bucketIndex;
    }
    if (c.activityCount > peakActivityCount) {
      peakActivityCount = c.activityCount;
      peakActivityBucketIndex = c.bucketIndex;
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: 24,
    buckets,
    targets,
    fleetTotals,
    summary: {
      totalActivityEvents24h,
      totalInspections24h,
      totalIncidents24h,
      totalCritical24h,
      overallErrorRatePct,
      activeTargetsCount: targets.length,
      peakIncidentBucketIndex,
      peakIncidentRangeLabel: buckets[peakIncidentBucketIndex].rangeLabel,
      peakIncidentCount: fleetTotals[peakIncidentBucketIndex].incidentsCount,
      peakErrorRatePct: fleetTotals[peakIncidentBucketIndex].errorRatePct,
      peakActivityBucketIndex,
      peakActivityRangeLabel: buckets[peakActivityBucketIndex].rangeLabel,
      peakActivityCount,
      hasLiveData: true,
    },
  };
}

function getActivityCellClasses(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 4:
      return 'bg-blue-700 text-white border-blue-800/30';
    case 3:
      return 'bg-blue-500 text-white border-blue-600/20';
    case 2:
      return 'bg-blue-300 text-slate-900 border-blue-400/20';
    case 1:
      return 'bg-blue-100 text-blue-900 border-blue-200/70';
    default:
      return 'bg-slate-100 text-slate-400 border-slate-200/60';
  }
}

function getErrorCellClasses(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 4:
      return 'bg-red-700 text-white border-red-800/40';
    case 3:
      return 'bg-red-500 text-white border-red-600/30';
    case 2:
      return 'bg-amber-400 text-slate-950 border-amber-500/40';
    case 1:
      return 'bg-amber-100 text-amber-950 border-amber-300/70';
    default:
      return 'bg-slate-100 text-slate-400 border-slate-200/60';
  }
}

function getCombinedCellClasses(cell: ActivityHeatmapCell): string {
  if (cell.errorLevel >= 3) {
    return getErrorCellClasses(cell.errorLevel);
  }
  if (cell.errorLevel >= 1) {
    return cell.errorLevel === 2
      ? 'bg-amber-400 text-slate-950 border-amber-500/50'
      : 'bg-amber-200 text-amber-950 border-amber-400/60';
  }
  return getActivityCellClasses(cell.activityLevel);
}

export function ActivityHeatmapCard({
  api,
  databases,
  envFilter,
  refreshKey,
  onSelectDatabase,
  onViewIncidents,
  onInspectAll,
}: ActivityHeatmapCardProps) {
  const { locale, tr, formatEnv, formatIncidentType } = useI18n();

  const [liveData, setLiveData] = useState<ActivityHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metricMode, setMetricMode] = useState<HeatmapMetricMode>('combined');
  const [previewMode, setPreviewMode] = useState(false);
  const [hoveredCell, setHoveredCell] = useState<SelectedCellRef | null>(null);
  const [pinnedCell, setPinnedCell] = useState<SelectedCellRef | null>(null);

  const loadHeatmap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getActivityHeatmap();
      setLiveData(res);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Unable to load 24-hour activity heat map.',
              '၂၄ နာရီ လှုပ်ရှားမှု အပူပြဇယားကို ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, tr]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap, refreshKey]);

  const previewData = useMemo(
    () => (previewMode ? buildPreviewHeatmap(databases) : null),
    [previewMode, databases]
  );

  const activeData = previewMode ? previewData : liveData;

  // Apply dashboard environment filter consistently
  const visibleTargets = useMemo(() => {
    if (!activeData) return [];
    if (envFilter === 'all') return activeData.targets;
    return activeData.targets.filter((row) => row.environment === envFilter);
  }, [activeData, envFilter]);

  // Recompute fleet row + summary for currently filtered environments so KPIs match visible rows
  const filteredView = useMemo(() => {
    if (!activeData) return null;
    if (envFilter === 'all') {
      return {
        fleetTotals: activeData.fleetTotals,
        summary: activeData.summary,
      };
    }

    const fleetTotals: ActivityHeatmapCell[] = activeData.buckets.map((b) => {
      const col = visibleTargets.map((t) => t.cells[b.index]);
      const activityCount = col.reduce((s, c) => s + c.activityCount, 0);
      const inspectionsCount = col.reduce((s, c) => s + c.inspectionsCount, 0);
      const queryCalls = col.reduce((s, c) => s + c.queryCalls, 0);
      const incidentsCount = col.reduce((s, c) => s + c.incidentsCount, 0);
      const criticalCount = col.reduce((s, c) => s + c.criticalCount, 0);
      const warningCount = col.reduce((s, c) => s + c.warningCount, 0);
      const infoCount = col.reduce((s, c) => s + c.infoCount, 0);
      const connVals = col
        .map((c) => c.avgConnectionPct)
        .filter((v): v is number => v !== null);
      const avgConnectionPct =
        connVals.length > 0
          ? Math.round(
              (connVals.reduce((s, v) => s + v, 0) / connVals.length) * 10
            ) / 10
          : null;
      const errorRatePct =
        incidentsCount > 0
          ? Math.min(
              100,
              Math.round(
                (incidentsCount / Math.max(1, inspectionsCount + incidentsCount)) *
                  1000
              ) / 10
            )
          : 0;
      const topIncidentType =
        col.find((c) => c.criticalCount > 0)?.topIncidentType ??
        col.find((c) => c.topIncidentType)?.topIncidentType ??
        null;

      return {
        bucketIndex: b.index,
        activityCount,
        activityLevel: 0,
        inspectionsCount,
        queryCalls,
        avgConnectionPct,
        incidentsCount,
        criticalCount,
        warningCount,
        infoCount,
        errorRatePct,
        errorLevel:
          incidentsCount === 0
            ? 0
            : criticalCount >= 2 || errorRatePct >= 60
              ? 4
              : criticalCount >= 1 || errorRatePct >= 35
                ? 3
                : incidentsCount >= 2 || errorRatePct >= 15
                  ? 2
                  : 1,
        topIncidentType,
      };
    });

    const maxAct = fleetTotals.reduce(
      (m, c) => Math.max(m, c.activityCount),
      0
    );
    for (const c of fleetTotals) {
      if (c.activityCount <= 0 || maxAct <= 0) c.activityLevel = 0;
      else {
        const r = c.activityCount / maxAct;
        c.activityLevel = r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
      }
    }

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
    const overallErrorRatePct =
      totalIncidents24h > 0
        ? Math.min(
            100,
            Math.round(
              (totalIncidents24h /
                Math.max(1, totalInspections24h + totalIncidents24h)) *
                1000
            ) / 10
          )
        : 0;

    let peakIncidentBucketIndex: number | null = null;
    let peakIncidentScore = 0;
    let peakIncidentCount = 0;
    let peakErrorRatePct = 0;
    let peakActivityBucketIndex: number | null = null;
    let peakActivityCount = 0;

    for (const c of fleetTotals) {
      const w = c.incidentsCount * 100 + c.criticalCount * 50 + c.errorRatePct;
      if (c.incidentsCount > 0 && w > peakIncidentScore) {
        peakIncidentScore = w;
        peakIncidentBucketIndex = c.bucketIndex;
        peakIncidentCount = c.incidentsCount;
        peakErrorRatePct = c.errorRatePct;
      }
      if (c.activityCount > peakActivityCount) {
        peakActivityCount = c.activityCount;
        peakActivityBucketIndex = c.bucketIndex;
      }
    }

    return {
      fleetTotals,
      summary: {
        totalActivityEvents24h,
        totalInspections24h,
        totalIncidents24h,
        totalCritical24h,
        overallErrorRatePct,
        activeTargetsCount: visibleTargets.filter((t) => t.totalActivity24h > 0)
          .length,
        peakIncidentBucketIndex,
        peakIncidentRangeLabel:
          peakIncidentBucketIndex !== null
            ? activeData.buckets[peakIncidentBucketIndex].rangeLabel
            : null,
        peakIncidentCount,
        peakErrorRatePct,
        peakActivityBucketIndex,
        peakActivityRangeLabel:
          peakActivityBucketIndex !== null
            ? activeData.buckets[peakActivityBucketIndex].rangeLabel
            : null,
        peakActivityCount,
        hasLiveData: totalActivityEvents24h > 0 || totalIncidents24h > 0,
      },
    };
  }, [activeData, envFilter, visibleTargets]);

  const activeCellRef: SelectedCellRef | null = useMemo(() => {
    if (hoveredCell) return hoveredCell;
    if (pinnedCell) return pinnedCell;
    if (!filteredView || !activeData) return null;
    const defaultBucket =
      filteredView.summary.peakIncidentBucketIndex ??
      filteredView.summary.peakActivityBucketIndex ??
      23;
    return { rowKey: 'fleet', bucketIndex: defaultBucket };
  }, [hoveredCell, pinnedCell, filteredView, activeData]);

  const inspectedDetails = useMemo(() => {
    if (!activeCellRef || !activeData || !filteredView) return null;
    const bucket = activeData.buckets[activeCellRef.bucketIndex];
    if (!bucket) return null;

    if (activeCellRef.rowKey === 'fleet') {
      const cell = filteredView.fleetTotals[activeCellRef.bucketIndex];
      return {
        rowName: tr('All Targets (Fleet Rollup)', 'ဒေတာဘေ့စ်အားလုံး စုပေါင်း'),
        databaseId: null as string | null,
        environment: null as EnvironmentType | null,
        bucket,
        cell,
      };
    }

    const row = visibleTargets.find(
      (r) => r.databaseId === activeCellRef.rowKey
    );
    if (!row) {
      const fallbackCell = filteredView.fleetTotals[activeCellRef.bucketIndex];
      return {
        rowName: tr('All Targets (Fleet Rollup)', 'ဒေတာဘေ့စ်အားလုံး စုပေါင်း'),
        databaseId: null as string | null,
        environment: null as EnvironmentType | null,
        bucket,
        cell: fallbackCell,
      };
    }

    return {
      rowName: row.name,
      databaseId: row.databaseId,
      environment: row.environment,
      bucket,
      cell: row.cells[activeCellRef.bucketIndex],
    };
  }, [activeCellRef, activeData, filteredView, visibleTargets, tr]);

  const peakIncidentCol = filteredView?.summary.peakIncidentBucketIndex ?? null;

  const renderCellClasses = (cell: ActivityHeatmapCell): string => {
    if (metricMode === 'activity') return getActivityCellClasses(cell.activityLevel);
    if (metricMode === 'errors') return getErrorCellClasses(cell.errorLevel);
    return getCombinedCellClasses(cell);
  };

  const renderCellLabel = (cell: ActivityHeatmapCell): string => {
    if (metricMode === 'errors') {
      if (cell.incidentsCount > 0) return String(cell.incidentsCount);
      return '';
    }
    if (metricMode === 'combined') {
      if (cell.incidentsCount > 0) return String(cell.incidentsCount);
      return '';
    }
    if (cell.activityCount >= 10) return String(cell.activityCount);
    return '';
  };

  const isCellSelected = (rowKey: string, bucketIndex: number): boolean =>
    pinnedCell?.rowKey === rowKey && pinnedCell?.bucketIndex === bucketIndex;

  const handleTogglePin = (rowKey: string, bucketIndex: number) => {
    setPinnedCell((prev) =>
      prev && prev.rowKey === rowKey && prev.bucketIndex === bucketIndex
        ? null
        : { rowKey, bucketIndex }
    );
  };

  const isPreviewTargetId = (id: string | null) =>
    !id || id.startsWith('preview-');

  return (
    <section
      aria-labelledby="activity-heatmap-heading"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
    >
      {/* Header & Controls */}
      <div className="px-6 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2
              id="activity-heatmap-heading"
              className="text-base font-semibold text-slate-900"
            >
              {tr(
                '24-Hour Target Activity & Error Heat Map',
                '၂၄ နာရီ ဒေတာဘေ့စ် လှုပ်ရှားမှုနှင့် အမှားနှုန်း အပူပြဇယား'
              )}
            </h2>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500 tabular-nums">
              {tr('Rolling 24h · Local Time', 'ပြီးခဲ့သော ၂၄ နာရီ · ဒေသစံတော်ချိန်')}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {tr(
              'Hourly PostgreSQL inspection activity, query load, and incident error rates across targets to pinpoint peak incident windows.',
              'သတိပေးချက် အဖြစ်အများဆုံး အချိန်များကို ရှာဖွေနိုင်ရန် PostgreSQL ဒေတာဘေ့စ်အလိုက် နာရီအလိုက် လှုပ်ရှားမှုနှင့် အမှားနှုန်းများကို ပြသထားပါသည်။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Metric Mode Segmented Switch */}
          <div
            role="group"
            aria-label={tr('Heat map metric mode', 'အပူပြဇယား ပြသမှု ပုံစံ')}
            className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            {(
              [
                {
                  id: 'combined' as const,
                  label: tr('Combined', 'ပေါင်းစပ်'),
                },
                {
                  id: 'activity' as const,
                  label: tr('Activity', 'လှုပ်ရှားမှု'),
                },
                {
                  id: 'errors' as const,
                  label: tr('Error Rate', 'အမှားနှုန်း'),
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMetricMode(opt.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  metricMode === opt.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setPreviewMode((prev) => !prev);
              setPinnedCell(null);
              setHoveredCell(null);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              previewMode
                ? 'bg-blue-50 text-blue-800 border-blue-200 hover:bg-blue-100'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>
              {previewMode
                ? tr('Live Data', 'တိုက်ရိုက်ဒေတာ')
                : tr('Preview 24h Pattern', '၂၄ နာရီ ပုံစံ အစမ်းကြည့်ရန်')}
            </span>
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setPreviewMode(false);
              loadHeatmap();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            <span>{tr('Refresh', 'ပြန်စစ်ရန်')}</span>
          </button>
        </div>
      </div>

      {/* Preview Mode Banner */}
      {previewMode && (
        <div className="px-6 py-2.5 bg-blue-50/70 border-b border-blue-200/80 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-900">
          <span>
            {tr(
              'Viewing sample 24-hour multi-target incident pattern preview. Switch back to Live Data to inspect your persisted PostgreSQL telemetry.',
              'နမူနာ ၂၄ နာရီ ဒေတာဘေ့စ် လှုပ်ရှားမှုနှင့် သတိပေးချက် ပုံစံကို အစမ်းကြည့်ရှုနေပါသည်။ သင့်လက်ရှိ PostgreSQL မှတ်တမ်းအစစ်ကို ကြည့်ရန် တိုက်ရိုက်ဒေတာသို့ ပြန်ပြောင်းပါ။'
            )}
          </span>
          <button
            type="button"
            onClick={() => setPreviewMode(false)}
            className="font-semibold text-blue-800 hover:text-blue-950 underline underline-offset-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {tr('Return to Live Data', 'တိုက်ရိုက်ဒေတာသို့ ပြန်သွားရန်')}
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && !previewMode ? (
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-14 bg-slate-100 rounded-lg animate-pulse"
              />
            ))}
          </div>
          <div className="space-y-2.5">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-7 bg-slate-100 rounded animate-pulse"
              />
            ))}
          </div>
        </div>
      ) : error && !previewMode ? (
        <div className="p-6">
          <div
            role="alert"
            className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 flex flex-wrap items-center justify-between gap-3"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={loadHeatmap}
              className="px-3 py-1.5 text-xs font-medium text-red-900 bg-white border border-red-200 hover:bg-red-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              {tr('Retry', 'ပြန်စမ်းရန်')}
            </button>
          </div>
        </div>
      ) : !activeData || !filteredView ? null : visibleTargets.length === 0 ? (
        <div className="p-8 text-center space-y-2.5">
          <p className="text-sm font-semibold text-slate-900">
            {tr(
              'No targets in this environment filter',
              'ဤပတ်ဝန်းကျင် စစ်ထုတ်မှုတွင် ဒေတာဘေ့စ် မရှိသေးပါ'
            )}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            {tr(
              'Register a PostgreSQL target or run an inspection to populate the 24-hour activity and incident heat map.',
              '၂၄ နာရီ လှုပ်ရှားမှုနှင့် သတိပေးချက် အပူပြဇယားတွင် ဒေတာပြသရန် PostgreSQL ဒေတာဘေ့စ်တစ်ခု ထည့်သွင်းပြီး စစ်ဆေးမှု ပြုလုပ်ပါ။'
            )}
          </p>
          <div className="pt-1 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewMode(true)}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
            >
              {tr('Preview 24h Pattern', '၂၄ နာရီ ပုံစံ အစမ်းကြည့်ရန်')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* 4-Column Peak Insights Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/50">
            <div className="px-6 py-3.5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Peak Incident Window', 'သတိပေးချက် အများဆုံး အချိန်')}
              </p>
              <p
                className={`mt-1 text-base font-bold font-mono tabular-nums ${
                  filteredView.summary.peakIncidentCount > 0
                    ? 'text-red-700'
                    : 'text-slate-900'
                }`}
              >
                {filteredView.summary.peakIncidentRangeLabel ??
                  tr('None in 24h', '၂၄ နာရီအတွင်း မရှိပါ')}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                {filteredView.summary.peakIncidentCount > 0
                  ? locale === 'my'
                    ? `သတိပေးချက် ${filteredView.summary.peakIncidentCount} ခု · အမှားနှုန်း ${filteredView.summary.peakErrorRatePct.toFixed(1)}%`
                    : `${filteredView.summary.peakIncidentCount} incident${filteredView.summary.peakIncidentCount === 1 ? '' : 's'} · ${filteredView.summary.peakErrorRatePct.toFixed(1)}% error rate`
                  : tr(
                      'Zero incidents recorded',
                      'သတိပေးချက် မှတ်တမ်း မရှိပါ'
                    )}
              </p>
            </div>

            <div className="px-6 py-3.5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Peak Activity Window', 'လှုပ်ရှားမှု အများဆုံး အချိန်')}
              </p>
              <p className="mt-1 text-base font-bold font-mono tabular-nums text-slate-900">
                {filteredView.summary.peakActivityRangeLabel ?? '—'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                {filteredView.summary.peakActivityCount > 0
                  ? locale === 'my'
                    ? `ဖြစ်စဉ် ${filteredView.summary.peakActivityCount} ခု မှတ်တမ်းတင်ထားသည်`
                    : `${filteredView.summary.peakActivityCount} telemetry events in peak hour`
                  : tr('Awaiting first scan', 'ပထမဆုံး စစ်ဆေးမှုကို စောင့်နေသည်')}
              </p>
            </div>

            <div className="px-6 py-3.5">
              <p className="text-xs font-medium text-slate-500">
                {tr('24h Fleet Error Rate', '၂၄ နာရီ စုစုပေါင်း အမှားနှုန်း')}
              </p>
              <p
                className={`mt-1 text-base font-bold font-mono tabular-nums ${
                  filteredView.summary.overallErrorRatePct >= 25
                    ? 'text-red-700'
                    : filteredView.summary.overallErrorRatePct > 0
                      ? 'text-amber-700'
                      : 'text-emerald-700'
                }`}
              >
                {filteredView.summary.overallErrorRatePct.toFixed(1)}%
              </p>
              <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                {locale === 'my'
                  ? `သတိပေးချက် ${filteredView.summary.totalIncidents24h} ခု · အရေးကြီး ${filteredView.summary.totalCritical24h} ခု`
                  : `${filteredView.summary.totalIncidents24h} incidents · ${filteredView.summary.totalCritical24h} critical`}
              </p>
            </div>

            <div className="px-6 py-3.5">
              <p className="text-xs font-medium text-slate-500">
                {tr('24h Telemetry Events', '၂၄ နာရီ စစ်ဆေးမှု ဖြစ်စဉ်များ')}
              </p>
              <p className="mt-1 text-base font-bold font-mono tabular-nums text-slate-900">
                {filteredView.summary.totalActivityEvents24h.toLocaleString()}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                {locale === 'my'
                  ? `စစ်ဆေးမှု ${filteredView.summary.totalInspections24h} ကြိမ် · တက်ကြွပစ်မှတ် ${filteredView.summary.activeTargetsCount} ခု`
                  : `${filteredView.summary.totalInspections24h} inspections · ${filteredView.summary.activeTargetsCount} active target${filteredView.summary.activeTargetsCount === 1 ? '' : 's'}`}
              </p>
            </div>
          </div>

          {/* Empty 24h Live Activity Notice (still renders the 24h grid so user sees structure) */}
          {!previewMode && !filteredView.summary.hasLiveData && (
            <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
              <span>
                {tr(
                  'No telemetry inspections or incidents have been recorded in the last 24 hours yet. Run a fleet inspection or preview a 24h incident pattern.',
                  'ပြီးခဲ့သော ၂၄ နာရီအတွင်း စစ်ဆေးမှု သို့မဟုတ် သတိပေးချက် မှတ်တမ်း မရှိသေးပါ။ ဒေတာဘေ့စ်အားလုံး စစ်ဆေးမှု ပြုလုပ်နိုင်သည် သို့မဟုတ် ၂၄ နာရီ ပုံစံကို အစမ်းကြည့်နိုင်ပါသည်။'
                )}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {onInspectAll && (
                  <button
                    type="button"
                    onClick={onInspectAll}
                    className="px-3 py-1 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md whitespace-nowrap cursor-pointer"
                  >
                    {tr('Inspect All Now', 'အားလုံး စစ်ဆေးရန်')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setPreviewMode(true)}
                  className="px-3 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-md whitespace-nowrap cursor-pointer"
                >
                  {tr('Preview 24h Pattern', '၂၄ နာရီ ပုံစံ အစမ်းကြည့်ရန်')}
                </button>
              </div>
            </div>
          )}

          {/* 24-Hour Matrix Grid */}
          <div className="px-6 py-5 overflow-x-auto">
            <div className="min-w-[820px]">
              {/* Hour Axis Header */}
              <div className="grid grid-cols-[200px_1fr_76px] items-end gap-3 mb-2">
                <div className="text-[11px] font-medium text-slate-500">
                  {tr('PostgreSQL Target', 'PostgreSQL ပစ်မှတ်')}
                </div>
                <div className="grid grid-cols-24 gap-1">
                  {activeData.buckets.map((bucket) => {
                    const isPeak = peakIncidentCol === bucket.index;
                    const showTick =
                      bucket.index % 3 === 0 ||
                      bucket.index === 23 ||
                      isPeak;
                    return (
                      <div
                        key={bucket.index}
                        className="flex flex-col items-center justify-end min-w-0"
                      >
                        {isPeak && (
                          <span className="text-[9px] font-semibold text-red-700 leading-none mb-0.5 whitespace-nowrap">
                            {tr('Peak', 'အများဆုံး')}
                          </span>
                        )}
                        <span
                          className={`text-[10px] font-mono tabular-nums leading-none ${
                            isPeak
                              ? 'text-red-700 font-semibold'
                              : showTick
                                ? 'text-slate-500'
                                : 'text-transparent select-none'
                          }`}
                        >
                          {bucket.hourLabel.slice(0, 2)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="text-[11px] font-medium text-slate-500 text-right whitespace-nowrap">
                  {tr('24h Err %', '၂၄ နာရီ အမှား%')}
                </div>
              </div>

              {/* Per-Target Rows */}
              <div className="space-y-1.5">
                {visibleTargets.map((row) => (
                  <div
                    key={row.databaseId}
                    className="grid grid-cols-[200px_1fr_76px] items-center gap-3"
                  >
                    <div className="min-w-0 pr-1">
                      <button
                        type="button"
                        disabled={isPreviewTargetId(row.databaseId)}
                        onClick={() => {
                          if (!isPreviewTargetId(row.databaseId)) {
                            onSelectDatabase(row.databaseId);
                          }
                        }}
                        className={`text-left max-w-full truncate text-xs font-semibold text-slate-900 block ${
                          isPreviewTargetId(row.databaseId)
                            ? 'cursor-default'
                            : 'hover:text-blue-700 cursor-pointer'
                        }`}
                        title={`${row.name} (${formatEnv(row.environment, true)})`}
                      >
                        {row.name}
                      </button>
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                        <span>{formatEnv(row.environment, true)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {locale === 'my'
                            ? `${row.totalActivity24h} ကြိမ်`
                            : `${row.totalActivity24h} ev`}
                        </span>
                      </div>
                    </div>

                    <div className="grid grid-cols-24 gap-1">
                      {row.cells.map((cell) => {
                        const bucket = activeData.buckets[cell.bucketIndex];
                        const isPeak = peakIncidentCol === cell.bucketIndex;
                        const selected = isCellSelected(
                          row.databaseId,
                          cell.bucketIndex
                        );
                        const label = renderCellLabel(cell);
                        return (
                          <button
                            key={cell.bucketIndex}
                            type="button"
                            onMouseEnter={() =>
                              setHoveredCell({
                                rowKey: row.databaseId,
                                bucketIndex: cell.bucketIndex,
                              })
                            }
                            onMouseLeave={() => setHoveredCell(null)}
                            onFocus={() =>
                              setHoveredCell({
                                rowKey: row.databaseId,
                                bucketIndex: cell.bucketIndex,
                              })
                            }
                            onBlur={() => setHoveredCell(null)}
                            onClick={() =>
                              handleTogglePin(row.databaseId, cell.bucketIndex)
                            }
                            aria-label={`${row.name} ${bucket.rangeLabel}: ${cell.activityCount} activity events, ${cell.incidentsCount} incidents, ${cell.errorRatePct}% error rate`}
                            className={`h-7 rounded-[4px] border text-[10px] font-mono font-semibold tabular-nums flex items-center justify-center transition-transform duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-1 ${renderCellClasses(
                              cell
                            )} ${
                              selected
                                ? 'ring-2 ring-slate-900 ring-offset-1 scale-[1.06] z-10'
                                : isPeak
                                  ? 'ring-1 ring-red-400/70'
                                  : 'hover:scale-[1.05]'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="text-right font-mono text-xs tabular-nums">
                      <span
                        className={
                          row.avgErrorRatePct >= 25
                            ? 'font-semibold text-red-700'
                            : row.avgErrorRatePct > 0
                              ? 'font-semibold text-amber-700'
                              : 'text-slate-500'
                        }
                      >
                        {row.avgErrorRatePct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Fleet Rollup Summary Row */}
              <div className="mt-3 pt-3 border-t border-slate-200 grid grid-cols-[200px_1fr_76px] items-center gap-3">
                <div className="min-w-0 pr-1">
                  <p className="text-xs font-semibold text-slate-900 truncate">
                    {tr('All Targets (Fleet)', 'ဒေတာဘေ့စ်အားလုံး စုပေါင်း')}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {tr('Combined hourly pulse', 'နာရီအလိုက် စုစုပေါင်း')}
                  </p>
                </div>

                <div className="grid grid-cols-24 gap-1">
                  {filteredView.fleetTotals.map((cell) => {
                    const bucket = activeData.buckets[cell.bucketIndex];
                    const isPeak = peakIncidentCol === cell.bucketIndex;
                    const selected = isCellSelected('fleet', cell.bucketIndex);
                    const label = renderCellLabel(cell);
                    return (
                      <button
                        key={cell.bucketIndex}
                        type="button"
                        onMouseEnter={() =>
                          setHoveredCell({
                            rowKey: 'fleet',
                            bucketIndex: cell.bucketIndex,
                          })
                        }
                        onMouseLeave={() => setHoveredCell(null)}
                        onFocus={() =>
                          setHoveredCell({
                            rowKey: 'fleet',
                            bucketIndex: cell.bucketIndex,
                          })
                        }
                        onBlur={() => setHoveredCell(null)}
                        onClick={() => handleTogglePin('fleet', cell.bucketIndex)}
                        aria-label={`All targets ${bucket.rangeLabel}: ${cell.activityCount} activity events, ${cell.incidentsCount} incidents, ${cell.errorRatePct}% error rate`}
                        className={`h-8 rounded-[4px] border text-[10px] font-mono font-semibold tabular-nums flex items-center justify-center transition-transform duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-1 ${renderCellClasses(
                          cell
                        )} ${
                          selected
                            ? 'ring-2 ring-slate-900 ring-offset-1 scale-[1.06] z-10'
                            : isPeak
                              ? 'ring-1 ring-red-500/80'
                              : 'hover:scale-[1.05]'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                <div className="text-right font-mono text-xs font-semibold tabular-nums">
                  <span
                    className={
                      filteredView.summary.overallErrorRatePct >= 25
                        ? 'text-red-700'
                        : filteredView.summary.overallErrorRatePct > 0
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                    }
                  >
                    {filteredView.summary.overallErrorRatePct.toFixed(1)}%
                  </span>
                </div>
              </div>

              {/* Scale Legend */}
              <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500">
                <div className="flex flex-wrap items-center gap-4">
                  {metricMode !== 'errors' && (
                    <div className="flex items-center gap-1.5">
                      <span>{tr('Activity:', 'လှုပ်ရှားမှု:')}</span>
                      <span>{tr('Idle', 'ငြိမ်')}</span>
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-slate-100 border border-slate-200 inline-block" />
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-blue-100 border border-blue-200 inline-block" />
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-blue-300 border border-blue-400/30 inline-block" />
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-blue-500 inline-block" />
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-blue-700 inline-block" />
                      <span>{tr('High', 'မြင့်')}</span>
                    </div>
                  )}

                  {metricMode !== 'activity' && (
                    <div className="flex items-center gap-1.5">
                      <span>
                        {tr('Errors / Incidents:', 'အမှား / သတိပေးချက်:')}
                      </span>
                      <span>{tr('Low', 'နည်း')}</span>
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-amber-200 border border-amber-400/60 inline-block" />
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-amber-400 inline-block" />
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-red-500 inline-block" />
                      <span className="w-3.5 h-3.5 rounded-[3px] bg-red-700 inline-block" />
                      <span>{tr('Critical', 'အရေးကြီး')}</span>
                    </div>
                  )}
                </div>

                <span>
                  {tr(
                    'Hover any hour to inspect · Click a cell to pin',
                    'အသေးစိတ်ကြည့်ရန် နာရီကွက်ပေါ် တင်ပါ · သော့ခတ်ရန် နှိပ်ပါ'
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Inline Selected / Hovered Hour Inspection Strip */}
          {inspectedDetails && (
            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
                <span className="font-semibold text-slate-900">
                  {inspectedDetails.rowName}
                </span>
                {inspectedDetails.environment && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-slate-600">
                      {formatEnv(inspectedDetails.environment, true)}
                    </span>
                  </>
                )}
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono font-semibold text-slate-800 tabular-nums">
                  {inspectedDetails.bucket.rangeLabel}
                </span>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono tabular-nums text-slate-700">
                  {locale === 'my'
                    ? `ဖြစ်စဉ် ${inspectedDetails.cell.activityCount} ခု (စစ်ဆေးမှု ${inspectedDetails.cell.inspectionsCount})`
                    : `${inspectedDetails.cell.activityCount} events (${inspectedDetails.cell.inspectionsCount} inspections)`}
                </span>
                {inspectedDetails.cell.queryCalls > 0 && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono tabular-nums text-slate-700">
                      {locale === 'my'
                        ? `Query ${inspectedDetails.cell.queryCalls.toLocaleString()} ကြိမ်`
                        : `${inspectedDetails.cell.queryCalls.toLocaleString()} query calls`}
                    </span>
                  </>
                )}
                {inspectedDetails.cell.avgConnectionPct !== null && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono tabular-nums text-slate-700">
                      {locale === 'my'
                        ? `ချိတ်ဆက်မှု ${inspectedDetails.cell.avgConnectionPct.toFixed(1)}%`
                        : `${inspectedDetails.cell.avgConnectionPct.toFixed(1)}% conn`}
                    </span>
                  </>
                )}
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span
                  className={`font-mono font-semibold tabular-nums ${
                    inspectedDetails.cell.errorRatePct >= 25
                      ? 'text-red-700'
                      : inspectedDetails.cell.incidentsCount > 0
                        ? 'text-amber-700'
                        : 'text-emerald-700'
                  }`}
                >
                  {locale === 'my'
                    ? `အမှားနှုန်း ${inspectedDetails.cell.errorRatePct.toFixed(1)}% (${inspectedDetails.cell.incidentsCount} သတိပေးချက်)`
                    : `${inspectedDetails.cell.errorRatePct.toFixed(1)}% error rate (${inspectedDetails.cell.incidentsCount} incident${inspectedDetails.cell.incidentsCount === 1 ? '' : 's'})`}
                </span>
                {inspectedDetails.cell.topIncidentType && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-red-700 font-medium">
                      {formatIncidentType(inspectedDetails.cell.topIncidentType)}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!isPreviewTargetId(inspectedDetails.databaseId) && (
                  <button
                    type="button"
                    onClick={() =>
                      onSelectDatabase(inspectedDetails.databaseId!)
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-md whitespace-nowrap cursor-pointer"
                  >
                    <span>{tr('Inspect Target', 'ပစ်မှတ်ကြည့်ရန်')}</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                )}
                {inspectedDetails.cell.incidentsCount > 0 && !previewMode && (
                  <button
                    type="button"
                    onClick={onViewIncidents}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-800 bg-red-50 border border-red-200 hover:bg-red-100 rounded-md whitespace-nowrap cursor-pointer"
                  >
                    <span>{tr('View Incidents', 'သတိပေးချက်များ ကြည့်ရန်')}</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
