import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellPlus,
  Check,
  Copy,
  Eye,
  RefreshCw,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  HealthTrendPoint,
  HealthTrendsResponse,
  MonitoredDatabaseDto,
  SuggestedTrendAlert,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface HealthTrendsPanelProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  selectedTargetId: string;
  onTargetChange: (databaseId: string) => void;
  onIncidentCreated?: () => void;
}

function buildSampleTrends(
  windowSize: number,
  sigmaThreshold: number,
  locale: 'en' | 'my'
): HealthTrendsResponse {
  const now = Date.now();
  const isMy = locale === 'my';
  const rawSamples = [
    { daysAgo: 13, deadPct: 6.1, deadTup: 8200, vac: 3, bloatPct: 16.4, bloatBytes: 24e6, idxCnt: 1 },
    { daysAgo: 12, deadPct: 6.8, deadTup: 9100, vac: 3, bloatPct: 17.1, bloatBytes: 25e6, idxCnt: 1 },
    { daysAgo: 11, deadPct: 7.2, deadTup: 9600, vac: 4, bloatPct: 17.8, bloatBytes: 27e6, idxCnt: 1 },
    { daysAgo: 10, deadPct: 6.9, deadTup: 9300, vac: 3, bloatPct: 18.2, bloatBytes: 28e6, idxCnt: 1 },
    { daysAgo: 9, deadPct: 7.4, deadTup: 10100, vac: 4, bloatPct: 19.0, bloatBytes: 30e6, idxCnt: 1 },
    { daysAgo: 8, deadPct: 7.9, deadTup: 10800, vac: 4, bloatPct: 19.6, bloatBytes: 32e6, idxCnt: 1 },
    { daysAgo: 7, deadPct: 8.3, deadTup: 11400, vac: 5, bloatPct: 20.3, bloatBytes: 34e6, idxCnt: 1 },
    { daysAgo: 6, deadPct: 7.6, deadTup: 10300, vac: 4, bloatPct: 21.1, bloatBytes: 36e6, idxCnt: 1 },
    { daysAgo: 5, deadPct: 8.5, deadTup: 11900, vac: 5, bloatPct: 21.8, bloatBytes: 38e6, idxCnt: 1 },
    { daysAgo: 4, deadPct: 9.1, deadTup: 12700, vac: 5, bloatPct: 23.0, bloatBytes: 42e6, idxCnt: 2 },
    { daysAgo: 3, deadPct: 10.4, deadTup: 14900, vac: 6, bloatPct: 24.4, bloatBytes: 47e6, idxCnt: 2 },
    { daysAgo: 2, deadPct: 26.8, deadTup: 41200, vac: 14, bloatPct: 27.6, bloatBytes: 56e6, idxCnt: 2 },
    { daysAgo: 1, deadPct: 31.5, deadTup: 52800, vac: 18, bloatPct: 44.2, bloatBytes: 91e6, idxCnt: 3 },
    { daysAgo: 0, deadPct: 34.2, deadTup: 59400, vac: 21, bloatPct: 51.8, bloatBytes: 112e6, idxCnt: 4 },
  ];

  const stats = (vals: number[]) => {
    const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    const variance =
      vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
      Math.max(1, vals.length);
    return { mean, stdDev: Math.sqrt(variance) };
  };

  const points: HealthTrendPoint[] = rawSamples.map((s, idx) => {
    const ts = new Date(now - s.daysAgo * 86_400_000);
    const trailing = rawSamples.slice(Math.max(0, idx - windowSize), idx);
    let vacuumBaselineMean: number | null = null;
    let vacuumUpperBound: number | null = null;
    let vacuumZScore: number | null = null;
    let vacuumAnomaly = false;
    let bloatBaselineMean: number | null = null;
    let bloatUpperBound: number | null = null;
    let bloatZScore: number | null = null;
    let bloatAnomaly = false;

    if (trailing.length >= 3) {
      const vs = stats(trailing.map((x) => x.deadPct));
      const vStd = Math.max(vs.stdDev, 1.25);
      const vUpper = vs.mean + sigmaThreshold * vStd;
      vacuumBaselineMean = Math.round(vs.mean * 100) / 100;
      vacuumUpperBound = Math.round(vUpper * 100) / 100;
      vacuumZScore = Math.round(((s.deadPct - vs.mean) / vStd) * 100) / 100;
      vacuumAnomaly = s.deadPct > vUpper && s.deadPct - vs.mean >= 4;

      const bs = stats(trailing.map((x) => x.bloatPct));
      const bStd = Math.max(bs.stdDev, 1.5);
      const bUpper = bs.mean + sigmaThreshold * bStd;
      bloatBaselineMean = Math.round(bs.mean * 100) / 100;
      bloatUpperBound = Math.round(bUpper * 100) / 100;
      bloatZScore = Math.round(((s.bloatPct - bs.mean) / bStd) * 100) / 100;
      bloatAnomaly = s.bloatPct > bUpper && s.bloatPct - bs.mean >= 5;
    }

    return {
      timestamp: ts.toISOString(),
      label: ts.toLocaleDateString(isMy ? 'my-MM' : 'en-US', {
        month: 'short',
        day: 'numeric',
      }),
      deadTuplePct: s.deadPct,
      deadTuples: s.deadTup,
      vacuumEvents: s.vac,
      vacuumBaselineMean,
      vacuumUpperBound,
      vacuumZScore,
      vacuumAnomaly,
      indexBloatPct: s.bloatPct,
      bloatedIndexBytes: s.bloatBytes,
      bloatedIndexCount: s.idxCnt,
      bloatBaselineMean,
      bloatUpperBound,
      bloatZScore,
      bloatAnomaly,
    };
  });

  const nowIso = new Date(now).toISOString();
  const suggestedAlerts: SuggestedTrendAlert[] = [
    {
      id: 'sample-vac-orders',
      fingerprint: 'sample_vacuum_spike_public_orders_001',
      category: 'VACUUM_SPIKE',
      incidentType: 'VACUUM_HEALTH',
      severity: 'CRITICAL',
      title: isMy
        ? 'public.orders တွင် VACUUM လှုပ်ရှားမှုနှင့် Dead-Tuple ရုတ်တရက် မြင့်တက်မှု'
        : 'Vacuum Activity & Dead-Tuple Spike on public.orders',
      targetObject: 'public.orders',
      observedLabel: isMy
        ? '34.2% dead tuple (၅၉,၄၀၀ အတန်း)'
        : '34.2% dead tuples (59,400 rows)',
      baselineLabel: isMy ? '8.7% ကာလပျမ်းမျှ' : '8.7% window avg',
      deviationLabel: isMy ? 'ကာလစံထက် +3.4σ မြင့်' : '+3.4σ above window',
      plainEnglishReason: isMy
        ? 'နောက်ဆုံး မှတ်တမ်း ၃ ခုအတွင်း dead tuple အချိုးသည် sliding-window အမြင့်ဆုံး ကန့်သတ်ချက်ကို ကျော်လွန်သွားပြီး autovacuum အကြိမ်ရေ ၃.၅ ဆ မြင့်တက်လာသဖြင့် UPDATE အလွန်များပြားမှုက မူလ vacuum ကန့်သတ်ချက်ထက် ကျော်လွန်နေကြောင်း ပြသနေပါသည်။'
        : 'Dead tuple ratio surged above the sliding-window upper bound over the last 3 snapshots while autovacuum cycles jumped 3.5x, signaling heavy UPDATE churn outpacing default vacuum cost limits.',
      remediationSql: 'VACUUM (VERBOSE, ANALYZE) "public"."orders";',
      detectedAt: nowIso,
      alreadyPromoted: false,
      metrics: {
        schemaname: 'public',
        tablename: 'orders',
        n_live_tup: 114200,
        n_dead_tup: 59400,
        dead_tuple_pct: 34.2,
      },
    },
    {
      id: 'sample-bloat-idx',
      fingerprint: 'sample_index_bloat_orders_created_002',
      category: 'INDEX_BLOAT_GROWTH',
      incidentType: 'INDEX_BLOAT',
      severity: 'WARNING',
      title: isMy
        ? 'public.idx_orders_status_created တွင် ပုံမှန်မဟုတ်သော အညွှန်း ဖောင်းပွမှု'
        : 'Anomalous Index Bloat Growth on public.idx_orders_status_created',
      targetObject: 'public.idx_orders_status_created (orders)',
      observedLabel: isMy ? '51.8% ဖောင်းပွမှု (112 MB)' : '51.8% bloat (112 MB)',
      baselineLabel: isMy ? '22.4% ကာလပျမ်းမျှ' : '22.4% window avg',
      deviationLabel: isMy ? 'ကာလစံထက် +2.9σ မြင့်' : '+2.9σ above window',
      plainEnglishReason: isMy
        ? 'အစုလိုက် status ပြင်ဆင်မှုများ ပြီးနောက် အညွှန်း ဖောင်းပွမှုသည် မူလပျမ်းမျှထက် ၂ ဆကျော် ကြီးထွားလာပြီး B-tree စာမျက်နှာများ ဖောင်းပွကာ အမှာစာ ရှာဖွေမှုများကို နှေးကွေးစေပါသည်။'
        : 'Index bloat expanded more than 2x above the trailing rolling baseline following bulk status backfills, inflating B-tree leaf pages and slowing order lookups.',
      remediationSql:
        'REINDEX INDEX CONCURRENTLY "public"."idx_orders_status_created";',
      detectedAt: nowIso,
      alreadyPromoted: false,
      metrics: {
        schemaname: 'public',
        tablename: 'orders',
        indexname: 'idx_orders_status_created',
        index_bytes: 112 * 1024 * 1024,
        index_size_pretty: '112 MB',
        estimated_bloat_pct: 51.8,
      },
    },
  ];

  return {
    targetLabel: isMy
      ? 'နမူနာ ထုတ်လုပ်ရေး Cluster (၁၄ မှတ် အစမ်းကြည့်)'
      : 'Sample Production Cluster (14-Sample Preview)',
    databaseId: null,
    canPromoteAlerts: false,
    collectedAt: nowIso,
    windowSize,
    sigmaThreshold,
    snapshotCount: rawSamples.length,
    points,
    vacuumAnomalyCount: points.filter((p) => p.vacuumAnomaly).length,
    bloatAnomalyCount: points.filter((p) => p.bloatAnomaly).length,
    latestDeadTuplePct: 34.2,
    latestIndexBloatPct: 51.8,
    totalVacuumCycles: 118,
    suggestedAlerts,
  };
}

