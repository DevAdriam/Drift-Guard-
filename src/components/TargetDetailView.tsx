import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileDown,
  GitCommitHorizontal,
  History,
  KeyRound,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { ApiClient, DatabaseDetailResponse } from '../lib/api.ts';
import type { ColumnCatalogRow, ColumnDiffItem } from '../types/telemetry.ts';
import { EventTimelineSidebar } from './EventTimelineSidebar.tsx';
import { UpdateCredentialsModal } from './UpdateCredentialsModal.tsx';
import { SchemaErdPanel } from './SchemaErdPanel.tsx';
import { SchemaTimeMachinePanel } from './SchemaTimeMachinePanel.tsx';
import { SecurityAuditPanel } from './SecurityAuditPanel.tsx';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface TargetDetailViewProps {
  api: ApiClient;
  databaseId: string;
  onBack: () => void;
  onChanged: () => void;
}

type DetailTab =
  | 'diff'
  | 'catalog'
  | 'erd'
  | 'time-machine'
  | 'security'
  | 'health'
  | 'unused-idx'
  | 'locks'
  | 'bloat'
  | 'baselines';

function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.slice(0, 12);
}

export function TargetDetailView({
  api,
  databaseId,
  onBack,
  onChanged,
}: TargetDetailViewProps) {
  const {
    locale,
    t,
    tr,
    formatEnv,
    formatSeverity,
    formatIncidentStatus,
    formatIncidentType,
  } = useI18n();

  const [detail, setDetail] = useState<DatabaseDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('diff');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gitShaInput, setGitShaInput] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [timelineRefreshKey, setTimelineRefreshKey] = useState(0);
  const [credentialsModalOpen, setCredentialsModalOpen] = useState(false);

  // Historical baseline time-travel diff state
  const [compareFromId, setCompareFromId] = useState('');
  const [compareToId, setCompareToId] = useState('');
  const [historicalDiff, setHistoricalDiff] = useState<{
    fromHash: string;
    toHash: string;
    diffs: ColumnDiffItem[];
    syncSql: string;
  } | null>(null);

  const formatTimestamp = useCallback(
    (iso: string | null): string => {
      if (!iso) return t('common.never');
      const d = new Date(iso);
      return d.toLocaleString(locale === 'my' ? 'my-MM' : 'en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    },
    [locale, t]
  );

  const loadDetail = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getDatabaseDetail(databaseId);
      setDetail(res);
      setTimelineRefreshKey((k) => k + 1);
      if (res.baselines.length >= 2) {
        setCompareToId((prev) => prev || res.baselines[0].id);
        setCompareFromId((prev) => prev || res.baselines[1].id);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to load target telemetry.',
              'ပစ်မှတ် ဒေတာဘေ့စ် အချက်အလက်များကို ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, databaseId, tr]);

  useEffect(() => {
    setLoading(true);
    loadDetail();
  }, [loadDetail]);

  const copyText = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const downloadFile = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCatalogJson = () => {
    if (!detail?.latestSnapshot) return;
    downloadFile(
      `${detail.database.name}_catalog_${detail.latestSnapshot.schemaHash.slice(0, 8)}.json`,
      JSON.stringify(detail.latestSnapshot.catalogJson, null, 2),
      'application/json'
    );
  };

  const handleExportCatalogCsv = () => {
    if (!detail?.latestSnapshot) return;
    const headers = [
      'table_schema',
      'table_name',
      'ordinal_position',
      'column_name',
      'data_type',
      'is_nullable',
      'column_default',
    ];
    const escapeCsv = (val: unknown) => {
      const str = val == null ? '' : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };
    const lines = [
      headers.join(','),
      ...detail.latestSnapshot.catalogJson.map((c) =>
        [
          c.table_schema,
          c.table_name,
          c.ordinal_position ?? '',
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default ?? '',
        ]
          .map(escapeCsv)
          .join(',')
      ),
    ];
    downloadFile(
      `${detail.database.name}_catalog.csv`,
      lines.join('\n'),
      'text/csv;charset=utf-8'
    );
  };

  const handleDownloadHealthReport = async () => {
    setBusyAction('report');
    setNotice(null);
    setError(null);
    try {
      const { blob, filename } = await api.downloadHealthReport(databaseId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(
        tr(
          `30-day health & schema drift PDF downloaded (${filename}).`,
          `ရက် ၃၀ စာ ကျန်းမာရေးနှင့် ဖွဲ့စည်းပုံ ကွာခြားချက် PDF အစီရင်ခံစာကို ဒေါင်းလုဒ်လုပ်ပြီးပါပြီ (${filename})။`
        )
      );
      setTimelineRefreshKey((k) => k + 1);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to generate 30-day PDF health report.',
              'ရက် ၃၀ စာ PDF ကျန်းမာရေး အစီရင်ခံစာ ထုတ်ယူ၍ မရပါ။'
            )
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleInspectNow = async () => {
    setBusyAction('inspect');
    setNotice(null);
    setError(null);
    try {
      const res = await api.inspectDatabase(databaseId);
      setNotice(
        locale === 'my'
          ? `${res.snapshot.durationMs}ms အတွင်း စစ်ဆေးမှု ပြီးဆုံးပါပြီ · ဇယား ${res.snapshot.tableCount} ခု၊ ကော်လံ ${res.snapshot.columnCount} ခု စစ်ဆေးပြီး${
              res.newIncidentsCount > 0
                ? ` · သတိပေးချက်အသစ် ${res.newIncidentsCount} ခု တွေ့ရှိပါသည်`
                : ''
            }။`
          : `Inspection complete in ${res.snapshot.durationMs}ms · ${res.snapshot.tableCount} tables, ${res.snapshot.columnCount} columns scanned${
              res.newIncidentsCount > 0
                ? ` · ${res.newIncidentsCount} new incident(s) opened`
                : ''
            }.`
      );
      await loadDetail();
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Inspection failed.', 'စစ်ဆေးမှု မအောင်မြင်ပါ။')
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCaptureBaseline = async () => {
    setBusyAction('baseline');
    setNotice(null);
    setError(null);
    try {
      const res = await api.captureBaseline(databaseId, {
        gitCommitSha: gitShaInput.trim() || undefined,
      });
      setGitShaInput('');
      setNotice(
        locale === 'my'
          ? `မူလစံ မှတ်တမ်းအသစ် သိမ်းဆည်းပြီးပါပြီ · SHA-256 ${res.baseline.schemaHash.slice(0, 12)}။`
          : `Baseline promoted · SHA-256 ${res.baseline.schemaHash.slice(0, 12)}.`
      );
      await loadDetail();
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Baseline capture failed.', 'မူလစံ မှတ်တမ်း သိမ်းဆည်း၍ မရပါ။')
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequestBaselineApproval = async () => {
    setBusyAction('approval-request');
    setNotice(null);
    setError(null);
    try {
      const res = await api.createBaselineApprovalRequest({
        databaseId,
        gitCommitSha: gitShaInput.trim() || undefined,
        note: tr(
          'Submitted from Target Inspector for DBA/Admin baseline promotion sign-off.',
          'DBA/Admin အတည်ပြုချက် ရယူရန် ပစ်မှတ် စစ်ဆေးရေးမှ တင်သွင်းထားပါသည်။'
        ),
      });
      setGitShaInput('');
      setNotice(
        locale === 'my'
          ? `မူလစံ အတည်ပြုချက် တောင်းဆိုမှု တင်သွင်းပြီးပါပြီ (${res.approval.proposedSchemaHash.slice(0, 12)}) — စီမံခန့်ခွဲမှုနှင့် အစီရင်ခံစာများ ကဏ္ဍတွင် အတည်ပြုနိုင်ပါသည်။`
          : `Baseline promotion approval request submitted (${res.approval.proposedSchemaHash.slice(0, 12)}). Review and approve under Governance & Reports.`
      );
      await loadDetail();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to submit baseline approval request.',
              'မူလစံ အတည်ပြုချက် တောင်းဆိုမှု တင်သွင်း၍ မရပါ။'
            )
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestoreBaseline = async (baselineId: string) => {
    setBusyAction(`restore-${baselineId}`);
    setNotice(null);
    setError(null);
    try {
      const res = await api.restoreBaseline(databaseId, baselineId);
      setNotice(
        locale === 'my'
          ? `မူလစံ ${res.baseline.schemaHash.slice(0, 12)} ကို လက်ရှိ အသုံးပြုနေသော မူလစံအဖြစ် ပြန်လည်သတ်မှတ်ပြီးပါပြီ။`
          : `Restored baseline ${res.baseline.schemaHash.slice(0, 12)} as active.`
      );
      await loadDetail();
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Baseline restore failed.', 'မူလစံ ပြန်လည်သတ်မှတ်၍ မရပါ။')
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCompareHistoricalBaselines = async () => {
    if (!compareFromId || !compareToId) return;
    setBusyAction('compare-baselines');
    setError(null);
    try {
      const res = await api.compareHistoricalBaselines(
        databaseId,
        compareFromId,
        compareToId
      );
      setHistoricalDiff(res);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to diff baselines.', 'မူလစံ နှစ်ခုကို နှိုင်းယှဉ်၍ မရပါ။')
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunDrill = async (scenario: 'drift' | 'lock' | 'bloat') => {
    setBusyAction(`drill-${scenario}`);
    setNotice(null);
    setError(null);
    try {
      await api.runDrill(databaseId, scenario);
      const label =
        scenario === 'drift'
          ? tr('Schema Drift (CRITICAL)', 'ဖွဲ့စည်းပုံ ကွာခြားချက် (အရေးကြီး)')
          : scenario === 'lock'
            ? tr('Lock Contention (WARNING)', 'Lock ပိတ်ဆို့မှု (သတိပေးချက်)')
            : tr('Index Bloat (INFO)', 'အညွှန်း ဖောင်းပွမှု (အချက်အလက်)');
      setNotice(
        locale === 'my'
          ? `${label} စမ်းသပ်မှုကို telemetry_incidents တွင် မှတ်တမ်းတင်ပြီး သက်ဆိုင်ရာ Webhook များသို့ ပေးပို့ပြီးပါပြီ။`
          : `${label} drill recorded in telemetry_incidents and dispatched to eligible webhooks.`
      );
      await loadDetail();
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Drill failed.', 'သတိပေးချက် စမ်းသပ်မှု မအောင်မြင်ပါ။')
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteTarget = async () => {
    setBusyAction('delete');
    try {
      await api.deleteDatabase(databaseId);
      onChanged();
      onBack();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to delete target.', 'ပစ်မှတ် ဒေတာဘေ့စ်ကို ဖျက်၍ မရပါ။')
      );
      setBusyAction(null);
    }
  };

  const groupedCatalog = useMemo(() => {
    const rows = detail?.latestSnapshot?.catalogJson ?? [];
    const term = catalogSearch.trim().toLowerCase();
    const filtered = term
      ? rows.filter(
          (r) =>
            r.table_name.toLowerCase().includes(term) ||
            r.column_name.toLowerCase().includes(term) ||
            r.data_type.toLowerCase().includes(term) ||
            r.table_schema.toLowerCase().includes(term)
        )
      : rows;

    const map = new Map<string, ColumnCatalogRow[]>();
    for (const row of filtered) {
      const key = `${row.table_schema}.${row.table_name}`;
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [detail?.latestSnapshot?.catalogJson, catalogSearch]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-56 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
        <div className="h-28 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl animate-pulse" />
        <div className="h-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-3">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {error ||
            tr(
              'Target database could not be loaded.',
              'ပစ်မှတ် ဒေတာဘေ့စ်ကို ဖွင့်၍ မရပါ။'
            )}
        </p>
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer"
        >
          {tr('Return to Targets', 'ဒေတာဘေ့စ် စာရင်းသို့ ပြန်သွားရန်')}
        </button>
      </div>
    );
  }

  const {
    database,
    baselines,
    latestSnapshot,
    liveDiff,
    revertToBaselineSql,
    incidents,
  } = detail;
  const latestBaseline = baselines[0] ?? null;
  const health = latestSnapshot?.healthJson ?? null;
  const hashMatches =
    latestBaseline &&
    latestSnapshot &&
    latestBaseline.schemaHash === latestSnapshot.schemaHash;

  const openCount = incidents.filter((i) => i.status !== 'RESOLVED').length;

  return (
    <div className="space-y-6">
      {/* Top navigation & primary actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>
              {tr('All Monitored Targets', 'စောင့်ကြည့်နေသော ဒေတာဘေ့စ်အားလုံး')}
            </span>
          </button>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
              {database.name}
            </h1>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {formatEnv(database.environment)}
            </span>
            {health?.pg_version && (
              <>
                <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
                  {health.pg_version}
                </span>
              </>
            )}
            <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate max-w-md">
              {database.maskedTarget}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowTimeline((prev) => !prev)}
            aria-pressed={showTimeline}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showTimeline
                ? 'text-blue-800 dark:text-blue-300 bg-blue-50/70 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/70 hover:bg-blue-50 dark:hover:bg-blue-950/55'
                : 'text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60'
            }`}
          >
            <History className="w-4 h-4" />
            <span>
              {showTimeline
                ? tr('Hide Timeline', 'ဖြစ်စဉ် မှတ်တမ်း ပိတ်ရန်')
                : tr('Event Timeline', 'ဖြစ်စဉ် မှတ်တမ်း')}
            </span>
          </button>

          <button
            type="button"
            onClick={handleDownloadHealthReport}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileDown className="w-4 h-4 text-slate-600 dark:text-slate-300" />
            <span>
              {busyAction === 'report'
                ? tr('Generating PDF…', 'PDF ထုတ်ယူနေသည်…')
                : t('action.downloadReport')}
            </span>
          </button>

          {database.connectionMode === 'external' && (
            <button
              type="button"
              onClick={() => setCredentialsModalOpen(true)}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <KeyRound className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              <span>{tr('Update URI', 'URI ပြင်ဆင်ရန်')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleInspectNow}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-4 h-4 ${busyAction === 'inspect' ? 'animate-spin' : ''}`}
            />
            <span>
              {busyAction === 'inspect'
                ? tr('Inspecting…', 'စစ်ဆေးနေသည်…')
                : tr('Run Inspection', 'စစ်ဆေးမှု ပြုလုပ်ရန်')}
            </span>
          </button>

          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-red-700 dark:hover:text-red-400 border border-slate-200 dark:border-slate-800 hover:border-red-200 dark:hover:border-red-800/70 bg-white dark:bg-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
              <span>{tr('Remove', 'ဖယ်ရှားရန်')}</span>
            </button>
          ) : (
            <div className="inline-flex items-center gap-2 border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-1.5">
              <span className="text-xs font-medium text-red-800 dark:text-red-300">
                {tr('Delete target?', 'ပစ်မှတ်ကို ဖျက်မည်လား?')}
              </span>
              <button
                type="button"
                onClick={handleDeleteTarget}
                disabled={busyAction === 'delete'}
                className="text-xs font-semibold text-red-700 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 cursor-pointer"
              >
                {tr('Confirm', 'အတည်ပြုရန်')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
              >
                {t('action.cancel')}
              </button>
            </div>
          )}
        </div>
      </div>

      {database.connectionMode === 'external' &&
        database.credentialsValid === false && (
          <div
            role="alert"
            className="px-4 py-3.5 rounded-lg border border-amber-200 dark:border-amber-900/70 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-900 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="space-y-0.5">
              <p className="font-semibold text-amber-950 dark:text-amber-200">
                {tr(
                  'Stored connection credentials need to be re-entered.',
                  'သိမ်းဆည်းထားသော ချိတ်ဆက်မှု အချက်အလက်ကို ပြန်လည်ထည့်သွင်းရန် လိုအပ်ပါသည်။'
                )}
              </p>
              <p className="text-amber-800 dark:text-amber-300">
                {tr(
                  'This target was encrypted with an earlier temporary key before a server restart. Re-enter its PostgreSQL URI once — it will now persist across restarts.',
                  'ဤဒေတာဘေ့စ်ကို ဆာဗာပြန်မစတင်မီ ယာယီသော့ဖြင့် ကုဒ်ဝှက်ထားခဲ့ခြင်း ဖြစ်ပါသည်။ PostgreSQL URI ကို တစ်ကြိမ် ပြန်လည်ထည့်သွင်းပါ — ယခုအခါ ဆာဗာပြန်စတင်သော်လည်း တည်မြဲနေမည် ဖြစ်ပါသည်။'
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCredentialsModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>
                {tr('Re-enter Connection URI', 'ချိတ်ဆက်မှု URI ပြန်ထည့်ရန်')}
              </span>
            </button>
          </div>
        )}

      {notice && (
        <div className="px-4 py-3 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50 dark:bg-blue-950/40 text-sm text-blue-900 dark:text-blue-200">
          {notice}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-sm text-red-800 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Primary Telemetry Summary Strip */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
        <div className="p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Drift Status', 'ဖွဲ့စည်းပုံ အခြေအနေ')}
          </p>
          <p
            className={`mt-1.5 text-lg font-semibold ${
              database.lastHealthStatus === 'DRIFT'
                ? 'text-red-700 dark:text-red-400'
                : database.lastHealthStatus === 'WARNING'
                  ? 'text-amber-700 dark:text-amber-400'
                  : database.lastHealthStatus === 'ERROR'
                    ? 'text-red-700 dark:text-red-400'
                    : database.lastHealthStatus === 'HEALTHY'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            {database.lastHealthStatus === 'HEALTHY'
              ? tr('Nominal', 'ပုံမှန်')
              : database.lastHealthStatus === 'DRIFT'
                ? tr('Schema Drift', 'ဖွဲ့စည်းပုံ ကွာခြားချက်')
                : database.lastHealthStatus === 'WARNING'
                  ? tr('Warning', 'သတိပေးချက်')
                  : database.lastHealthStatus === 'ERROR'
                    ? tr('Poll Error', 'စစ်ဆေးမှု အမှား')
                    : tr('Pending', 'စောင့်ဆိုင်းနေသည်')}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {locale === 'my'
              ? `ဖွင့်ထားသော သတိပေးချက် ${openCount} ခု · ${database.pollIntervalSeconds} စက္ကန့်တိုင်း စစ်ဆေးသည်`
              : `${openCount} open incident${openCount === 1 ? '' : 's'} · Poll every ${database.pollIntervalSeconds}s`}
          </p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Live Canonical SHA-256', 'လက်ရှိ စံ SHA-256')}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-base font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
              {shortHash(latestSnapshot?.schemaHash ?? database.lastSchemaHash)}
            </span>
            {latestSnapshot?.schemaHash && (
              <button
                type="button"
                onClick={() => copyText('live-hash', latestSnapshot.schemaHash)}
                aria-label={tr('Copy live SHA-256 hash', 'လက်ရှိ SHA-256 ကူးယူရန်')}
                className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer"
              >
                {copiedId === 'live-hash' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {latestBaseline
              ? hashMatches
                ? tr('Matches stored baseline', 'သိမ်းဆည်းထားသော မူလစံနှင့် ကိုက်ညီသည်')
                : locale === 'my'
                  ? `မူလစံ ${shortHash(latestBaseline.schemaHash)} နှင့် ကွာခြားနေသည်`
                  : `Diverged from ${shortHash(latestBaseline.schemaHash)}`
              : tr('No baseline stored yet', 'မူလစံ မှတ်တမ်း မသိမ်းဆည်းရသေးပါ')}
          </p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Cache Hit & DB Size', 'Cache ထိရောက်မှုနှင့် ဒေတာဘေ့စ် အရွယ်အစား')}
          </p>
          <p
            className={`mt-1.5 text-lg font-semibold font-mono tabular-nums ${
              health && health.cache_hit_ratio_pct < 95
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {health
              ? `${health.cache_hit_ratio_pct.toFixed(1)}% · ${health.database_size_pretty}`
              : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {latestSnapshot
              ? locale === 'my'
                ? `ဇယား ${latestSnapshot.tableCount} ခု · ကော်လံ ${latestSnapshot.columnCount} ခု`
                : `${latestSnapshot.tableCount} tables · ${latestSnapshot.columnCount} columns`
              : tr('Run inspection to populate', 'အချက်အလက်ရယူရန် စစ်ဆေးမှု ပြုလုပ်ပါ')}
          </p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Connection Pool', 'ချိတ်ဆက်မှု ပမာဏ')}
          </p>
          <p
            className={`mt-1.5 text-lg font-semibold font-mono tabular-nums ${
              health && health.connection_usage_pct >= 80
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {health
              ? `${health.active_connections + health.idle_connections + health.idle_in_transaction} / ${health.max_connections} (${health.connection_usage_pct}%)`
              : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {health
              ? locale === 'my'
                ? `လုပ်ဆောင်နေဆဲ ${health.active_connections} ခု · idle-in-tx ${health.idle_in_transaction} ခု`
                : `${health.active_connections} active · ${health.idle_in_transaction} idle-in-tx`
              : locale === 'my'
                ? `နောက်ဆုံး စစ်ဆေးချိန်: ${formatTimestamp(database.lastPolledAt)}`
                : `Last scan: ${formatTimestamp(database.lastPolledAt)}`}
          </p>
        </div>
      </div>

      {/* Main Workspace + Sticky Event Timeline Sidebar */}
      <div className="flex flex-col xl:flex-row xl:items-start gap-6">
        <div className="flex-1 min-w-0 space-y-6">
          {/* Baseline Promotion & Incident Drill Action Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <GitCommitHorizontal className="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0" />
                <input
                  type="text"
                  maxLength={40}
                  value={gitShaInput}
                  onChange={(e) => setGitShaInput(e.target.value)}
                  placeholder={tr(
                    'Git commit SHA (optional)',
                    'Git commit SHA (ထည့်လိုက ထည့်ပါ)'
                  )}
                  className="w-48 px-3 py-1.5 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
                />
              </div>
              <button
                type="button"
                onClick={handleCaptureBaseline}
                disabled={busyAction !== null}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                {busyAction === 'baseline'
                  ? tr('Capturing…', 'သိမ်းဆည်းနေသည်…')
                  : tr(
                      'Promote Live Catalog to Baseline',
                      'လက်ရှိ Catalog ကို မူလစံအဖြစ် သတ်မှတ်ရန်'
                    )}
              </button>
              {database.environment === 'production' && (
                <button
                  type="button"
                  onClick={handleRequestBaselineApproval}
                  disabled={busyAction !== null}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-950/75 border border-blue-200 dark:border-blue-900/70 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>
                    {busyAction === 'approval-request'
                      ? tr('Submitting…', 'တင်သွင်းနေသည်…')
                      : tr('Request Approval', 'အတည်ပြုချက် တောင်းဆိုရန်')}
                  </span>
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mr-1">
                {tr('Verify Alert Pipeline:', 'သတိပေးစနစ် စမ်းသပ်ရန်:')}
              </span>
              <button
                type="button"
                onClick={() => handleRunDrill('drift')}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 border border-red-200 dark:border-red-900/70 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                <Play className="w-3 h-3" />
                <span>{tr('Drift Drill', 'Drift စမ်းသပ်ရန်')}</span>
              </button>
              <button
                type="button"
                onClick={() => handleRunDrill('lock')}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/50 border border-amber-200 dark:border-amber-900/70 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                <Play className="w-3 h-3" />
                <span>{tr('Lock Drill', 'Lock စမ်းသပ်ရန်')}</span>
              </button>
              <button
                type="button"
                onClick={() => handleRunDrill('bloat')}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-800 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/55 border border-blue-200 dark:border-blue-900/70 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                <Play className="w-3 h-3" />
                <span>{tr('Bloat Drill', 'Bloat စမ်းသပ်ရန်')}</span>
              </button>
            </div>
          </div>

          {/* Sub-navigation Tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit overflow-x-auto max-w-full">
            {(
              [
                {
                  id: 'diff',
                  label: `${tr('Schema Diff', 'ဖွဲ့စည်းပုံ ကွာခြားချက်')} (${liveDiff.length})`,
                },
                {
                  id: 'catalog',
                  label: `${tr('Live Catalog', 'လက်ရှိ Catalog')} (${latestSnapshot?.columnCount ?? 0})`,
                },
                {
                  id: 'erd',
                  label: tr('ERD Graph', 'ERD ဆက်နွှယ်ပုံ'),
                },
                {
                  id: 'time-machine',
                  label: tr('Time Machine', 'အချိန်ခရီးစဉ်'),
                },
                {
                  id: 'security',
                  label: tr('Security Audit', 'လုံခြုံရေး စစ်ဆေးမှု'),
                },
                {
                  id: 'health',
                  label: `${tr('Table & Vacuum Health', 'ဇယားနှင့် VACUUM ကျန်းမာရေး')} (${health?.table_health.length ?? 0})`,
                },
                {
                  id: 'unused-idx',
                  label: `${tr('Unused Indexes', 'အသုံးမပြုသော အညွှန်းများ')} (${health?.unused_indexes.length ?? 0})`,
                },
                {
                  id: 'locks',
                  label: `${tr('Lock Tree', 'Lock ပိတ်ဆို့မှု')} (${latestSnapshot?.activeLocksCount ?? 0})`,
                },
                {
                  id: 'bloat',
                  label: `${tr('Index Bloat', 'အညွှန်း ဖောင်းပွမှု')} (${latestSnapshot?.bloatedIndexesCount ?? 0})`,
                },
                {
                  id: 'baselines',
                  label: `${tr('Baselines', 'မူလစံ မှတ်တမ်းများ')} (${baselines.length})`,
                },
              ] as { id: DetailTab; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* TAB 1: Schema Diff & Revert SQL */}
          {activeTab === 'diff' && (
            <div className="space-y-4">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(
                        'Live Catalog vs. Stored Baseline Comparison',
                        'လက်ရှိ Catalog နှင့် သိမ်းဆည်းထားသော မူလစံ နှိုင်းယှဉ်ချက်'
                      )}
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {tr(
                        'Detects added, dropped, or changed columns compared to your expected Git baseline.',
                        'သတ်မှတ်ထားသော Git မူလစံနှင့် နှိုင်းယှဉ်၍ အသစ်ထည့်ထားသော၊ ဖျက်လိုက်သော သို့မဟုတ် ပြောင်းလဲသွားသော ကော်လံများကို ရှာဖွေဖော်ပြပါသည်။'
                      )}
                    </p>
                  </div>
                  {latestBaseline && (
                    <span className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                      {tr('Baseline', 'မူလစံ')}{' '}
                      {shortHash(latestBaseline.schemaHash)}
                      {latestBaseline.gitCommitSha
                        ? ` · commit ${latestBaseline.gitCommitSha.slice(0, 7)}`
                        : ''}
                    </span>
                  )}
                </div>

                {!latestBaseline ? (
                  <div className="p-8 text-center space-y-2">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {tr(
                        'No schema baseline recorded yet',
                        'ဖွဲ့စည်းပုံ မူလစံ မှတ်တမ်း မသိမ်းဆည်းရသေးပါ'
                      )}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                      {tr(
                        'Click "Promote Live Catalog to Baseline" above to save your expected schema snapshot.',
                        'သတ်မှတ်ထားသော ဖွဲ့စည်းပုံ မှတ်တမ်းကို သိမ်းဆည်းရန် အပေါ်ရှိ "လက်ရှိ Catalog ကို မူလစံအဖြစ် သတ်မှတ်ရန်" ခလုတ်ကို နှိပ်ပါ။'
                      )}
                    </p>
                  </div>
                ) : liveDiff.length === 0 ? (
                  <div className="p-8 text-center space-y-1.5">
                    <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                      {tr(
                        'Zero Unexpected Database Changes',
                        'မမျှော်လင့်သော ဒေတာဘေ့စ် ပြောင်းလဲမှု လုံးဝမရှိပါ'
                      )}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {locale === 'my' ? (
                        <>
                          လက်ရှိ SHA-256 တန်ဖိုး{' '}
                          <code className="font-mono text-slate-700 dark:text-slate-300">
                            {shortHash(latestSnapshot?.schemaHash)}
                          </code>{' '}
                          သည် ကော်လံ {latestSnapshot?.columnCount ?? 0} ခုလုံးတွင်
                          သိမ်းဆည်းထားသော မူလစံနှင့် အတိအကျ ကိုက်ညီပါသည်။
                        </>
                      ) : (
                        <>
                          Live SHA-256 hash{' '}
                          <code className="font-mono text-slate-700 dark:text-slate-300">
                            {shortHash(latestSnapshot?.schemaHash)}
                          </code>{' '}
                          matches stored baseline identically across{' '}
                          {latestSnapshot?.columnCount ?? 0} columns.
                        </>
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-xs font-medium text-slate-500 dark:text-slate-400">
                          <th className="py-2.5 px-4">
                            {tr('Change', 'ပြောင်းလဲမှု')}
                          </th>
                          <th className="py-2.5 px-4">{tr('Table', 'ဇယား')}</th>
                          <th className="py-2.5 px-4">
                            {tr('Column', 'ကော်လံ')}
                          </th>
                          <th className="py-2.5 px-4">
                            {tr('Baseline Definition', 'မူလစံ သတ်မှတ်ချက်')}
                          </th>
                          <th className="py-2.5 px-4">
                            {tr('Live Definition', 'လက်ရှိ သတ်မှတ်ချက်')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                        {liveDiff.map((diff) => (
                          <tr
                            key={`${diff.kind}-${diff.table_schema}.${diff.table_name}.${diff.column_name}`}
                            className="hover:bg-slate-50 dark:hover:bg-slate-800/60"
                          >
                            <td className="py-3 px-4 font-semibold">
                              <span
                                className={
                                  diff.kind === 'ADDED'
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : diff.kind === 'REMOVED'
                                      ? 'text-red-700 dark:text-red-400'
                                      : 'text-amber-700 dark:text-amber-400'
                                }
                              >
                                {diff.kind === 'ADDED'
                                  ? tr('+ Added', '+ အသစ်ထည့်')
                                  : diff.kind === 'REMOVED'
                                    ? tr('- Removed', '- ဖျက်လိုက်')
                                    : tr('~ Modified', '~ ပြင်ဆင်')}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300">
                              {diff.table_schema}.{diff.table_name}
                            </td>
                            <td className="py-3 px-4 font-mono font-semibold text-slate-900 dark:text-slate-100">
                              {diff.column_name}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">
                              {diff.baseline
                                ? `${diff.baseline.data_type} · ${
                                    diff.baseline.is_nullable === 'YES'
                                      ? 'NULL'
                                      : 'NOT NULL'
                                  }`
                                : '—'}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-900 dark:text-slate-100">
                              {diff.live
                                ? `${diff.live.data_type} · ${
                                    diff.live.is_nullable === 'YES'
                                      ? 'NULL'
                                      : 'NOT NULL'
                                  }`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {revertToBaselineSql && (
                <div className="bg-slate-900 dark:bg-slate-950 dark:border dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between gap-4">
                    <span className="text-xs font-medium text-slate-300 dark:text-slate-700">
                      {tr(
                        'Suggested Reconciliation SQL (Revert Live to Match Baseline)',
                        'အကြံပြု ပြန်လည်ညှိနှိုင်း SQL (လက်ရှိကို မူလစံနှင့် ကိုက်ညီစေရန်)'
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyText('revert-sql', revertToBaselineSql)}
                      className="inline-flex items-center gap-1.5 text-xs text-slate-300 dark:text-slate-700 hover:text-white cursor-pointer whitespace-nowrap shrink-0"
                    >
                      {copiedId === 'revert-sql' ? (
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
                  <pre className="p-4 text-xs font-mono text-slate-100 overflow-x-auto leading-relaxed">
                    {revertToBaselineSql}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Live Catalog + JSON/CSV Export */}
          {activeTab === 'catalog' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Live System Catalog Columns',
                      'လက်ရှိ System Catalog ကော်လံများ'
                    )}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {locale === 'my' ? (
                      <>
                        <code className="font-mono text-slate-700 dark:text-slate-300">
                          information_schema.columns
                        </code>{' '}
                        မှ ထုတ်ယူနိုင်သော လက်ရှိ မှတ်တမ်းဖြစ်ပါသည်။
                      </>
                    ) : (
                      <>
                        Exportable snapshot from{' '}
                        <code className="font-mono text-slate-700 dark:text-slate-300">
                          information_schema.columns
                        </code>
                        .
                      </>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-full sm:w-56">
                    <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      placeholder={tr(
                        'Filter table, column, type…',
                        'ဇယား၊ ကော်လံ၊ အမျိုးအစား ရှာရန်…'
                      )}
                      className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  {latestSnapshot && (
                    <>
                      <button
                        type="button"
                        onClick={handleExportCatalogJson}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>JSON</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleExportCatalogCsv}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>CSV</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {groupedCatalog.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  {latestSnapshot
                    ? tr(
                        'No catalog columns match your filter.',
                        'ရှာဖွေမှုနှင့် ကိုက်ညီသော ကော်လံ မရှိပါ။'
                      )
                    : tr(
                        'Run an inspection to fetch the live PostgreSQL catalog.',
                        'လက်ရှိ PostgreSQL catalog ကို ရယူရန် စစ်ဆေးမှု ပြုလုပ်ပါ။'
                      )}
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {groupedCatalog.map(([tableKey, cols]) => (
                    <div key={tableKey}>
                      <div className="px-5 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                        <span className="text-xs font-mono font-semibold text-slate-900 dark:text-slate-100">
                          {tableKey}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          {locale === 'my'
                            ? `ကော်လံ ${cols.length} ခု`
                            : `${cols.length} column${cols.length === 1 ? '' : 's'}`}
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="border-b border-slate-100 dark:border-slate-800/80 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                              <th className="py-2 px-5 w-14">#</th>
                              <th className="py-2 px-4">
                                {tr('Column', 'ကော်လံ')}
                              </th>
                              <th className="py-2 px-4">
                                {tr('Data Type', 'ဒေတာ အမျိုးအစား')}
                              </th>
                              <th className="py-2 px-4">
                                {tr('Nullable', 'NULL ခွင့်ပြုမှု')}
                              </th>
                              <th className="py-2 px-4">
                                {tr('Default', 'မူလတန်ဖိုး')}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
                            {cols.map((col, idx) => (
                              <tr
                                key={col.column_name}
                                className="hover:bg-slate-50 dark:hover:bg-slate-800/60"
                              >
                                <td className="py-2 px-5 font-mono text-slate-400 dark:text-slate-500 tabular-nums">
                                  {col.ordinal_position ?? idx + 1}
                                </td>
                                <td className="py-2 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                                  {col.column_name}
                                </td>
                                <td className="py-2 px-4 font-mono text-slate-700 dark:text-slate-300">
                                  {col.data_type}
                                </td>
                                <td className="py-2 px-4 font-mono text-slate-600 dark:text-slate-300">
                                  {col.is_nullable === 'YES'
                                    ? 'NULL'
                                    : 'NOT NULL'}
                                </td>
                                <td className="py-2 px-4 font-mono text-slate-500 dark:text-slate-400 truncate max-w-xs">
                                  {col.column_default ?? '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: Table & Vacuum Health */}
          {activeTab === 'health' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {tr(
                    'Table Size, Dead Tuples & Autovacuum Health',
                    'ဇယား အရွယ်အစား၊ Dead Tuple နှင့် Autovacuum ကျန်းမာရေး'
                  )}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {locale === 'my' ? (
                    <>
                      <code className="font-mono text-slate-700 dark:text-slate-300">
                        pg_stat_user_tables
                      </code>{' '}
                      မှတစ်ဆင့် dead-row စုပုံမှုနှင့် sequential / index scan
                      အချိုးများကို စောင့်ကြည့်ပါသည်။
                    </>
                  ) : (
                    <>
                      Tracks dead-row buildup and sequential vs. index scan
                      ratios from{' '}
                      <code className="font-mono text-slate-700 dark:text-slate-300">
                        pg_stat_user_tables
                      </code>
                      .
                    </>
                  )}
                </p>
              </div>

              {!health || health.table_health.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  {tr(
                    'Click "Run Inspection" to collect live table vacuum and scan telemetry.',
                    'ဇယား VACUUM နှင့် scan အချက်အလက်များကို ရယူရန် "စစ်ဆေးမှု ပြုလုပ်ရန်" ကို နှိပ်ပါ။'
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-medium">
                        <th className="py-2.5 px-4">{tr('Table', 'ဇယား')}</th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Total Size', 'စုစုပေါင်း အရွယ်အစား')}
                        </th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Live / Dead Rows', 'အသုံးပြု / Dead အတန်း')}
                        </th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Dead %', 'Dead %')}
                        </th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Seq / Idx Scans', 'Seq / Idx Scan')}
                        </th>
                        <th className="py-2.5 px-4">
                          {tr('Last Autovacuum', 'နောက်ဆုံး Autovacuum')}
                        </th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Maintenance', 'ပြုပြင်ထိန်းသိမ်းမှု')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {health.table_health.map((row) => (
                        <tr
                          key={`${row.schemaname}.${row.relname}`}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800/60"
                        >
                          <td className="py-3 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                            {row.schemaname}.{row.relname}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {row.total_size_pretty}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {row.n_live_tup.toLocaleString()} /{' '}
                            {row.n_dead_tup.toLocaleString()}
                          </td>
                          <td
                            className={`py-3 px-4 text-right font-mono tabular-nums font-semibold ${
                              row.dead_tuple_pct > 20
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            {row.dead_tuple_pct.toFixed(1)}%
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            {row.seq_scan.toLocaleString()} /{' '}
                            {row.idx_scan.toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                            {formatTimestamp(row.last_autovacuum)}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                copyText(
                                  `vac-${row.relname}`,
                                  row.remediation_sql
                                )
                              }
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 cursor-pointer whitespace-nowrap"
                            >
                              {copiedId === `vac-${row.relname}` ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                                  <span>
                                    {tr('Copied VACUUM', 'VACUUM ကူးယူပြီး')}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  <span>
                                    {tr('Copy VACUUM', 'VACUUM ကူးယူရန်')}
                                  </span>
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: Unused Indexes */}
          {activeTab === 'unused-idx' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {tr(
                    'Unused Non-Unique Indexes (Zero Scans)',
                    'အသုံးမပြုသော Non-Unique အညွှန်းများ (Scan သုည)'
                  )}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {tr(
                    'Indexes with zero reads since stats reset slow down every INSERT and UPDATE while consuming storage.',
                    'စာရင်းအင်း ပြန်လည်စတင်ချိန်မှစ၍ တစ်ကြိမ်မျှ အသုံးမပြုရသေးသော အညွှန်းများသည် သိုလှောင်မှု နေရာယူပြီး INSERT နှင့် UPDATE များကို နှေးကွေးစေပါသည်။'
                  )}
                </p>
              </div>

              {!health || health.unused_indexes.length === 0 ? (
                <div className="p-8 text-center space-y-1">
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    {tr(
                      'No Unused Indexes Detected',
                      'အသုံးမပြုသော အညွှန်းများ မတွေ့ရှိပါ'
                    )}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {tr(
                      'Every non-unique index on this database has active scan usage.',
                      'ဤဒေတာဘေ့စ်ရှိ non-unique အညွှန်းအားလုံးကို ပုံမှန် အသုံးပြုလျက်ရှိပါသည်။'
                    )}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-medium">
                        <th className="py-2.5 px-4">
                          {tr('Index Name', 'အညွှန်း အမည်')}
                        </th>
                        <th className="py-2.5 px-4">{tr('Table', 'ဇယား')}</th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Scans', 'Scan အကြိမ်')}
                        </th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Wasted Size', 'အလဟဿ အရွယ်အစား')}
                        </th>
                        <th className="py-2.5 px-4">
                          {tr('Safe Cleanup SQL', 'ဘေးကင်း ရှင်းလင်းရေး SQL')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {health.unused_indexes.map((idx) => (
                        <tr key={`${idx.schemaname}.${idx.indexname}`}>
                          <td className="py-3 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                            {idx.schemaname}.{idx.indexname}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300">
                            {idx.tablename}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            {idx.idx_scan}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                            {idx.index_size_pretty}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <code className="text-xs font-mono text-slate-700 dark:text-slate-300 truncate max-w-xs">
                                {idx.remediation_sql}
                              </code>
                              <button
                                type="button"
                                onClick={() =>
                                  copyText(
                                    `drop-${idx.indexname}`,
                                    idx.remediation_sql
                                  )
                                }
                                className="text-slate-400 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer shrink-0"
                                aria-label={tr(
                                  'Copy DROP INDEX SQL',
                                  'DROP INDEX SQL ကူးယူရန်'
                                )}
                              >
                                {copiedId === `drop-${idx.indexname}` ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 5: Recursive Lock Tree */}
          {activeTab === 'locks' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {tr(
                    'Active Blocking Lock Tree (> 5s Wait Threshold)',
                    'လက်ရှိ Lock ပိတ်ဆို့မှု အဆင့်ဆင့် (စောင့်ဆိုင်းချိန် ၅ စက္ကန့်အထက်)'
                  )}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {tr(
                    'Pinpoints queries blocking other sessions with sensitive values automatically redacted.',
                    'အခြား session များကို ပိတ်ဆို့နေသော query များကို အရေးကြီး တန်ဖိုးများ အလိုအလျောက် ဖုံးအုပ်၍ ဖော်ပြပါသည်။'
                  )}
                </p>
              </div>

              {!latestSnapshot || latestSnapshot.locksJson.length === 0 ? (
                <div className="p-8 text-center space-y-1.5">
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    {tr(
                      'No Database Traffic Jams Active',
                      'လက်ရှိ ဒေတာဘေ့စ် Lock ပိတ်ဆို့မှု မရှိပါ'
                    )}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {tr(
                      'Zero sessions waiting on exclusive locks for more than 5 seconds during the latest poll.',
                      'နောက်ဆုံး စစ်ဆေးမှုအတွင်း exclusive lock ကြောင့် ၅ စက္ကန့်ထက်ပို၍ စောင့်ဆိုင်းနေသော session မရှိပါ။'
                    )}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-xs font-medium text-slate-500 dark:text-slate-400">
                        <th className="py-2.5 px-4">
                          {tr('Blocking PID', 'ပိတ်ဆို့နေသော PID')}
                        </th>
                        <th className="py-2.5 px-4">
                          {tr('Blocked PID', 'ပိတ်ဆို့ခံရသော PID')}
                        </th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Wait Duration', 'စောင့်ဆိုင်းချိန်')}
                        </th>
                        <th className="py-2.5 px-4">
                          {tr(
                            'Blocking Statement (Redacted)',
                            'ပိတ်ဆို့နေသော SQL (ဖုံးအုပ်ပြီး)'
                          )}
                        </th>
                        <th className="py-2.5 px-4">
                          {tr(
                            'Blocked Statement (Redacted)',
                            'ပိတ်ဆို့ခံ SQL (ဖုံးအုပ်ပြီး)'
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {latestSnapshot.locksJson.map((lock, idx) => (
                        <tr
                          key={`${lock.blocking_pid}-${lock.blocked_pid}-${idx}`}
                        >
                          <td className="py-3 px-4 font-mono text-slate-900 dark:text-slate-100 tabular-nums">
                            {lock.blocking_pid} · {lock.blocking_user}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300 tabular-nums">
                            {lock.blocked_pid} · {lock.blocked_user}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                            {lock.wait_duration_seconds}s
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300 max-w-xs truncate">
                            {lock.blocking_statement}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300 max-w-xs truncate">
                            {lock.blocked_statement}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 6: Index Bloat */}
          {activeTab === 'bloat' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {tr(
                    'Index Bloat Telemetry (> 10 MB Relations)',
                    'အညွှန်း ဖောင်းပွမှု စစ်ဆေးချက် (10 MB အထက် ဇယားများ)'
                  )}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {tr(
                    'Indexes exceeding your configured bloat thresholds include copy-paste online reindex commands.',
                    'သတ်မှတ်ထားသော ဖောင်းပွမှု ကန့်သတ်ချက်ထက် ကျော်လွန်သော အညွှန်းများအတွက် ချက်ချင်းကူးယူနိုင်သော online REINDEX အမိန့်များ ပါဝင်ပါသည်။'
                  )}
                </p>
              </div>

              {!latestSnapshot || latestSnapshot.bloatJson.length === 0 ? (
                <div className="p-8 text-center space-y-1.5">
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    {tr(
                      'No Bloated Indexes Above 10 MB Detected',
                      '10 MB အထက် ဖောင်းပွနေသော အညွှန်း မတွေ့ရှိပါ'
                    )}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {tr(
                      'All scanned user indexes are within healthy tuple-fetch ratios.',
                      'စစ်ဆေးပြီးသော အညွှန်းအားလုံးသည် ပုံမှန် ကျန်းမာသော အချိုးအစားအတွင်း ရှိပါသည်။'
                    )}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-xs font-medium text-slate-500 dark:text-slate-400">
                        <th className="py-2.5 px-4">{tr('Index', 'အညွှန်း')}</th>
                        <th className="py-2.5 px-4">{tr('Table', 'ဇယား')}</th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Size', 'အရွယ်အစား')}
                        </th>
                        <th className="py-2.5 px-4 text-right">
                          {tr('Est. Bloat', 'ခန့်မှန်း ဖောင်းပွမှု')}
                        </th>
                        <th className="py-2.5 px-4">
                          {tr('Remediation', 'ပြုပြင်ရေး SQL')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {latestSnapshot.bloatJson.map((idx) => (
                        <tr key={`${idx.schemaname}.${idx.indexname}`}>
                          <td className="py-3 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                            {idx.schemaname}.{idx.indexname}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300">
                            {idx.tablename}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                            {idx.index_size_pretty}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-amber-700 dark:text-amber-400">
                            {idx.estimated_bloat_pct.toFixed(1)}%
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <code className="text-xs font-mono text-slate-700 dark:text-slate-300 truncate max-w-xs">
                                {idx.remediation_sql}
                              </code>
                              <button
                                type="button"
                                onClick={() =>
                                  copyText(idx.indexname, idx.remediation_sql)
                                }
                                className="text-slate-400 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer shrink-0"
                                aria-label={tr(
                                  'Copy REINDEX SQL',
                                  'REINDEX SQL ကူးယူရန်'
                                )}
                              >
                                {copiedId === idx.indexname ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 7: Baselines History + Restore + Time-Travel Diff */}
          {activeTab === 'baselines' && (
            <div className="space-y-4">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Stored Schema Baselines',
                      'သိမ်းဆည်းထားသော ဖွဲ့စည်းပုံ မူလစံ မှတ်တမ်းများ'
                    )}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {locale === 'my' ? (
                      <>
                        <code className="font-mono text-slate-700 dark:text-slate-300">
                          schema_baselines
                        </code>{' '}
                        တွင် မပြောင်းလဲနိုင်သော မှတ်တမ်းများအဖြစ် သိမ်းဆည်းထားပြီး
                        မည်သည့် မှတ်တမ်းဟောင်းကိုမဆို လက်ရှိ မူလစံအဖြစ် ပြန်လည်သတ်မှတ်နိုင်ပါသည်။
                      </>
                    ) : (
                      <>
                        Immutable schema snapshots stored in{' '}
                        <code className="font-mono text-slate-700 dark:text-slate-300">
                          schema_baselines
                        </code>
                        . Restore any archived snapshot as active.
                      </>
                    )}
                  </p>
                </div>
                {baselines.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                    {tr(
                      'No baselines have been captured for this target yet.',
                      'ဤပစ်မှတ်အတွက် မူလစံ မှတ်တမ်း မသိမ်းဆည်းရသေးပါ။'
                    )}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-xs font-medium text-slate-500 dark:text-slate-400">
                          <th className="py-2.5 px-4">
                            {tr('Captured', 'သိမ်းဆည်းချိန်')}
                          </th>
                          <th className="py-2.5 px-4">
                            {tr('SHA-256 Digest', 'SHA-256 တန်ဖိုး')}
                          </th>
                          <th className="py-2.5 px-4">
                            {tr('Git Commit', 'Git Commit')}
                          </th>
                          <th className="py-2.5 px-4 text-right">
                            {tr('Columns', 'ကော်လံများ')}
                          </th>
                          <th className="py-2.5 px-4">
                            {tr('State', 'အခြေအနေ')}
                          </th>
                          <th className="py-2.5 px-4 text-right">
                            {tr('Action', 'လုပ်ဆောင်ချက်')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                        {baselines.map((b, index) => (
                          <tr key={b.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                            <td className="py-3 px-4 text-slate-700 dark:text-slate-300 tabular-nums">
                              {formatTimestamp(b.createdAt)}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-900 dark:text-slate-100 tabular-nums">
                              {b.schemaHash.slice(0, 20)}…
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">
                              {b.gitCommitSha
                                ? b.gitCommitSha.slice(0, 10)
                                : '—'}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                              {b.tablesJson.length}
                            </td>
                            <td className="py-3 px-4 font-medium">
                              {index === 0 ? (
                                <span className="text-blue-700 dark:text-blue-400">
                                  {tr('Active Baseline', 'လက်ရှိ မူလစံ')}
                                </span>
                              ) : (
                                <span className="text-slate-500 dark:text-slate-400">
                                  {tr('Archived', 'မှတ်တမ်းဟောင်း')}
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right">
                              {index > 0 && (
                                <button
                                  type="button"
                                  disabled={busyAction !== null}
                                  onClick={() => handleRestoreBaseline(b.id)}
                                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-blue-700 dark:hover:text-blue-400 cursor-pointer whitespace-nowrap"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  <span>{tr('Restore', 'ပြန်သုံးရန်')}</span>
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {baselines.length >= 2 && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {tr(
                          'Time-Travel Baseline Comparison',
                          'သမိုင်းကြောင်း မူလစံ နှိုင်းယှဉ်ခြင်း'
                        )}
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {locale === 'my'
                          ? `${database.name} ၏ မည်သည့် မှတ်တမ်းဟောင်း နှစ်ခုကိုမဆို နှိုင်းယှဉ်ကြည့်ရှုနိုင်ပါသည်။`
                          : `Compare any two historical snapshots of ${database.name}.`}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={compareFromId}
                        onChange={(e) => setCompareFromId(e.target.value)}
                        aria-label={tr('Older baseline', 'မူလစံ အဟောင်း')}
                        className="px-2.5 py-1.5 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
                      >
                        {baselines.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.schemaHash.slice(0, 10)} (
                            {formatTimestamp(b.createdAt)})
                          </option>
                        ))}
                      </select>
                      <span className="text-xs text-slate-400 dark:text-slate-500">→</span>
                      <select
                        value={compareToId}
                        onChange={(e) => setCompareToId(e.target.value)}
                        aria-label={tr('Newer baseline', 'မူလစံ အသစ်')}
                        className="px-2.5 py-1.5 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
                      >
                        {baselines.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.schemaHash.slice(0, 10)} (
                            {formatTimestamp(b.createdAt)})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={handleCompareHistoricalBaselines}
                        disabled={busyAction === 'compare-baselines'}
                        className="px-3 py-1.5 text-xs font-medium text-white dark:text-slate-900 bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        {tr('Compare', 'နှိုင်းယှဉ်ရန်')}
                      </button>
                    </div>
                  </div>

                  {historicalDiff && (
                    <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        {historicalDiff.diffs.length === 0
                          ? tr(
                              'Both selected snapshots have identical schemas.',
                              'ရွေးချယ်ထားသော မှတ်တမ်း နှစ်ခုလုံး၏ ဖွဲ့စည်းပုံများ အတိအကျ တူညီပါသည်။'
                            )
                          : locale === 'my'
                            ? `${historicalDiff.fromHash.slice(0, 10)} နှင့် ${historicalDiff.toHash.slice(0, 10)} အကြား ကော်လံ ပြောင်းလဲမှု ${historicalDiff.diffs.length} ခု ရှိပါသည်။`
                            : `${historicalDiff.diffs.length} column change(s) between ${historicalDiff.fromHash.slice(0, 10)} and ${historicalDiff.toHash.slice(0, 10)}.`}
                      </p>
                      {historicalDiff.diffs.length > 0 && (
                        <pre className="p-3.5 bg-slate-900 dark:bg-slate-950 dark:border dark:border-slate-800 rounded-lg text-xs font-mono text-slate-100 overflow-x-auto">
                          {historicalDiff.syncSql}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* NEW ENTERPRISE TABS: ERD Graph, Time Machine, Security Audit */}
          {activeTab === 'erd' && (
            <SchemaErdPanel api={api} databaseId={databaseId} />
          )}

          {activeTab === 'time-machine' && (
            <SchemaTimeMachinePanel api={api} databaseId={databaseId} />
          )}

          {activeTab === 'security' && (
            <SecurityAuditPanel api={api} databaseId={databaseId} />
          )}

          {/* Recent Target Incidents */}
          {incidents.length > 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {locale === 'my'
                      ? `${database.name} အတွက် လတ်တလော သတိပေးချက်များ`
                      : `Recent Telemetry Incidents for ${database.name}`}
                  </h2>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {locale === 'my'
                    ? `မှတ်တမ်း ${incidents.length} ခု`
                    : `${incidents.length} recorded`}
                </span>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {incidents.slice(0, 5).map((inc) => (
                  <div
                    key={inc.id}
                    className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                  >
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`font-semibold ${
                            inc.severity === 'CRITICAL'
                              ? 'text-red-700 dark:text-red-400'
                              : inc.severity === 'WARNING'
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-blue-700 dark:text-blue-400'
                          }`}
                        >
                          {formatSeverity(inc.severity)}
                        </span>
                        <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-mono text-slate-700 dark:text-slate-300">
                          {formatIncidentType(inc.incidentType)}
                        </span>
                        <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">
                          {formatIncidentStatus(inc.status)}
                        </span>
                      </div>
                      <p className="text-slate-700 dark:text-slate-300">{inc.details.summary}</p>
                    </div>
                    <span className="text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                      {formatTimestamp(inc.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {showTimeline && (
          <EventTimelineSidebar
            api={api}
            databaseId={databaseId}
            databaseName={database.name}
            refreshKey={timelineRefreshKey}
            onInspectNow={handleInspectNow}
            onJumpToTab={(tab) => setActiveTab(tab)}
            onClose={() => setShowTimeline(false)}
          />
        )}
      </div>

      {database.connectionMode === 'external' && (
        <UpdateCredentialsModal
          isOpen={credentialsModalOpen}
          targetName={database.name}
          maskedTarget={database.maskedTarget}
          onClose={() => setCredentialsModalOpen(false)}
          onSave={async (connectionUrl) => {
            await api.updateDatabase(databaseId, { connectionUrl });
            setNotice(
              tr(
                'Connection URI updated and encrypted with the persistent server key.',
                'ချိတ်ဆက်မှု URI ကို အသစ်ပြင်ဆည်းပြီး တည်မြဲသော ဆာဗာသော့ဖြင့် လုံခြုံစွာ ကုဒ်ဝှက်သိမ်းဆည်းပြီးပါပြီ။'
              )
            );
            await loadDetail();
            onChanged();
          }}
        />
      )}
    </div>
  );
}
