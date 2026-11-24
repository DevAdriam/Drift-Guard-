import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';
import type { ApiClient } from '../lib/api.ts';
import type {
  ApiKeyDto,
  AuditLogDto,
  MonitoredDatabaseDto,
  TargetHealthThresholdDto,
  WorkspaceSettingsDto,
} from '../types/telemetry.ts';

interface AutomationSettingsViewProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  onDatabasesChanged?: () => void | Promise<void>;
}

type SettingsTab = 'cicd' | 'health-thresholds' | 'thresholds' | 'audit';

interface ThresholdDraft {
  enabled: boolean;
  minHealthScore: number;
  cooldownMinutes: number;
}

export function AutomationSettingsView({
  api,
  databases,
  onDatabasesChanged,
}: AutomationSettingsViewProps) {
  const { locale, t, tr, formatEnv, formatDateTime, formatRelativeTime } =
    useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('cicd');
  const [settings, setSettings] = useState<WorkspaceSettingsDto>({
    lockThresholdSeconds: 15,
    bloatMbThreshold: 50,
    bloatPctThreshold: 40,
    deadTuplePctThreshold: 20,
    cacheHitMinPct: 95,
    connSaturationPct: 80,
    updatedAt: null,
  });
  const [targetThresholds, setTargetThresholds] = useState<
    TargetHealthThresholdDto[]
  >([]);
  const [thresholdDrafts, setThresholdDrafts] = useState<
    Record<string, ThresholdDraft>
  >({});
  const [savingDbId, setSavingDbId] = useState<string | null>(null);
  const [evaluatingDbId, setEvaluatingDbId] = useState<string | null>(null);
  const [evaluatingAll, setEvaluatingAll] = useState(false);

  const [apiKeys, setApiKeys] = useState<ApiKeyDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newKeyName, setNewKeyName] = useState('');
  const [createdPlaintextKey, setCreatedPlaintextKey] = useState<string | null>(
    null
  );
  const [selectedCiDbId, setSelectedCiDbId] = useState(databases[0]?.id ?? '');
  const [auditSearch, setAuditSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const syncDraftsFromServer = useCallback(
    (targets: TargetHealthThresholdDto[], forceIds?: Set<string>) => {
      setThresholdDrafts((prev) => {
        const next: Record<string, ThresholdDraft> = {};
        for (const item of targets) {
          const existing = prev[item.databaseId];
          if (existing && (!forceIds || !forceIds.has(item.databaseId))) {
            next[item.databaseId] = existing;
          } else {
            next[item.databaseId] = {
              enabled: item.enabled,
              minHealthScore: item.minHealthScore,
              cooldownMinutes: item.cooldownMinutes,
            };
          }
        }
        return next;
      });
    },
    []
  );

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [settingsRes, keysRes, logsRes, targetThreshRes] = await Promise.all([
        api.getSettings(),
        api.listApiKeys(),
        api.listAuditLogs(),
        api.listTargetHealthThresholds(),
      ]);
      setSettings(settingsRes.settings);
      setApiKeys(keysRes.keys);
      setAuditLogs(logsRes.logs);
      setTargetThresholds(targetThreshRes.targets);
      syncDraftsFromServer(targetThreshRes.targets);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to load workspace controls.',
              'လုပ်ငန်းခွင် ဆက်တင်များ ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, tr, syncDraftsFromServer]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedCiDbId && databases.length > 0) {
      setSelectedCiDbId(databases[0].id);
    }
  }, [databases, selectedCiDbId]);

  const updateDraft = (
    databaseId: string,
    patch: Partial<ThresholdDraft>,
    fallback: TargetHealthThresholdDto
  ) => {
    setThresholdDrafts((prev) => {
      const base = prev[databaseId] ?? {
        enabled: fallback.enabled,
        minHealthScore: fallback.minHealthScore,
        cooldownMinutes: fallback.cooldownMinutes,
      };
      return {
        ...prev,
        [databaseId]: { ...base, ...patch },
      };
    });
  };

  const handleSaveTargetThreshold = async (row: TargetHealthThresholdDto) => {
    const draft = thresholdDrafts[row.databaseId] ?? {
      enabled: row.enabled,
      minHealthScore: row.minHealthScore,
      cooldownMinutes: row.cooldownMinutes,
    };
    const clampedScore = Math.max(
      10,
      Math.min(99, Math.round(Number(draft.minHealthScore) || 80))
    );
    const clampedCooldown = Math.max(
      1,
      Math.min(1440, Math.round(Number(draft.cooldownMinutes) || 10))
    );

    setSavingDbId(row.databaseId);
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateTargetHealthThreshold(row.databaseId, {
        enabled: draft.enabled,
        minHealthScore: clampedScore,
        cooldownMinutes: clampedCooldown,
        evaluateImmediately: true,
      });

      setTargetThresholds(res.targets);
      syncDraftsFromServer(res.targets, new Set([row.databaseId]));

      const evalItem = res.evaluation?.results[0];
      if (evalItem?.triggered) {
        setNotice(
          tr(
            `Saved rule for ${row.databaseName} (< ${clampedScore}/100). Score was ${evalItem.previousScore}/100 — automatic re-inspection triggered (updated score: ${evalItem.newScore ?? evalItem.previousScore}/100).`,
            `${row.databaseName} အတွက် စည်းမျဉ်း (< ${clampedScore}/100) သိမ်းဆည်းပြီးပါပြီ။ လက်ရှိရမှတ် ${evalItem.previousScore}/100 ဖြစ်နေသဖြင့် အလိုအလျောက် ပြန်လည်စစ်ဆေးမှု လုပ်ဆောင်ပြီး (ရမှတ်အသစ် — ${evalItem.newScore ?? evalItem.previousScore}/100)။`
          )
        );
        await onDatabasesChanged?.();
      } else if (evalItem?.breached && evalItem.skippedReason === 'cooldown') {
        setNotice(
          tr(
            `Saved rule for ${row.databaseName} (< ${clampedScore}/100). Threshold is breached, waiting for cooldown window before next automatic re-inspection.`,
            `${row.databaseName} အတွက် စည်းမျဉ်း (< ${clampedScore}/100) သိမ်းဆည်းပြီးပါပြီ။ ကန့်သတ်ချက်အောက် ရောက်နေသော်လည်း စောင့်ဆိုင်းချိန် (Cooldown) ပြည့်မှသာ နောက်တစ်ကြိမ် အလိုအလျောက် ပြန်စစ်ဆေးပါမည်။`
          )
        );
      } else if (evalItem?.error) {
        setError(
          tr(
            `Rule saved for ${row.databaseName}, but automatic re-inspection failed: ${evalItem.error}`,
            `${row.databaseName} အတွက် စည်းမျဉ်း သိမ်းဆည်းပြီးသော်လည်း အလိုအလျောက် ပြန်လည်စစ်ဆေးမှု မအောင်မြင်ပါ — ${evalItem.error}`
          )
        );
      } else {
        setNotice(
          draft.enabled
            ? tr(
                `Health score threshold saved for ${row.databaseName}: auto re-inspect below ${clampedScore}/100 (${clampedCooldown}m cooldown).`,
                `${row.databaseName} အတွက် ကျန်းမာရေးရမှတ် ကန့်သတ်ချက် သိမ်းဆည်းပြီးပါပြီ — ${clampedScore}/100 အောက်ကျပါက အလိုအလျောက် ပြန်စစ်ဆေးမည် (${clampedCooldown} မိနစ် စောင့်ဆိုင်းချိန်)။`
              )
            : tr(
                `Automatic health-threshold re-inspection disabled for ${row.databaseName}.`,
                `${row.databaseName} အတွက် ကျန်းမာရေးရမှတ် အလိုအလျောက် ပြန်စစ်ဆေးမှုကို ပိတ်ထားပြီးပါပြီ။`
              )
        );
      }

      const logsRes = await api.listAuditLogs();
      setAuditLogs(logsRes.logs);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to save target health score threshold.',
              'ဒေတာဘေ့စ် ကျန်းမာရေးရမှတ် ကန့်သတ်ချက် သိမ်းဆည်းခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setSavingDbId(null);
    }
  };

  const handleEvaluateThresholds = async (databaseId?: string) => {
    setError(null);
    setNotice(null);
    if (databaseId) {
      setEvaluatingDbId(databaseId);
    } else {
      setEvaluatingAll(true);
    }
    try {
      const res = await api.evaluateTargetHealthThresholds(databaseId);
      setTargetThresholds(res.targets);
      const ev = res.evaluation;

      const failedItems = ev.results.filter((r) => r.error);
      if (failedItems.length > 0 && ev.triggeredCount === 0) {
        setError(
          tr(
            `Threshold breached on ${failedItems[0].databaseName}, but automatic re-inspection failed: ${failedItems[0].error}`,
            `${failedItems[0].databaseName} တွင် ရမှတ်ကန့်သတ်ချက် ကျော်လွန်နေသော်လည်း အလိုအလျောက် ပြန်စစ်ဆေးမှု မအောင်မြင်ပါ — ${failedItems[0].error}`
          )
        );
      } else if (ev.triggeredCount > 0) {
        setNotice(
          tr(
            `Evaluated ${ev.evaluatedCount} rule${ev.evaluatedCount === 1 ? '' : 's'}: ${ev.breachedCount} breached, ${ev.triggeredCount} automatic re-inspection${ev.triggeredCount === 1 ? '' : 's'} triggered${ev.cooldownSkippedCount > 0 ? ` (${ev.cooldownSkippedCount} in cooldown)` : ''}.`,
            `စည်းမျဉ်း ${ev.evaluatedCount} ခု စစ်ဆေးပြီး — ${ev.breachedCount} ခု ကန့်သတ်ချက်အောက်ရောက်နေပြီး ${ev.triggeredCount} ခုကို အလိုအလျောက် ပြန်လည်စစ်ဆေးပြီးပါပြီ${ev.cooldownSkippedCount > 0 ? ` (${ev.cooldownSkippedCount} ခု စောင့်ဆိုင်းချိန်အတွင်း ရှိနေသည်)` : ''}။`
          )
        );
        await onDatabasesChanged?.();
      } else if (ev.cooldownSkippedCount > 0) {
        setNotice(
          tr(
            `Evaluated ${ev.evaluatedCount} rule${ev.evaluatedCount === 1 ? '' : 's'}: ${ev.breachedCount} breached, currently within cooldown window.`,
            `စည်းမျဉ်း ${ev.evaluatedCount} ခု စစ်ဆေးပြီး — ${ev.breachedCount} ခု ကန့်သတ်ချက်အောက်ရောက်နေသော်လည်း စောင့်ဆိုင်းချိန် (Cooldown) အတွင်း ရှိနေပါသည်။`
          )
        );
      } else {
        setNotice(
          tr(
            `Evaluated ${ev.evaluatedCount} active rule${ev.evaluatedCount === 1 ? '' : 's'}: all targets are above their configured health score thresholds.`,
            `ဖွင့်ထားသော စည်းမျဉ်း ${ev.evaluatedCount} ခု စစ်ဆေးပြီး — ဒေတာဘေ့စ်အားလုံး သတ်မှတ်ထားသော ကျန်းမာရေးရမှတ် အထက်တွင် ရှိနေပါသည်။`
          )
        );
      }

      const logsRes = await api.listAuditLogs();
      setAuditLogs(logsRes.logs);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to evaluate health score thresholds.',
              'ကျန်းမာရေးရမှတ် စည်းမျဉ်းများ စစ်ဆေးခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setEvaluatingDbId(null);
      setEvaluatingAll(false);
    }
  };

  const handleSaveThresholds = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const res = await api.updateSettings({
        lockThresholdSeconds: settings.lockThresholdSeconds,
        bloatMbThreshold: settings.bloatMbThreshold,
        bloatPctThreshold: settings.bloatPctThreshold,
        deadTuplePctThreshold: settings.deadTuplePctThreshold,
        cacheHitMinPct: settings.cacheHitMinPct,
        connSaturationPct: settings.connSaturationPct,
      });
      setSettings(res.settings);
      setNotice(
        tr(
          'Alert threshold rules saved and active on next inspection.',
          'သတိပေးချက် စည်းမျဉ်းများကို သိမ်းဆည်းပြီးဖြစ်ပြီး နောက်တစ်ကြိမ် စစ်ဆေးမှုမှစ၍ အသက်ဝင်ပါမည်။'
        )
      );
      await loadAll();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to save thresholds.',
              'စည်းမျဉ်းများ သိမ်းဆည်းခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const res = await api.createApiKey(newKeyName.trim());
      setCreatedPlaintextKey(res.plaintextKey);
      setNewKeyName('');
      await loadAll();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to create key.', 'API Key ဖန်တီးခြင်း မအောင်မြင်ပါ။')
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    setError(null);
    try {
      await api.deleteApiKey(id);
      await loadAll();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to revoke key.', 'API Key ပယ်ဖျက်ခြင်း မအောင်မြင်ပါ။')
      );
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const appOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'https://your-app';
  const targetDbPlaceholder = selectedCiDbId || '<MONITORED_DATABASE_UUID>';

  const githubActionYaml = `name: DriftGuard Schema Gate
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  schema-drift-check:
    runs-on: ubuntu-latest
    steps:
      - name: Verify zero undocumented drift before deploy
        run: |
          curl --fail-with-body -sS -X POST "${appOrigin}/api/ci/check-drift" \\
            -H "Content-Type: application/json" \\
            -H "X-DriftGuard-Key: \${{ secrets.DRIFTGUARD_API_KEY }}" \\
            -d '{"databaseId":"${targetDbPlaceholder}"}'

      - name: Promote new Git baseline after production migration
        if: github.ref == 'refs/heads/main'
        run: |
          curl --fail-with-body -sS -X POST "${appOrigin}/api/ci/check-drift" \\
            -H "Content-Type: application/json" \\
            -H "X-DriftGuard-Key: \${{ secrets.DRIFTGUARD_API_KEY }}" \\
            -d '{"databaseId":"${targetDbPlaceholder}","promoteBaseline":true,"gitCommitSha":"\${{ github.sha }}"}'`;

  const filteredLogs = auditLogs.filter((l) => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      l.action.toLowerCase().includes(q) ||
      l.entityLabel.toLowerCase().includes(q) ||
      l.summary.toLowerCase().includes(q) ||
      l.actorEmail.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          {tr(
            'CI/CD Gates, Alert Rules & Audit Log',
            'CI/CD စစ်ဆေးဂိတ်၊ သတိပေးချက် စည်းမျဉ်းများနှင့် မှတ်တမ်း'
          )}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {tr(
            'Block drifted deploys automatically in GitHub Actions, tune your alert thresholds, and audit every schema inspection and baseline change.',
            'GitHub Actions တွင် ဖွဲ့စည်းပုံ မကိုက်ညီသော Deploy များကို အလိုအလျောက် တားဆီးနိုင်ပြီး သတိပေးချက် သတ်မှတ်ချက်များနှင့် လုပ်ဆောင်ချက် မှတ်တမ်းအားလုံးကို စီမံနိုင်ပါသည်။'
          )}
        </p>
      </div>

      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {(
          [
            {
              id: 'cicd',
              label: tr(
                `CI/CD Gate & Keys (${apiKeys.length})`,
                `CI/CD ဂိတ်နှင့် API Key များ (${apiKeys.length})`
              ),
            },
            {
              id: 'health-thresholds',
              label: tr(
                `Health Score Auto-Inspect (${targetThresholds.filter((x) => x.enabled).length})`,
                `ကျန်းမာရေးရမှတ် အလိုအလျောက် စစ်ဆေးမှု (${targetThresholds.filter((x) => x.enabled).length})`
              ),
            },
            {
              id: 'thresholds',
              label: tr('Alert Thresholds', 'သတိပေးချက် သတ်မှတ်ချက်များ'),
            },
            {
              id: 'audit',
              label: tr(
                `Activity Audit Log (${auditLogs.length})`,
                `လုပ်ဆောင်ချက် မှတ်တမ်း (${auditLogs.length})`
              ),
            },
          ] as { id: SettingsTab; label: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="px-4 py-3 rounded-lg border border-blue-200 bg-blue-50 text-sm text-blue-900">
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {/* TAB 1: CI/CD Gate & API Keys */}
      {activeTab === 'cicd' && (
        <div className="space-y-6">
          <form
            onSubmit={handleCreateKey}
            className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                {tr(
                  'Create CI/CD Pipeline API Key',
                  'CI/CD Pipeline API Key အသစ် ဖန်တီးရန်'
                )}
              </h2>
            </div>
            <p className="text-xs text-slate-500">
              {tr(
                'Authenticate GitHub Actions or GitLab CI to run automated drift checks',
                'GitHub Actions သို့မဟုတ် GitLab CI မှတစ်ဆင့် ဖွဲ့စည်းပုံ အလိုအလျောက် စစ်ဆေးရန် အသုံးပြုပါ'
              )}{' '}
              (<code className="font-mono">POST /api/ci/check-drift</code>).{' '}
              {tr(
                'Only a SHA-256 hash is stored on the server.',
                'ဆာဗာပေါ်တွင် SHA-256 Hash ကိုသာ လုံခြုံစွာ သိမ်းဆည်းထားပါသည်။'
              )}
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                required
                minLength={2}
                maxLength={64}
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder={tr(
                  'e.g. GitHub Actions — Production Deploy',
                  'ဥပမာ — GitHub Actions — Production Deploy'
                )}
                className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
              />
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                {saving
                  ? tr('Generating…', 'ဖန်တီးနေသည်…')
                  : tr('Generate API Key', 'API Key ဖန်တီးရန်')}
              </button>
            </div>

            {createdPlaintextKey && (
              <div className="p-4 rounded-lg border border-amber-300 bg-amber-50 space-y-2">
                <p className="text-xs font-semibold text-amber-900">
                  {tr(
                    'Copy your new API key now — it will not be shown again:',
                    'သင့် API Key အသစ်ကို ယခု ကူးယူသိမ်းဆည်းထားပါ — နောက်တစ်ကြိမ် ထပ်မံပြသမည် မဟုတ်ပါ —'
                  )}
                </p>
                <div className="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded-md px-3 py-2">
                  <code className="text-xs font-mono text-slate-900 break-all">
                    {createdPlaintextKey}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopy('new-key', createdPlaintextKey)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedId === 'new-key' ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>{t('action.copied')}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>{t('action.copy')}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </form>

          {/* Existing Keys */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                {tr('Active Pipeline Keys', 'အသုံးပြုနေသော Pipeline API Key များ')}
              </h2>
              <span className="text-xs text-slate-500 tabular-nums">
                {tr(
                  `${apiKeys.length} key${apiKeys.length === 1 ? '' : 's'}`,
                  `Key ${apiKeys.length} ခု`
                )}
              </span>
            </div>

            {loading ? (
              <div className="p-6 animate-pulse h-16 bg-slate-50" />
            ) : apiKeys.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                {tr(
                  'No CI/CD API keys created yet.',
                  'CI/CD API Key မဖန်တီးရသေးပါ။'
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                      <th className="py-2.5 px-6">
                        {tr('Key Name', 'Key အမည်')}
                      </th>
                      <th className="py-2.5 px-4">
                        {tr('Prefix', 'ရှေ့ဆက်ကုဒ်')}
                      </th>
                      <th className="py-2.5 px-4">
                        {tr('Last Used', 'နောက်ဆုံး အသုံးပြုချိန်')}
                      </th>
                      <th className="py-2.5 px-6 text-right">
                        {tr('Action', 'လုပ်ဆောင်ချက်')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {apiKeys.map((k) => (
                      <tr key={k.id}>
                        <td className="py-3 px-6 font-medium text-slate-900">
                          {k.name}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600">
                          {k.keyPrefix}••••••••
                        </td>
                        <td className="py-3 px-4 text-slate-500 tabular-nums">
                          {k.lastUsedAt
                            ? formatDateTime(k.lastUsedAt)
                            : tr('Never used', 'မသုံးရသေးပါ')}
                        </td>
                        <td className="py-3 px-6 text-right">
                          <button
                            type="button"
                            onClick={() => handleRevokeKey(k.id)}
                            className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 font-medium cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>{tr('Revoke', 'ပယ်ဖျက်ရန်')}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* GitHub Actions Snippet */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {tr(
                    'GitHub Actions Workflow Template',
                    'GitHub Actions Workflow နမူနာပုံစံ'
                  )}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tr(
                    'Fails the pull request with HTTP 409 if undocumented drift is present, and promotes the Git commit SHA baseline after deploy.',
                    'မှတ်တမ်းမတင်ထားသော ဖွဲ့စည်းပုံ ပြောင်းလဲမှုရှိပါက Pull Request ကို HTTP 409 ဖြင့် ရပ်တန့်ပေးပြီး Deploy အပြီး Git Commit SHA ကို မူလစံအဖြစ် အလိုအလျောက် မြှင့်တင်ပေးပါသည်။'
                  )}
                </p>
              </div>
              {databases.length > 0 && (
                <select
                  value={selectedCiDbId}
                  onChange={(e) => setSelectedCiDbId(e.target.value)}
                  aria-label={tr(
                    'Target database for CI template',
                    'CI နမူနာအတွက် ဒေတာဘေ့စ် ရွေးရန်'
                  )}
                  className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white text-slate-900"
                >
                  {databases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name} ({formatEnv(db.environment, true)})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="bg-slate-900 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
                <span className="text-xs font-mono text-slate-300">
                  .github/workflows/driftguard.yml
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy('gh-yaml', githubActionYaml)}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  {copiedId === 'gh-yaml' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>{tr('Copied YAML', 'YAML ကူးယူပြီး')}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>{tr('Copy YAML', 'YAML ကူးယူရန်')}</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-4 text-xs font-mono text-slate-100 overflow-x-auto leading-relaxed">
                {githubActionYaml}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Per-Target Health Score Thresholds & Automatic Re-Inspection */}
      {activeTab === 'health-thresholds' && (
        <div className="space-y-6">
          {/* 4-Column Summary Strip */}
          <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Protected Targets', 'ကာကွယ်ထားသော ဒေတာဘေ့စ်များ')}
              </p>
              <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {targetThresholds.filter((x) => x.enabled).length}
                <span className="text-sm font-normal text-slate-400">
                  /{targetThresholds.length}
                </span>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {tr(
                  'Auto re-inspection rules active',
                  'အလိုအလျောက် ပြန်စစ်ဆေးမှု ဖွင့်ထားသည်'
                )}
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Currently Breached', 'လက်ရှိ ကန့်သတ်ချက်အောက်')}
              </p>
              <p
                className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                  targetThresholds.some((x) => x.isBreached)
                    ? 'text-red-700'
                    : 'text-emerald-700'
                }`}
              >
                {targetThresholds.filter((x) => x.isBreached).length}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {tr(
                  'Below custom min health score',
                  'စိတ်ကြိုက် ကျန်းမာရေးရမှတ်အောက် ရောက်နေသည်'
                )}
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Auto Re-Inspections', 'အလိုအလျောက် စစ်ဆေးပြီးအကြိမ်')}
              </p>
              <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {targetThresholds.reduce(
                  (sum, x) => sum + x.autoReinspectCount,
                  0
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {tr(
                  'Triggered by threshold breaches',
                  'ကန့်သတ်ချက် ကျော်လွန်မှုကြောင့် စစ်ဆေးမှု'
                )}
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Health Score Model', 'ကျန်းမာရေးရမှတ် တွက်ချက်ပုံ')}
              </p>
              <p className="mt-1.5 text-sm font-semibold font-mono tabular-nums text-slate-900">
                0–100 pts
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {tr(
                  'Drift, open alerts, locks, bloat & pool pressure',
                  'ဖွဲ့စည်းပုံ၊ သတိပေးချက်၊ Lock၊ ဖောင်းပွမှုနှင့် ချိတ်ဆက်မှု'
                )}
              </p>
            </div>
          </div>

          {/* Per-Target Threshold Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-blue-700 shrink-0" />
                  <h2 className="text-base font-semibold text-slate-900">
                    {tr(
                      'Per-Target Health Score Thresholds',
                      'ဒေတာဘေ့စ်တစ်ခုချင်းစီအတွက် ကျန်းမာရေးရမှတ် ကန့်သတ်ချက်များ'
                    )}
                  </h2>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {tr(
                    'Configure a minimum 0–100 health score per PostgreSQL target. When a target drops below its threshold, DriftGuard automatically triggers a verification re-inspection while honoring the cooldown window to prevent loops.',
                    'PostgreSQL ဒေတာဘေ့စ်တစ်ခုချင်းစီအတွက် အနည်းဆုံး ကျန်းမာရေးရမှတ် (0–100) ကို စိတ်ကြိုက်သတ်မှတ်ပါ။ ရမှတ်ကန့်သတ်ချက်အောက် ကျဆင်းပါက စောင့်ဆိုင်းချိန် (Cooldown) အတိုင်း အလိုအလျောက် ပြန်လည်စစ်ဆေးပေးပါမည်။'
                  )}
                </p>
              </div>

              {targetThresholds.some((x) => x.enabled) && (
                <button
                  type="button"
                  disabled={evaluatingAll || evaluatingDbId !== null}
                  onClick={() => handleEvaluateThresholds()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${evaluatingAll ? 'animate-spin' : ''}`}
                  />
                  <span>
                    {evaluatingAll
                      ? tr('Evaluating…', 'စစ်ဆေးနေသည်…')
                      : tr(
                          'Evaluate All Rules Now',
                          'စည်းမျဉ်းအားလုံး ယခု စစ်ဆေးရန်'
                        )}
                  </span>
                </button>
              )}
            </div>

            {loading ? (
              <div className="p-6 space-y-3 animate-pulse">
                <div className="h-10 bg-slate-100 rounded" />
                <div className="h-10 bg-slate-100 rounded" />
              </div>
            ) : targetThresholds.length === 0 ? (
              <div className="p-10 text-center space-y-1.5">
                <p className="text-sm font-medium text-slate-900">
                  {tr(
                    'No monitored databases configured yet',
                    'စောင့်ကြည့်နေသော ဒေတာဘေ့စ် မရှိသေးပါ'
                  )}
                </p>
                <p className="text-xs text-slate-500">
                  {tr(
                    'Add a PostgreSQL target first to configure per-database health score thresholds and automatic re-inspections.',
                    'ဒေတာဘေ့စ်အလိုက် ကျန်းမာရေးရမှတ် ကန့်သတ်ချက်နှင့် အလိုအလျောက် ပြန်စစ်ဆေးမှု သတ်မှတ်ရန် PostgreSQL ဒေတာဘေ့စ်တစ်ခုကို ဦးစွာ ထည့်သွင်းပါ။'
                  )}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                      <th className="py-3 px-6">
                        {tr('Target Database', 'ဒေတာဘေ့စ် ပစ်မှတ်')}
                      </th>
                      <th className="py-3 px-4 min-w-[180px]">
                        {tr('Live Score vs Min', 'လက်ရှိရမှတ်နှင့် ကန့်သတ်ချက်')}
                      </th>
                      <th className="py-3 px-4">
                        {tr('Auto Re-Inspect', 'အလိုအလျောက် စစ်ဆေး')}
                      </th>
                      <th className="py-3 px-4">
                        {tr('Min Score (10–99)', 'အနည်းဆုံး ရမှတ် (10–99)')}
                      </th>
                      <th className="py-3 px-4">
                        {tr('Cooldown (min)', 'စောင့်ဆိုင်းချိန် (မိနစ်)')}
                      </th>
                      <th className="py-3 px-4">
                        {tr('Rule Status & History', 'အခြေအနေနှင့် မှတ်တမ်း')}
                      </th>
                      <th className="py-3 px-6 text-right">
                        {tr('Actions', 'လုပ်ဆောင်ချက်')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {targetThresholds.map((row) => {
                      const draft = thresholdDrafts[row.databaseId] ?? {
                        enabled: row.enabled,
                        minHealthScore: row.minHealthScore,
                        cooldownMinutes: row.cooldownMinutes,
                      };
                      const isDirty =
                        draft.enabled !== row.enabled ||
                        draft.minHealthScore !== row.minHealthScore ||
                        draft.cooldownMinutes !== row.cooldownMinutes;
                      const previewThreshold = Math.max(
                        10,
                        Math.min(99, Number(draft.minHealthScore) || 80)
                      );
                      const isScoreBelowDraft =
                        draft.enabled &&
                        row.lastHealthStatus !== 'PENDING' &&
                        row.currentHealthScore < previewThreshold;
                      const isRowBusy =
                        savingDbId === row.databaseId ||
                        evaluatingDbId === row.databaseId ||
                        evaluatingAll;
                      const cooldownMinsLeft = Math.max(
                        1,
                        Math.ceil(row.cooldownRemainingSeconds / 60)
                      );

                      const scoreBarFill = isScoreBelowDraft
                        ? 'fill-red-600'
                        : row.currentHealthScore >= 85
                          ? 'fill-emerald-600'
                          : row.currentHealthScore >= 60
                            ? 'fill-amber-500'
                            : 'fill-red-600';

                      return (
                        <tr
                          key={row.databaseId}
                          className={
                            row.isBreached ? 'bg-red-50/30' : 'hover:bg-slate-50/70'
                          }
                        >
                          <td className="py-4 px-6">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-slate-900">
                                {row.databaseName}
                              </span>
                              <span
                                className="text-slate-300"
                                aria-hidden="true"
                              >
                                ·
                              </span>
                              <span className="text-slate-500">
                                {formatEnv(row.environment, true)}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                              <span
                                className={
                                  row.lastHealthStatus === 'HEALTHY'
                                    ? 'text-emerald-700 font-medium'
                                    : row.lastHealthStatus === 'DRIFT' ||
                                        row.lastHealthStatus === 'ERROR'
                                      ? 'text-red-700 font-medium'
                                      : row.lastHealthStatus === 'WARNING'
                                        ? 'text-amber-700 font-medium'
                                        : 'text-slate-500'
                                }
                              >
                                {row.lastHealthStatus === 'HEALTHY'
                                  ? t('status.healthy')
                                  : row.lastHealthStatus === 'DRIFT'
                                    ? tr('Schema Drift', 'ဖွဲ့စည်းပုံ ပြောင်းလဲမှု')
                                    : row.lastHealthStatus === 'WARNING'
                                      ? t('status.warning')
                                      : row.lastHealthStatus === 'ERROR'
                                        ? tr('Poll Error', 'ချိတ်ဆက်မှု အမှား')
                                        : t('status.unknown')}
                              </span>
                              {!row.isActive && (
                                <>
                                  <span
                                    className="text-slate-300"
                                    aria-hidden="true"
                                  >
                                    ·
                                  </span>
                                  <span className="text-slate-400">
                                    {tr('Paused', 'ရပ်ဆိုင်းထား')}
                                  </span>
                                </>
                              )}
                              {row.openIncidentsCount > 0 && (
                                <>
                                  <span
                                    className="text-slate-300"
                                    aria-hidden="true"
                                  >
                                    ·
                                  </span>
                                  <span className="tabular-nums">
                                    {tr(
                                      `${row.openIncidentsCount} open alert${row.openIncidentsCount === 1 ? '' : 's'}`,
                                      `သတိပေးချက် ${row.openIncidentsCount} ခု`
                                    )}
                                  </span>
                                </>
                              )}
                            </div>
                          </td>

                          <td className="py-4 px-4">
                            <div className="flex items-baseline justify-between gap-2 mb-1.5">
                              <span
                                className={`font-mono font-semibold tabular-nums ${
                                  isScoreBelowDraft
                                    ? 'text-red-700'
                                    : row.currentHealthScore >= 85
                                      ? 'text-emerald-700'
                                      : 'text-amber-700'
                                }`}
                              >
                                {row.currentHealthScore}/100
                              </span>
                              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                                {tr(
                                  `Min ${previewThreshold}`,
                                  `အနည်းဆုံး ${previewThreshold}`
                                )}
                              </span>
                            </div>
                            <svg
                              viewBox="0 0 100 10"
                              preserveAspectRatio="none"
                              className="w-full h-2.5 overflow-visible block"
                              role="img"
                              aria-label={tr(
                                `Current score ${row.currentHealthScore} out of 100 versus threshold ${previewThreshold}`,
                                `လက်ရှိရမှတ် ${row.currentHealthScore}/100 နှင့် ကန့်သတ်ချက် ${previewThreshold}/100`
                              )}
                            >
                              <rect
                                x={0}
                                y={2}
                                width={100}
                                height={6}
                                rx={3}
                                className="fill-slate-100"
                              />
                              <rect
                                x={0}
                                y={2}
                                width={Math.max(
                                  4,
                                  Math.min(100, row.currentHealthScore)
                                )}
                                height={6}
                                rx={3}
                                className={scoreBarFill}
                              />
                              <rect
                                x={Math.max(
                                  0,
                                  Math.min(98.5, previewThreshold - 0.75)
                                )}
                                y={0.5}
                                width={1.5}
                                height={9}
                                rx={0.75}
                                className="fill-slate-900"
                              />
                            </svg>
                          </td>

                          <td className="py-4 px-4 whitespace-nowrap">
                            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                              <button
                                type="button"
                                role="switch"
                                aria-checked={draft.enabled}
                                aria-label={tr(
                                  `Toggle automatic re-inspection for ${row.databaseName}`,
                                  `${row.databaseName} အတွက် အလိုအလျောက် ပြန်စစ်ဆေးမှု ဖွင့်/ပိတ်ရန်`
                                )}
                                disabled={isRowBusy}
                                onClick={() =>
                                  updateDraft(
                                    row.databaseId,
                                    { enabled: !draft.enabled },
                                    row
                                  )
                                }
                                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-60 ${
                                  draft.enabled
                                    ? 'bg-blue-700'
                                    : 'bg-slate-200'
                                }`}
                              >
                                <span
                                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                                    draft.enabled
                                      ? 'translate-x-4.5'
                                      : 'translate-x-1'
                                  }`}
                                />
                              </button>
                              <span
                                className={`font-medium ${
                                  draft.enabled
                                    ? 'text-slate-900'
                                    : 'text-slate-400'
                                }`}
                              >
                                {draft.enabled
                                  ? tr('Enabled', 'ဖွင့်ထား')
                                  : tr('Off', 'ပိတ်ထား')}
                              </span>
                            </label>
                          </td>

                          <td className="py-4 px-4 whitespace-nowrap">
                            <input
                              type="number"
                              min={10}
                              max={99}
                              disabled={isRowBusy}
                              aria-label={tr(
                                `Minimum health score for ${row.databaseName}`,
                                `${row.databaseName} အတွက် အနည်းဆုံး ကျန်းမာရေးရမှတ်`
                              )}
                              value={draft.minHealthScore}
                              onChange={(e) =>
                                updateDraft(
                                  row.databaseId,
                                  {
                                    minHealthScore: Number(e.target.value),
                                  },
                                  row
                                )
                              }
                              className="w-20 px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 disabled:bg-slate-50"
                            />
                          </td>

                          <td className="py-4 px-4 whitespace-nowrap">
                            <input
                              type="number"
                              min={1}
                              max={1440}
                              disabled={isRowBusy}
                              aria-label={tr(
                                `Cooldown minutes for ${row.databaseName}`,
                                `${row.databaseName} အတွက် စောင့်ဆိုင်းချိန် (မိနစ်)`
                              )}
                              value={draft.cooldownMinutes}
                              onChange={(e) =>
                                updateDraft(
                                  row.databaseId,
                                  {
                                    cooldownMinutes: Number(e.target.value),
                                  },
                                  row
                                )
                              }
                              className="w-20 px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 disabled:bg-slate-50"
                            />
                          </td>

                          <td className="py-4 px-4">
                            <div className="font-semibold whitespace-nowrap">
                              {!row.enabled ? (
                                <span className="text-slate-400 font-medium">
                                  {tr('Disabled', 'ပိတ်ထားသည်')}
                                </span>
                              ) : !row.isActive ? (
                                <span className="text-slate-500 font-medium">
                                  {tr('Target paused', 'ပစ်မှတ် ရပ်ဆိုင်းထား')}
                                </span>
                              ) : row.isBreached && row.inCooldown ? (
                                <span className="text-amber-700">
                                  {tr(
                                    `Breached · Cooldown (${cooldownMinsLeft}m)`,
                                    `ကန့်သတ်ချက်အောက် · စောင့်ဆိုင်း (${cooldownMinsLeft} မိနစ်)`
                                  )}
                                </span>
                              ) : row.isBreached ? (
                                <span className="text-red-700">
                                  {tr(
                                    `Breached (< ${row.minHealthScore})`,
                                    `ကန့်သတ်ချက်အောက် (< ${row.minHealthScore})`
                                  )}
                                </span>
                              ) : (
                                <span className="text-emerald-700 font-medium">
                                  {tr('Above threshold', 'စံနှုန်းအထက် ရှိသည်')}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums whitespace-nowrap">
                              {row.autoReinspectCount > 0
                                ? tr(
                                    `${row.autoReinspectCount} auto run${row.autoReinspectCount === 1 ? '' : 's'} · Last ${formatRelativeTime(row.lastAutoReinspectAt)}`,
                                    `အလိုအလျောက် ${row.autoReinspectCount} ကြိမ် · နောက်ဆုံး ${formatRelativeTime(row.lastAutoReinspectAt)}`
                                  )
                                : tr(
                                    'No auto re-inspections yet',
                                    'အလိုအလျောက် ပြန်စစ်ဆေးမှု မရှိသေးပါ'
                                  )}
                            </p>
                          </td>

                          <td className="py-4 px-6 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                disabled={isRowBusy || !isDirty}
                                onClick={() => handleSaveTargetThreshold(row)}
                                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed ${
                                  isDirty
                                    ? 'bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-60'
                                    : 'bg-white border border-slate-200 text-slate-400'
                                }`}
                              >
                                {savingDbId === row.databaseId
                                  ? t('action.saving')
                                  : isDirty
                                    ? tr('Save', 'သိမ်းရန်')
                                    : tr('Saved', 'သိမ်းပြီး')}
                              </button>
                              <button
                                type="button"
                                disabled={isRowBusy || !row.enabled || !row.isActive}
                                onClick={() =>
                                  handleEvaluateThresholds(row.databaseId)
                                }
                                title={tr(
                                  'Evaluate threshold and trigger automatic re-inspection if breached',
                                  'ကန့်သတ်ချက်ကို စစ်ဆေးပြီး လိုအပ်ပါက အလိုအလျောက် ပြန်လည်စစ်ဆေးရန်'
                                )}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                              >
                                <RefreshCw
                                  className={`w-3 h-3 ${
                                    evaluatingDbId === row.databaseId
                                      ? 'animate-spin'
                                      : ''
                                  }`}
                                />
                                <span>{tr('Check', 'စစ်ရန်')}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Custom Alert Thresholds */}
      {activeTab === 'thresholds' && (
        <form
          onSubmit={handleSaveThresholds}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {tr(
                  'Custom Telemetry Alert Thresholds',
                  'စိတ်ကြိုက် သတိပေးချက် သတ်မှတ်ချက်များ'
                )}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {tr(
                  'Customize when DriftGuard opens incidents and dispatches Slack or Discord alerts during inspections.',
                  'စစ်ဆေးမှုများအတွင်း မည်သည့်အခြေအနေတွင် ဖြစ်ရပ်ဖွင့်ပြီး Slack သို့မဟုတ် Discord သတိပေးချက် ပေးပို့မည်ကို စိတ်ကြိုက်သတ်မှတ်နိုင်ပါသည်။'
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('health-thresholds')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50/60 border border-blue-200 hover:bg-blue-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>
                {tr(
                  'Per-Target Health Score Auto-Inspect',
                  'ဒေတာဘေ့စ်အလိုက် ကျန်းမာရေးရမှတ် စည်းမျဉ်းများ'
                )}
              </span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            <div>
              <label
                htmlFor="set-lock"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {tr(
                  'Blocking Lock Wait Threshold (seconds)',
                  'Lock ပိတ်ဆို့မှု စောင့်ဆိုင်းချိန် ကန့်သတ်ချက် (စက္ကန့်)'
                )}
              </label>
              <input
                id="set-lock"
                type="number"
                min={3}
                max={600}
                value={settings.lockThresholdSeconds}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    lockThresholdSeconds: Number(e.target.value) || 15,
                  })
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {tr(
                  'Default: 15s (opens WARNING lock contention alert).',
                  'မူလ — ၁၅ စက္ကန့် (Lock ပိတ်ဆို့မှု သတိပေးချက် ဖွင့်ပေးမည်)။'
                )}
              </p>
            </div>

            <div>
              <label
                htmlFor="set-bloat-mb"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {tr(
                  'Index Bloat Min Size (MB)',
                  'အညွှန်း ဖောင်းပွမှု အနည်းဆုံး အရွယ်အစား (MB)'
                )}
              </label>
              <input
                id="set-bloat-mb"
                type="number"
                min={1}
                max={10000}
                value={settings.bloatMbThreshold}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    bloatMbThreshold: Number(e.target.value) || 50,
                  })
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {tr(
                  'Default: 50 MB (ignores tiny tables).',
                  'မူလ — 50 MB (ဇယားအသေးများကို ကျော်သွားမည်)။'
                )}
              </p>
            </div>

            <div>
              <label
                htmlFor="set-bloat-pct"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {tr(
                  'Index Bloat Min Percentage (%)',
                  'အညွှန်း ဖောင်းပွမှု အနည်းဆုံး ရာခိုင်နှုန်း (%)'
                )}
              </label>
              <input
                id="set-bloat-pct"
                type="number"
                min={5}
                max={99}
                value={settings.bloatPctThreshold}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    bloatPctThreshold: Number(e.target.value) || 40,
                  })
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {tr(
                  'Default: 40% wasted space threshold.',
                  'မူလ — အလဟဿ သိုလှောင်မှု ၄၀% ကန့်သတ်ချက်။'
                )}
              </p>
            </div>

            <div>
              <label
                htmlFor="set-dead"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {tr(
                  'Table Dead Tuple Ratio (%)',
                  'ဇယား Dead Tuple အချိုး (%)'
                )}
              </label>
              <input
                id="set-dead"
                type="number"
                min={5}
                max={95}
                value={settings.deadTuplePctThreshold}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    deadTuplePctThreshold: Number(e.target.value) || 20,
                  })
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {tr(
                  'Flags tables needing VACUUM (ANALYZE) above 10k dead rows.',
                  'Dead Row ၁၀,၀၀၀ ကျော်ပြီး VACUUM (ANALYZE) လိုအပ်သော ဇယားများကို သတိပေးမည်။'
                )}
              </p>
            </div>

            <div>
              <label
                htmlFor="set-cache"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {tr(
                  'Target Buffer Cache Hit Ratio (%)',
                  'Buffer Cache ထိရောက်မှု စံနှုန်း (%)'
                )}
              </label>
              <input
                id="set-cache"
                type="number"
                min={50}
                max={100}
                value={settings.cacheHitMinPct}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    cacheHitMinPct: Number(e.target.value) || 95,
                  })
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {tr(
                  'Highlights memory pressure when cache hits dip below target.',
                  'Cache ထိရောက်မှု စံနှုန်းအောက်ကျဆင်းပါက မှတ်ဉာဏ် ဖိအားကို သတိပေးမည်။'
                )}
              </p>
            </div>

            <div>
              <label
                htmlFor="set-conn"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {tr(
                  'Connection Pool Saturation (%)',
                  'ချိတ်ဆက်မှု ပြည့်ကျပ်မှု ရာခိုင်နှုန်း (%)'
                )}
              </label>
              <input
                id="set-conn"
                type="number"
                min={20}
                max={100}
                value={settings.connSaturationPct}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    connSaturationPct: Number(e.target.value) || 80,
                  })
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {tr(
                  'Opens WARNING before hitting PostgreSQL max_connections.',
                  'PostgreSQL max_connections မပြည့်မီ ကြိုတင် သတိပေးချက် ဖွင့်ပေးမည်။'
                )}
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {settings.updatedAt
                ? tr(
                    `Last updated ${formatDateTime(settings.updatedAt)}`,
                    `နောက်ဆုံး ပြင်ဆင်ချိန် — ${formatDateTime(settings.updatedAt)}`
                  )
                : tr('Using blueprint defaults', 'မူလ စံသတ်မှတ်ချက်များကို သုံးနေသည်')}
            </span>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg cursor-pointer"
            >
              {saving
                ? t('action.saving')
                : tr('Save Threshold Rules', 'စည်းမျဉ်းများ သိမ်းဆည်းရန်')}
            </button>
          </div>
        </form>
      )}

      {/* TAB 3: Activity Audit Log */}
      {activeTab === 'audit' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {tr(
                  'Workspace Activity Audit Log',
                  'လုပ်ငန်းခွင် လုပ်ဆောင်ချက် မှတ်တမ်း'
                )}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {tr(
                  'Immutable trail of inspections, baseline promotions, migration reviews, incident updates, and API key actions.',
                  'စစ်ဆေးမှုများ၊ မူလစံ မြှင့်တင်မှုများ၊ Migration စစ်ဆေးချက်များ၊ ဖြစ်ရပ်ပြင်ဆင်မှုနှင့် API Key လုပ်ဆောင်ချက်အားလုံး၏ မပြောင်းလဲနိုင်သော မှတ်တမ်း။'
                )}
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder={tr(
                  'Filter actions, targets…',
                  'လုပ်ဆောင်ချက်၊ ပစ်မှတ် ရှာရန်…'
                )}
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white text-slate-900"
              />
            </div>
          </div>

          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              {tr(
                'No activity entries match your filter yet.',
                'ရှာဖွေမှုနှင့် ကိုက်ညီသော လုပ်ဆောင်ချက် မှတ်တမ်း မရှိသေးပါ။'
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                    <th className="py-2.5 px-6">{tr('Time', 'အချိန်')}</th>
                    <th className="py-2.5 px-4">
                      {tr('Actor', 'ဆောင်ရွက်သူ')}
                    </th>
                    <th className="py-2.5 px-4">
                      {tr('Action', 'လုပ်ဆောင်ချက်')}
                    </th>
                    <th className="py-2.5 px-4">{tr('Target', 'ပစ်မှတ်')}</th>
                    <th className="py-2.5 px-6">
                      {tr('Details', 'အသေးစိတ်')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50">
                      <td className="py-3 px-6 text-slate-500 tabular-nums whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString(
                          locale === 'my' ? 'my-MM' : 'en-US',
                          {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          }
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-700 whitespace-nowrap">
                        {log.actorEmail}
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {log.action}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-800 whitespace-nowrap">
                        {log.entityLabel}
                      </td>
                      <td className="py-3 px-6 text-slate-600">
                        {log.summary}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
