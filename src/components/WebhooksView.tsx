import React, { useCallback, useEffect, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';
import type { ApiClient } from '../lib/api.ts';
import type {
  AlertWebhookDto,
  SeverityLevel,
  WebhookProvider,
} from '../types/telemetry.ts';

interface WebhooksViewProps {
  api: ApiClient;
  onChanged: () => void;
}

export function WebhooksView({ api, onChanged }: WebhooksViewProps) {
  const { locale, t, tr, formatSeverity } = useI18n();
  const [webhooks, setWebhooks] = useState<AlertWebhookDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [provider, setProvider] = useState<WebhookProvider>('slack');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [minSeverity, setMinSeverity] = useState<SeverityLevel>('WARNING');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadWebhooks = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listWebhooks();
      setWebhooks(res.webhooks);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to load alert channels.',
              'သတိပေးချက် လမ်းကြောင်းများ ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, tr]);

  useEffect(() => {
    loadWebhooks();
  }, [loadWebhooks]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await api.createWebhook({
        name: name.trim(),
        provider,
        webhookUrl: webhookUrl.trim(),
        minSeverity,
      });
      setName('');
      setWebhookUrl('');
      setNotice(
        tr(
          'Alert channel saved with AES-256-GCM URL encryption.',
          'သတိပေးချက် လမ်းကြောင်းကို AES-256-GCM ကုဒ်ဝှက်စနစ်ဖြင့် သိမ်းဆည်းပြီးပါပြီ။'
        )
      );
      await loadWebhooks();
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to create alert channel.',
              'သတိပေးချက် လမ်းကြောင်း ဖန်တီးခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (ch: AlertWebhookDto) => {
    setBusyId(ch.id);
    setError(null);
    try {
      await api.toggleWebhook(ch.id, !ch.isActive);
      await loadWebhooks();
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to update channel state.',
              'လမ်းကြောင်း အခြေအနေ ပြောင်းလဲ၍ မရပါ။'
            )
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = async (id: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.testWebhook(id);
      setNotice(res.message);
      await loadWebhooks();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Test delivery failed.', 'စမ်းသပ်ပေးပို့မှု မအောင်မြင်ပါ။')
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.deleteWebhook(id);
      await loadWebhooks();
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to remove channel.',
              'သတိပေးချက် လမ်းကြောင်း ဖျက်၍ မရပါ။'
            )
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {tr(
            'Alert Channels & Webhook Routing',
            'သတိပေးချက် လမ်းကြောင်းများနှင့် Webhook ချိတ်ဆက်မှု'
          )}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {tr(
            'Route high-priority schema drift, lock contention, and index bloat notifications to Slack, Discord, or custom HTTPS endpoints.',
            'အရေးကြီး ဖွဲ့စည်းပုံ ပြောင်းလဲမှု၊ Lock ပိတ်ဆို့မှုနှင့် အညွှန်း ဖောင်းပွမှု သတိပေးချက်များကို Slack၊ Discord သို့မဟုတ် စိတ်ကြိုက် HTTPS Webhook များသို့ ပေးပို့နိုင်ပါသည်။'
          )}
        </p>
      </div>

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

      {/* Create Webhook Form */}
      <form
        onSubmit={handleCreate}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
      >
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {tr('Add Webhook Destination', 'Webhook လမ်းကြောင်း အသစ်ထည့်ရန်')}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label
              htmlFor="wh-name"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {tr('Channel Name', 'လမ်းကြောင်း အမည်')}
            </label>
            <input
              id="wh-name"
              type="text"
              required
              minLength={2}
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="#db-alerts-prod"
              className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor="wh-provider"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {tr('Provider', 'ဝန်ဆောင်မှု အမျိုးအစား')}
            </label>
            <select
              id="wh-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as WebhookProvider)}
              className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
            >
              <option value="slack">Slack (hooks.slack.com)</option>
              <option value="discord">Discord (discord.com)</option>
              <option value="webhook">
                {tr('Custom HTTPS Webhook', 'စိတ်ကြိုက် HTTPS Webhook')}
              </option>
            </select>
          </div>

          <div>
            <label
              htmlFor="wh-severity"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {tr('Minimum Severity', 'အနည်းဆုံး အရေးကြီးမှုအဆင့်')}
            </label>
            <select
              id="wh-severity"
              value={minSeverity}
              onChange={(e) => setMinSeverity(e.target.value as SeverityLevel)}
              className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
            >
              <option value="CRITICAL">
                {tr(
                  'CRITICAL only (Schema Drift)',
                  'အရေးကြီး (CRITICAL) သီးသန့်'
                )}
              </option>
              <option value="WARNING">
                {tr(
                  'WARNING and above (Drift + Locks)',
                  'သတိပေးချက် (WARNING) နှင့် အထက်'
                )}
              </option>
              <option value="INFO">
                {tr(
                  'INFO and above (All Advisories)',
                  'အချက်အလက် (INFO) နှင့် အထက် (အားလုံး)'
                )}
              </option>
            </select>
          </div>

          <div>
            <label
              htmlFor="wh-url"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {tr('HTTPS Webhook URL', 'HTTPS Webhook လိပ်စာ')}
            </label>
            <input
              id="wh-url"
              type="url"
              required
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={
                provider === 'slack'
                  ? 'https://hooks.slack.com/services/...'
                  : provider === 'discord'
                    ? 'https://discord.com/api/webhooks/...'
                    : 'https://ops.example.com/hooks/drift'
              }
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {tr(
              'Outbound URLs are strictly validated for public HTTPS hosts and encrypted at rest.',
              'ပြင်ပ HTTPS လိပ်စာများကို လုံခြုံရေး စစ်ဆေးပြီး သိမ်းဆည်းချိန်တွင် ကုဒ်ဝှက်ထားပါသည်။'
            )}
          </span>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {submitting
              ? t('action.saving')
              : tr('Add Alert Channel', 'သတိပေးချက် လမ်းကြောင်း ထည့်ရန်')}
          </button>
        </div>
      </form>

      {/* Configured Channels Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {tr(
              'Configured Destinations',
              'ချိတ်ဆက်ထားသော သတိပေးချက် လမ်းကြောင်းများ'
            )}
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {tr(
              `${webhooks.length} channel${webhooks.length === 1 ? '' : 's'}`,
              `လမ်းကြောင်း ${webhooks.length} ခု`
            )}
          </span>
        </div>

        {loading ? (
          <div className="p-6 space-y-3 animate-pulse">
            <div className="h-10 bg-slate-100 dark:bg-slate-800 rounded" />
            <div className="h-10 bg-slate-100 dark:bg-slate-800 rounded" />
          </div>
        ) : webhooks.length === 0 ? (
          <div className="p-10 text-center space-y-1.5">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {tr(
                'No alert channels configured yet',
                'သတိပေးချက် လမ်းကြောင်း မထည့်သွင်းရသေးပါ'
              )}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tr(
                'Add a Slack or Discord webhook above to receive real-time alerts whenever drift or lock incidents occur.',
                'ဖွဲ့စည်းပုံ ပြောင်းလဲမှု သို့မဟုတ် Lock ပိတ်ဆို့မှု ဖြစ်ပွားတိုင်း ချက်ချင်း သတိပေးချက် ရရှိရန် အထက်တွင် Slack သို့မဟုတ် Discord Webhook ထည့်သွင်းပါ။'
              )}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-medium">
                  <th className="py-3 px-6">{tr('Channel', 'လမ်းကြောင်း')}</th>
                  <th className="py-3 px-4">{tr('Endpoint', 'လိပ်စာ')}</th>
                  <th className="py-3 px-4">
                    {tr('Min Severity', 'အနည်းဆုံး အဆင့်')}
                  </th>
                  <th className="py-3 px-4">
                    {tr('Last Delivery', 'နောက်ဆုံး ပေးပို့ချိန်')}
                  </th>
                  <th className="py-3 px-4">{t('common.status')}</th>
                  <th className="py-3 px-6 text-right">
                    {t('common.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {webhooks.map((ch) => (
                  <tr key={ch.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <td className="py-3.5 px-6">
                      <p className="font-semibold text-slate-900 dark:text-slate-100">{ch.name}</p>
                      <p className="text-slate-500 dark:text-slate-400 capitalize">{ch.provider}</p>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-600 dark:text-slate-300 max-w-xs truncate">
                      {ch.maskedUrl}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                      {formatSeverity(ch.minSeverity)}
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                      {ch.lastTriggeredAt
                        ? `HTTP ${ch.lastStatusCode ?? 'ERR'} · ${new Date(
                            ch.lastTriggeredAt
                          ).toLocaleTimeString(
                            locale === 'my' ? 'my-MM' : 'en-US'
                          )}`
                        : tr('Never triggered', 'မပေးပို့ရသေးပါ')}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <button
                        type="button"
                        disabled={busyId === ch.id}
                        onClick={() => handleToggle(ch)}
                        className={`font-medium cursor-pointer ${
                          ch.isActive ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {ch.isActive ? t('status.enabled') : t('status.paused')}
                      </button>
                    </td>
                    <td className="py-3.5 px-6 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busyId === ch.id}
                          onClick={() => handleTest(ch.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                        >
                          <Send className="w-3 h-3" />
                          <span>{tr('Test', 'စမ်းသပ်ရန်')}</span>
                        </button>
                        <button
                          type="button"
                          disabled={busyId === ch.id}
                          onClick={() => handleDelete(ch.id)}
                          aria-label={`${t('action.delete')} ${ch.name}`}
                          className="p-1.5 text-slate-400 dark:text-slate-500 hover:text-red-700 dark:hover:text-red-400 rounded-md cursor-pointer disabled:opacity-60"
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
