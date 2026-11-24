import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, ShieldAlert, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';
import type { ApiClient } from '../lib/api.ts';
import type {
  MigrationCheckDto,
  MonitoredDatabaseDto,
} from '../types/telemetry.ts';

interface MigrationLinterViewProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
}

const SAMPLE_RISKY_SQL = `-- Risky deployment migration example
CREATE INDEX idx_orders_customer_status ON public.orders (customer_id, status);

ALTER TABLE public.invoices
  ADD COLUMN billing_tier VARCHAR(32) NOT NULL;

ALTER TABLE public.customers
  ALTER COLUMN phone_number TYPE TEXT;

ALTER TABLE public.orders
  ADD CONSTRAINT fk_orders_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);`;

const SAMPLE_SAFE_SQL = `-- Zero-downtime PostgreSQL migration
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS billing_tier VARCHAR(32) DEFAULT 'standard';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_status
  ON public.orders (customer_id, status);

ALTER TABLE public.orders
  ADD CONSTRAINT fk_orders_org FOREIGN KEY (org_id) REFERENCES public.organizations(id) NOT VALID;`;

const SAMPLE_DESTRUCTIVE_SQL = `-- Destructive schema cleanup
ALTER TABLE public.users RENAME COLUMN full_name TO display_name;
ALTER TABLE public.legacy_sessions DROP COLUMN session_token;
UPDATE public.subscriptions SET status = 'active';`;

