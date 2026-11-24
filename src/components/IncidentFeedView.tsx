import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Search } from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';
import type { ApiClient } from '../lib/api.ts';
import type {
  ConnectionSaturationDetails,
  IncidentStatus,
  IncidentType,
  IndexBloatDetails,
  LockContentionDetails,
  SchemaDriftDetails,
  TelemetryIncidentDto,
  VacuumHealthDetails,
} from '../types/telemetry.ts';

interface IncidentFeedViewProps {
  api: ApiClient;
  onIncidentChanged: () => void;
  onSelectDatabase: (databaseId: string) => void;
}

export function IncidentFeedView({
  api,
  onIncidentChanged,
  onSelectDatabase,
}: IncidentFeedViewProps) {
  const {
    t,
    tr,
    formatEnv,
    formatSeverity,
    formatIncidentStatus,
    formatIncidentType,
    formatDateTime,
  } = useI18n();
  const [incidents, setIncidents] = useState<TelemetryIncidentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ALL' | IncidentStatus>(
    'ALL'
  );
  const [typeFilter, setTypeFilter] = useState<'ALL' | IncidentType>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadIncidents = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listIncidents({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        type: typeFilter === 'ALL' ? undefined : typeFilter,
      });
      setIncidents(res.incidents);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to load incidents.',
              'ဖြစ်ရပ်နှင့် သတိပေးချက်များ ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, statusFilter, typeFilter, tr]);

  useEffect(() => {
    setLoading(true);
    loadIncidents();
  }, [loadIncidents]);

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return incidents;
    return incidents.filter(
      (i) =>
        i.databaseName.toLowerCase().includes(q) ||
        i.details.summary.toLowerCase().includes(q) ||
        i.incidentType.toLowerCase().includes(q) ||
        i.fingerprint.toLowerCase().includes(q)
    );
  }, [incidents, searchTerm]);

  const handleStatusChange = async (id: string, nextStatus: IncidentStatus) => {
    setUpdatingId(id);
    setError(null);
    try {
      await api.updateIncidentStatus(id, nextStatus);
      await loadIncidents();
      onIncidentChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to update incident status.',
              'ဖြစ်ရပ် အခြေအနေ ပြောင်းလဲခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          {tr('Telemetry Incidents', 'ဖြစ်ရပ်နှင့် သတိပေးချက်များ')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {tr(
            'Smart, deduplicated alerts for unexpected database changes, blocking queries, bloated indexes, dead tuples, and connection spikes.',
            'မမျှော်လင့်သော ဖွဲ့စည်းပုံ ပြောင်းလဲမှုများ၊ Lock ပိတ်ဆို့မှုများ၊ အညွှန်း ဖောင်းပွမှု၊ Dead Tuple များနှင့် ချိတ်ဆက်မှု ပြည့်ကျပ်မှု သတိပေးချက်များကို စုစည်းဖော်ပြပေးပါသည်။'
          )}
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['ALL', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const).map(
              (st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'ALL'
                    ? tr('All Statuses', 'အခြေအနေ အားလုံး')
                    : formatIncidentStatus(st)}
                </button>
              )
            )}
          </div>

          <select
            value={typeFilter}
            onChange={(e) =>
              setTypeFilter(e.target.value as 'ALL' | IncidentType)
            }
            aria-label={tr(
              'Filter by incident type',
              'ဖြစ်ရပ် အမျိုးအစားအလိုက် စစ်ထုတ်ရန်'
            )}
            className="px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
          >
            <option value="ALL">
              {tr('All Incident Types', 'ဖြစ်ရပ် အမျိုးအစား အားလုံး')}
            </option>
            <option value="SCHEMA_DRIFT">
              {tr(
                'Schema Drift (CRITICAL)',
                'ဖွဲ့စည်းပုံ ပြောင်းလဲမှု (အရေးကြီး)'
              )}
            </option>
            <option value="LOCK_CONTENTION">
              {tr(
                'Lock Contention (WARNING)',
                'Lock ပိတ်ဆို့မှု (သတိပေးချက်)'
              )}
            </option>
            <option value="INDEX_BLOAT">
              {tr('Index Bloat (INFO)', 'အညွှန်း ဖောင်းပွမှု (အချက်အလက်)')}
            </option>
            <option value="VACUUM_HEALTH">
              {tr(
                'Vacuum / Dead Tuples (WARNING)',
                'VACUUM / Dead Tuple များ (သတိပေးချက်)'
              )}
            </option>
            <option value="CONNECTION_SATURATION">
              {tr(
                'Connection Saturation (WARNING)',
                'ချိတ်ဆက်မှု ပြည့်ကျပ်ခြင်း (သတိပေးချက်)'
              )}
            </option>
          </select>
        </div>

        <div className="relative w-full lg:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={tr(
              'Search target, summary, fingerprint…',
              'ဒေတာဘေ့စ်၊ အကျဉ်းချုပ်၊ Fingerprint ရှာရန်…'
            )}
            className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {/* Incident List */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="divide-y divide-slate-200">
            {[1, 2, 3].map((n) => (
              <div key={n} className="p-5 animate-pulse flex justify-between">
                <div className="space-y-2 w-2/3">
                  <div className="h-4 bg-slate-200 rounded w-1/3" />
                  <div className="h-3 bg-slate-100 rounded w-4/5" />
                </div>
                <div className="h-7 bg-slate-100 rounded w-28" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center space-y-2">
            <p className="text-sm font-semibold text-slate-900">
              {tr(
                'No telemetry incidents match the current filters',
                'လက်ရှိ စစ်ထုတ်မှုနှင့် ကိုက်ညီသော သတိပေးချက် မရှိပါ'
              )}
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              {tr(
                'When live catalog SHA-256 hashes diverge from stored baselines, blocking queries stall sessions, or indexes/tables bloat past your thresholds, incidents appear here automatically.',
                'လက်ရှိ ဖွဲ့စည်းပုံ SHA-256 သည် မူလစံဖွဲ့စည်းပုံနှင့် ကွဲလွဲသည့်အခါ၊ Query များ Lock ပိတ်ဆို့သည့်အခါ သို့မဟုတ် ဇယား/အညွှန်း ဖောင်းပွမှု သတ်မှတ်ချက်ကျော်သည့်အခါ ဤနေရာတွင် အလိုအလျောက် ပေါ်လာပါမည်။'
              )}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {filtered.map((inc) => {
              const isExpanded = expandedId === inc.id;
              return (
                <div key={inc.id} className="transition-colors">
                  <div className="px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-50/70">
                    <div className="flex items-start gap-3 min-w-0">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(isExpanded ? null : inc.id)
                        }
                        aria-label={
                          isExpanded
                            ? tr(
                                'Collapse incident details',
                                'အသေးစိတ် ပိတ်ရန်'
                              )
                            : tr('Expand incident details', 'အသေးစိတ် ဖွင့်ရန်')
                        }
                        className="mt-0.5 p-1 text-slate-400 hover:text-slate-900 rounded cursor-pointer shrink-0"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>

                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <span
                            className={`font-semibold ${
                              inc.severity === 'CRITICAL'
                                ? 'text-red-700'
                                : inc.severity === 'WARNING'
                                  ? 'text-amber-700'
                                  : 'text-blue-700'
                            }`}
                          >
                            {formatSeverity(inc.severity)}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="font-medium text-slate-800">
                            {formatIncidentType(inc.incidentType)}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <button
                            type="button"
                            onClick={() => onSelectDatabase(inc.databaseId)}
                            className="font-medium text-blue-700 hover:underline cursor-pointer"
                          >
                            {inc.databaseName}
                          </button>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-slate-500">
                            {formatEnv(inc.environment, true)}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-slate-500 tabular-nums">
                            {formatDateTime(inc.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm text-slate-900">
                          {inc.details.summary}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 pl-8 lg:pl-0 shrink-0">
                      <span
                        className={`text-xs font-medium ${
                          inc.status === 'OPEN'
                            ? 'text-red-700'
                            : inc.status === 'ACKNOWLEDGED'
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                        }`}
                      >
                        {formatIncidentStatus(inc.status)}
                      </span>

                      {inc.status === 'OPEN' && (
                        <button
                          type="button"
                          disabled={updatingId === inc.id}
                          onClick={() =>
                            handleStatusChange(inc.id, 'ACKNOWLEDGED')
                          }
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                        >
                          {t('action.acknowledge')}
                        </button>
                      )}
                      {inc.status !== 'RESOLVED' ? (
                        <button
                          type="button"
                          disabled={updatingId === inc.id}
                          onClick={() => handleStatusChange(inc.id, 'RESOLVED')}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                        >
                          {t('action.resolve')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={updatingId === inc.id}
                          onClick={() => handleStatusChange(inc.id, 'OPEN')}
                          className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                        >
                          {t('action.reopen')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded Forensics Drawer */}
                  {isExpanded && (
                    <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 space-y-4">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 font-mono">
                        <span>
                          {tr('Fingerprint:', 'Fingerprint —')}{' '}
                          {inc.fingerprint.slice(0, 16)}…
                        </span>
                        {inc.resolvedAt && (
                          <span className="font-sans">
                            {tr('Resolved:', 'ဖြေရှင်းချိန် —')}{' '}
                            {formatDateTime(inc.resolvedAt)}
                          </span>
                        )}
                      </div>

                      {inc.incidentType === 'SCHEMA_DRIFT' && (
                        <DriftForensics
                          details={inc.details as SchemaDriftDetails}
                        />
                      )}

                      {inc.incidentType === 'LOCK_CONTENTION' && (
                        <LockForensics
                          details={inc.details as LockContentionDetails}
                        />
                      )}

                      {inc.incidentType === 'INDEX_BLOAT' && (
                        <BloatForensics
                          details={inc.details as IndexBloatDetails}
                          copied={copiedId === inc.id}
                          onCopy={() =>
                            handleCopy(
                              inc.id,
                              (inc.details as IndexBloatDetails).remediation_sql
                            )
                          }
                        />
                      )}

                      {inc.incidentType === 'VACUUM_HEALTH' && (
                        <VacuumForensics
                          details={inc.details as VacuumHealthDetails}
                          copied={copiedId === inc.id}
                          onCopy={() =>
                            handleCopy(
                              inc.id,
                              (inc.details as VacuumHealthDetails)
                                .remediation_sql
                            )
                          }
                        />
                      )}

                      {inc.incidentType === 'CONNECTION_SATURATION' && (
                        <ConnectionForensics
                          details={inc.details as ConnectionSaturationDetails}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DriftForensics({ details }: { details: SchemaDriftDetails }) {
  const { tr } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6 text-xs font-mono text-slate-700">
        <span>
          {tr('Baseline SHA:', 'မူလစံ SHA —')}{' '}
          <strong className="text-slate-900">
            {details.baseline_hash.slice(0, 16)}
          </strong>
        </span>
        <span>
          {tr('Live SHA:', 'လက်ရှိ SHA —')}{' '}
          <strong className="text-red-700">
            {details.live_hash.slice(0, 16)}
          </strong>
        </span>
        {details.git_commit_sha && (
          <span>Git Commit: {details.git_commit_sha}</span>
        )}
      </div>

      {details.diffs.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <th className="py-2 px-3">{tr('Change', 'ပြောင်းလဲမှု')}</th>
                <th className="py-2 px-3">
                  {tr('Target Column', 'ပစ်မှတ် ကော်လံ')}
                </th>
                <th className="py-2 px-3">{tr('Baseline', 'မူလစံ')}</th>
                <th className="py-2 px-3">{tr('Live', 'လက်ရှိ')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {details.diffs.map((d, i) => (
                <tr key={`${d.table_name}-${d.column_name}-${i}`}>
                  <td
                    className={`py-2 px-3 font-sans font-semibold ${
                      d.kind === 'ADDED'
                        ? 'text-emerald-700'
                        : d.kind === 'REMOVED'
                          ? 'text-red-700'
                          : 'text-amber-700'
                    }`}
                  >
                    {d.kind === 'ADDED'
                      ? tr('ADDED', 'ထပ်တိုး')
                      : d.kind === 'REMOVED'
                        ? tr('REMOVED', 'ဖယ်ရှား')
                        : tr('MODIFIED', 'ပြင်ဆင်')}
                  </td>
                  <td className="py-2 px-3 text-slate-900">
                    {d.table_schema}.{d.table_name}.{d.column_name}
                  </td>
                  <td className="py-2 px-3 text-slate-600">
                    {d.baseline
                      ? `${d.baseline.data_type} (${d.baseline.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'})`
                      : '—'}
                  </td>
                  <td className="py-2 px-3 text-slate-900">
                    {d.live
                      ? `${d.live.data_type} (${d.live.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'})`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LockForensics({ details }: { details: LockContentionDetails }) {
  const { tr } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6 text-xs font-mono text-slate-700 tabular-nums">
        <span>
          {tr('Blocker PID:', 'ပိတ်ဆို့နေသော PID —')}{' '}
          <strong className="text-slate-900">{details.blocking_pid}</strong> (
          {details.blocking_user})
        </span>
        <span>
          {tr('Blocked PID:', 'ပိတ်ဆို့ခံရသော PID —')}{' '}
          <strong className="text-slate-900">{details.blocked_pid}</strong> (
          {details.blocked_user})
        </span>
        <span className="text-amber-800 font-semibold">
          {tr('Wait Duration:', 'စောင့်ဆိုင်းချိန် —')}{' '}
          {details.wait_duration_seconds}s
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-slate-900 rounded-lg p-3.5">
          <p className="text-[11px] font-medium text-slate-400 mb-1.5">
            {tr(
              'Blocking Query (Literals Redacted)',
              'ပိတ်ဆို့နေသော Query (တန်ဖိုးများ ဖုံးအုပ်ထားသည်)'
            )}
          </p>
          <pre className="text-xs font-mono text-slate-100 whitespace-pre-wrap break-all">
            {details.blocking_statement_redacted}
          </pre>
        </div>
        <div className="bg-slate-900 rounded-lg p-3.5">
          <p className="text-[11px] font-medium text-slate-400 mb-1.5">
            {tr(
              'Blocked Query (Literals Redacted)',
              'ပိတ်ဆို့ခံရသော Query (တန်ဖိုးများ ဖုံးအုပ်ထားသည်)'
            )}
          </p>
          <pre className="text-xs font-mono text-slate-100 whitespace-pre-wrap break-all">
            {details.blocked_statement_redacted}
          </pre>
        </div>
      </div>
    </div>
  );
}

function BloatForensics({
  details,
  copied,
  onCopy,
}: {
  details: IndexBloatDetails;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t, tr } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6 text-xs font-mono text-slate-700 tabular-nums">
        <span>
          {tr('Relation:', 'ဇယား —')}{' '}
          <strong className="text-slate-900">
            {details.schemaname}.{details.tablename}
          </strong>
        </span>
        <span>
          {tr('Size:', 'အရွယ်အစား —')}{' '}
          <strong className="text-slate-900">
            {details.index_size_pretty}
          </strong>
        </span>
        <span>
          {tr('Est. Bloat:', 'ခန့်မှန်း ဖောင်းပွမှု —')}{' '}
          <strong className="text-amber-700">
            {details.estimated_bloat_pct.toFixed(1)}%
          </strong>
        </span>
      </div>
      <div className="bg-slate-900 rounded-lg p-3.5 flex items-center justify-between gap-4">
        <code className="text-xs font-mono text-slate-100 overflow-x-auto">
          {details.remediation_sql}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
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
    </div>
  );
}

function VacuumForensics({
  details,
  copied,
  onCopy,
}: {
  details: VacuumHealthDetails;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t, tr } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6 text-xs font-mono text-slate-700 tabular-nums">
        <span>
          {tr('Table:', 'ဇယား —')}{' '}
          <strong className="text-slate-900">
            {details.schemaname}.{details.relname}
          </strong>
        </span>
        <span>
          {tr('Dead Tuples:', 'Dead Tuple များ —')}{' '}
          <strong className="text-amber-700">
            {details.n_dead_tup.toLocaleString()} ({details.dead_tuple_pct}%)
          </strong>
        </span>
        <span>
          {tr('Live Tuples:', 'လက်ရှိ Row များ —')}{' '}
          {details.n_live_tup.toLocaleString()}
        </span>
      </div>
      <div className="bg-slate-900 rounded-lg p-3.5 flex items-center justify-between gap-4">
        <code className="text-xs font-mono text-slate-100 overflow-x-auto">
          {details.remediation_sql}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
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
    </div>
  );
}

function ConnectionForensics({
  details,
}: {
  details: ConnectionSaturationDetails;
}) {
  const { tr } = useI18n();
  return (
    <div className="flex flex-wrap gap-6 text-xs font-mono text-slate-700 tabular-nums">
      <span>
        {tr('Utilization:', 'အသုံးပြုမှု ရာခိုင်နှုန်း —')}{' '}
        <strong className="text-amber-700">
          {details.connection_usage_pct}%
        </strong>
      </span>
      <span>
        {tr('Active:', 'လုပ်ဆောင်နေသည် —')}{' '}
        <strong className="text-slate-900">{details.active_connections}</strong>
      </span>
      <span>
        {tr('Max Connections:', 'အများဆုံး ချိတ်ဆက်မှု —')}{' '}
        {details.max_connections}
      </span>
      <span>
        {tr('Idle in Transaction:', 'Transaction အတွင်း ရပ်နေသည် —')}{' '}
        <strong className="text-slate-900">
          {details.idle_in_transaction}
        </strong>
      </span>
    </div>
  );
}
