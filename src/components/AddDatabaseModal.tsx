import React, { useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';
import type { ConnectionMode, EnvironmentType } from '../types/telemetry.ts';

interface AddDatabaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    environment: EnvironmentType;
    connectionMode: ConnectionMode;
    connectionUrl?: string;
    pollIntervalSeconds: number;
    gitCommitSha?: string;
    autoCaptureBaseline: boolean;
  }) => Promise<void>;
}

const READ_ONLY_SQL = `CREATE USER drift_monitor WITH PASSWORD 'strong_password';
GRANT CONNECT ON DATABASE production TO drift_monitor;
GRANT pg_read_all_stats TO drift_monitor; -- For pg_stat_activity & lock monitoring`;

export function AddDatabaseModal({
  isOpen,
  onClose,
  onCreate,
}: AddDatabaseModalProps) {
  const { t, tr } = useI18n();
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<EnvironmentType>('production');
  const [connectionMode, setConnectionMode] =
    useState<ConnectionMode>('workspace_pg');
  const [connectionUrl, setConnectionUrl] = useState('');
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(60);
  const [gitCommitSha, setGitCommitSha] = useState('');
  const [autoCaptureBaseline, setAutoCaptureBaseline] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);

  if (!isOpen) return null;

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(READ_ONLY_SQL);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        environment,
        connectionMode,
        connectionUrl:
          connectionMode === 'external' ? connectionUrl.trim() : undefined,
        pollIntervalSeconds,
        gitCommitSha: gitCommitSha.trim() || undefined,
        autoCaptureBaseline,
      });
      setName('');
      setConnectionUrl('');
      setGitCommitSha('');
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to register target database.',
              'ဒေတာဘေ့စ် ပစ်မှတ် မှတ်ပုံတင်ခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 dark:bg-slate-950/75 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-db-title"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h2
              id="add-db-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              {tr(
                'Register Monitored PostgreSQL Target',
                'စောင့်ကြည့်မည့် PostgreSQL ဒေတာဘေ့စ် ထည့်သွင်းရန်'
              )}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {tr(
                'Establishes read-only catalog polling with a 4,000ms statement timeout.',
                '4,000ms Query အချိန်ကန့်သတ်ချက်ဖြင့် ဘေးကင်းသော Read-Only စောင့်ကြည့်မှုကို စတင်ပေးပါမည်။'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('action.close')}
            className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-sm text-red-800 dark:text-red-300"
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="db-name"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                {tr('Target Name', 'ဒေတာဘေ့စ် အမည်')}
              </label>
              <input
                id="db-name"
                type="text"
                required
                minLength={2}
                maxLength={64}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tr(
                  'e.g. billing-prod-primary',
                  'ဥပမာ — billing-prod-primary'
                )}
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
              />
            </div>

            <div>
              <label
                htmlFor="db-env"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                {t('common.environment')}
              </label>
              <select
                id="db-env"
                value={environment}
                onChange={(e) =>
                  setEnvironment(e.target.value as EnvironmentType)
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
              >
                <option value="production">{t('env.production')}</option>
                <option value="staging">{t('env.staging')}</option>
                <option value="development">{t('env.development')}</option>
              </select>
            </div>
          </div>

          <div>
            <span className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              {tr('Connection Source', 'ချိတ်ဆက်မှု အရင်းအမြစ်')}
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => setConnectionMode('workspace_pg')}
                className={`px-3 py-2 text-xs font-medium rounded-md transition-colors text-center whitespace-nowrap cursor-pointer ${
                  connectionMode === 'workspace_pg'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {tr(
                  'Workspace PostgreSQL (Live)',
                  'လုပ်ငန်းခွင် PostgreSQL (တိုက်ရိုက်)'
                )}
              </button>
              <button
                type="button"
                onClick={() => setConnectionMode('external')}
                className={`px-3 py-2 text-xs font-medium rounded-md transition-colors text-center whitespace-nowrap cursor-pointer ${
                  connectionMode === 'external'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {tr(
                  'External PostgreSQL URI',
                  'ပြင်ပ PostgreSQL ချိတ်ဆက် URI'
                )}
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
              {connectionMode === 'workspace_pg'
                ? tr(
                    'Inspects this workspace’s provisioned PostgreSQL 15+ catalog, lock views, and index stats directly with zero external credentials required.',
                    'ပြင်ပ စကားဝှက်မလိုဘဲ ဤလုပ်ငန်းခွင်၏ PostgreSQL 15+ ဖွဲ့စည်းပုံ၊ Lock များနှင့် အညွှန်းစာရင်းအင်းများကို တိုက်ရိုက်စစ်ဆေးပေးပါသည်။'
                  )
                : tr(
                    'Connects out-of-band to any reachable PostgreSQL 13+ host. URI is AES-256-GCM encrypted before storage.',
                    'ချိတ်ဆက်နိုင်သော မည်သည့် PostgreSQL 13+ ဆာဗာနှင့်မဆို ချိတ်ဆက်နိုင်ပြီး URI ကို မသိမ်းဆည်းမီ AES-256-GCM ဖြင့် လုံခြုံစွာ ကုဒ်ဝှက်ထားပါသည်။'
                  )}
            </p>
          </div>

          {connectionMode === 'external' && (
            <div>
              <label
                htmlFor="db-uri"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                {tr('Read-Only Connection URI', 'Read-Only ချိတ်ဆက်မှု URI')}
              </label>
              <input
                id="db-uri"
                type="password"
                required
                value={connectionUrl}
                onChange={(e) => setConnectionUrl(e.target.value)}
                placeholder="postgresql://drift_monitor:password@db.example.com:5432/production"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="db-interval"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                {tr(
                  'Poll Interval (seconds)',
                  'စစ်ဆေးမှု အကြိမ်ကာလ (စက္ကန့်)'
                )}
              </label>
              <input
                id="db-interval"
                type="number"
                min={15}
                max={86400}
                value={pollIntervalSeconds}
                onChange={(e) =>
                  setPollIntervalSeconds(Math.max(15, Number(e.target.value) || 60))
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
              />
            </div>

            <div>
              <label
                htmlFor="db-sha"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                {tr(
                  'Baseline Git Commit SHA (optional)',
                  'မူလ Git Commit SHA (ရွေးချယ်နိုင်သည်)'
                )}
              </label>
              <input
                id="db-sha"
                type="text"
                maxLength={40}
                value={gitCommitSha}
                onChange={(e) => setGitCommitSha(e.target.value)}
                placeholder={tr('e.g. a9f4c21', 'ဥပမာ — a9f4c21')}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCaptureBaseline}
              onChange={(e) => setAutoCaptureBaseline(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-700 dark:text-blue-400 focus:ring-blue-700"
            />
            <span>
              {tr(
                'Capture initial canonical SHA-256 schema baseline immediately',
                'ကနဦး SHA-256 မူလစံဖွဲ့စည်းပုံကို ချက်ချင်း မှတ်တမ်းတင်ထားရန်'
              )}
            </span>
          </label>

          {connectionMode === 'external' && (
            <div className="bg-slate-900 dark:bg-slate-950 dark:border dark:border-slate-800 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300 dark:text-slate-700">
                  {tr(
                    'Read-Only Role Provisioning SQL',
                    'Read-Only အကောင့် ဖန်တီးရန် SQL'
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleCopySql}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-300 dark:text-slate-700 hover:text-white cursor-pointer"
                >
                  {copiedSql ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
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
              <pre className="text-xs font-mono text-slate-100 overflow-x-auto leading-relaxed">
                {READ_ONLY_SQL}
              </pre>
            </div>
          )}

          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              {t('action.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {submitting
                ? tr('Registering…', 'ထည့်သွင်းနေသည်…')
                : tr('Register Target', 'ဒေတာဘေ့စ် ထည့်သွင်းရန်')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
