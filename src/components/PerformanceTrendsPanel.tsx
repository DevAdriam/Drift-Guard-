import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  KeyRound,
  PlusCircle,
  RefreshCw,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  MonitoredDatabaseDto,
  PerformanceTrendsResponse,
  QueryLatencySeries,
  RegressionStatus,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface PerformanceTrendsPanelProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  selectedTargetId: string;
  onTargetChange: (nextId: string) => void;
  onRequestReconnect?: () => void;
}

const SERIES_COLORS = [
  '#1D4ED8', // Blue 700
  '#0D9488', // Teal 600
  '#4F46E5', // Indigo 600
  '#D97706', // Amber 600
  '#475569', // Slate 600
];

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '0.00 ms';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function formatDeltaPct(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

function buildPreviewPerformanceTrends(
  targetLabel: string,
  days: number,
  locale: 'en' | 'my'
): PerformanceTrendsResponse {
  const count = Math.min(30, Math.max(7, days));
  const now = Date.now();
  const bucketDates = Array.from({ length: count }, (_, i) => {
    const ts = new Date(now - (count - 1 - i) * 86_400_000);
    const key = ts.toISOString().slice(0, 10);
    return {
      key,
      label: ts.toLocaleDateString(locale === 'my' ? 'my-MM' : 'en-US', {
        month: 'short',
        day: 'numeric',
      }),
      timestamp: ts.toISOString(),
    };
  });

  const defs: {
    queryId: string;
    shortLabel: string;
    queryText: string;
    baseline: number;
    calls: number;
    cacheHit: number;
    pattern: (dayIdx: number, total: number) => number;
  }[] = [
    {
      queryId: 'sim-orders-history',
      shortLabel: 'SELECT orders',
      queryText:
        'SELECT o.id, o.customer_id, o.total_cents, o.status, o.created_at FROM public.orders o LEFT JOIN public.order_items oi ON oi.order_id = o.id WHERE o.tenant_id = $1 AND o.created_at >= $2 ORDER BY o.created_at DESC LIMIT $3',
      baseline: 18.4,
      calls: 48210,
      cacheHit: 91.4,
      pattern: (i, n) => {
        const wave = Math.sin(i * 0.7) * 1.4;
        if (i >= n - 4) return 44.5 + (i - (n - 4)) * 3.8 + wave;
        return 18.4 + wave;
      },
    },
    {
      queryId: 'sim-invoices-agg',
      shortLabel: 'SELECT invoices',
      queryText:
        'SELECT account_id, count(*), sum(amount_due_cents) FROM public.invoices WHERE status IN ($1, $2) AND billing_cycle_end <= $3 GROUP BY account_id',
      baseline: 31.2,
      calls: 19405,
      cacheHit: 95.8,
      pattern: (i, n) => {
        const wave = Math.cos(i * 0.55) * 2.1;
        if (i === Math.floor(n * 0.55) || i === Math.floor(n * 0.55) + 1) {
          return 58.6 + wave;
        }
        if (i >= n - 2) return 46.8 + wave;
        return 31.2 + wave;
      },
    },
    {
      queryId: 'sim-sessions-upsert',
      shortLabel: 'UPDATE user_sessions',
      queryText:
        'UPDATE public.user_sessions SET last_seen_at = NOW(), payload = $2 WHERE session_token = $1 RETURNING id, user_id',
      baseline: 9.6,
      calls: 142890,
      cacheHit: 99.1,
      pattern: (i) => 9.6 + Math.sin(i * 0.9) * 0.85,
    },
    {
      queryId: 'sim-audit-search',
      shortLabel: 'SELECT audit_events',
      queryText:
        'SELECT id, actor_id, action, metadata, created_at FROM public.audit_events WHERE workspace_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 100',
      baseline: 26.0,
      calls: 11240,
      cacheHit: 97.6,
      pattern: (i, n) => {
        if (i >= Math.floor(n * 0.6)) return 14.2 + Math.cos(i * 0.8) * 1.1;
        return 26.0 + Math.sin(i * 0.6) * 1.6;
      },
    },
    {
      queryId: 'sim-webhooks-queue',
      shortLabel: 'SELECT webhook_deliveries',
      queryText:
        'SELECT id, endpoint_id, payload, attempt_count FROM public.webhook_deliveries WHERE status = $1 AND next_retry_at <= NOW() ORDER BY next_retry_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED',
      baseline: 12.8,
      calls: 63520,
      cacheHit: 98.4,
      pattern: (i) => 12.8 + Math.cos(i * 0.45) * 1.0,
    },
  ];

  const series: QueryLatencySeries[] = defs.map((def) => {
    const threshold =
      Math.round(Math.max(def.baseline * 1.35, def.baseline + 3) * 100) / 100;
    const points = bucketDates.map((b, idx) => {
      const avgLatencyMs =
        Math.round(Math.max(1, def.pattern(idx, count)) * 100) / 100;
      const deltaPct =
        Math.round(((avgLatencyMs - def.baseline) / def.baseline) * 1000) / 10;
      const isRegression = idx >= 1 && avgLatencyMs > threshold && deltaPct >= 35;
      return {
        bucketKey: b.key,
        label: b.label,
        timestamp: b.timestamp,
        avgLatencyMs,
        maxLatencyMs: Math.round(avgLatencyMs * 2.6 * 100) / 100,
        calls: Math.round(def.calls / count),
        deltaPct,
        isRegression,
      };
    });

    const latestMs = points[points.length - 1]?.avgLatencyMs ?? def.baseline;
    const peakMs = points.reduce((m, p) => Math.max(m, p.avgLatencyMs), 0);
    const deltaPct =
      Math.round(((latestMs - def.baseline) / def.baseline) * 1000) / 10;
    const regressionCount = points.filter((p) => p.isRegression).length;

    let status: RegressionStatus = 'STABLE';
    if (latestMs > threshold && deltaPct >= 35) status = 'REGRESSION';
    else if (deltaPct >= 15) status = 'ELEVATED';
    else if (deltaPct <= -15) status = 'IMPROVED';

    return {
      queryId: def.queryId,
      shortLabel: def.shortLabel,
      queryText: def.queryText,
      baselineMs: def.baseline,
      regressionThresholdMs: threshold,
      latestMs,
      peakMs,
      deltaPct,
      status,
      regressionCount,
      totalCalls: def.calls,
      avgCacheHitPct: def.cacheHit,
      points,
    };
  });

  const blendedBaselineMs =
    Math.round(
      (series.reduce((s, q) => s + q.baselineMs, 0) / series.length) * 100
    ) / 100;
  const blendedLatestMs =
    Math.round(
      (series.reduce((s, q) => s + q.latestMs, 0) / series.length) * 100
    ) / 100;

  return {
    targetLabel,
    databaseId: null,
    extensionAvailable: true,
    days: count,
    collectedAt: new Date().toISOString(),
    totalSamplesStored: count * series.length,
    distinctDays: count,
    bucketDates,
    blendedBaselineMs,
    blendedLatestMs,
    blendedDeltaPct:
      Math.round(
        ((blendedLatestMs - blendedBaselineMs) / blendedBaselineMs) * 1000
      ) / 10,
    regressionQueriesCount: series.filter(
      (q) => q.status === 'REGRESSION' || q.regressionCount > 0
    ).length,
    worstDeltaPct: series.reduce((m, q) => Math.max(m, q.deltaPct), 0),
    series,
  };
}

export function PerformanceTrendsPanel({
  api,
  databases,
  selectedTargetId,
  onTargetChange,
  onRequestReconnect,
}: PerformanceTrendsPanelProps) {
  const { locale, t, tr, formatEnv } = useI18n();

  const [days, setDays] = useState<7 | 14 | 30>(30);
  const [liveData, setLiveData] = useState<PerformanceTrendsResponse | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [focusedQueryId, setFocusedQueryId] = useState<string | null>(null);
  const [hoveredBucketIdx, setHoveredBucketIdx] = useState<number | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const statusMeta = useCallback(
    (status: RegressionStatus): { label: string; className: string } => {
      switch (status) {
        case 'REGRESSION':
          return {
            label: tr('Regression', 'စွမ်းဆောင်ရည် ကျဆင်းမှု'),
            className: 'text-red-700',
          };
        case 'ELEVATED':
          return {
            label: tr('Elevated', 'မြင့်တက်နေသည်'),
            className: 'text-amber-700',
          };
        case 'IMPROVED':
          return {
            label: tr('Improved', 'တိုးတက်လာသည်'),
            className: 'text-emerald-700',
          };
        default:
          return {
            label: tr('Stable', 'တည်ငြိမ်သည်'),
            className: 'text-slate-600',
          };
      }
    },
    [tr]
  );

  const loadTrends = useCallback(
    async (dbId: string, windowDays: number, capture = false) => {
      if (capture) {
        setCapturing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await api.getPerformanceTrends({
          databaseId: dbId || undefined,
          days: windowDays,
          capture,
        });
        setLiveData(res);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Unable to load 30-day query performance trends.',
                'ရက် ၃၀ query စွမ်းဆောင်ရည် လမ်းကြောင်းများကို ရယူ၍ မရပါ။'
              )
        );
      } finally {
        setLoading(false);
        setCapturing(false);
      }
    },
    [api, tr]
  );

  useEffect(() => {
    setFocusedQueryId(null);
    setHoveredBucketIdx(null);
    loadTrends(selectedTargetId, days, false);
  }, [selectedTargetId, days, loadTrends]);

  const activeData = useMemo(() => {
    if (previewMode) {
      return buildPreviewPerformanceTrends(
        liveData?.targetLabel ??
          tr(
            'Workspace PostgreSQL (Simulated Preview)',
            'လုပ်ငန်းခွင် PostgreSQL (နမူနာ အစမ်းကြည့်)'
          ),
        days,
        locale
      );
    }
    return liveData;
  }, [previewMode, liveData, days, locale, tr]);

  const handleCopySql = async (id: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  // Chart geometry constants
  const chartW = 920;
  const chartH = 264;
  const padL = 62;
  const padR = 24;
  const padT = 22;
  const padB = 34;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const seriesList = activeData?.series ?? [];
  const buckets = activeData?.bucketDates ?? [];
  const focusedSeries =
    focusedQueryId !== null
      ? seriesList.find((s) => s.queryId === focusedQueryId) ?? null
      : null;

  const yMax = useMemo(() => {
    const visible = focusedSeries ? [focusedSeries] : seriesList;
    let peak = 1;
    for (const s of visible) {
      peak = Math.max(peak, s.baselineMs, s.regressionThresholdMs);
      for (const p of s.points) {
        peak = Math.max(peak, p.avgLatencyMs);
      }
    }
    return peak * 1.15;
  }, [focusedSeries, seriesList]);

  const xForBucket = useCallback(
    (bucketIdx: number) => {
      if (buckets.length <= 1) return padL + plotW / 2;
      return padL + (bucketIdx / (buckets.length - 1)) * plotW;
    },
    [buckets.length, padL, plotW]
  );

  const yForMs = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(yMax, ms));
      return padT + plotH - (clamped / yMax) * plotH;
    },
    [padT, plotH, yMax]
  );

  const bucketIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    buckets.forEach((b, idx) => map.set(b.key, idx));
    return map;
  }, [buckets]);

  const yTicks = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, i) => (yMax / steps) * i);
  }, [yMax]);

  const xTickIndices = useMemo(() => {
    if (buckets.length === 0) return [];
    if (buckets.length <= 6) return buckets.map((_, i) => i);
    const desired = 6;
    const indices = new Set<number>([0, buckets.length - 1]);
    for (let i = 1; i < desired - 1; i += 1) {
      indices.add(Math.round((i / (desired - 1)) * (buckets.length - 1)));
    }
    return Array.from(indices).sort((a, b) => a - b);
  }, [buckets]);

  const hoveredBucket =
    hoveredBucketIdx !== null && buckets[hoveredBucketIdx]
      ? buckets[hoveredBucketIdx]
      : null;

  const isSparseLive =
    !previewMode &&
    activeData !== null &&
    activeData.distinctDays < 3 &&
    activeData.bucketDates.length < 3;

  return (
    <section
      aria-labelledby="performance-trends-heading"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
    >
      {/* Panel Header */}
      <div className="px-6 py-5 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="performance-trends-heading"
              className="text-base font-semibold text-slate-900"
            >
              {tr('Performance Trends', 'စွမ်းဆောင်ရည် လမ်းကြောင်းများ')}
            </h2>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500">
              {locale === 'my'
                ? `${days} ရက် ပျမ်းမျှ ကြာချိန်နှင့် သမိုင်းကြောင်း မူလစံ နှိုင်းယှဉ်ချက်`
                : `${days}-day average latency vs. historical baseline`}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {tr(
              'Compares daily average execution latency of top queries against their historical baseline to flag sudden performance regressions.',
              'ထိပ်တန်း query များ၏ နေ့စဉ် ပျမ်းမျှ လုပ်ဆောင်ချိန်ကို သမိုင်းကြောင်း မူလစံနှုန်းနှင့် နှိုင်းယှဉ်၍ စွမ်းဆောင်ရည် ရုတ်တရက် ကျဆင်းမှုများကို ရှာဖွေဖော်ပြပါသည်။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <span className="whitespace-nowrap">
              {tr('Source', 'အရင်းအမြစ်')}
            </span>
            <select
              value={selectedTargetId}
              onChange={(e) => {
                setPreviewMode(false);
                onTargetChange(e.target.value);
              }}
              aria-label={tr(
                'Select target database for performance trends',
                'စွမ်းဆောင်ရည် လမ်းကြောင်းအတွက် ပစ်မှတ် ဒေတာဘေ့စ် ရွေးချယ်ရန်'
              )}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 max-w-[200px] truncate"
            >
              <option value="">
                {tr(
                  'Workspace PostgreSQL (Live)',
                  'လုပ်ငန်းခွင် PostgreSQL (တိုက်ရိုက်)'
                )}
              </option>
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({formatEnv(d.environment)})
                </option>
              ))}
            </select>
          </label>

          {/* Timeframe Segmented Control */}
          <div
            role="group"
            aria-label={tr(
              'Select latency trend timeframe',
              'ကြာချိန် လမ်းကြောင်း ကာလ ရွေးချယ်ရန်'
            )}
            className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg border border-slate-200"
          >
            {([7, 14, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums cursor-pointer ${
                  days === d
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {locale === 'my' ? `${d} ရက်` : `${d}d`}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setPreviewMode(false);
              loadTrends(selectedTargetId, days, true);
            }}
            disabled={capturing || loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <PlusCircle
              className={`w-3.5 h-3.5 ${capturing ? 'animate-spin' : ''}`}
            />
            <span>
              {capturing
                ? tr('Sampling…', 'မှတ်တမ်းယူနေသည်…')
                : tr('Capture Sample', 'နမူနာ မှတ်တမ်းယူရန်')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setFocusedQueryId(null);
              setHoveredBucketIdx(null);
              setPreviewMode((prev) => !prev);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              previewMode
                ? 'text-amber-900 bg-amber-50 border-amber-300 hover:bg-amber-100'
                : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>
              {previewMode
                ? tr('Return to Live Trends', 'တိုက်ရိုက် လမ်းကြောင်းသို့ ပြန်ရန်')
                : tr('Preview 30-Day Pattern', 'ရက် ၃၀ ပုံစံ အစမ်းကြည့်ရန်')}
            </span>
          </button>
        </div>
      </div>

      {/* Explicit Simulated Preview Banner */}
      {previewMode && (
        <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900">
          <span>
            {locale === 'my'
              ? `မူလစံ ကွာခြားမှုနှင့် စွမ်းဆောင်ရည် ရုတ်တရက် ကျဆင်းမှု ရှာဖွေပုံကို ပြသရန် ${days} ရက်စာ နမူနာဒေတာကို ဖော်ပြထားပါသည်။`
              : `Showing simulated ${days}-day regression preview data to demonstrate baseline drift and spike detection.`}
          </span>
          <button
            type="button"
            onClick={() => {
              setPreviewMode(false);
              setFocusedQueryId(null);
            }}
            className="font-semibold underline hover:text-amber-950 whitespace-nowrap cursor-pointer"
          >
            {tr('Switch back to live telemetry', 'တိုက်ရိုက် ဒေတာသို့ ပြန်ပြောင်းရန်')}
          </button>
        </div>
      )}

      {/* Loading State */}
      {loading && !previewMode ? (
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 bg-slate-100 rounded-lg animate-pulse"
              />
            ))}
          </div>
          <div className="h-64 bg-slate-100 rounded-lg animate-pulse" />
        </div>
      ) : error && !previewMode ? (
        <div className="p-8 text-center space-y-3">
          <p className="text-sm font-medium text-red-700">{error}</p>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => loadTrends(selectedTargetId, days, false)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{tr('Retry', 'ပြန်စမ်းရန်')}</span>
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode(true)}
              className="px-3.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg cursor-pointer"
            >
              {tr('Preview 30-Day Pattern', 'ရက် ၃၀ ပုံစံ အစမ်းကြည့်ရန်')}
            </button>
          </div>
        </div>
      ) : !activeData || seriesList.length === 0 ? (
        <div className="p-8 text-center space-y-2.5">
          <p className="text-sm font-semibold text-slate-900">
            {tr(
              'No query latency samples recorded yet',
              'Query ကြာချိန် မှတ်တမ်းများ မရှိသေးပါ'
            )}
          </p>
          <p className="text-xs text-slate-500 max-w-lg mx-auto">
            {activeData?.unavailableReason === 'CREDENTIAL_DECRYPT_FAILED'
              ? tr(
                  'Stored connection credentials could not be decrypted after a server restart. Re-enter the connection URI to resume live sampling.',
                  'ဆာဗာ ပြန်လည်စတင်ပြီးနောက် သိမ်းဆည်းထားသော ချိတ်ဆက်မှု အချက်အလက်ကို ဖွင့်၍ မရတော့ပါ။ တိုက်ရိုက် နမူနာ ပြန်လည်ရယူရန် ချိတ်ဆက်မှု URI ကို ပြန်ထည့်ပါ။'
                )
              : activeData?.unavailableReason ===
                  'External target credentials unavailable for live sampling; showing stored history.'
                ? tr(
                    'External target credentials are unavailable for live sampling; showing stored history.',
                    'တိုက်ရိုက် နမူနာရယူရန် ပြင်ပ ဒေတာဘေ့စ် ချိတ်ဆက်မှု အချက်အလက် မရရှိနိုင်ပါ — သိမ်းဆည်းထားသော သမိုင်းကြောင်းကိုသာ ပြသနေပါသည်။'
                  )
                : activeData?.unavailableReason ??
                  tr(
                    'Capture your first live pg_stat_statements sample to begin building a 30-day historical latency baseline.',
                    'ရက် ၃၀ စာ သမိုင်းကြောင်း ကြာချိန် မူလစံ စတင်တည်ဆောက်ရန် ပထမဆုံး pg_stat_statements နမူနာကို မှတ်တမ်းယူပါ။'
                  )}
          </p>
          <div className="pt-1 flex flex-wrap items-center justify-center gap-2.5">
            {activeData?.unavailableReason === 'CREDENTIAL_DECRYPT_FAILED' &&
            onRequestReconnect ? (
              <button
                type="button"
                onClick={onRequestReconnect}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>
                  {tr('Update Connection URI', 'ချိတ်ဆက်မှု URI ပြင်ဆင်ရန်')}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => loadTrends(selectedTargetId, days, true)}
                disabled={capturing}
                className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer"
              >
                {tr('Capture First Sample', 'ပထမဆုံး နမူနာ မှတ်တမ်းယူရန်')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setPreviewMode(true)}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
            >
              {tr('Preview 30-Day Pattern', 'ရက် ၃၀ ပုံစံ အစမ်းကြည့်ရန်')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* 4-Column Summary KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/50">
            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Tracked Top Queries', 'စောင့်ကြည့်နေသော ထိပ်တန်း Query များ')}
              </p>
              <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
                {seriesList.length}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                {locale === 'my'
                  ? `မှတ်တမ်း ${activeData.totalSamplesStored} ခု · ${activeData.distinctDays} ရက်`
                  : `${activeData.totalSamplesStored} stored samples · ${activeData.distinctDays} day${activeData.distinctDays === 1 ? '' : 's'}`}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Regressions Flagged', 'တွေ့ရှိသော စွမ်းဆောင်ရည် ကျဆင်းမှုများ')}
              </p>
              <p
                className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                  activeData.regressionQueriesCount > 0
                    ? 'text-red-700'
                    : 'text-emerald-700'
                }`}
              >
                {activeData.regressionQueriesCount}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {activeData.regressionQueriesCount > 0
                  ? tr(
                      'Exceeded +35% & 2σ baseline bound',
                      '+35% နှင့် 2σ မူလစံဘောင်ကို ကျော်လွန်သည်'
                    )
                  : tr(
                      'All queries within baseline bounds',
                      'Query အားလုံး မူလစံဘောင်အတွင်း ရှိသည်'
                    )}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Worst Drift vs. Baseline', 'မူလစံထက် အများဆုံး ကွာခြားမှု')}
              </p>
              <p
                className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                  activeData.worstDeltaPct >= 35
                    ? 'text-red-700'
                    : activeData.worstDeltaPct >= 15
                      ? 'text-amber-700'
                      : 'text-slate-900'
                }`}
              >
                {formatDeltaPct(activeData.worstDeltaPct)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {activeData.worstDeltaPct >= 35
                  ? tr('Sudden latency regression', 'ကြာချိန် ရုတ်တရက် မြင့်တက်မှု')
                  : activeData.worstDeltaPct >= 15
                    ? tr('Moderate upward drift', 'အသင့်အတင့် မြင့်တက်လာမှု')
                    : tr('Nominal variance', 'ပုံမှန် ပြောင်းလဲမှု')}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Blended Top-5 Latency', 'ထိပ်တန်း ၅ ခု ပျမ်းမျှ ကြာချိန်')}
              </p>
              <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
                {formatMs(activeData.blendedLatestMs)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                {tr('Baseline', 'မူလစံ')}{' '}
                {formatMs(activeData.blendedBaselineMs)} (
                {formatDeltaPct(activeData.blendedDeltaPct)})
              </p>
            </div>
          </div>

          {/* Interactive Chart Area */}
          <div className="px-6 py-5 space-y-4 border-b border-slate-200">
            {/* Query Focus Filter Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setFocusedQueryId(null)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    focusedQueryId === null
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {locale === 'my'
                    ? `ထိပ်တန်း ${seriesList.length} ခုလုံး`
                    : `All Top ${seriesList.length}`}
                </button>
                {seriesList.map((s, idx) => {
                  const color = SERIES_COLORS[idx % SERIES_COLORS.length];
                  const active = focusedQueryId === s.queryId;
                  return (
                    <button
                      key={s.queryId}
                      type="button"
                      onClick={() =>
                        setFocusedQueryId((prev) =>
                          prev === s.queryId ? null : s.queryId
                        )
                      }
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        active
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span className="font-mono">{s.shortLabel}</span>
                      {s.status === 'REGRESSION' && (
                        <span
                          className={`text-[11px] font-semibold ${
                            active ? 'text-red-300' : 'text-red-700'
                          }`}
                        >
                          {formatDeltaPct(s.deltaPct)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Clean Chart Legend */}
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="w-4 h-0.5 bg-blue-700 inline-block"
                  />
                  {tr('Observed Avg', 'တိုင်းတာရရှိ ပျမ်းမျှ')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="w-4 border-t-2 border-dashed border-slate-500 inline-block"
                  />
                  {tr('Historical Baseline', 'သမိုင်းကြောင်း မူလစံ')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="w-2 h-2 rounded-full bg-red-600 inline-block"
                  />
                  {tr('Regression Spike', 'ကျဆင်းမှု မြင့်တက်ချက်')}
                </span>
              </div>
            </div>

            {/* Sparse live history helper notice */}
            {isSparseLive && (
              <div className="px-3.5 py-2.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span>
                  {locale === 'my' ? (
                    <>
                      တိုက်ရိုက် မူလစံ စုဆောင်းမှု စတင်ပြီးပါပြီ (မှတ်တမ်း{' '}
                      {buckets.length} ခု)။ ရက်အလိုက် သမိုင်းကြောင်း တည်ဆောက်ရန်{' '}
                      <strong className="font-semibold text-slate-900">
                        နမူနာ မှတ်တမ်းယူရန်
                      </strong>{' '}
                      ကို နှိပ်ပါ သို့မဟုတ်{' '}
                      <strong className="font-semibold text-slate-900">
                        ရက် ၃၀ ပုံစံ အစမ်းကြည့်ရန်
                      </strong>{' '}
                      ကို ဖွင့်ကြည့်နိုင်ပါသည်။
                    </>
                  ) : (
                    <>
                      Live baseline collection started ({buckets.length} sample
                      bucket{buckets.length === 1 ? '' : 's'} captured). Click{' '}
                      <strong className="font-semibold text-slate-900">
                        Capture Sample
                      </strong>{' '}
                      over time to build multi-day history, or open the{' '}
                      <strong className="font-semibold text-slate-900">
                        Preview 30-Day Pattern
                      </strong>{' '}
                      to inspect multi-week regression curves.
                    </>
                  )}
                </span>
              </div>
            )}

            {/* Live Hover / Latest Readout Strip */}
            <div className="min-h-[28px] flex flex-wrap items-center justify-between gap-2 text-xs bg-slate-50/70 border border-slate-200/80 rounded-lg px-3.5 py-1.5">
              {hoveredBucket ? (
                <>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {hoveredBucket.label}
                  </span>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono tabular-nums text-[11px]">
                    {(focusedSeries ? [focusedSeries] : seriesList).map((s) => {
                      const originalIdx = seriesList.findIndex(
                        (x) => x.queryId === s.queryId
                      );
                      const pt = s.points.find(
                        (p) => p.bucketKey === hoveredBucket.key
                      );
                      if (!pt) return null;
                      return (
                        <span
                          key={s.queryId}
                          className="inline-flex items-center gap-1.5"
                        >
                          <span
                            aria-hidden="true"
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{
                              backgroundColor:
                                SERIES_COLORS[
                                  originalIdx % SERIES_COLORS.length
                                ],
                            }}
                          />
                          <span className="text-slate-600">
                            {s.shortLabel}:
                          </span>
                          <span
                            className={
                              pt.isRegression
                                ? 'font-semibold text-red-700'
                                : 'font-semibold text-slate-900'
                            }
                          >
                            {formatMs(pt.avgLatencyMs)}
                          </span>
                          <span className="text-slate-400">
                            ({tr('base', 'မူလစံ')} {formatMs(s.baselineMs)} ·{' '}
                            {formatDeltaPct(pt.deltaPct)})
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </>
              ) : (
                <span className="text-slate-500">
                  {tr(
                    'Hover across the chart to inspect exact daily average latency against historical baselines, or click a query below to isolate its regression zone.',
                    'နေ့စဉ် ပျမ်းမျှ ကြာချိန်နှင့် မူလစံ နှိုင်းယှဉ်ချက်ကို ကြည့်ရှုရန် ဂရပ်ပေါ် ထောက်ပါ သို့မဟုတ် အောက်ပါ query တစ်ခုချင်းစီကို နှိပ်၍ သီးခြားကြည့်ရှုပါ။'
                  )}
                </span>
              )}
            </div>

            {/* Responsive SVG Multi-Series Latency vs Baseline Chart */}
            <div className="w-full overflow-x-auto">
              <svg
                viewBox={`0 0 ${chartW} ${chartH}`}
                role="img"
                aria-label={tr(
                  `${days}-day query average latency trends compared against historical baselines`,
                  `${days} ရက် query ပျမ်းမျှ ကြာချိန်နှင့် မူလစံ နှိုင်းယှဉ်ဂရပ်`
                )}
                className="w-full h-auto min-w-[620px] select-none"
                onMouseLeave={() => setHoveredBucketIdx(null)}
              >
                {/* Horizontal grid lines + Y-axis labels */}
                {yTicks.map((val, idx) => {
                  const y = yForMs(val);
                  return (
                    <g key={idx}>
                      <line
                        x1={padL}
                        x2={chartW - padR}
                        y1={y}
                        y2={y}
                        stroke={idx === 0 ? '#CBD5E1' : '#E2E8F0'}
                        strokeWidth={1}
                      />
                      <text
                        x={padL - 8}
                        y={y + 3.5}
                        textAnchor="end"
                        className="fill-slate-500 text-[10px] font-mono"
                      >
                        {formatMs(val)}
                      </text>
                    </g>
                  );
                })}

                {/* Focused query regression threshold zone & historical baseline */}
                {focusedSeries ? (
                  <>
                    <rect
                      x={padL}
                      y={padT}
                      width={plotW}
                      height={Math.max(
                        0,
                        yForMs(focusedSeries.regressionThresholdMs) - padT
                      )}
                      fill="#FEE2E2"
                      opacity={0.35}
                    />
                    <line
                      x1={padL}
                      x2={chartW - padR}
                      y1={yForMs(focusedSeries.regressionThresholdMs)}
                      y2={yForMs(focusedSeries.regressionThresholdMs)}
                      stroke="#DC2626"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      opacity={0.65}
                    />
                    <text
                      x={chartW - padR - 4}
                      y={yForMs(focusedSeries.regressionThresholdMs) - 5}
                      textAnchor="end"
                      className="fill-red-700 text-[10px] font-mono"
                    >
                      {tr('Regression threshold', 'ကျဆင်းမှု ကန့်သတ်ချက်')} (
                      {formatMs(focusedSeries.regressionThresholdMs)})
                    </text>

                    <line
                      x1={padL}
                      x2={chartW - padR}
                      y1={yForMs(focusedSeries.baselineMs)}
                      y2={yForMs(focusedSeries.baselineMs)}
                      stroke="#475569"
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                    />
                    <text
                      x={chartW - padR - 4}
                      y={yForMs(focusedSeries.baselineMs) - 5}
                      textAnchor="end"
                      className="fill-slate-600 text-[10px] font-mono"
                    >
                      {tr('Baseline', 'မူလစံ')} (
                      {formatMs(focusedSeries.baselineMs)})
                    </text>
                  </>
                ) : (
                  <>
                    <line
                      x1={padL}
                      x2={chartW - padR}
                      y1={yForMs(activeData.blendedBaselineMs)}
                      y2={yForMs(activeData.blendedBaselineMs)}
                      stroke="#64748B"
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                    />
                    <text
                      x={chartW - padR - 4}
                      y={yForMs(activeData.blendedBaselineMs) - 5}
                      textAnchor="end"
                      className="fill-slate-600 text-[10px] font-mono"
                    >
                      {tr('Blended Baseline', 'ပျမ်းမျှ မူလစံ')} (
                      {formatMs(activeData.blendedBaselineMs)})
                    </text>
                  </>
                )}

                {/* Vertical hover guide line */}
                {hoveredBucketIdx !== null && (
                  <line
                    x1={xForBucket(hoveredBucketIdx)}
                    x2={xForBucket(hoveredBucketIdx)}
                    y1={padT}
                    y2={padT + plotH}
                    stroke="#94A3B8"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                  />
                )}

                {/* Series polylines and point markers */}
                {seriesList.map((s, seriesIdx) => {
                  const color = SERIES_COLORS[seriesIdx % SERIES_COLORS.length];
                  const isFocused =
                    focusedQueryId === null || focusedQueryId === s.queryId;

                  const coords = s.points
                    .map((p) => {
                      const bIdx = bucketIndexByKey.get(p.bucketKey);
                      if (bIdx === undefined) return null;
                      return {
                        x: xForBucket(bIdx),
                        y: yForMs(p.avgLatencyMs),
                        bIdx,
                        point: p,
                      };
                    })
                    .filter(
                      (
                        c
                      ): c is {
                        x: number;
                        y: number;
                        bIdx: number;
                        point: QueryLatencySeries['points'][number];
                      } => c !== null
                    );

                  if (coords.length === 0) return null;
                  const pathD = coords
                    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`)
                    .join(' ');

                  return (
                    <g
                      key={s.queryId}
                      opacity={isFocused ? 1 : 0.16}
                      className="transition-opacity duration-150"
                    >
                      {coords.length > 1 && (
                        <path
                          d={pathD}
                          fill="none"
                          stroke={color}
                          strokeWidth={focusedQueryId === s.queryId ? 2.5 : 1.9}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      )}

                      {coords.map((c) => {
                        const isHovered = hoveredBucketIdx === c.bIdx;
                        const showDot =
                          coords.length <= 3 ||
                          c.point.isRegression ||
                          isHovered ||
                          focusedQueryId === s.queryId;
                        if (!showDot) return null;
                        return (
                          <circle
                            key={`${s.queryId}-${c.point.bucketKey}`}
                            cx={c.x}
                            cy={c.y}
                            r={
                              c.point.isRegression
                                ? isHovered
                                  ? 5.5
                                  : 4.5
                                : isHovered
                                  ? 4.5
                                  : 3
                            }
                            fill={c.point.isRegression ? '#DC2626' : '#FFFFFF'}
                            stroke={c.point.isRegression ? '#FFFFFF' : color}
                            strokeWidth={2}
                          />
                        );
                      })}
                    </g>
                  );
                })}

                {/* X-axis date labels */}
                {xTickIndices.map((idx) => (
                  <text
                    key={buckets[idx].key}
                    x={xForBucket(idx)}
                    y={chartH - 10}
                    textAnchor={
                      idx === 0 && buckets.length > 1
                        ? 'start'
                        : idx === buckets.length - 1 && buckets.length > 1
                          ? 'end'
                          : 'middle'
                    }
                    className="fill-slate-500 text-[10px] font-mono"
                  >
                    {buckets[idx].label}
                  </text>
                ))}

                {/* Invisible interactive hit columns */}
                {buckets.map((b, idx) => {
                  const colW =
                    buckets.length <= 1
                      ? plotW
                      : plotW / Math.max(1, buckets.length - 1);
                  const x =
                    buckets.length <= 1
                      ? padL
                      : Math.max(padL, xForBucket(idx) - colW / 2);
                  return (
                    <rect
                      key={`hit-${b.key}`}
                      x={x}
                      y={padT}
                      width={colW}
                      height={plotH}
                      fill="transparent"
                      className="cursor-crosshair"
                      onMouseEnter={() => setHoveredBucketIdx(idx)}
                    />
                  );
                })}
              </svg>
            </div>
          </div>

          {/* Per-Query Historical Baseline & Regression Breakdown Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                  <th className="py-2.5 pl-6 pr-3">
                    {tr('Query Pattern', 'Query ပုံစံ')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {tr('Historical Baseline', 'သမိုင်းကြောင်း မူလစံ')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {tr('Latest Avg', 'နောက်ဆုံး ပျမ်းမျှ')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {locale === 'my' ? `${days} ရက် အမြင့်ဆုံး` : `${days}d Peak`}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {tr('Drift vs. Baseline', 'မူလစံနှင့် ကွာခြားမှု')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {tr('Spikes', 'မြင့်တက်မှု')}
                  </th>
                  <th className="py-2.5 pl-3 pr-6 text-right">
                    {tr('Status', 'အခြေအနေ')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {seriesList.map((s, idx) => {
                  const color = SERIES_COLORS[idx % SERIES_COLORS.length];
                  const st = statusMeta(s.status);
                  const isFocused = focusedQueryId === s.queryId;
                  const isExpanded = expandedRowId === s.queryId;

                  return (
                    <Fragment key={s.queryId}>
                      <tr
                        onClick={() =>
                          setFocusedQueryId((prev) =>
                            prev === s.queryId ? null : s.queryId
                          )
                        }
                        className={`cursor-pointer transition-colors ${
                          isFocused ? 'bg-blue-50/50' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-3 pl-6 pr-3 max-w-sm">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <button
                              type="button"
                              aria-label={
                                isExpanded
                                  ? tr('Collapse query SQL', 'Query SQL ပိတ်ရန်')
                                  : tr('Expand query SQL', 'Query SQL ဖွင့်ကြည့်ရန်')
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedRowId((prev) =>
                                  prev === s.queryId ? null : s.queryId
                                );
                              }}
                              className="text-slate-400 hover:text-slate-800 shrink-0 cursor-pointer"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <span
                              aria-hidden="true"
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: color }}
                            />
                            <div className="min-w-0">
                              <p className="font-mono font-semibold text-slate-900 truncate">
                                {s.shortLabel}
                              </p>
                              <p className="font-mono text-[11px] text-slate-500 truncate">
                                {s.queryText}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {formatMs(s.baselineMs)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                          {formatMs(s.latestMs)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {formatMs(s.peakMs)}
                        </td>
                        <td
                          className={`py-3 px-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                            s.deltaPct >= 35
                              ? 'text-red-700'
                              : s.deltaPct >= 15
                                ? 'text-amber-700'
                                : s.deltaPct <= -15
                                  ? 'text-emerald-700'
                                  : 'text-slate-600'
                          }`}
                        >
                          {formatDeltaPct(s.deltaPct)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {s.regressionCount > 0 ? (
                            <span className="font-semibold text-red-700">
                              {s.regressionCount}
                            </span>
                          ) : (
                            '0'
                          )}
                        </td>
                        <td className="py-3 pl-3 pr-6 text-right whitespace-nowrap">
                          <span className={`font-semibold ${st.className}`}>
                            {st.label}
                          </span>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-slate-50/80">
                          <td colSpan={7} className="px-6 py-4 space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                              <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
                                <span>Query ID {s.queryId}</span>
                                <span
                                  className="text-slate-300"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span>
                                  {locale === 'my'
                                    ? `${s.totalCalls.toLocaleString()} ကြိမ်`
                                    : `${s.totalCalls.toLocaleString()} calls`}
                                </span>
                                <span
                                  className="text-slate-300"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span>
                                  {locale === 'my'
                                    ? `Cache နှုန်း ${s.avgCacheHitPct.toFixed(1)}%`
                                    : `${s.avgCacheHitPct.toFixed(1)}% cache hit`}
                                </span>
                                <span
                                  className="text-slate-300"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span>
                                  {tr('Threshold', 'ကန့်သတ်ချက်')}{' '}
                                  {formatMs(s.regressionThresholdMs)}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopySql(s.queryId, s.queryText);
                                }}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                {copiedId === s.queryId ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                                    <span>{t('action.copied')}</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" />
                                    <span>{tr('Copy SQL', 'SQL ကူးယူရန်')}</span>
                                  </>
                                )}
                              </button>
                            </div>
                            <pre className="p-3.5 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words leading-relaxed">
                              {s.queryText}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