export function HealthTrendsPanel({
  api,
  databases,
  selectedTargetId,
  onTargetChange,
  onIncidentCreated,
}: HealthTrendsPanelProps) {
  const { locale, t, tr, formatEnv, formatSeverity, formatIncidentType } =
    useI18n();

  const [windowSize, setWindowSize] = useState<number>(5);
  const [sigmaThreshold, setSigmaThreshold] = useState<number>(2.0);
  const [liveTrends, setLiveTrends] = useState<HealthTrendsResponse | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewSample, setPreviewSample] = useState(false);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promotedIds, setPromotedIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadTrends = useCallback(
    async (dbId: string, win: number, sigma: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getHealthTrends({
          databaseId: dbId || undefined,
          windowSize: win,
          sigmaThreshold: sigma,
        });
        setLiveTrends(res);
      } catch (err) {
        setLiveTrends(null);
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Unable to compute sliding-window health trends.',
                'ကျန်းမာရေး လမ်းကြောင်း ခွဲခြမ်းစိတ်ဖြာမှုကို တွက်ချက်၍ မရပါ။'
              )
        );
      } finally {
        setLoading(false);
      }
    },
    [api, tr]
  );

  useEffect(() => {
    setPreviewSample(false);
    setNotice(null);
    loadTrends(selectedTargetId, windowSize, sigmaThreshold);
  }, [selectedTargetId, windowSize, sigmaThreshold, loadTrends]);

  const activeTrends = useMemo(() => {
    if (previewSample) {
      return buildSampleTrends(windowSize, sigmaThreshold, locale);
    }
    return liveTrends;
  }, [previewSample, liveTrends, windowSize, sigmaThreshold, locale]);

  const handleCopy = async (id: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const handlePromoteAlert = async (alert: SuggestedTrendAlert) => {
    if (!activeTrends?.databaseId) return;
    setPromotingId(alert.id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.promoteTrendAlert({
        databaseId: activeTrends.databaseId,
        incidentType: alert.incidentType,
        severity: alert.severity,
        fingerprint: alert.fingerprint,
        summary: `${alert.title}: ${alert.observedLabel} (${alert.deviationLabel}).`,
        schemaname: alert.metrics.schemaname,
        tablename: alert.metrics.tablename,
        indexname: alert.metrics.indexname,
        n_live_tup: alert.metrics.n_live_tup,
        n_dead_tup: alert.metrics.n_dead_tup,
        dead_tuple_pct: alert.metrics.dead_tuple_pct,
        index_bytes: alert.metrics.index_bytes,
        index_size_pretty: alert.metrics.index_size_pretty,
        estimated_bloat_pct: alert.metrics.estimated_bloat_pct,
      });
      setPromotedIds((prev) => new Set(prev).add(alert.id));
      setNotice(
        res.alreadyExists
          ? locale === 'my'
            ? `${alert.targetObject} အတွက် ဖွင့်ထားသော သတိပေးချက် ရှိနှင့်ပြီးဖြစ်ပါသည်။`
            : `An active incident alert already exists for ${alert.targetObject}.`
          : locale === 'my'
            ? `${alert.targetObject} အတွက် ${formatSeverity(alert.severity)} ${formatIncidentType(alert.incidentType)} သတိပေးချက်ကို ဖန်တီးပြီး သက်ဆိုင်ရာ Webhook များသို့ ပေးပို့ပြီးပါပြီ။`
            : `Created ${alert.severity} ${alert.incidentType} alert for ${alert.targetObject} and dispatched eligible webhooks.`
      );
      onIncidentCreated?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to promote suggested alert to Incident Feed.',
              'အကြံပြု သတိပေးချက်ကို သတိပေးချက် စာရင်းသို့ ထည့်သွင်း၍ မရပါ။'
            )
      );
    } finally {
      setPromotingId(null);
    }
  };

  const totalFlaggedPoints =
    (activeTrends?.vacuumAnomalyCount ?? 0) +
    (activeTrends?.bloatAnomalyCount ?? 0);

  return (
    <section
      aria-labelledby="health-trends-heading"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
    >
      {/* Header Bar */}
      <div className="px-6 py-5 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="health-trends-heading"
              className="text-base font-semibold text-slate-900"
            >
              {tr('Health Trends', 'ကျန်းမာရေး လမ်းကြောင်းများ')}
            </h2>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500">
              {locale === 'my'
                ? `Sliding-Window မူမမှန်မှု ရှာဖွေခြင်း (${windowSize} မှတ် · ${sigmaThreshold.toFixed(1)}σ)`
                : `Sliding-Window Anomaly Detection (${windowSize}-sample · ${sigmaThreshold.toFixed(1)}σ)`}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {tr(
              'Automatically detects anomalous spikes in vacuum dead-tuple activity and index bloat growth against a rolling baseline and suggests new incident alerts.',
              'VACUUM dead-tuple လှုပ်ရှားမှုနှင့် အညွှန်း ဖောင်းပွမှု ရုတ်တရက် မြင့်တက်ခြင်းများကို ရွေ့လျားစံနှုန်းနှင့် နှိုင်းယှဉ်၍ အလိုအလျောက် ရှာဖွေပြီး သတိပေးချက်အသစ်များ အကြံပြုပေးပါသည်။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <select
            value={selectedTargetId}
            onChange={(e) => onTargetChange(e.target.value)}
            aria-label={tr(
              'Select PostgreSQL target for health trends',
              'ကျန်းမာရေး လမ်းကြောင်းအတွက် PostgreSQL ပစ်မှတ် ရွေးချယ်ရန်'
            )}
            className="px-3 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 max-w-[200px] truncate"
          >
            <option value="">
              {tr(
                'Workspace PostgreSQL (Live)',
                'လုပ်ငန်းခွင် PostgreSQL (တိုက်ရိုက်)'
              )}
            </option>
            {databases.map((db) => (
              <option key={db.id} value={db.id}>
                {db.name} ({formatEnv(db.environment)})
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-xs text-slate-600 whitespace-nowrap">
            <span>{tr('Window', 'ကာလအကွာအဝေး')}</span>
            <select
              value={windowSize}
              onChange={(e) => setWindowSize(Number(e.target.value))}
              aria-label={tr('Sliding window size', 'Sliding window အရွယ်အစား')}
              className="px-2.5 py-1.5 text-xs font-mono text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            >
              <option value={3}>{locale === 'my' ? '၃ မှတ်' : '3 pts'}</option>
              <option value={5}>{locale === 'my' ? '၅ မှတ်' : '5 pts'}</option>
              <option value={7}>{locale === 'my' ? '၇ မှတ်' : '7 pts'}</option>
              <option value={14}>{locale === 'my' ? '၁၄ မှတ်' : '14 pts'}</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-slate-600 whitespace-nowrap">
            <span>{tr('Sensitivity', 'အာရုံခံနိုင်စွမ်း')}</span>
            <select
              value={sigmaThreshold}
              onChange={(e) => setSigmaThreshold(Number(e.target.value))}
              aria-label={tr(
                'Anomaly sensitivity threshold',
                'မူမမှန်မှု အာရုံခံ ကန့်သတ်ချက်'
              )}
              className="px-2.5 py-1.5 text-xs font-mono text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            >
              <option value={1.5}>
                {tr('1.5σ (High)', '1.5σ (မြင့်)')}
              </option>
              <option value={2.0}>
                {tr('2.0σ (Balanced)', '2.0σ (မျှတ)')}
              </option>
              <option value={2.5}>
                {tr('2.5σ (Strict)', '2.5σ (တင်းကျပ်)')}
              </option>
            </select>
          </label>

          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setPreviewSample(false);
              loadTrends(selectedTargetId, windowSize, sigmaThreshold);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            <span>{t('action.refresh')}</span>
          </button>
        </div>
      </div>

      {/* Preview Mode Banner */}
      {previewSample && (
        <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-900">
          <span>
            {tr(
              'Showing a 14-sample anomaly preview demonstrating sliding-window detection on vacuum activity and index bloat spikes. Switch back to live telemetry to promote real database incidents.',
              'VACUUM လှုပ်ရှားမှုနှင့် အညွှန်း ဖောင်းပွမှု ရုတ်တရက် မြင့်တက်ခြင်းများကို sliding-window ဖြင့် ရှာဖွေပုံ နမူနာ ၁၄ မှတ်ကို ပြသထားပါသည်။ တကယ့် သတိပေးချက်များ ထည့်သွင်းရန် တိုက်ရိုက်ဒေတာသို့ ပြန်ပြောင်းပါ။'
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              setPreviewSample(false);
              loadTrends(selectedTargetId, windowSize, sigmaThreshold);
            }}
            className="px-3 py-1.5 text-xs font-medium text-amber-950 bg-white border border-amber-300 hover:bg-amber-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            {tr('Return to Live Trends', 'တိုက်ရိုက် လမ်းကြောင်းသို့ ပြန်သွားရန်')}
          </button>
        </div>
      )}

      {notice && (
        <div className="px-6 py-3 bg-blue-50 border-b border-blue-200 text-xs text-blue-900">
          {notice}
        </div>
      )}

      {/* Body States */}
      {loading ? (
        <div className="p-6 space-y-4 animate-pulse">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((k) => (
              <div key={k} className="h-20 bg-slate-100 rounded-lg" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="h-52 bg-slate-100 rounded-lg" />
            <div className="h-52 bg-slate-100 rounded-lg" />
          </div>
        </div>
      ) : error ? (
        <div className="p-6">
          <div
            role="alert"
            className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() =>
                loadTrends(selectedTargetId, windowSize, sigmaThreshold)
              }
              className="px-3 py-1.5 text-xs font-medium text-red-900 bg-white border border-red-200 hover:bg-red-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              {tr('Retry Analysis', 'ပြန်လည် ခွဲခြမ်းစိတ်ဖြာရန်')}
            </button>
          </div>
        </div>
      ) : activeTrends ? (
        <div>
          {/* 4-Column Trend KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/50">
            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Sliding-Window Spikes', 'မူမမှန် မြင့်တက်မှု အရေအတွက်')}
              </p>
              <p
                className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                  totalFlaggedPoints > 0 ? 'text-red-700' : 'text-slate-900'
                }`}
              >
                {totalFlaggedPoints}
              </p>
              <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                {locale === 'my'
                  ? `VACUUM ${activeTrends.vacuumAnomalyCount} · ဖောင်းပွမှု ${activeTrends.bloatAnomalyCount}`
                  : `${activeTrends.vacuumAnomalyCount} vacuum · ${activeTrends.bloatAnomalyCount} bloat`}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Latest Peak Dead Tuples', 'နောက်ဆုံး အမြင့်ဆုံး Dead Tuple')}
              </p>
              <p
                className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                  activeTrends.latestDeadTuplePct >= 20
                    ? 'text-red-700'
                    : activeTrends.latestDeadTuplePct >= 10
                      ? 'text-amber-700'
                      : 'text-slate-900'
                }`}
              >
                {activeTrends.latestDeadTuplePct.toFixed(1)}%
              </p>
              <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                {locale === 'my'
                  ? `စုစုပေါင်း VACUUM ${activeTrends.totalVacuumCycles.toLocaleString()} ကြိမ်`
                  : `${activeTrends.totalVacuumCycles.toLocaleString()} cumulative vacuum cycles`}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Latest Index Bloat Peak', 'နောက်ဆုံး အမြင့်ဆုံး အညွှန်း ဖောင်းပွမှု')}
              </p>
              <p
                className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                  activeTrends.latestIndexBloatPct >= 40
                    ? 'text-amber-700'
                    : 'text-slate-900'
                }`}
              >
                {activeTrends.latestIndexBloatPct.toFixed(1)}%
              </p>
              <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                {locale === 'my'
                  ? `တိုင်းတာချက် ${activeTrends.points.length} ခု ခွဲခြမ်းစိတ်ဖြာပြီး`
                  : `${activeTrends.points.length} observation${activeTrends.points.length === 1 ? '' : 's'} analyzed`}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Suggested Incident Alerts', 'အကြံပြု သတိပေးချက်များ')}
              </p>
              <p
                className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                  activeTrends.suggestedAlerts.length > 0
                    ? 'text-amber-700'
                    : 'text-emerald-700'
                }`}
              >
                {activeTrends.suggestedAlerts.length}
              </p>
              <p className="text-xs text-slate-500 mt-0.5 truncate">
                {activeTrends.suggestedAlerts.length > 0
                  ? tr(
                      'Ready for 1-click alert promotion',
                      'တစ်ချက်နှိပ်ရုံဖြင့် သတိပေးချက် ထည့်သွင်းနိုင်သည်'
                    )
                  : tr(
                      'All metrics within rolling band',
                      'တိုင်းတာချက်အားလုံး ပုံမှန်ဘောင်အတွင်း ရှိသည်'
                    )}
              </p>
            </div>
          </div>

          {/* Dual Sliding-Window Trend Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200">
            <SlidingWindowChart
              title={tr(
                'Vacuum Activity & Dead-Tuple Spike Trend',
                'VACUUM လှုပ်ရှားမှုနှင့် Dead-Tuple မြင့်တက်မှု လမ်းကြောင်း'
              )}
              subtitle={tr(
                'Tracks peak dead-tuple % against the trailing rolling upper bound.',
                'အမြင့်ဆုံး dead-tuple % ကို ရွေ့လျားအမြင့်ဆုံး ကန့်သတ်ချက်နှင့် နှိုင်းယှဉ်ပြသပါသည်။'
              )}
              points={activeTrends.points}
              series="vacuum"
              windowSize={activeTrends.windowSize}
              sigmaThreshold={activeTrends.sigmaThreshold}
              legendObserved={tr('Observed %', 'တိုင်းတာရရှိ %')}
              legendMean={tr('Window Mean', 'ကာလပျမ်းမျှ')}
              legendUpper={tr('Upper Bound', 'အမြင့်ဆုံး ဘောင်')}
              legendSpike={tr('Flagged Spike', 'မူမမှန် မြင့်တက်မှု')}
              bandSuffix={locale === 'my' ? 'မှတ်' : 'pt'}
            />
            <SlidingWindowChart
              title={tr(
                'Index Bloat Growth Trend',
                'အညွှန်း ဖောင်းပွမှု တိုးပွားလာသည့် လမ်းကြောင်း'
              )}
              subtitle={tr(
                'Tracks peak estimated index bloat % against the trailing rolling upper bound.',
                'ခန့်မှန်း အမြင့်ဆုံး အညွှန်း ဖောင်းပွမှု % ကို ရွေ့လျားအမြင့်ဆုံး ဘောင်နှင့် နှိုင်းယှဉ်ပြသပါသည်။'
              )}
              points={activeTrends.points}
              series="bloat"
              windowSize={activeTrends.windowSize}
              sigmaThreshold={activeTrends.sigmaThreshold}
              legendObserved={tr('Observed %', 'တိုင်းတာရရှိ %')}
              legendMean={tr('Window Mean', 'ကာလပျမ်းမျှ')}
              legendUpper={tr('Upper Bound', 'အမြင့်ဆုံး ဘောင်')}
              legendSpike={tr('Flagged Spike', 'မူမမှန် မြင့်တက်မှု')}
              bandSuffix={locale === 'my' ? 'မှတ်' : 'pt'}
            />
          </div>

          {/* Suggested Incident Alerts Section */}
          <div>
            <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-slate-900">
                  {tr('Suggested Incident Alerts', 'အကြံပြု သတိပေးချက်များ')}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tr(
                    'Anomalous vacuum spikes and index bloat surges recommended for promotion to your workspace Incident Feed.',
                    'ပုံမှန်မဟုတ်သော VACUUM နှင့် အညွှန်း ဖောင်းပွမှု မြင့်တက်ခြင်းများကို လုပ်ငန်းခွင် သတိပေးချက် စာရင်းသို့ ထည့်သွင်းရန် အကြံပြုထားပါသည်။'
                  )}
                </p>
              </div>
              {!previewSample && (
                <button
                  type="button"
                  onClick={() => setPreviewSample(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>
                    {tr('Preview Anomaly Window', 'မူမမှန်မှု နမူနာကြည့်ရန်')}
                  </span>
                </button>
              )}
            </div>

            {activeTrends.suggestedAlerts.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <div className="space-y-1 max-w-lg mx-auto">
                  <p className="text-sm font-semibold text-slate-900">
                    {tr(
                      'No anomalous vacuum or index bloat spikes detected',
                      'မူမမှန်သော VACUUM သို့မဟုတ် အညွှန်း ဖောင်းပွမှု မြင့်တက်ခြင်း မတွေ့ရှိပါ'
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    {activeTrends.points.length < 4
                      ? locale === 'my'
                        ? `${activeTrends.targetLabel} အတွက် လက်ရှိ မှတ်တမ်း ${activeTrends.points.length} ခုသာ ရှိသေးပါသည်။ ${windowSize} မှတ် sliding window အတွက် ပုံမှန် စစ်ဆေးမှုများ ဆက်လက်ပြုလုပ်ပါ သို့မဟုတ် နမူနာကြည့်ရှုပါ။`
                        : `Currently ${activeTrends.points.length} telemetry sample(s) recorded for ${activeTrends.targetLabel}. Run periodic inspections so the ${windowSize}-sample sliding window builds a multi-point rolling baseline, or preview how spike suggestions appear.`
                      : locale === 'my'
                        ? `${activeTrends.targetLabel} ရှိ လတ်တလော VACUUM လှုပ်ရှားမှုနှင့် အညွှန်း ဖောင်းပွမှု တိုင်းတာချက်အားလုံးသည် ${sigmaThreshold.toFixed(1)}σ ကန့်သတ်ဘောင်အတွင်း ရှိနေပါသည်။`
                        : `All recent vacuum activity and index bloat measurements on ${activeTrends.targetLabel} remain inside the ${sigmaThreshold.toFixed(1)}σ rolling threshold band.`}
                  </p>
                </div>
                {!previewSample && (
                  <button
                    type="button"
                    onClick={() => setPreviewSample(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>
                      {tr('Preview Anomaly Window', 'မူမမှန်မှု နမူနာကြည့်ရန်')}
                    </span>
                  </button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {activeTrends.suggestedAlerts.map((alert) => {
                  const isPromoted =
                    alert.alreadyPromoted || promotedIds.has(alert.id);
                  const copyKey = `trend-sql-${alert.id}`;
                  const sevClass =
                    alert.severity === 'CRITICAL'
                      ? 'text-red-700'
                      : alert.severity === 'WARNING'
                        ? 'text-amber-700'
                        : 'text-blue-700';

                  return (
                    <div
                      key={alert.id}
                      className="px-6 py-4 flex flex-col lg:flex-row lg:items-start justify-between gap-4 hover:bg-slate-50/60 transition-colors"
                    >
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`font-semibold ${sevClass}`}>
                            {formatSeverity(alert.severity)}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="font-mono font-semibold text-slate-700">
                            {formatIncidentType(alert.incidentType)}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="font-mono text-slate-900">
                            {alert.targetObject}
                          </span>
                        </div>

                        <p className="text-sm font-semibold text-slate-900">
                          {alert.title}
                        </p>

                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-slate-600">
                          <span className="text-slate-900 font-semibold">
                            {tr('Observed:', 'တိုင်းတာရရှိ:')} {alert.observedLabel}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span>
                            {tr('Baseline:', 'မူလစံ:')} {alert.baselineLabel}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className={`font-semibold ${sevClass}`}>
                            {alert.deviationLabel}
                          </span>
                        </div>

                        <p className="text-xs text-slate-600 leading-relaxed max-w-3xl">
                          {alert.plainEnglishReason}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            handleCopy(copyKey, alert.remediationSql)
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {copiedId === copyKey ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                              <span>{tr('Copied SQL', 'SQL ကူးယူပြီး')}</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>
                                {tr('Copy Fix SQL', 'ပြုပြင် SQL ကူးယူရန်')}
                              </span>
                            </>
                          )}
                        </button>

                        {previewSample ? (
                          <span className="text-xs text-slate-500 font-medium px-2">
                            {tr('Sample suggestion', 'နမူနာ အကြံပြုချက်')}
                          </span>
                        ) : !activeTrends.canPromoteAlerts ? (
                          <span className="text-xs text-slate-500 px-2">
                            {tr(
                              'Register target to promote',
                              'ထည့်သွင်းရန် ပစ်မှတ် မှတ်ပုံတင်ပါ'
                            )}
                          </span>
                        ) : isPromoted ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
                            <Check className="w-3.5 h-3.5" />
                            <span>
                              {tr(
                                'Active in Incidents',
                                'သတိပေးချက်တွင် ပါဝင်ပြီး'
                              )}
                            </span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={promotingId === alert.id}
                            onClick={() => handlePromoteAlert(alert)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <BellPlus className="w-3.5 h-3.5" />
                            <span>
                              {promotingId === alert.id
                                ? tr('Promoting…', 'ထည့်သွင်းနေသည်…')
                                : tr(
                                    'Promote to Incident Alert',
                                    'သတိပေးချက်အဖြစ် ထည့်သွင်းရန်'
                                  )}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SlidingWindowChart({
  title,
  subtitle,
  points,
  series,
  windowSize,
  sigmaThreshold,
  legendObserved,
  legendMean,
  legendUpper,
  legendSpike,
  bandSuffix,
}: {
  title: string;
  subtitle: string;
  points: HealthTrendPoint[];
  series: 'vacuum' | 'bloat';
  windowSize: number;
  sigmaThreshold: number;
  legendObserved: string;
  legendMean: string;
  legendUpper: string;
  legendSpike: string;
  bandSuffix: string;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const width = 460;
  const height = 205;
  const padLeft = 44;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const getValue = (p: HealthTrendPoint) =>
    series === 'vacuum' ? p.deadTuplePct : p.indexBloatPct;
  const getMean = (p: HealthTrendPoint) =>
    series === 'vacuum' ? p.vacuumBaselineMean : p.bloatBaselineMean;
  const getUpper = (p: HealthTrendPoint) =>
    series === 'vacuum' ? p.vacuumUpperBound : p.bloatUpperBound;
  const getZ = (p: HealthTrendPoint) =>
    series === 'vacuum' ? p.vacuumZScore : p.bloatZScore;
  const isAnomaly = (p: HealthTrendPoint) =>
    series === 'vacuum' ? p.vacuumAnomaly : p.bloatAnomaly;

  const maxVal = Math.max(
    25,
    ...points.map((p) =>
      Math.max(getValue(p), getUpper(p) ?? 0, getMean(p) ?? 0)
    )
  );
  const yMax = Math.min(100, Math.ceil((maxVal * 1.15) / 10) * 10);

  const toX = (idx: number) =>
    points.length <= 1
      ? padLeft + plotW / 2
      : padLeft + (idx / (points.length - 1)) * plotW;
  const toY = (val: number) =>
    padTop +
    plotH -
    (Math.min(yMax, Math.max(0, val)) / Math.max(1, yMax)) * plotH;

  const observedPath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(getValue(p)).toFixed(1)}`
    )
    .join(' ');

  const upperPoints = points
    .map((p, i) => ({ i, val: getUpper(p) }))
    .filter((x): x is { i: number; val: number } => x.val !== null);

  const upperPath = upperPoints
    .map(
      (x, idx) =>
        `${idx === 0 ? 'M' : 'L'} ${toX(x.i).toFixed(1)} ${toY(x.val).toFixed(1)}`
    )
    .join(' ');

  const meanPoints = points
    .map((p, i) => ({ i, val: getMean(p) }))
    .filter((x): x is { i: number; val: number } => x.val !== null);

  const meanPath = meanPoints
    .map(
      (x, idx) =>
        `${idx === 0 ? 'M' : 'L'} ${toX(x.i).toFixed(1)} ${toY(x.val).toFixed(1)}`
    )
    .join(' ');

  const lineColor = series === 'vacuum' ? '#1D4ED8' : '#0F766E';
  const activePt =
    hoveredIdx !== null ? (points[hoveredIdx] ?? null) : null;

  const yTicks = [0, 0.5, 1].map((frac) => ({
    val: Math.round(yMax * frac),
    y: padTop + plotH - frac * plotH,
  }));

  return (
    <div className="p-6 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-slate-900">{title}</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        <div className="text-right font-mono text-[11px] tabular-nums text-slate-600 shrink-0">
          {activePt ? (
            <div>
              <span className="font-semibold text-slate-900">
                {getValue(activePt).toFixed(1)}%
              </span>
              {getZ(activePt) !== null && (
                <span
                  className={`ml-1.5 font-semibold ${
                    isAnomaly(activePt) ? 'text-red-700' : 'text-slate-500'
                  }`}
                >
                  ({getZ(activePt)! >= 0 ? '+' : ''}
                  {getZ(activePt)!.toFixed(1)}σ)
                </span>
              )}
            </div>
          ) : (
            <span className="text-slate-400">
              {windowSize}-{bandSuffix} · {sigmaThreshold.toFixed(1)}σ
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="w-3 h-0.5 inline-block"
            style={{ backgroundColor: lineColor }}
          />
          <span>{legendObserved}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0 border-t border-dashed border-slate-400 inline-block" />
          <span>{legendMean}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-0 border-t-2 border-dashed border-amber-600 inline-block" />
          <span>{legendUpper}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-600 inline-block" />
          <span>{legendSpike}</span>
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto select-none"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={padLeft}
              y1={t.y}
              x2={width - padRight}
              y2={t.y}
              stroke="#E2E8F0"
              strokeWidth="1"
            />
            <text
              x={padLeft - 8}
              y={t.y + 3.5}
              textAnchor="end"
              className="fill-slate-500 text-[10px] font-mono"
            >
              {t.val}%
            </text>
          </g>
        ))}

        {/* X Axis start / middle / end labels */}
        {points.length > 0 && (
          <>
            <text
              x={toX(0)}
              y={height - 8}
              textAnchor={points.length === 1 ? 'middle' : 'start'}
              className="fill-slate-500 text-[10px] font-mono"
            >
              {points[0].label}
            </text>
            {points.length > 2 && (
              <text
                x={toX(Math.floor(points.length / 2))}
                y={height - 8}
                textAnchor="middle"
                className="fill-slate-500 text-[10px] font-mono"
              >
                {points[Math.floor(points.length / 2)].label}
              </text>
            )}
            {points.length > 1 && (
              <text
                x={toX(points.length - 1)}
                y={height - 8}
                textAnchor="end"
                className="fill-slate-500 text-[10px] font-mono"
              >
                {points[points.length - 1].label}
              </text>
            )}
          </>
        )}

        {/* Trailing Window Mean */}
        {meanPath && (
          <path
            d={meanPath}
            fill="none"
            stroke="#94A3B8"
            strokeWidth="1.25"
            strokeDasharray="3 3"
          />
        )}

        {/* Sliding Window Upper Anomaly Bound */}
        {upperPath && (
          <path
            d={upperPath}
            fill="none"
            stroke="#D97706"
            strokeWidth="1.5"
            strokeDasharray="5 3"
          />
        )}

        {/* Observed Series */}
        {observedPath && (
          <path
            d={observedPath}
            fill="none"
            stroke={lineColor}
            strokeWidth="2.25"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Data Points & Anomaly Spike Markers */}
        {points.map((p, idx) => {
          const cx = toX(idx);
          const cy = toY(getValue(p));
          const anomalous = isAnomaly(p);
          const isHovered = hoveredIdx === idx;
          const hitW = points.length > 1 ? plotW / points.length : plotW;

          return (
            <g key={`${p.timestamp}-${idx}`}>
              {isHovered && (
                <line
                  x1={cx}
                  y1={padTop}
                  x2={cx}
                  y2={padTop + plotH}
                  stroke="#CBD5E1"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
              )}
              {anomalous && (
                <circle
                  cx={cx}
                  cy={cy}
                  r="7"
                  fill="#DC2626"
                  fillOpacity="0.18"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={anomalous ? 4 : isHovered ? 4 : 2.75}
                fill={anomalous ? '#DC2626' : isHovered ? lineColor : '#FFFFFF'}
                stroke={anomalous ? '#FFFFFF' : lineColor}
                strokeWidth="1.5"
              />
              <rect
                x={cx - hitW / 2}
                y={padTop}
                width={hitW}
                height={plotH}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIdx(idx)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
