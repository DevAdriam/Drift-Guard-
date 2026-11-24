import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  RefreshCw,
} from 'lucide-react';
import type { ApiClient, TelemetrySuiteResponse } from '../lib/api.ts';
import type {
  MonitoredDatabaseDto,
  QueryPerformanceResponse,
} from '../types/telemetry.ts';
import { LockContentionPanel } from './LockContentionPanel.tsx';
import { CapacityPlanningPanel } from './CapacityPlanningPanel.tsx';
import { HealthTrendsPanel } from './HealthTrendsPanel.tsx';
import { PerformanceTrendsPanel } from './PerformanceTrendsPanel.tsx';
import { IndexAdvisorPanel } from './IndexAdvisorPanel.tsx';
import { UpdateCredentialsModal } from './UpdateCredentialsModal.tsx';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface TelemetrySuiteViewProps {
  api: ApiClient;
  databases?: MonitoredDatabaseDto[];
  onIncidentCreated?: () => void;
  onDatabasesChanged?: () => Promise<void> | void;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '0.00 ms';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

export function TelemetrySuiteView({
  api,
  databases = [],
  onIncidentCreated,
  onDatabasesChanged,
}: TelemetrySuiteViewProps) {
  const { locale, t, tr, formatEnv, formatSeverity } = useI18n();

  const [suite, setSuite] = useState<TelemetrySuiteResponse | null>(null);
  const [loadingSuite, setLoadingSuite] = useState(true);
  const [roleName, setRoleName] = useState('drift_monitor');
  const [dbName, setDbName] = useState('production');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [performance, setPerformance] =
    useState<QueryPerformanceResponse | null>(null);
  const [loadingPerf, setLoadingPerf] = useState(true);
  const [perfError, setPerfError] = useState<string | null>(null);
  const [expandedQueryId, setExpandedQueryId] = useState<string | null>(null);
  const [reconnectModalOpen, setReconnectModalOpen] = useState(false);
  const [panelRefreshKey, setPanelRefreshKey] = useState(0);

  const selectedDatabase = databases.find((d) => d.id === selectedTargetId) ?? null;
  const isCredentialDecryptError =
    selectedDatabase?.credentialsValid === false ||
    (perfError != null &&
      (perfError.includes('could not be decrypted') ||
        perfError.includes('Unsupported state or unable to authenticate data')));

  const formatLatencySeverity = useCallback(
    (ms: number): { label: string; className: string } => {
      if (ms >= 100) {
        return { label: tr('Critical', 'အရေးကြီး'), className: 'text-red-700' };
      }
      if (ms >= 25) {
        return {
          label: tr('Elevated', 'မြင့်တက်နေသည်'),
          className: 'text-amber-700',
        };
      }
      return {
        label: tr('Nominal', 'ပုံမှန်'),
        className: 'text-emerald-700',
      };
    },
    [tr]
  );

  useEffect(() => {
    api
      .getTelemetrySuite()
      .then((res) => setSuite(res))
      .catch(() => undefined)
      .finally(() => setLoadingSuite(false));
  }, [api]);

  const loadPerformance = useCallback(
    async (dbId: string) => {
      setLoadingPerf(true);
      setPerfError(null);
      try {
        const res = await api.getQueryPerformance(dbId || undefined);
        setPerformance(res);
      } catch (err) {
        setPerformance(null);
        setPerfError(
          err instanceof Error
            ? err.message
            : tr(
                'Unable to query pg_stat_statements on the selected target.',
                'ရွေးချယ်ထားသော ပစ်မှတ်တွင် pg_stat_statements ကို စစ်ဆေး၍ မရပါ။'
              )
        );
      } finally {
        setLoadingPerf(false);
      }
    },
    [api, tr]
  );

  useEffect(() => {
    loadPerformance(selectedTargetId);
  }, [selectedTargetId, loadPerformance]);

  const safeRole = roleName.replace(/[^a-zA-Z0-9_]/g, '') || 'drift_monitor';
  const safeDb = dbName.replace(/[^a-zA-Z0-9_]/g, '') || 'production';

  const generatedProvisioningSql = `CREATE USER ${safeRole} WITH PASSWORD 'strong_password';
GRANT CONNECT ON DATABASE ${safeDb} TO ${safeRole};
GRANT pg_read_all_stats TO ${safeRole}; -- For pg_stat_activity, pg_stat_statements & lock monitoring`;

  const handleCopy = async (id: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const queries = performance?.queries ?? [];
  const peakMeanMs = queries.length > 0 ? queries[0].mean_exec_time_ms : 0;
  const peakSeverity = formatLatencySeverity(peakMeanMs);
  const combinedTotalMs = queries.reduce(
    (sum, q) => sum + q.total_exec_time_ms,
    0
  );
  const combinedCalls = queries.reduce((sum, q) => sum + q.calls, 0);
  const avgCacheHit =
    queries.length > 0
      ? queries.reduce((sum, q) => sum + q.cache_hit_pct, 0) / queries.length
      : 100;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          {tr(
            'SQL Telemetry & Provisioning Suite',
            'SQL စောင့်ကြည့်ရေးနှင့် အခွင့်အာဏာ သတ်မှတ်ရေး စနစ်'
          )}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {tr(
            'Live query latency profiling, 30-day performance regression trends, query-plan index advisor, real-time lock contention hierarchy, storage capacity planning, sliding-window health trends, and all 8 read-only collectors.',
            'တိုက်ရိုက် query နှောင့်နှေးမှု တိုင်းတာခြင်း၊ ရက် ၃၀ စွမ်းဆောင်ရည် လမ်းကြောင်းများ၊ အညွှန်း အကြံပေးစနစ်၊ အချိန်နှင့်တစ်ပြေးညီ Lock ပိတ်ဆို့မှု၊ သိုလှောင်မှု ပမာဏ ကြိုတင်ခန့်မှန်းခြင်း၊ ကျန်းမာရေး လမ်းကြောင်းများနှင့် ဖတ်ရှုသီးသန့် စစ်ဆေးရေး SQL ၈ ခုလုံး ပါဝင်ပါသည်။'
          )}
        </p>
      </div>

      {/* Performance Panel (Top 5 Most Expensive Queries by Average Latency) */}
      <section
        aria-labelledby="performance-panel-heading"
        className="bg-white border border-slate-200 rounded-xl overflow-hidden"
      >
        <div className="px-6 py-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2
                id="performance-panel-heading"
                className="text-base font-semibold text-slate-900"
              >
                {tr('Performance', 'စွမ်းဆောင်ရည်')}
              </h2>
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              <span className="text-xs font-mono text-slate-500">
                pg_stat_statements
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {locale === 'my' ? (
                <>
                  ပျမ်းမျှ လုပ်ဆောင်ချိန် (
                  <code className="font-mono text-slate-700">mean_exec_time</code>
                  ) အများဆုံး ထိပ်တန်း Query ၅ ခုကို စီစဉ်ဖော်ပြထားပါသည်။
                </>
              ) : (
                <>
                  Top 5 most expensive queries ranked by average execution
                  latency (
                  <code className="font-mono text-slate-700">mean_exec_time</code>
                  ).
                </>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <span className="whitespace-nowrap">
                {tr('Source', 'အရင်းအမြစ်')}
              </span>
              <select
                value={selectedTargetId}
                onChange={(e) => {
                  setSelectedTargetId(e.target.value);
                  setExpandedQueryId(null);
                }}
                aria-label={tr(
                  'Select PostgreSQL target for query performance',
                  'Query စွမ်းဆောင်ရည်အတွက် PostgreSQL ပစ်မှတ် ရွေးချယ်ရန်'
                )}
                className="px-3 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 max-w-xs truncate"
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
            </label>

            <button
              type="button"
              disabled={loadingPerf}
              onClick={() => loadPerformance(selectedTargetId)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loadingPerf ? 'animate-spin' : ''}`}
              />
              <span>
                {loadingPerf
                  ? tr('Refreshing…', 'ပြန်တင်နေသည်…')
                  : t('action.refresh')}
              </span>
            </button>
          </div>
        </div>

        {/* Performance Summary Strip */}
        {!loadingPerf && !perfError && performance?.extensionAvailable && (
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/50">
            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Slowest Average Latency', 'အနှေးဆုံး ပျမ်းမျှ ကြာချိန်')}
              </p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-xl font-bold font-mono tabular-nums text-slate-900">
                  {queries.length > 0 ? formatMs(peakMeanMs) : '—'}
                </span>
                {queries.length > 0 && (
                  <span
                    className={`text-xs font-semibold ${peakSeverity.className}`}
                  >
                    {peakSeverity.label}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5 truncate">
                {performance.targetLabel}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr('Top 5 Cumulative Time', 'ထိပ်တန်း ၅ ခု စုစုပေါင်း ကြာချိန်')}
              </p>
              <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
                {queries.length > 0 ? formatMs(combinedTotalMs) : '—'}
              </p>
              <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                {locale === 'my'
                  ? `စုစုပေါင်း လုပ်ဆောင်မှု ${combinedCalls.toLocaleString()} ကြိမ်`
                  : `${combinedCalls.toLocaleString()} total executions`}
              </p>
            </div>

            <div className="px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                {tr(
                  'Top 5 Shared Buffer Hit Rate',
                  'ထိပ်တန်း ၅ ခု Shared Buffer ထိရောက်မှုနှုန်း'
                )}
              </p>
              <p
                className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                  queries.length > 0 && avgCacheHit < 90
                    ? 'text-amber-700'
                    : 'text-slate-900'
                }`}
              >
                {queries.length > 0 ? `${avgCacheHit.toFixed(1)}%` : '—'}
              </p>
              <p className="text-xs text-slate-500 tabular-nums mt-0.5">
                {tr('Collected', 'စုဆောင်းချိန်')}{' '}
                {new Date(performance.collectedAt).toLocaleTimeString(
                  locale === 'my' ? 'my-MM' : 'en-US',
                  {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }
                )}
              </p>
            </div>
          </div>
        )}

        {/* Performance Body States */}
        {loadingPerf ? (
          <div className="divide-y divide-slate-200">
            {[1, 2, 3, 4, 5].map((row) => (
              <div
                key={row}
                className="px-6 py-3.5 flex items-center justify-between gap-4 animate-pulse"
              >
                <div className="flex items-center gap-3 w-3/5">
                  <div className="h-4 w-6 bg-slate-200 rounded" />
                  <div className="h-4 w-full bg-slate-100 rounded" />
                </div>
                <div className="h-4 w-20 bg-slate-200 rounded" />
                <div className="h-4 w-16 bg-slate-200 rounded" />
                <div className="h-4 w-16 bg-slate-200 rounded" />
              </div>
            ))}
          </div>
        ) : perfError ? (
          <div className="p-6">
            <div
              role="alert"
              className="px-4 py-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="space-y-1">
                <p className="font-medium text-red-900">
                  {isCredentialDecryptError
                    ? tr(
                        'Stored connection credentials could not be decrypted because the server encryption key changed on restart.',
                        'ဆာဗာ ပြန်လည်စတင်ရာတွင် ကုဒ်ဝှက်သော့ ပြောင်းလဲသွားသောကြောင့် သိမ်းဆည်းထားသော ချိတ်ဆက်မှု အချက်အလက်ကို ပြန်ဖွင့်၍ မရပါ။'
                      )
                    : perfError}
                </p>
                {isCredentialDecryptError && (
                  <p className="text-red-700">
                    {tr(
                      'Re-enter the PostgreSQL connection URI once — it will now be encrypted with a persistent server key and survive restarts.',
                      'PostgreSQL ချိတ်ဆက်မှု URI ကို တစ်ကြိမ် ပြန်လည်ထည့်သွင်းပါ — ယခုအခါ တည်မြဲသော ဆာဗာသော့ဖြင့် ကုဒ်ဝှက်သိမ်းဆည်းမည်ဖြစ်ပြီး ဆာဗာပြန်စတင်သော်လည်း မပျက်တော့ပါ။'
                    )}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {isCredentialDecryptError && selectedDatabase && (
                  <button
                    type="button"
                    onClick={() => setReconnectModalOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>
                      {tr('Update Connection URI', 'ချိတ်ဆက်မှု URI ပြင်ဆင်ရန်')}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => loadPerformance(selectedTargetId)}
                  className="px-3 py-1.5 text-xs font-medium text-red-900 bg-white border border-red-200 hover:bg-red-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {tr('Retry Query', 'ပြန်လည်စမ်းသပ်ရန်')}
                </button>
              </div>
            </div>
          </div>
        ) : !performance?.extensionAvailable ? (
          <div className="p-6 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-slate-900">
                {locale === 'my'
                  ? `${performance?.targetLabel ?? 'ဤပစ်မှတ်'} တွင် pg_stat_statements ဖွင့်မထားပါ`
                  : `pg_stat_statements is not active on ${performance?.targetLabel ?? 'this target'}`}
              </p>
              <p className="text-xs text-slate-600">
                {performance?.unavailableReason ||
                  tr(
                    'Enable the pg_stat_statements extension and grant pg_read_all_stats to track average query latency.',
                    'ပျမ်းမျှ query ကြာချိန်များကို စောင့်ကြည့်ရန် pg_stat_statements extension ကို ဖွင့်ပြီး pg_read_all_stats ခွင့်ပြုချက် ပေးပါ။'
                  )}
              </p>
            </div>
            {performance?.enableExtensionSql && (
              <SqlBlock
                id="enable-pgss"
                title={tr(
                  'Enable pg_stat_statements on Target',
                  'ပစ်မှတ်တွင် pg_stat_statements ဖွင့်ရန် SQL'
                )}
                sql={performance.enableExtensionSql}
                copied={copiedId === 'enable-pgss'}
                onCopy={handleCopy}
                copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
                copiedLabel={t('action.copied')}
              />
            )}
          </div>
        ) : queries.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm font-medium text-slate-900">
              {tr(
                'No query execution statistics recorded yet',
                'Query လုပ်ဆောင်မှု စာရင်းအင်း မှတ်တမ်း မရှိသေးပါ'
              )}
            </p>
            <p className="text-xs text-slate-500">
              {locale === 'my'
                ? `${performance.targetLabel} တွင် query များ လုပ်ဆောင်ပြီးနောက် အနှေးဆုံး ထိပ်တန်း ၅ ခုကို ကြည့်ရှုရန် ပြန်လည်စစ်ဆေးရန် နှိပ်ပါ။`
                : `Run workload queries against ${performance.targetLabel} and click Refresh to inspect the top 5 slowest statements.`}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 pl-6 pr-3 w-14">
                    {tr('Rank', 'အဆင့်')}
                  </th>
                  <th className="py-3 px-3">
                    {tr('Normalized Query', 'ပုံမှန်ပြုထားသော Query')}
                  </th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">
                    {tr('Avg Latency', 'ပျမ်းမျှ ကြာချိန်')}
                  </th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">
                    {tr('Max Latency', 'အမြင့်ဆုံး ကြာချိန်')}
                  </th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">
                    {tr('Calls', 'အကြိမ်')}
                  </th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">
                    {tr('Total Time', 'စုစုပေါင်းချိန်')}
                  </th>
                  <th className="py-3 pl-4 pr-6 text-right whitespace-nowrap">
                    {tr('Cache Hit', 'Cache နှုန်း')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {queries.map((q, index) => {
                  const rowKey = `${q.query_id}-${index}`;
                  const isExpanded = expandedQueryId === rowKey;
                  const severity = formatLatencySeverity(q.mean_exec_time_ms);
                  const relativePct =
                    peakMeanMs > 0
                      ? Math.max(
                          4,
                          Math.round((q.mean_exec_time_ms / peakMeanMs) * 100)
                        )
                      : 0;
                  const avgRowsPerCall =
                    q.calls > 0 ? (q.total_rows / q.calls).toFixed(1) : '0.0';

                  return (
                    <Fragment key={rowKey}>
                      <tr
                        onClick={() =>
                          setExpandedQueryId(isExpanded ? null : rowKey)
                        }
                        className="hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        <td className="py-3.5 pl-6 pr-3 font-mono font-semibold text-slate-500 tabular-nums whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                            )}
                            <span>#{index + 1}</span>
                          </span>
                        </td>

                        <td className="py-3.5 px-3 max-w-md lg:max-w-lg">
                          <p
                            className="font-mono text-slate-900 truncate"
                            title={q.query}
                          >
                            {q.query}
                          </p>
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1 flex-1 max-w-[160px] bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  q.mean_exec_time_ms >= 100
                                    ? 'bg-red-600'
                                    : q.mean_exec_time_ms >= 25
                                      ? 'bg-amber-500'
                                      : 'bg-blue-700'
                                }`}
                                style={{ width: `${relativePct}%` }}
                              />
                            </div>
                            <span className="text-[11px] text-slate-500 font-mono tabular-nums">
                              {locale === 'my'
                                ? `တစ်ကြိမ်လျှင် ${avgRowsPerCall} အတန်း`
                                : `${avgRowsPerCall} rows/call`}
                            </span>
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          <span className={`font-semibold ${severity.className}`}>
                            {formatMs(q.mean_exec_time_ms)}
                          </span>
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {formatMs(q.max_exec_time_ms)}
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {q.calls.toLocaleString()}
                        </td>

                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {formatMs(q.total_exec_time_ms)}
                        </td>

                        <td className="py-3.5 pl-4 pr-6 text-right font-mono tabular-nums whitespace-nowrap">
                          <span
                            className={
                              q.cache_hit_pct < 90
                                ? 'font-semibold text-amber-700'
                                : 'text-slate-700'
                            }
                          >
                            {q.cache_hit_pct.toFixed(1)}%
                          </span>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={7} className="px-6 py-4 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                              <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
                                <span>
                                  {tr('Query ID', 'Query ID')} {q.query_id}
                                </span>
                                <span
                                  className="text-slate-300"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span>
                                  {locale === 'my'
                                    ? `စုစုပေါင်း ${q.total_rows.toLocaleString()} အတန်း`
                                    : `${q.total_rows.toLocaleString()} total rows`}
                                </span>
                                <span
                                  className="text-slate-300"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span
                                  className={`font-sans font-semibold ${severity.className}`}
                                >
                                  {locale === 'my'
                                    ? `${severity.label} ကြာချိန်`
                                    : `${severity.label} latency`}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopy(`perf-${rowKey}`, q.query);
                                }}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                {copiedId === `perf-${rowKey}` ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-emerald-600" />
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
                              {q.query}
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
        )}
      </section>

      {/* 30-Day Query Latency Performance Trends vs. Historical Baselines */}
      <PerformanceTrendsPanel
        key={`perf-trends-${panelRefreshKey}`}
        api={api}
        databases={databases}
        selectedTargetId={selectedTargetId}
        onTargetChange={(nextId) => {
          setSelectedTargetId(nextId);
          setExpandedQueryId(null);
        }}
        onRequestReconnect={
          selectedDatabase?.connectionMode === 'external'
            ? () => setReconnectModalOpen(true)
            : undefined
        }
      />

      {/* Index Advisor: Query Plan & Sequential-Scan Composite Index Recommendations */}
      <IndexAdvisorPanel
        key={`index-advisor-${panelRefreshKey}`}
        api={api}
        databases={databases}
        selectedTargetId={selectedTargetId}
        onTargetChange={(nextId) => {
          setSelectedTargetId(nextId);
          setExpandedQueryId(null);
        }}
      />

      {/* Real-Time Lock Contention Hierarchy & Tree-Map */}
      <LockContentionPanel
        key={`locks-${panelRefreshKey}`}
        api={api}
        databases={databases}
        selectedTargetId={selectedTargetId}
        onTargetChange={(nextId) => {
          setSelectedTargetId(nextId);
          setExpandedQueryId(null);
        }}
      />

      {/* Capacity Planning & Disk Usage Growth Forecast */}
      <CapacityPlanningPanel
        key={`capacity-${panelRefreshKey}`}
        api={api}
        databases={databases}
        selectedTargetId={selectedTargetId}
        onTargetChange={(nextId) => {
          setSelectedTargetId(nextId);
          setExpandedQueryId(null);
        }}
      />

      {/* Sliding-Window Health Trends & Suggested Anomaly Alerts */}
      <HealthTrendsPanel
        key={`health-trends-${panelRefreshKey}`}
        api={api}
        databases={databases}
        selectedTargetId={selectedTargetId}
        onTargetChange={(nextId) => {
          setSelectedTargetId(nextId);
          setExpandedQueryId(null);
        }}
        onIncidentCreated={onIncidentCreated}
      />

      {/* Read-Only Role Provisioning Generator */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {tr(
                '1. Read-Only Target Role Provisioning',
                '၁။ ဖတ်ရှုသီးသန့် ပစ်မှတ် Role ဖန်တီးခြင်း'
              )}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {tr(
                'Grants bounded system-catalog inspection only—never reads or alters customer tables.',
                'System catalog စစ်ဆေးခွင့်ကိုသာ ကန့်သတ်ပေးထားပြီး အသုံးပြုသူ ဒေတာဇယားများကို မဖတ်ရှု၊ မပြင်ဆင်ပါ။'
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-slate-600 flex items-center gap-1.5">
              <span>{tr('Role', 'Role အမည်')}</span>
              <input
                type="text"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
                className="w-32 px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white text-slate-900"
              />
            </label>
            <label className="text-xs text-slate-600 flex items-center gap-1.5">
              <span>{tr('Database', 'ဒေတာဘေ့စ်')}</span>
              <input
                type="text"
                value={dbName}
                onChange={(e) => setDbName(e.target.value)}
                className="w-32 px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white text-slate-900"
              />
            </label>
          </div>
        </div>

        <SqlBlock
          id="provision"
          title={tr('Bounded Permissions DDL', 'ကန့်သတ် ခွင့်ပြုချက် DDL')}
          sql={generatedProvisioningSql}
          copied={copiedId === 'provision'}
          onCopy={handleCopy}
          copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
          copiedLabel={t('action.copied')}
        />
      </div>

      {/* Core Inspection Queries */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {tr(
              '2. Core Inspection SQL Collectors (8 Queries)',
              '၂။ အဓိက စစ်ဆေးရေး SQL Collector များ (Query ၈ ခု)'
            )}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {tr(
              'Exact read-only queries executed against monitored targets during telemetry, performance, and capacity inspections.',
              'စောင့်ကြည့်နေသော ပစ်မှတ်များတွင် ကျန်းမာရေး၊ စွမ်းဆောင်ရည်နှင့် သိုလှောင်မှု စစ်ဆေးစဉ် လုပ်ဆောင်သည့် ဖတ်ရှုသီးသန့် SQL များဖြစ်ပါသည်။'
            )}
          </p>
        </div>

        {loadingSuite || !suite ? (
          <div className="space-y-4">
            <div className="h-32 bg-slate-100 rounded-lg animate-pulse" />
            <div className="h-44 bg-slate-100 rounded-lg animate-pulse" />
          </div>
        ) : (
          <div className="space-y-4">
            <SqlBlock
              id="catalog"
              title={tr(
                'A. Catalog Column Inspection Query (Unexpected Schema Changes)',
                'က။ Catalog ကော်လံ စစ်ဆေးရေး Query (မမျှော်လင့်သော ဖွဲ့စည်းပုံ ပြောင်းလဲမှုများ)'
              )}
              sql={suite.catalogQuery}
              copied={copiedId === 'catalog'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
            <SqlBlock
              id="locks"
              title={tr(
                'B. Recursive Lock Tree & Blocking Query Detector (Database Traffic Jams)',
                'ခ။ Lock အဆင့်ဆင့်နှင့် ပိတ်ဆို့နေသော Query ရှာဖွေရေး'
              )}
              sql={suite.lockTreeQuery}
              copied={copiedId === 'locks'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
            <SqlBlock
              id="bloat"
              title={tr(
                'C. Index Bloat Estimation Query (Wasted Index Space)',
                'ဂ။ အညွှန်း ဖောင်းပွမှု ခန့်မှန်းရေး Query (အလဟဿ အညွှန်း နေရာများ)'
              )}
              sql={suite.indexBloatQuery}
              copied={copiedId === 'bloat'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
            <SqlBlock
              id="table-health"
              title={tr(
                'D. Table Size, Dead Tuples & Autovacuum Health',
                'ဃ။ ဇယား အရွယ်အစား၊ Dead Tuple နှင့် Autovacuum ကျန်းမာရေး'
              )}
              sql={suite.tableHealthQuery}
              copied={copiedId === 'table-health'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
            <SqlBlock
              id="unused-idx"
              title={tr(
                'E. Unused Non-Unique Indexes (Zero-Scan Write Overhead)',
                'င။ အသုံးမပြုသော Non-Unique အညွှန်းများ (Scan သုည ရေးသားမှု ဝန်ထုပ်ဝန်ပိုး)'
              )}
              sql={suite.unusedIndexesQuery}
              copied={copiedId === 'unused-idx'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
            <SqlBlock
              id="db-summary"
              title={tr(
                'F. Buffer Cache Hit Ratio & Connection Pool Saturation',
                'စ။ Buffer Cache ထိရောက်မှုနှုန်းနှင့် ချိတ်ဆက်မှု ပြည့်ကျပ်မှု'
              )}
              sql={suite.databaseHealthQuery}
              copied={copiedId === 'db-summary'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
            <SqlBlock
              id="top-queries"
              title={tr(
                'G. Top 5 Slowest Queries by Average Latency (pg_stat_statements)',
                'ဆ။ ပျမ်းမျှ ကြာချိန် အနှေးဆုံး ထိပ်တန်း Query ၅ ခု (pg_stat_statements)'
              )}
              sql={suite.topExpensiveQueriesQuery}
              copied={copiedId === 'top-queries'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
            <SqlBlock
              id="capacity-bloat"
              title={tr(
                'H. Table Bloat Velocity & Storage Capacity Projection Collector',
                'ဇ။ ဇယား ဖောင်းပွမှု နှုန်းထားနှင့် သိုလှောင်မှု ပမာဏ ကြိုတင်ခန့်မှန်း Collector'
              )}
              sql={suite.capacityBloatQuery}
              copied={copiedId === 'capacity-bloat'}
              onCopy={handleCopy}
              copyLabel={tr('Copy SQL', 'SQL ကူးယူရန်')}
              copiedLabel={t('action.copied')}
            />
          </div>
        )}
      </div>

      {/* Incident Trigger Matrix */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            {tr(
              '3. Incident Alerting & Webhook Trigger Matrix',
              '၃။ သတိပေးချက်နှင့် Webhook ထုတ်လွှတ်မှု ဇယား'
            )}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-3 px-6">
                  {tr('Incident Type', 'သတိပေးချက် အမျိုးအစား')}
                </th>
                <th className="py-3 px-4">
                  {tr('Severity', 'ပြင်းထန်မှု')}
                </th>
                <th className="py-3 px-4">
                  {tr('Default Trigger Condition', 'မူလ သတိပေးမည့် အခြေအနေ')}
                </th>
                <th className="py-3 px-6">
                  {tr('Action Taken', 'လုပ်ဆောင်မည့် အချက်')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              <tr>
                <td className="py-3.5 px-6 font-mono font-semibold text-slate-900">
                  SCHEMA_DRIFT
                </td>
                <td className="py-3.5 px-4 font-semibold text-red-700">
                  {formatSeverity('CRITICAL')}
                </td>
                <td className="py-3.5 px-4 text-slate-700">
                  {tr(
                    'Live catalog SHA-256 hash does not match stored baseline SHA.',
                    'လက်ရှိ catalog SHA-256 တန်ဖိုးသည် သိမ်းဆည်းထားသော မူလစံ SHA နှင့် မကိုက်ညီပါက။'
                  )}
                </td>
                <td className="py-3.5 px-6 text-slate-700">
                  {tr(
                    'Generates column diff + revert SQL; dispatches high-priority Slack/Discord alert.',
                    'ကော်လံ ကွာခြားချက်နှင့် ပြန်ပြင် SQL ထုတ်ပေးပြီး ဦးစားပေး Slack/Discord သတိပေးချက် ပေးပို့ပါသည်။'
                  )}
                </td>
              </tr>
              <tr>
                <td className="py-3.5 px-6 font-mono font-semibold text-slate-900">
                  LOCK_CONTENTION
                </td>
                <td className="py-3.5 px-4 font-semibold text-amber-700">
                  {formatSeverity('WARNING')}
                </td>
                <td className="py-3.5 px-4 text-slate-700">
                  {tr(
                    'Blocking query holds exclusive lock past threshold (default 15s).',
                    'ပိတ်ဆို့နေသော query သည် exclusive lock ကို ကန့်သတ်ချိန် (မူလ ၁၅ စက္ကန့်) ထက် ကျော်လွန် ထိန်းထားပါက။'
                  )}
                </td>
                <td className="py-3.5 px-6 text-slate-700">
                  {tr(
                    'Captures blocker PID and redacted query string; alerts active channels.',
                    'ပိတ်ဆို့နေသော PID နှင့် ဖုံးအုပ်ထားသော query စာသားကို မှတ်တမ်းတင်ပြီး ချိတ်ဆက်ထားသော ချန်နယ်များသို့ အကြောင်းကြားပါသည်။'
                  )}
                </td>
              </tr>
              <tr>
                <td className="py-3.5 px-6 font-mono font-semibold text-slate-900">
                  INDEX_BLOAT
                </td>
                <td className="py-3.5 px-4 font-semibold text-blue-700">
                  {formatSeverity('INFO')}
                </td>
                <td className="py-3.5 px-4 text-slate-700">
                  {tr(
                    'Index size > 50 MB and estimated bloat percentage > 40%.',
                    'အညွှန်း အရွယ်အစား 50 MB အထက်နှင့် ခန့်မှန်း ဖောင်းပွမှု 40% အထက် ရှိပါက။'
                  )}
                </td>
                <td className="py-3.5 px-6 text-slate-700">
                  {locale === 'my' ? (
                    <>
                      ဖောင်းပွမှု အကြံပြုချက် မှတ်တမ်းတင်ပြီး{' '}
                      <code className="font-mono text-slate-900">
                        REINDEX INDEX CONCURRENTLY
                      </code>{' '}
                      အသုံးပြုရန် အကြံပြုပါသည်။
                    </>
                  ) : (
                    <>
                      Logs bloat advisory; suggests{' '}
                      <code className="font-mono text-slate-900">
                        REINDEX INDEX CONCURRENTLY
                      </code>
                      .
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td className="py-3.5 px-6 font-mono font-semibold text-slate-900">
                  VACUUM_HEALTH
                </td>
                <td className="py-3.5 px-4 font-semibold text-amber-700">
                  {formatSeverity('WARNING')}
                </td>
                <td className="py-3.5 px-4 text-slate-700">
                  {tr(
                    'Dead tuples exceed 10,000 rows and 20% dead ratio.',
                    'Dead tuple အရေအတွက် ၁၀,၀၀၀ ကျော်ပြီး 20% အထက် ရောက်ရှိပါက။'
                  )}
                </td>
                <td className="py-3.5 px-6 text-slate-700">
                  {locale === 'my' ? (
                    <>
                      ဇယား ဖောင်းပွမှုကို သတိပေးပြီး ကူးယူအသုံးပြုနိုင်သော{' '}
                      <code className="font-mono text-slate-900">
                        VACUUM (VERBOSE, ANALYZE)
                      </code>{' '}
                      အမိန့် ပေးပါသည်။
                    </>
                  ) : (
                    <>
                      Flags table bloat; provides copyable{' '}
                      <code className="font-mono text-slate-900">
                        VACUUM (VERBOSE, ANALYZE)
                      </code>{' '}
                      command.
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td className="py-3.5 px-6 font-mono font-semibold text-slate-900">
                  CONNECTION_SATURATION
                </td>
                <td className="py-3.5 px-4 font-semibold text-amber-700">
                  {formatSeverity('WARNING')}
                </td>
                <td className="py-3.5 px-4 text-slate-700">
                  {locale === 'my' ? (
                    <>
                      လုပ်ဆောင်နေဆဲနှင့် idle session များသည်{' '}
                      <code className="font-mono">max_connections</code> ၏ 80%
                      သို့ ရောက်ရှိပါက။
                    </>
                  ) : (
                    <>
                      Active + idle sessions reach 80% of{' '}
                      <code className="font-mono">max_connections</code>.
                    </>
                  )}
                </td>
                <td className="py-3.5 px-6 text-slate-700">
                  {tr(
                    'Alerts before connection pool exhaustion; tracks idle-in-tx leaks.',
                    'ချိတ်ဆက်မှု ပမာဏ မပြည့်မီ ကြိုတင်သတိပေးပြီး idle-in-tx ယိုစိမ့်မှုများကို စောင့်ကြည့်ပါသည်။'
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {selectedDatabase && (
        <UpdateCredentialsModal
          isOpen={reconnectModalOpen}
          targetName={selectedDatabase.name}
          maskedTarget={selectedDatabase.maskedTarget}
          onClose={() => setReconnectModalOpen(false)}
          onSave={async (connectionUrl) => {
            await api.updateDatabase(selectedDatabase.id, { connectionUrl });
            if (onDatabasesChanged) {
              await onDatabasesChanged();
            }
            setPanelRefreshKey((k) => k + 1);
            await loadPerformance(selectedDatabase.id);
          }}
        />
      )}
    </div>
  );
}

function SqlBlock({
  id,
  title,
  sql,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
}: {
  id: string;
  title: string;
  sql: string;
  copied: boolean;
  onCopy: (id: string, sql: string) => void;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div className="bg-slate-900 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between gap-4">
        <span className="text-xs font-medium text-slate-300">{title}</span>
        <button
          type="button"
          onClick={() => onCopy(id, sql)}
          className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white cursor-pointer whitespace-nowrap shrink-0"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>{copiedLabel}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>{copyLabel}</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 text-xs font-mono text-slate-100 overflow-x-auto leading-relaxed">
        {sql}
      </pre>
    </div>
  );
}