export function MigrationLinterView({
  api,
  databases,
}: MigrationLinterViewProps) {
  const { t, tr, formatEnv, formatSeverity, formatDateTime } = useI18n();
  const [title, setTitle] = useState('20261123_add_billing_tier_and_index');
  const [sqlText, setSqlText] = useState(SAMPLE_RISKY_SQL);
  const [databaseId, setDatabaseId] = useState<string>('');
  const [checks, setChecks] = useState<MigrationCheckDto[]>([]);
  const [activeCheck, setActiveCheck] = useState<MigrationCheckDto | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.listMigrationChecks();
      setChecks(res.checks);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to load migration review history.',
              'Migration စစ်ဆေးမှု မှတ်တမ်းများ ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, tr]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setAnalyzing(true);
    try {
      const res = await api.analyzeMigration({
        title: title.trim() || tr('Untitled Migration', 'အမည်မသတ်မှတ်ထားသော Migration'),
        sqlText,
        databaseId: databaseId || undefined,
      });
      setActiveCheck(res.check);
      await loadHistory();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Migration analysis failed.',
              'Migration စစ်ဆေးမှု မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteMigrationCheck(id);
      if (activeCheck?.id === id) setActiveCheck(null);
      await loadHistory();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to delete check.', 'စစ်ဆေးမှု မှတ်တမ်း ဖျက်၍ မရပါ။')
      );
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

  const handleDownloadSql = (check: MigrationCheckDto) => {
    const blob = new Blob([check.wrappedSafeSql], {
      type: 'application/sql;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${check.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_safe.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatRiskBadge = (level: string) => {
    if (level === 'BLOCKED') return tr('BLOCKED', 'အန္တရာယ်များ (တားဆီးထားသည်)');
    if (level === 'WARNING') return t('severity.warning');
    return tr('SAFE', 'ဘေးကင်းသည်');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {tr(
            'Pre-Flight SQL Migration Safety Checker',
            'Deploy မတိုင်မီ SQL Migration ဘေးကင်းရေး စစ်ဆေးစက်'
          )}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {tr(
            'Check migrations before deploying to catch table-freezing locks, missing CONCURRENTLY clauses, full table rewrites, and breaking renames in plain language.',
            'Deploy မပြုလုပ်မီ ဇယားပိတ်ဆို့စေသော Lock များ၊ CONCURRENTLY မပါသော Index များ၊ ဇယားအပြည့် ပြန်ရေးမှုများနှင့် စနစ်ပျက်စေနိုင်သော အမည်ပြောင်းမှုများကို ရှင်းလင်းစွာ ကြိုတင်စစ်ဆေးနိုင်ပါသည်။'
          )}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-sm text-red-800 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Migration Input Form */}
      <form
        onSubmit={handleAnalyze}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {tr(
              'Analyze Proposed PostgreSQL DDL',
              'အဆိုပြုထားသော PostgreSQL DDL ကို စစ်ဆေးရန်'
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {tr('Load sample:', 'နမူနာ ရွေးရန် —')}
            </span>
            <button
              type="button"
              onClick={() => {
                setTitle('20261123_risky_index_and_type_change');
                setSqlText(SAMPLE_RISKY_SQL);
              }}
              className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md cursor-pointer"
            >
              {tr('Risky Locks', 'Lock အန္တရာယ်ရှိ နမူနာ')}
            </button>
            <button
              type="button"
              onClick={() => {
                setTitle('20261123_zero_downtime_safe');
                setSqlText(SAMPLE_SAFE_SQL);
              }}
              className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md cursor-pointer"
            >
              {tr('Zero-Downtime Safe', 'ရပ်တန့်မှုမရှိ ဘေးကင်းနမူနာ')}
            </button>
            <button
              type="button"
              onClick={() => {
                setTitle('20261123_destructive_cleanup');
                setSqlText(SAMPLE_DESTRUCTIVE_SQL);
              }}
              className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md cursor-pointer"
            >
              {tr('Destructive Trap', 'ဒေတာထိခိုက်နိုင်သော နမူနာ')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="mig-title"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {tr(
                'Migration Name / PR Reference',
                'Migration အမည် / PR အမှတ်စဉ်'
              )}
            </label>
            <input
              id="mig-title"
              type="text"
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr(
                'e.g. 20261123_add_invoices_index',
                'ဥပမာ — 20261123_add_invoices_index'
              )}
              className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
            />
          </div>
          <div>
            <label
              htmlFor="mig-db"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {tr(
                'Target Database (optional)',
                'ပစ်မှတ် ဒေတာဘေ့စ် (ရွေးချယ်နိုင်သည်)'
              )}
            </label>
            <select
              id="mig-db"
              value={databaseId}
              onChange={(e) => setDatabaseId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
            >
              <option value="">
                {tr(
                  'General PostgreSQL 13+ check',
                  'အထွေထွေ PostgreSQL 13+ စစ်ဆေးမှု'
                )}
              </option>
              {databases.map((db) => (
                <option key={db.id} value={db.id}>
                  {db.name} ({formatEnv(db.environment, true)})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label
            htmlFor="mig-sql"
            className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
          >
            {tr('Migration SQL Script', 'Migration SQL ကုဒ်')}
          </label>
          <textarea
            id="mig-sql"
            rows={8}
            required
            value={sqlText}
            onChange={(e) => setSqlText(e.target.value)}
            spellCheck={false}
            className="w-full p-3.5 text-xs font-mono leading-relaxed bg-slate-900 dark:bg-slate-950 text-slate-100 rounded-lg border border-slate-700 dark:border-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {tr(
              'Static analysis checks 11 PostgreSQL lock & safety rules without executing any SQL on your database.',
              'သင့်ဒေတာဘေ့စ်ပေါ်တွင် SQL လုံးဝ မ run ဘဲ PostgreSQL Lock နှင့် ဘေးကင်းရေး စည်းမျဉ်း ၁၁ ချက်ဖြင့် စစ်ဆေးပေးပါသည်။'
            )}
          </span>
          <button
            type="submit"
            disabled={analyzing}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {analyzing
              ? tr('Analyzing SQL…', 'SQL စစ်ဆေးနေသည်…')
              : tr('Run Safety Check', 'ဘေးကင်းရေး စစ်ဆေးရန်')}
          </button>
        </div>
      </form>

      {/* Active Analysis Result */}
      {activeCheck && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <span
                  className={`font-bold ${
                    activeCheck.riskLevel === 'BLOCKED'
                      ? 'text-red-700 dark:text-red-400'
                      : activeCheck.riskLevel === 'WARNING'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {activeCheck.riskLevel === 'BLOCKED'
                    ? tr(
                        'High Risk — Fix Before Deploying',
                        'အန္တရာယ်မြင့်မား — Deploy မလုပ်မီ ပြင်ဆင်ပါ'
                      )
                    : activeCheck.riskLevel === 'WARNING'
                      ? tr(
                          'Caution — Lock Risks Found',
                          'သတိပြုရန် — Lock အန္တရာယ်များ တွေ့ရှိသည်'
                        )
                      : tr(
                          'Safe for Zero-Downtime Deploy',
                          'ဝန်ဆောင်မှု မရပ်တန့်ဘဲ Deploy လုပ်ရန် ဘေးကင်းပါသည်'
                        )}
                </span>
                <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                  {tr(
                    `${activeCheck.findings.length} finding${
                      activeCheck.findings.length === 1 ? '' : 's'
                    }`,
                    `တွေ့ရှိချက် ${activeCheck.findings.length} ခု`
                  )}
                </span>
              </div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {activeCheck.title}
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() =>
                  handleCopy('wrapped-sql', activeCheck.wrappedSafeSql)
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer whitespace-nowrap"
              >
                {copiedId === 'wrapped-sql' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                    <span>
                      {tr('Copied Guarded SQL', 'ဘေးကင်း SQL ကူးယူပြီး')}
                    </span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>
                      {tr('Copy Guarded SQL', 'ဘေးကင်း SQL ကူးယူရန်')}
                    </span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleDownloadSql(activeCheck)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{tr('Download .sql', '.sql ဒေါင်းလုဒ်ဆွဲရန်')}</span>
              </button>
            </div>
          </div>

          {activeCheck.findings.length === 0 ? (
            <div className="p-8 text-center space-y-1">
              <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                {tr(
                  'All 11 PostgreSQL Zero-Downtime Safety Checks Passed',
                  'PostgreSQL ဘေးကင်းရေး စည်းမျဉ်း ၁၁ ချက်လုံး အောင်မြင်ပါသည်'
                )}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {tr(
                  'Lock timeouts are configured and no blocking DDL rewrites or destructive operations were detected.',
                  'Lock Timeout များ သတ်မှတ်ထားပြီး ဇယားပိတ်ဆို့စေသော DDL နှင့် အန္တရာယ်ရှိ လုပ်ဆောင်ချက်များ မတွေ့ရှိပါ။'
                )}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {activeCheck.findings.map((finding, idx) => (
                <div key={`${finding.ruleId}-${idx}`} className="p-5 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`font-semibold ${
                        finding.severity === 'CRITICAL'
                          ? 'text-red-700 dark:text-red-400'
                          : finding.severity === 'WARNING'
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-blue-700 dark:text-blue-400'
                      }`}
                    >
                      {formatSeverity(finding.severity)}
                    </span>
                    <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono text-slate-500 dark:text-slate-400">
                      {finding.ruleId}
                    </span>
                    <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono text-slate-700 dark:text-slate-300">
                      {tr('Lock:', 'Lock အဆင့် —')} {finding.lockLevel}
                    </span>
                  </div>

                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {finding.title}
                  </p>
                  <p className="text-sm text-slate-700 dark:text-slate-300">
                    <strong className="font-medium text-slate-900 dark:text-slate-100">
                      {tr('Why it matters:', 'အဘယ်ကြောင့် အရေးကြီးသနည်း —')}
                    </strong>{' '}
                    {finding.plainEnglishImpact}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    <strong className="font-medium text-slate-800 dark:text-slate-200">
                      {tr('How to fix:', 'ပြင်ဆင်ရန် နည်းလမ်း —')}
                    </strong>{' '}
                    {finding.recommendation}
                  </p>

                  <div className="bg-slate-900 dark:bg-slate-950 dark:border dark:border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 overflow-x-auto">
                    {finding.statementPreview}
                  </div>

                  {finding.safeRewrite && (
                    <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/70 rounded-lg p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-300 mb-0.5">
                          {tr(
                            'Suggested Safe Rewrite',
                            'အကြံပြုထားသော ဘေးကင်း SQL ပုံစံ'
                          )}
                        </p>
                        <code className="text-xs font-mono text-emerald-950 dark:text-emerald-200 break-all">
                          {finding.safeRewrite}
                        </code>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          handleCopy(`rewrite-${idx}`, finding.safeRewrite!)
                        }
                        className="text-xs font-medium text-emerald-800 dark:text-emerald-300 hover:text-emerald-950 dark:hover:text-emerald-200 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {copiedId === `rewrite-${idx}`
                          ? t('action.copied')
                          : t('action.copy')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Saved Review History */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-slate-400 dark:text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                'Recent Migration Safety Reviews',
                'မကြာသေးမီက Migration စစ်ဆေးမှု မှတ်တမ်းများ'
              )}
            </h2>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {tr(`${checks.length} saved`, `မှတ်တမ်း ${checks.length} ခု`)}
          </span>
        </div>

        {loading ? (
          <div className="p-6 space-y-3 animate-pulse">
            <div className="h-9 bg-slate-100 dark:bg-slate-800 rounded" />
            <div className="h-9 bg-slate-100 dark:bg-slate-800 rounded" />
          </div>
        ) : checks.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
            {tr(
              'No migration checks saved yet. Paste a DDL migration above and run a safety check.',
              'Migration စစ်ဆေးမှု မှတ်တမ်း မရှိသေးပါ။ အထက်တွင် DDL ကုဒ်ထည့်၍ ဘေးကင်းရေး စစ်ဆေးမှု စတင်ပါ။'
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-medium">
                  <th className="py-2.5 px-6">
                    {tr('Migration', 'Migration အမည်')}
                  </th>
                  <th className="py-2.5 px-4">{tr('Verdict', 'ရလဒ်')}</th>
                  <th className="py-2.5 px-4 text-right">
                    {tr('Findings', 'တွေ့ရှိချက်')}
                  </th>
                  <th className="py-2.5 px-4 text-right">
                    {tr('Checked', 'စစ်ဆေးချိန်')}
                  </th>
                  <th className="py-2.5 px-6 text-right">
                    {tr('Action', 'လုပ်ဆောင်ချက်')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {checks.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => {
                      setActiveCheck(c);
                      setTitle(c.title);
                      setSqlText(c.sqlText);
                    }}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer"
                  >
                    <td className="py-3 px-6 font-medium text-slate-900 dark:text-slate-100">
                      {c.title}
                    </td>
                    <td className="py-3 px-4 font-semibold whitespace-nowrap">
                      <span
                        className={
                          c.riskLevel === 'BLOCKED'
                            ? 'text-red-700 dark:text-red-400'
                            : c.riskLevel === 'WARNING'
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-emerald-700 dark:text-emerald-400'
                        }
                      >
                        {formatRiskBadge(c.riskLevel)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {c.findings.length}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                      {formatDateTime(c.createdAt)}
                    </td>
                    <td className="py-3 px-6 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(c.id);
                        }}
                        aria-label={`${t('action.delete')} ${c.title}`}
                        className="p-1 text-slate-400 dark:text-slate-500 hover:text-red-700 dark:hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
