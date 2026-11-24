import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { monitoredDatabases, queryLatencySamples } from '../db/schema.ts';
import {
  decryptSecret,
  SecretDecryptionError,
  validateSafePostgresUrl,
} from './crypto.ts';
import { SchemaInspector } from './inspector.ts';
import type {
  ConnectionMode,
  PerformanceTrendsResponse,
  QueryLatencySeries,
  QueryTrendPoint,
  RegressionStatus,
} from '../types/telemetry.ts';

function computeMedian(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildShortQueryLabel(sql: string, queryId: string): string {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  if (!normalized) return `Query #${queryId.slice(0, 8)}`;
  const verbMatch = normalized.match(
    /^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|REFRESH)\b/i
  );
  const tableMatch = normalized.match(
    /\b(?:FROM|INTO|UPDATE|JOIN)\s+"?(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)"?/i
  );
  if (verbMatch && tableMatch) {
    return `${verbMatch[1].toUpperCase()} ${tableMatch[1]}`;
  }
  return normalized.length > 36 ? `${normalized.slice(0, 35)}…` : normalized;
}

function formatDayBucketKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDayBucketLabel(isoOrDay: string): string {
  const d = new Date(isoOrDay.length === 10 ? `${isoOrDay}T12:00:00Z` : isoOrDay);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTimeBucketLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getPerformanceTrends(
  ownerUid: string,
  options: {
    databaseId?: string;
    days?: number;
    captureLive?: boolean;
  } = {}
): Promise<PerformanceTrendsResponse> {
  const days = Math.min(90, Math.max(7, Math.round(options.days ?? 30)));
  const captureLive = options.captureLive === true;

  let targetLabel = 'Workspace PostgreSQL (Live)';
  let resolvedDbId: string | null = null;
  let mode: ConnectionMode = 'workspace_pg';
  let connectionUrl: string | undefined;
  let decryptErrorFlag = false;

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

    if (mode === 'external' && target.connectionUrlEncrypted) {
      try {
        connectionUrl = decryptSecret(target.connectionUrlEncrypted);
        await validateSafePostgresUrl(connectionUrl);
      } catch (err) {
        connectionUrl = undefined;
        if (err instanceof SecretDecryptionError) {
          decryptErrorFlag = true;
        }
      }
    }
  }

  // Probe live pg_stat_statements if reachable
  let extensionAvailable = true;
  let unavailableReason: string | undefined;
  let liveQueries: Awaited<
    ReturnType<typeof SchemaInspector.fetchTopExpensiveQueries>
  >['queries'] = [];

  if (mode === 'workspace_pg' || connectionUrl) {
    try {
      const liveRes = await SchemaInspector.fetchTopExpensiveQueries(
        mode,
        connectionUrl
      );
      extensionAvailable = liveRes.extensionAvailable;
      unavailableReason = liveRes.unavailableReason;
      liveQueries = liveRes.queries;
    } catch (err) {
      unavailableReason =
        err instanceof Error
          ? err.message
          : 'Unable to reach target PostgreSQL for live sampling.';
    }
  } else {
    unavailableReason = decryptErrorFlag
      ? 'CREDENTIAL_DECRYPT_FAILED'
      : 'External target credentials unavailable for live sampling; showing stored history.';
  }

  const targetFilter = resolvedDbId
    ? and(
        eq(queryLatencySamples.ownerUid, ownerUid),
        eq(queryLatencySamples.databaseId, resolvedDbId)
      )
    : and(
        eq(queryLatencySamples.ownerUid, ownerUid),
        isNull(queryLatencySamples.databaseId)
      );

  // Persist a live snapshot into query_latency_samples if >= 3 min elapsed or explicit captureLive
  if (extensionAvailable && liveQueries.length > 0) {
    const latestRows = await db
      .select({ sampledAt: queryLatencySamples.sampledAt })
      .from(queryLatencySamples)
      .where(targetFilter)
      .orderBy(desc(queryLatencySamples.sampledAt))
      .limit(1);

    const lastSampleMs = latestRows[0]?.sampledAt?.getTime() ?? 0;
    const elapsedMs = Date.now() - lastSampleMs;

    if (captureLive || elapsedMs >= 3 * 60 * 1000) {
      const now = new Date();
      await db
        .insert(queryLatencySamples)
        .values(
          liveQueries.map((q) => ({
            ownerUid,
            databaseId: resolvedDbId,
            queryId: String(q.query_id).slice(0, 64),
            queryPreview: q.query.slice(0, 2000),
            calls: Math.max(0, Math.round(q.calls)),
            meanExecTimeMs: Math.max(0, Number(q.mean_exec_time_ms) || 0),
            maxExecTimeMs: Math.max(0, Number(q.max_exec_time_ms) || 0),
            cacheHitPct: Math.min(100, Math.max(0, Number(q.cache_hit_pct) || 0)),
            sampledAt: now,
          }))
        )
        .catch((err) => {
          console.warn('Skipping query latency sample write:', err);
        });
    }
  }

  // Load stored samples over the requested trailing window
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const storedSamples = await db
    .select()
    .from(queryLatencySamples)
    .where(and(targetFilter, gte(queryLatencySamples.sampledAt, cutoff)))
    .orderBy(asc(queryLatencySamples.sampledAt))
    .limit(1500);

  if (storedSamples.length === 0) {
    return {
      targetLabel,
      databaseId: resolvedDbId,
      extensionAvailable,
      unavailableReason,
      days,
      collectedAt: new Date().toISOString(),
      totalSamplesStored: 0,
      distinctDays: 0,
      bucketDates: [],
      blendedBaselineMs: 0,
      blendedLatestMs: 0,
      blendedDeltaPct: 0,
      regressionQueriesCount: 0,
      worstDeltaPct: 0,
      series: [],
    };
  }

  // Determine whether we have multi-day data (>= 3 distinct calendar days) or intra-day samples
  const distinctDaySet = new Set(
    storedSamples.map((s) => formatDayBucketKey(s.sampledAt))
  );
  const useDailyBuckets = distinctDaySet.size >= 3;

  // Build ordered master bucket list
  const bucketMap = new Map<
    string,
    { key: string; label: string; timestamp: string }
  >();

  const getBucketKey = (d: Date) =>
    useDailyBuckets
      ? formatDayBucketKey(d)
      : d.toISOString().slice(0, 16); // minute-level bucket when intra-day

  for (const s of storedSamples) {
    const key = getBucketKey(s.sampledAt);
    if (!bucketMap.has(key)) {
      const iso = s.sampledAt.toISOString();
      bucketMap.set(key, {
        key,
        label: useDailyBuckets
          ? formatDayBucketLabel(key)
          : formatTimeBucketLabel(iso),
        timestamp: iso,
      });
    }
  }

  const bucketDates = Array.from(bucketMap.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Group samples by queryId
  const byQuery = new Map<
    string,
    {
      queryId: string;
      queryText: string;
      rows: typeof storedSamples;
    }
  >();

  for (const s of storedSamples) {
    const existing = byQuery.get(s.queryId);
    if (existing) {
      existing.rows.push(s);
      existing.queryText = s.queryPreview;
    } else {
      byQuery.set(s.queryId, {
        queryId: s.queryId,
        queryText: s.queryPreview,
        rows: [s],
      });
    }
  }

  // Rank queries by latest latency + peak latency, pick Top 5
  const rankedQueries = Array.from(byQuery.values())
    .sort((a, b) => {
      const aLatest = a.rows[a.rows.length - 1]?.meanExecTimeMs ?? 0;
      const bLatest = b.rows[b.rows.length - 1]?.meanExecTimeMs ?? 0;
      return bLatest - aLatest;
    })
    .slice(0, 5);

  const series: QueryLatencySeries[] = rankedQueries.map((entry) => {
    // Aggregate samples per bucket for this query
    const perBucket = new Map<
      string,
      {
        sumMean: number;
        maxLatency: number;
        calls: number;
        count: number;
        timestamp: string;
      }
    >();

    for (const r of entry.rows) {
      const key = getBucketKey(r.sampledAt);
      const curr = perBucket.get(key);
      if (curr) {
        curr.sumMean += r.meanExecTimeMs;
        curr.maxLatency = Math.max(curr.maxLatency, r.maxExecTimeMs);
        curr.calls = Math.max(curr.calls, r.calls);
        curr.count += 1;
      } else {
        perBucket.set(key, {
          sumMean: r.meanExecTimeMs,
          maxLatency: r.maxExecTimeMs,
          calls: r.calls,
          count: 1,
          timestamp: r.sampledAt.toISOString(),
        });
      }
    }

    const rawPoints = bucketDates
      .filter((b) => perBucket.has(b.key))
      .map((b) => {
        const agg = perBucket.get(b.key)!;
        return {
          bucketKey: b.key,
          label: b.label,
          timestamp: agg.timestamp,
          avgLatencyMs: round2(agg.sumMean / agg.count),
          maxLatencyMs: round2(agg.maxLatency),
          calls: agg.calls,
        };
      });

    // Historical baseline: median of the first 70% of buckets (minimum 1) so recent regressions stand out clearly
    const baselineEndIdx =
      rawPoints.length >= 4
        ? Math.max(2, Math.floor(rawPoints.length * 0.7))
        : Math.max(1, rawPoints.length - 1);
    const baselineSlice = rawPoints
      .slice(0, baselineEndIdx)
      .map((p) => p.avgLatencyMs);
    const baselineMs = round2(
      baselineSlice.length > 0
        ? computeMedian(baselineSlice)
        : rawPoints[0]?.avgLatencyMs ?? 0
    );
    const baselineStd = computeStdDev(baselineSlice);
    const regressionThresholdMs = round2(
      Math.max(
        baselineMs * 1.35,
        baselineMs + 2 * baselineStd,
        baselineMs + 1.5
      )
    );

    const points: QueryTrendPoint[] = rawPoints.map((pt, idx) => {
      const deltaPct =
        baselineMs > 0
          ? round2(((pt.avgLatencyMs - baselineMs) / baselineMs) * 100)
          : 0;
      const isRegression =
        rawPoints.length >= 2 &&
        idx >= 1 &&
        pt.avgLatencyMs > regressionThresholdMs &&
        deltaPct >= 35;

      return {
        ...pt,
        deltaPct,
        isRegression,
      };
    });

    const latestMs = points[points.length - 1]?.avgLatencyMs ?? 0;
    const peakMs = points.reduce((m, p) => Math.max(m, p.avgLatencyMs), 0);
    const deltaPct =
      baselineMs > 0 ? round2(((latestMs - baselineMs) / baselineMs) * 100) : 0;
    const regressionCount = points.filter((p) => p.isRegression).length;

    let status: RegressionStatus = 'STABLE';
    if (
      points.length >= 2 &&
      latestMs > regressionThresholdMs &&
      deltaPct >= 35
    ) {
      status = 'REGRESSION';
    } else if (points.length >= 2 && deltaPct >= 15 && latestMs - baselineMs >= 0.5) {
      status = 'ELEVATED';
    } else if (points.length >= 2 && deltaPct <= -15) {
      status = 'IMPROVED';
    }

    const totalCalls = entry.rows[entry.rows.length - 1]?.calls ?? 0;
    const avgCacheHitPct = round2(
      entry.rows.reduce((s, r) => s + r.cacheHitPct, 0) / entry.rows.length
    );

    return {
      queryId: entry.queryId,
      shortLabel: buildShortQueryLabel(entry.queryText, entry.queryId),
      queryText: entry.queryText,
      baselineMs,
      regressionThresholdMs,
      latestMs,
      peakMs,
      deltaPct,
      status,
      regressionCount,
      totalCalls,
      avgCacheHitPct,
      points,
    };
  });

  const blendedBaselineMs = round2(
    series.reduce((s, q) => s + q.baselineMs, 0) / Math.max(series.length, 1)
  );
  const blendedLatestMs = round2(
    series.reduce((s, q) => s + q.latestMs, 0) / Math.max(series.length, 1)
  );
  const blendedDeltaPct =
    blendedBaselineMs > 0
      ? round2(
          ((blendedLatestMs - blendedBaselineMs) / blendedBaselineMs) * 100
        )
      : 0;
  const regressionQueriesCount = series.filter(
    (q) => q.status === 'REGRESSION' || q.regressionCount > 0
  ).length;
  const worstDeltaPct = series.reduce(
    (max, q) => Math.max(max, q.deltaPct),
    0
  );

  return {
    targetLabel,
    databaseId: resolvedDbId,
    extensionAvailable,
    unavailableReason,
    days,
    collectedAt: new Date().toISOString(),
    totalSamplesStored: storedSamples.length,
    distinctDays: distinctDaySet.size,
    bucketDates,
    blendedBaselineMs,
    blendedLatestMs,
    blendedDeltaPct,
    regressionQueriesCount,
    worstDeltaPct: round2(worstDeltaPct),
    series,
  };
}
