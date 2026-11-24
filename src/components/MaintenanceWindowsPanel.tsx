import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  EnvironmentType,
  MaintenanceWindowDto,
  MonitoredDatabaseDto,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface MaintenanceWindowsPanelProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  onChanged?: () => void;
}

const DAYS_EN = ['Daily', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_MY = ['နေ့စဉ်', 'တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'];

export function MaintenanceWindowsPanel({
  api,
  databases,
  onChanged,
}: MaintenanceWindowsPanelProps) {
  const { locale, tr, formatEnv } = useI18n();
  const [windows, setWindows] = useState<MaintenanceWindowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<string>('env:production');
  const [dayOfWeek, setDayOfWeek] = useState<number>(0);
  const [startTimeUtc, setStartTimeUtc] = useState('02:00');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [suppressWebhooks, setSuppressWebhooks] = useState(true);
  const [suppressAutoReinspect, setSuppressAutoReinspect] = useState(true);

  const loadWindows = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listMaintenanceWindows();
      setWindows(res.windows);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to load maintenance windows.',
              'ပြုပြင်ထိန်းသိမ်းချိန် ဇယားများကို ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, tr]);

  useEffect(() => {
    loadWindows();
  }, [loadWindows]);

  const formatDayLabel = (dow: number) => {
    const arr = locale === 'my' ? DAYS_MY : DAYS_EN;
    return arr[dow + 1] ?? arr[0];
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const isDb = scope.startsWith('db:');
      const databaseId = isDb ? scope.slice(3) : null;
      const environment = (
        isDb ? 'all' : scope.slice(4)
      ) as 'all' | EnvironmentType;

      await api.createMaintenanceWindow({
        title: title.trim(),
        databaseId,
        environment,
        dayOfWeek,
        startTimeUtc,
        durationMinutes,
        suppressWebhooks,
        suppressAutoReinspect,
      });
      setTitle('');
      setNotice(
        tr(
          'Maintenance window scheduled. Matching alerts will be silenced automatically during this window.',
          'ပြုပြင်ထိန်းသိမ်းချိန် သတ်မှတ်ပြီးပါပြီ။ ဤအချိန်အတွင်း သက်ဆိုင်ရာ သတိပေးချက်များကို အလိုအလျောက် တိတ်ဆိတ်ထားပေးပါမည်။'
        )
      );
      await loadWindows();
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to create maintenance window.',
              'ပြုပြင်ထိန်းသိမ်းချိန် ဖန်တီးခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (w: MaintenanceWindowDto) => {
    setError(null);
    try {
      await api.toggleMaintenanceWindow(w.id, !w.isActive);
      await loadWindows();
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to update window.', 'ပြင်ဆင်မှု မအောင်မြင်ပါ။')
      );
    }
  };

  const handleDelete = async (w: MaintenanceWindowDto) => {
    setError(null);
    try {
      await api.deleteMaintenanceWindow(w.id);
      await loadWindows();
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to delete window.', 'ဖျက်သိမ်းမှု မအောင်မြင်ပါ။')
      );
    }
  };

  const activeSilencingCount = windows.filter((w) => w.currentlyInWindow).length;

  return (
    <div className="space-y-6">
      {notice && (
        <div className="px-4 py-3 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50 dark:bg-blue-950/40 text-xs text-blue-900 dark:text-blue-200">
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Create Maintenance Window Form */}
      <form
        onSubmit={handleCreate}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                'Schedule Maintenance Window & Alert Silencing',
                'ပြုပြင်ထိန်းသိမ်းချိန်နှင့် သတိပေးချက် တိတ်ဆိတ်ချိန် သတ်မှတ်ရန်'
              )}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {tr(
                'Suppress outgoing Slack/Discord/HTTPS alerts and optional auto re-inspections during planned schema deployments.',
                'စီစဉ်ထားသော Migration နှင့် Deploy လုပ်ချိန်များအတွင်း Slack/Discord သတိပေးချက်များနှင့် အလိုအလျောက် ပြန်စစ်ဆေးမှုများကို ခေတ္တတားဆီးထားနိုင်ပါသည်။'
              )}
            </p>
          </div>
          {activeSilencingCount > 0 && (
            <span className="text-xs font-semibold text-amber-800 dark:text-amber-300 tabular-nums">
              {tr(
                `${activeSilencingCount} window(s) actively silencing alerts now`,
                `လက်ရှိတွင် ပြုပြင်ချိန် ${activeSilencingCount} ခု အသက်ဝင်နေသည်`
              )}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="lg:col-span-2 space-y-1">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {tr('Window Title', 'အစီအစဉ် အမည်')}
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr(
                'e.g. Weekly Production Schema Release',
                'ဥပမာ — အပတ်စဉ် ထုတ်လုပ်ရေး ဖွဲ့စည်းပုံ အဆင့်မြှင့်တင်ချိန်'
              )}
              className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {tr('Target Scope', 'သက်ရောက်မည့် နယ်ပယ်')}
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            >
              <option value="env:all">
                {tr('All Environments', 'ပတ်ဝန်းကျင် အားလုံး')}
              </option>
              <option value="env:production">
                {tr('Production Targets', 'ထုတ်လုပ်ရေး ဒေတာဘေ့စ်များ')}
              </option>
              <option value="env:staging">
                {tr('Staging Targets', 'စမ်းသပ်ရေး ဒေတာဘေ့စ်များ')}
              </option>
              <option value="env:development">
                {tr('Development Targets', 'ဖွံ့ဖြိုးရေး ဒေတာဘေ့စ်များ')}
              </option>
              {databases.map((db) => (
                <option key={db.id} value={`db:${db.id}`}>
                  {db.name} ({formatEnv(db.environment, true)})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {tr('Recurrence (UTC)', 'ထပ်ခါတလဲလဲ အချိန် (UTC)')}
            </label>
            <select
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(Number(e.target.value))}
              className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            >
              {[-1, 0, 1, 2, 3, 4, 5, 6].map((d) => (
                <option key={d} value={d}>
                  {formatDayLabel(d)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {tr('Start Time (UTC)', 'စတင်ချိန် (UTC)')}
            </label>
            <input
              type="time"
              required
              value={startTimeUtc}
              onChange={(e) => setStartTimeUtc(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {tr('Duration (Minutes)', 'ကြာချိန် (မိနစ်)')}
            </label>
            <input
              type="number"
              min={10}
              max={720}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value) || 60)}
              className="w-full px-3 py-2 text-xs font-mono tabular-nums border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="lg:col-span-2 flex flex-wrap items-center gap-4 pt-5">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={suppressWebhooks}
                onChange={(e) => setSuppressWebhooks(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-blue-700 dark:accent-blue-500"
              />
              <span>{tr('Silence Webhook Alerts', 'Webhook သတိပေးချက် ပိတ်ထားရန်')}</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={suppressAutoReinspect}
                onChange={(e) => setSuppressAutoReinspect(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-blue-700 dark:accent-blue-500"
              />
              <span>
                {tr('Pause Auto Re-Inspect', 'အလိုအလျောက် ပြန်စစ်ဆေးမှု ခေတ္တရပ်ရန်')}
              </span>
            </label>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>
              {creating
                ? tr('Scheduling…', 'သိမ်းဆည်းနေသည်…')
                : tr('Add Maintenance Window', 'ပြုပြင်ထိန်းသိမ်းချိန် ထည့်ရန်')}
            </span>
          </button>
        </div>
      </form>

      {/* Scheduled Windows Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {tr('Configured Maintenance Schedules', 'သတ်မှတ်ထားသော ပြုပြင်ထိန်းသိမ်းချိန် ဇယားများ')}
          </h3>
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {windows.length} {tr('schedules', 'ခု')}
          </span>
        </div>

        {loading ? (
          <div className="p-6 text-xs text-slate-500 dark:text-slate-400">
            {tr('Loading maintenance schedules…', 'ဇယားများကို ဖွင့်နေသည်…')}
          </div>
        ) : windows.length === 0 ? (
          <div className="p-10 text-center space-y-1.5">
            <CalendarClock className="w-6 h-6 text-slate-400 dark:text-slate-500 mx-auto" />
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {tr('No maintenance windows scheduled yet', 'ပြုပြင်ထိန်းသိမ်းချိန် မသတ်မှတ်ရသေးပါ')}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tr(
                'Add a recurring window above to prevent false-positive Slack/Discord alerts during planned deployments.',
                'စီစဉ်ထားသော Deploy ချိန်များတွင် သတိပေးချက် မှားယွင်းမထွက်စေရန် အပေါ်တွင် အချိန်ဇယား ထည့်သွင်းပါ။'
              )}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{tr('Window', 'အမည်')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('Scope', 'နယ်ပယ်')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('Schedule (UTC)', 'အချိန်ဇယား (UTC)')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('Suppression', 'တားဆီးမှု')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('State', 'အခြေအနေ')}</th>
                  <th className="px-4 py-2.5 font-medium text-right">{tr('Actions', 'လုပ်ဆောင်ချက်')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {windows.map((w) => (
                  <tr key={w.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60">
                    <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100">
                      {w.title}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {w.databaseName ? (
                        <span className="font-mono text-slate-800 dark:text-slate-200">
                          {w.databaseName}
                        </span>
                      ) : w.environment === 'all' ? (
                        tr('All Targets', 'ဒေတာဘေ့စ် အားလုံး')
                      ) : (
                        formatEnv(w.environment)
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {formatDayLabel(w.dayOfWeek)} · {w.startTimeUtc} UTC ({w.durationMinutes}m)
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {[
                        w.suppressWebhooks ? tr('Webhooks', 'Webhook') : null,
                        w.suppressAutoReinspect
                          ? tr('Auto-Inspect', 'အလိုအလျောက် စစ်ဆေးမှု')
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {w.currentlyInWindow ? (
                        <span className="text-amber-700 dark:text-amber-400 font-semibold">
                          {tr('Active Now (Silencing)', 'ယခု အသက်ဝင်နေသည်')}
                        </span>
                      ) : w.isActive ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          {tr('Scheduled', 'အသင့်ရှိ')}
                        </span>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500">
                          {tr('Paused', 'ခေတ္တရပ်ထား')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggle(w)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-md cursor-pointer"
                        >
                          {w.isActive
                            ? tr('Pause', 'ခေတ္တရပ်ရန်')
                            : tr('Enable', 'ဖွင့်ရန်')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(w)}
                          aria-label={tr('Delete maintenance window', 'ဖျက်ရန်')}
                          className="p-1.5 text-slate-400 dark:text-slate-500 hover:text-red-700 dark:hover:text-red-400 rounded-md cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
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
    </div>
  );
}
