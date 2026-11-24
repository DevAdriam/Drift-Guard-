import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  CapacityPlanningResponse,
  MonitoredDatabaseDto,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';
import { useTheme } from '../context/ThemeContext.tsx';

interface CapacityPlanningPanelProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  selectedTargetId: string;
  onTargetChange: (databaseId: string) => void;
}

const GB_BYTES = 1024 ** 3;
const PRESET_CAPACITIES_GB = [1, 10, 50, 100, 500, 1000] as const;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(2)} ${units[idx]}`;
}

export function CapacityPlanningPanel({
  api,
  databases,
  selectedTargetId,
  onTargetChange,
}: CapacityPlanningPanelProps) {
  const { locale, t, tr, formatEnv } = useI18n();

  const [data, setData] = useState<CapacityPlanningResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maxCapacityGb, setMaxCapacityGb] = useState<number>(10);
  const [capacityInput, setCapacityInput] = useState<string>('10');
  const [showMitigated, setShowMitigated] = useState(true);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const dateLocale = locale === 'my' ? 'my-MM' : 'en-US';

  const formatDateShort = useCallback(
    (date: Date): string =>
      date.toLocaleDateString(dateLocale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    [dateLocale]
  );

  const formatAxisDate = useCallback(
    (date: Date): string =>
      date.toLocaleDateString(dateLocale, {
        month: 'short',
        year: '2-digit',
      }),
    [dateLocale]
  );

  const formatRunwayDuration = useCallback(
    (days: number): string => {
      if (!Number.isFinite(days)) return tr('Stable', 'တည်ငြိမ်သည်');
      if (days <= 0) return tr('Reached', 'ပြည့်သွားပြီး');
      if (days < 60) {
        return locale === 'my'
          ? `${Math.round(days)} ရက်`
          : `${Math.round(days)} days`;
      }
      if (days < 730) {
        return locale === 'my'
          ? `${(days / 30.4375).toFixed(1)} လ`
          : `${(days / 30.4375).toFixed(1)} months`;
      }
      return locale === 'my'
        ? `${(days / 365.25).toFixed(1)} နှစ်`
        : `${(days / 365.25).toFixed(1)} years`;
    },
    [locale, tr]
  );

  const loadCapacity = useCallback(
    async (dbId: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getCapacityPlanning(dbId || undefined);
        setData(res);
        setMaxCapacityGb(res.defaultMaxCapacityGb);
        setCapacityInput(String(res.defaultMaxCapacityGb));
        setHoveredIdx(null);
      } catch (err) {
        setData(null);
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Unable to calculate storage capacity projection for this database.',
                'ဤဒေတာဘေ့စ်အတွက် သိုလှောင်မှု ပမာဏ ကြိုတင်ခန့်မှန်းချက်ကို တွက်ချက်၍ မရပါ။'
              )
        );
      } finally {
        setLoading(false);
      }
    },
    [api, tr]
  );

  useEffect(() => {
    loadCapacity(selectedTargetId);
  }, [selectedTargetId, loadCapacity]);

  const applyCapacityGb = (nextGb: number) => {
    const clamped = Math.min(100000, Math.max(0.05, nextGb));
    setMaxCapacityGb(clamped);
    setCapacityInput(String(clamped));
  };

  const handleCapacityInputChange = (raw: string) => {
    setCapacityInput(raw);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0.05 && parsed <= 100000) {
      setMaxCapacityGb(parsed);
    }
  };

  const handleCopy = async (id: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const projection = useMemo(() => {
    if (!data) return null;

    const maxBytes = maxCapacityGb * GB_BYTES;
    const usedBytes = data.currentDbBytes;
    const usedPct = maxBytes > 0 ? (usedBytes / maxBytes) * 100 : 0;
    const remainingBytes = Math.max(0, maxBytes - usedBytes);
    const dailyGrowth = Math.max(0, data.dailyGrowthBytes);
    const mitigatedDaily = Math.max(0, data.mitigatedDailyGrowthBytes);

    const daysToExhaustion =
      usedBytes >= maxBytes
        ? 0
        : dailyGrowth > 0
          ? remainingBytes / dailyGrowth
          : Number.POSITIVE_INFINITY;

    const mitigatedDaysToExhaustion =
      usedBytes >= maxBytes
        ? 0
        : mitigatedDaily > 0
          ? remainingBytes / mitigatedDaily
          : Number.POSITIVE_INFINITY;

    const nowMs = Date.now();
    const maxForecastDays = 365 * 5;

    const exhaustionDate =
      daysToExhaustion === 0
        ? new Date(nowMs)
        : Number.isFinite(daysToExhaustion) && daysToExhaustion <= maxForecastDays
          ? new Date(nowMs + daysToExhaustion * 86_400_000)
          : null;

    const extraRunwayDays =
      Number.isFinite(daysToExhaustion) &&
      Number.isFinite(mitigatedDaysToExhaustion)
        ? Math.max(0, mitigatedDaysToExhaustion - daysToExhaustion)
        : Number.isFinite(daysToExhaustion) &&
            !Number.isFinite(mitigatedDaysToExhaustion)
          ? Number.POSITIVE_INFINITY
          : 0;

    const horizonDays =
      daysToExhaustion === 0
        ? 180
        : Number.isFinite(daysToExhaustion) && daysToExhaustion <= maxForecastDays
          ? Math.max(
              30,
              Math.min(maxForecastDays, Math.ceil(daysToExhaustion * 1.2))
            )
          : 365;

    const steps = 12;
    const waypoints = Array.from({ length: steps + 1 }, (_, i) => {
      const dayOffset = Math.round((horizonDays * i) / steps);
      const date = new Date(nowMs + dayOffset * 86_400_000);
      const projectedBytes = usedBytes + dailyGrowth * dayOffset;
      const mitigatedBytes = Math.max(
        0,
        usedBytes - data.estimatedBloatBytes * 0.65 + mitigatedDaily * dayOffset
      );
      return {
        index: i,
        dayOffset,
        date,
        projectedBytes,
        mitigatedBytes,
        pctOfMax: maxBytes > 0 ? (projectedBytes / maxBytes) * 100 : 0,
      };
    });

    const maxPlotBytes = Math.max(
      maxBytes * 1.12,
      waypoints[waypoints.length - 1]?.projectedBytes ?? maxBytes,
      usedBytes * 1.25
    );

    const bloatShareOfGrowthPct =
      dailyGrowth > 0
        ? Math.min(100, Math.round((data.dailyBloatBytes / dailyGrowth) * 100))
        : 0;

    const urgency: {
      label: string;
      textClass: string;
      strokeColor: string;
    } =
      daysToExhaustion <= 30
        ? {
            label:
              daysToExhaustion === 0
                ? tr('Capacity Reached', 'သိုလှောင်မှု ပြည့်သွားပြီး')
                : tr('Critical (<30d)', 'အရေးကြီး (<၃၀ ရက်)'),
            textClass: 'text-red-700 dark:text-red-400',
            strokeColor: '#DC2626',
          }
        : daysToExhaustion <= 90
          ? {
              label: tr('Plan Expansion (<90d)', 'တိုးချဲ့ရန် ပြင်ဆင်ပါ (<၉၀ ရက်)'),
              textClass: 'text-amber-700 dark:text-amber-400',
              strokeColor: '#D97706',
            }
          : {
              label: Number.isFinite(daysToExhaustion)
                ? tr('Healthy Runway', 'လုံလောက်သော ကာလ')
                : tr('Stable', 'တည်ငြိမ်သည်'),
              textClass: 'text-emerald-700 dark:text-emerald-400',
              strokeColor: '#1D4ED8',
            };

    return {
      maxBytes,
      usedPct,
      daysToExhaustion,
      mitigatedDaysToExhaustion,
      exhaustionDate,
      extraRunwayDays,
      horizonDays,
      waypoints,
      maxPlotBytes,
      bloatShareOfGrowthPct,
      urgency,
    };
  }, [data, maxCapacityGb, tr]);

  const activePoint =
    projection && hoveredIdx !== null
      ? projection.waypoints[hoveredIdx] ?? null
      : null;

  return (
    <section
      aria-labelledby="capacity-planning-heading"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
    >
      {/* Header Bar */}
      <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="capacity-planning-heading"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              {tr('Capacity Planning', 'သိုလှောင်မှု ပမာဏ ကြိုတင်ခန့်မှန်းခြင်း')}
            </h2>
            <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
              {data?.dataSource === 'historical_snapshots'
                ? locale === 'my'
                  ? `သမိုင်းကြောင်း မှတ်တမ်းများ (${data.snapshotCount} မှတ်)`
                  : `Historical Snapshots (${data.snapshotCount} pts)`
                : tr(
                    'Table Bloat & Turnover Forecast',
                    'ဇယား ဖောင်းပွမှုနှင့် ပြောင်းလဲမှု ခန့်မှန်းချက်'
                  )}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {tr(
              'Projects disk growth from historical table bloat rates and estimates when the selected database will hit maximum storage capacity.',
              'သမိုင်းကြောင်း ဇယား ဖောင်းပွမှု နှုန်းထားများအပေါ် အခြေခံ၍ သိုလှောင်မှု တိုးပွားမှုနှင့် အမြင့်ဆုံး ပမာဏ ပြည့်မည့် ခန့်မှန်းရက်စွဲကို တွက်ချက်ဖော်ပြပါသည်။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <select
            value={selectedTargetId}
            onChange={(e) => onTargetChange(e.target.value)}
            aria-label={tr(
              'Select PostgreSQL target for capacity planning',
              'သိုလှောင်မှု ကြိုတင်ခန့်မှန်းရန် PostgreSQL ပစ်မှတ် ရွေးချယ်ရန်'
            )}
            className="px-3 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500 max-w-[210px] truncate"
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

          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
            <span>{tr('Max Storage', 'အမြင့်ဆုံး သိုလှောင်မှု')}</span>
            <input
              type="number"
              min="0.05"
              max="100000"
              step="any"
              value={capacityInput}
              onChange={(e) => handleCapacityInputChange(e.target.value)}
              aria-label={tr(
                'Maximum storage capacity in gigabytes',
                'အမြင့်ဆုံး သိုလှောင်မှု ပမာဏ (GB)'
              )}
              className="w-20 px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
            />
            <span className="font-mono text-slate-500 dark:text-slate-400">GB</span>
          </label>

          <button
            type="button"
            disabled={loading}
            onClick={() => loadCapacity(selectedTargetId)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            <span>{t('action.refresh')}</span>
          </button>
        </div>
      </div>

      {/* Quick Storage Tier Bar */}
      {!loading && !error && data && (
        <div className="px-6 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-slate-500 dark:text-slate-400 mr-1">
              {tr('Provisioned Volume Tier:', 'သတ်မှတ်ထားသော သိုလှောင်မှု အဆင့်:')}
            </span>
            {PRESET_CAPACITIES_GB.map((gb) => (
              <button
                key={gb}
                type="button"
                onClick={() => applyCapacityGb(gb)}
                className={`px-2.5 py-1 font-mono text-xs rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  Math.abs(maxCapacityGb - gb) < 0.001
                    ? 'bg-slate-900 dark:bg-blue-600 text-white'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowMitigated((prev) => !prev)}
            className="text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {showMitigated
              ? tr(
                  'Hide Post-Vacuum Trajectory',
                  'VACUUM ပြီးနောက် လမ်းကြောင်း ဖျောက်ရန်'
                )
              : tr(
                  'Compare Post-Vacuum Trajectory',
                  'VACUUM ပြီးနောက် လမ်းကြောင်း နှိုင်းယှဉ်ရန်'
                )}
          </button>
        </div>
      )}

      {/* Body States */}
      {loading ? (
        <div className="p-6 space-y-5 animate-pulse">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((k) => (
              <div key={k} className="h-20 bg-slate-100 dark:bg-slate-800 rounded-lg" />
            ))}
          </div>
          <div className="h-60 bg-slate-100 dark:bg-slate-800 rounded-lg" />
        </div>
      ) : error ? (
        <div className="p-6">
          <div
            role="alert"
            className="px-4 py-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => loadCapacity(selectedTargetId)}
              className="px-3 py-1.5 text-xs font-medium text-red-900 dark:text-red-200 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 hover:bg-red-100 dark:hover:bg-red-950/70 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              {tr('Retry Forecast', 'ပြန်လည်တွက်ချက်ရန်')}
            </button>
          </div>
        </div>
      ) : data && projection ? (
        <div>
          {/* 4-Column Forecast KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 dark:divide-slate-800 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr(
                  'Estimated Max Capacity Date',
                  'သိုလှောင်မှု ပြည့်မည့် ခန့်မှန်းရက်စွဲ'
                )}
              </p>
              <p className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {projection.daysToExhaustion === 0
                  ? tr('Capacity Reached', 'ပြည့်သွားပြီး')
                  : projection.exhaustionDate
                    ? formatDateShort(projection.exhaustionDate)
                    : tr('> 5 Years', '> ၅ နှစ်')}
              </p>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                <span className={`font-semibold ${projection.urgency.textClass}`}>
                  {projection.urgency.label}
                </span>
                {Number.isFinite(projection.daysToExhaustion) &&
                  projection.daysToExhaustion > 0 && (
                    <>
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {locale === 'my'
                          ? `ကျန်ရှိချိန် ${formatRunwayDuration(projection.daysToExhaustion)}`
                          : `${formatRunwayDuration(projection.daysToExhaustion)} left`}
                      </span>
                    </>
                  )}
              </div>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr('Current Disk Footprint', 'လက်ရှိ အသုံးပြုထားသော ပမာဏ')}
              </p>
              <p className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {data.currentDbPretty}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      projection.usedPct >= 85
                        ? 'bg-red-600'
                        : projection.usedPct >= 65
                          ? 'bg-amber-500'
                          : 'bg-blue-700 dark:bg-blue-600'
                    }`}
                    style={{
                      width: `${Math.min(100, Math.max(2, projection.usedPct))}%`,
                    }}
                  />
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                  {projection.usedPct < 0.1 && projection.usedPct > 0
                    ? '<0.1%'
                    : `${projection.usedPct.toFixed(1)}%`}{' '}
                  {locale === 'my'
                    ? `/ ${maxCapacityGb} GB`
                    : `of ${maxCapacityGb} GB`}
                </span>
              </div>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr('Projected Disk Growth Rate', 'ခန့်မှန်း နေ့စဉ် တိုးပွားမှုနှုန်း')}
              </p>
              <p className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {data.dailyGrowthBytes > 0
                  ? locale === 'my'
                    ? `${formatBytes(data.dailyGrowthBytes)}/ရက်`
                    : `${formatBytes(data.dailyGrowthBytes)}/day`
                  : locale === 'my'
                    ? '0 B/ရက်'
                    : '0 B/day'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                {locale === 'my'
                  ? `${formatBytes(data.monthlyGrowthBytes)}/လ · ဖောင်းပွမှုမှ ${projection.bloatShareOfGrowthPct}%`
                  : `${formatBytes(data.monthlyGrowthBytes)}/mo · ${projection.bloatShareOfGrowthPct}% from bloat`}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr(
                  'Reclaimable Bloat & Runway Gain',
                  'ပြန်လည်ရယူနိုင်သော ဖောင်းပွမှုနှင့် ကာလတိုးမြှင့်မှု'
                )}
              </p>
              <p className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {data.estimatedBloatPretty}
              </p>
              <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400 font-medium tabular-nums">
                {projection.extraRunwayDays === Number.POSITIVE_INFINITY
                  ? tr(
                      'Stabilizes runway after VACUUM',
                      'VACUUM လုပ်ပြီးနောက် သိုလှောင်မှု တည်ငြိမ်စေသည်'
                    )
                  : projection.extraRunwayDays > 1
                    ? locale === 'my'
                      ? `VACUUM ဖြင့် +${formatRunwayDuration(projection.extraRunwayDays)} ပိုမိုရရှိမည်`
                      : `+${formatRunwayDuration(projection.extraRunwayDays)} gained with VACUUM`
                    : locale === 'my'
                      ? `လက်ရှိ ဖောင်းပွမှုနှုန်း ${data.bloatRatioPct.toFixed(1)}%`
                      : `${data.bloatRatioPct.toFixed(1)}% current bloat ratio`}
              </p>
            </div>
          </div>

          {/* Interactive Projection SVG Chart */}
          <div className="p-6 border-b border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-4 text-slate-600 dark:text-slate-300">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-3 h-0.5 inline-block"
                    style={{ backgroundColor: projection.urgency.strokeColor }}
                  />
                  <span>
                    {tr(
                      'Projected Growth (Current Bloat Rate)',
                      'ခန့်မှန်း တိုးပွားမှု (လက်ရှိ ဖောင်းပွမှုနှုန်း)'
                    )}
                  </span>
                </span>
                {showMitigated && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0 border-t-2 border-dashed border-emerald-600 inline-block" />
                    <span>
                      {tr(
                        'After VACUUM & Bloat Cleanup',
                        'VACUUM နှင့် ဖောင်းပွမှု ရှင်းလင်းပြီးနောက်'
                      )}
                    </span>
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0 border-t-2 border-dashed border-red-600 inline-block" />
                  <span>
                    {tr('Max Capacity', 'အမြင့်ဆုံး ပမာဏ')} ({maxCapacityGb} GB)
                  </span>
                </span>
              </div>

              <div className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                {activePoint ? (
                  <span>
                    {formatDateShort(activePoint.date)} ·{' '}
                    <strong>{formatBytes(activePoint.projectedBytes)}</strong> (
                    {locale === 'my'
                      ? `အမြင့်ဆုံး၏ ${activePoint.pctOfMax.toFixed(1)}%`
                      : `${activePoint.pctOfMax.toFixed(1)}% of max`}
                    )
                  </span>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400">
                    {tr(
                      'Hover chart points to inspect forecasted storage',
                      'ခန့်မှန်း သိုလှောင်မှု အသေးစိတ်ကြည့်ရန် ဂရပ်အမှတ်များပေါ် ထောက်ပါ'
                    )}
                  </span>
                )}
              </div>
            </div>

            <CapacitySvgChart
              waypoints={projection.waypoints}
              maxBytes={projection.maxBytes}
              maxPlotBytes={projection.maxPlotBytes}
              horizonDays={projection.horizonDays}
              daysToExhaustion={projection.daysToExhaustion}
              exhaustionDate={projection.exhaustionDate}
              strokeColor={projection.urgency.strokeColor}
              showMitigated={showMitigated}
              hoveredIdx={hoveredIdx}
              onHoverIdx={setHoveredIdx}
              formatDateShort={formatDateShort}
              formatAxisDate={formatAxisDate}
              todayLabel={tr('Today', 'ယနေ့')}
              maxCapLabel={tr('Max Capacity', 'အမြင့်ဆုံး ပမာဏ')}
              fullLabel={tr('Full ~', 'ပြည့်မည့်ခန့်မှန်း ~')}
              ariaLabel={tr(
                'Projected database disk usage growth chart toward maximum storage capacity',
                'အမြင့်ဆုံး သိုလှောင်မှု ပမာဏသို့ ဦးတည်သော ဒေတာဘေ့စ် သိုလှောင်မှု ခန့်မှန်းဂရပ်'
              )}
            />
          </div>

          {/* Top Table Bloat & Growth Contributors */}
          <div className="overflow-x-auto">
            <div className="px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {tr(
                    'Table Bloat & Storage Growth Contributors',
                    'ဇယား ဖောင်းပွမှုနှင့် သိုလှောင်မှု တိုးပွားစေသော အဓိက ဇယားများ'
                  )}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {locale === 'my' ? (
                    <>
                      PostgreSQL စောင့်ကြည့်ကာလ{' '}
                      <span className="font-mono tabular-nums">
                        {data.statsWindowDays < 1
                          ? `${Math.round(data.statsWindowDays * 24)} နာရီ`
                          : `${data.statsWindowDays.toFixed(1)} ရက်`}
                      </span>{' '}
                      အတွင်း နေ့စဉ် သိုလှောင်မှု တိုးပွားနှုန်းအလိုက် စီစဉ်ထားပါသည်။
                    </>
                  ) : (
                    <>
                      Ranked by daily storage accumulation velocity across a{' '}
                      <span className="font-mono tabular-nums">
                        {data.statsWindowDays < 1
                          ? `${Math.round(data.statsWindowDays * 24)}h`
                          : `${data.statsWindowDays.toFixed(1)}d`}
                      </span>{' '}
                      PostgreSQL telemetry window.
                    </>
                  )}
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {locale === 'my'
                  ? `ဇယား ${data.topTables.length} ခု ခွဲခြမ်းစိတ်ဖြာပြီး`
                  : `${data.topTables.length} table${data.topTables.length === 1 ? '' : 's'} analyzed`}
              </span>
            </div>

            {data.topTables.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                {locale === 'my' ? (
                  <>
                    ဤဒေတာဘေ့စ်အတွက် <code className="font-mono">pg_stat_user_tables</code>{' '}
                    တွင် အသုံးပြုသူ ဇယား မတွေ့ရှိသေးပါ။
                  </>
                ) : (
                  <>
                    No user tables found in{' '}
                    <code className="font-mono">pg_stat_user_tables</code> for
                    this database yet.
                  </>
                )}
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th className="py-3 pl-6 pr-3">{tr('Table', 'ဇယား')}</th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">
                      {tr('Current Size', 'လက်ရှိ အရွယ်အစား')}
                    </th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">
                      {tr('Dead Tuples', 'Dead Tuple %')}
                    </th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">
                      {tr('Est. Bloat', 'ခန့်မှန်း ဖောင်းပွမှု')}
                    </th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">
                      {tr('Daily Growth', 'နေ့စဉ် တိုးပွားမှု')}
                    </th>
                    <th className="py-3 px-4 text-right whitespace-nowrap">
                      {tr('Growth Share', 'တိုးပွားမှု အချိုး')}
                    </th>
                    <th className="py-3 pl-4 pr-6 text-right whitespace-nowrap">
                      {tr('Reclaim', 'ပြန်လည်ရှင်းလင်း')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {data.topTables.map((table) => {
                    const key = `${table.schemaname}.${table.relname}`;
                    const copyKey = `cap-vac-${key}`;
                    return (
                      <tr
                        key={key}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
                      >
                        <td className="py-3 pl-6 pr-3">
                          <p className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {key}
                          </p>
                          <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                            {locale === 'my'
                              ? `အသုံးပြု ${table.n_live_tup.toLocaleString()} · ပြင်ဆင်/ဖျက် ${(table.n_tup_upd + table.n_tup_del).toLocaleString()}`
                              : `${table.n_live_tup.toLocaleString()} live · ${(table.n_tup_upd + table.n_tup_del).toLocaleString()} upd/del churn`}
                          </p>
                        </td>

                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          <div>{table.total_size_pretty}</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            idx {formatBytes(table.index_bytes)}
                          </div>
                        </td>

                        <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          <span
                            className={
                              table.dead_tuple_pct >= 20
                                ? 'font-semibold text-red-700 dark:text-red-400'
                                : table.dead_tuple_pct >= 10
                                  ? 'font-semibold text-amber-700 dark:text-amber-400'
                                  : 'text-slate-700 dark:text-slate-300'
                            }
                          >
                            {table.dead_tuple_pct.toFixed(1)}%
                          </span>
                        </td>

                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {table.estimated_bloat_pretty}
                        </td>

                        <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          <div className="font-semibold text-slate-900 dark:text-slate-100">
                            {formatBytes(table.daily_growth_bytes)}/d
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {tr('bloat', 'ဖောင်းပွမှု')}{' '}
                            {formatBytes(table.daily_bloat_bytes)}/d
                          </div>
                        </td>

                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          <div className="inline-flex items-center gap-2 justify-end">
                            <div className="w-14 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-700 dark:bg-blue-600 rounded-full"
                                style={{
                                  width: `${Math.min(100, Math.max(2, table.growth_share_pct))}%`,
                                }}
                              />
                            </div>
                            <span className="w-10 text-right">
                              {table.growth_share_pct.toFixed(1)}%
                            </span>
                          </div>
                        </td>

                        <td className="py-3 pl-4 pr-6 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() =>
                              handleCopy(copyKey, table.remediation_sql)
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer whitespace-nowrap shrink-0"
                          >
                            {copiedId === copyKey ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                                <span>{t('action.copied')}</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>VACUUM SQL</span>
                              </>
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CapacitySvgChart({
  waypoints,
  maxBytes,
  maxPlotBytes,
  horizonDays,
  daysToExhaustion,
  exhaustionDate,
  strokeColor,
  showMitigated,
  hoveredIdx,
  onHoverIdx,
  formatDateShort,
  formatAxisDate,
  todayLabel,
  maxCapLabel,
  fullLabel,
  ariaLabel,
}: {
  waypoints: {
    index: number;
    dayOffset: number;
    date: Date;
    projectedBytes: number;
    mitigatedBytes: number;
    pctOfMax: number;
  }[];
  maxBytes: number;
  maxPlotBytes: number;
  horizonDays: number;
  daysToExhaustion: number;
  exhaustionDate: Date | null;
  strokeColor: string;
  showMitigated: boolean;
  hoveredIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
  formatDateShort: (d: Date) => string;
  formatAxisDate: (d: Date) => string;
  todayLabel: string;
  maxCapLabel: string;
  fullLabel: string;
  ariaLabel: string;
}) {
  const { isDark } = useTheme();
  const width = 760;
  const height = 240;
  const padLeft = 66;
  const padRight = 24;
  const padTop = 20;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const toX = (dayOffset: number) =>
    padLeft +
    (Math.min(horizonDays, Math.max(0, dayOffset)) / Math.max(1, horizonDays)) *
      plotW;
  const toY = (bytes: number) =>
    padTop +
    plotH -
    (Math.min(maxPlotBytes, Math.max(0, bytes)) / Math.max(1, maxPlotBytes)) *
      plotH;

  const projectedPath = waypoints
    .map(
      (p, idx) =>
        `${idx === 0 ? 'M' : 'L'} ${toX(p.dayOffset).toFixed(1)} ${toY(p.projectedBytes).toFixed(1)}`
    )
    .join(' ');

  const areaPath =
    waypoints.length > 0
      ? `${projectedPath} L ${toX(waypoints[waypoints.length - 1].dayOffset).toFixed(1)} ${(padTop + plotH).toFixed(1)} L ${toX(0).toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`
      : '';

  const mitigatedPath = waypoints
    .map(
      (p, idx) =>
        `${idx === 0 ? 'M' : 'L'} ${toX(p.dayOffset).toFixed(1)} ${toY(p.mitigatedBytes).toFixed(1)}`
    )
    .join(' ');

  const capY = toY(maxBytes);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    bytes: maxPlotBytes * frac,
    y: padTop + plotH - frac * plotH,
  }));

  const xTickIndices = [0, 3, 6, 9, 12];
  const showExhaustionMarker =
    exhaustionDate !== null &&
    daysToExhaustion > 0 &&
    daysToExhaustion <= horizonDays;
  const exhaustX = showExhaustionMarker ? toX(daysToExhaustion) : 0;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full min-w-[540px] h-auto select-none"
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => onHoverIdx(null)}
      >
        <defs>
          <linearGradient id="capAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.16" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Horizontal Y Gridlines & Labels */}
        {yTicks.map((tick, idx) => (
          <g key={idx}>
            <line
              x1={padLeft}
              y1={tick.y}
              x2={width - padRight}
              y2={tick.y}
              stroke={isDark ? '#1E293B' : '#E2E8F0'}
              strokeWidth="1"
            />
            <text
              x={padLeft - 10}
              y={tick.y + 4}
              textAnchor="end"
              className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
            >
              {formatBytes(tick.bytes)}
            </text>
          </g>
        ))}

        {/* X Axis Date Ticks */}
        {xTickIndices.map((idx) => {
          const wp = waypoints[idx];
          if (!wp) return null;
          const x = toX(wp.dayOffset);
          return (
            <text
              key={idx}
              x={x}
              y={height - 10}
              textAnchor={
                idx === 0 ? 'start' : idx === 12 ? 'end' : 'middle'
              }
              className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
            >
              {idx === 0 ? todayLabel : formatAxisDate(wp.date)}
            </text>
          );
        })}

        {/* Projected Growth Area & Curve */}
        {areaPath && <path d={areaPath} fill="url(#capAreaFill)" />}
        {projectedPath && (
          <path
            d={projectedPath}
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.25"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Mitigated Post-Vacuum Comparison Curve */}
        {showMitigated && mitigatedPath && (
          <path
            d={mitigatedPath}
            fill="none"
            stroke="#059669"
            strokeWidth="1.75"
            strokeDasharray="5 4"
            strokeLinejoin="round"
          />
        )}

        {/* Max Storage Capacity Threshold Line */}
        <line
          x1={padLeft}
          y1={capY}
          x2={width - padRight}
          y2={capY}
          stroke="#DC2626"
          strokeWidth="1.5"
          strokeDasharray="6 4"
        />
        <text
          x={width - padRight}
          y={Math.max(padTop + 10, capY - 6)}
          textAnchor="end"
          className="fill-red-700 dark:fill-red-400 text-[10px] font-mono font-semibold"
        >
          {maxCapLabel} ({formatBytes(maxBytes)})
        </text>

        {/* Estimated Exhaustion Intersection Marker */}
        {showExhaustionMarker && (
          <g>
            <line
              x1={exhaustX}
              y1={capY}
              x2={exhaustX}
              y2={padTop + plotH}
              stroke="#DC2626"
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.7"
            />
            <circle
              cx={exhaustX}
              cy={capY}
              r="4.5"
              fill="#EF4444"
              stroke={isDark ? '#0F172A' : '#FFFFFF'}
              strokeWidth="1.5"
            />
            <text
              x={Math.min(width - padRight - 4, Math.max(padLeft + 4, exhaustX))}
              y={Math.min(padTop + plotH - 8, capY + 16)}
              textAnchor={exhaustX > width - 160 ? 'end' : 'middle'}
              className="fill-red-700 dark:fill-red-400 text-[10px] font-mono font-semibold"
            >
              {fullLabel}
              {formatDateShort(exhaustionDate)}
            </text>
          </g>
        )}

        {/* Interactive Waypoint Hover Targets */}
        {waypoints.map((wp) => {
          const cx = toX(wp.dayOffset);
          const cy = toY(wp.projectedBytes);
          const isHovered = hoveredIdx === wp.index;
          return (
            <g key={wp.index}>
              {isHovered && (
                <line
                  x1={cx}
                  y1={padTop}
                  x2={cx}
                  y2={padTop + plotH}
                  stroke="#94A3B8"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={isHovered ? 4.5 : 2.5}
                fill={
                  isHovered ? strokeColor : isDark ? '#0F172A' : '#FFFFFF'
                }
                stroke={strokeColor}
                strokeWidth="1.75"
              />
              <rect
                x={cx - plotW / 24}
                y={padTop}
                width={plotW / 12}
                height={plotH}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => onHoverIdx(wp.index)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
