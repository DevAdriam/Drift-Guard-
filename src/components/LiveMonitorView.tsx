import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  LiveMonitorResponse,
  LiveSessionRow,
  MonitoredDatabaseDto,
  PgSettingAuditRow,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';
import { LongRunningBlockerTree } from './LongRunningBlockerTree.tsx';

interface LiveMonitorViewProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
}

type MonitorSubTab =
  | 'sessions'
  | 'blocker-tree'
  | 'io'
  | 'checkpoints'
  | 'wraparound'
  | 'settings';
type SessionFilter = 'all' | 'active' | 'idle_tx' | 'blocked' | 'idle';
type SettingsFilter = 'all' | 'attention' | 'optimal';

interface LiveTickSample {
  timestamp: string;
  tps: number;
  activeConn: number;
  cacheHit: number;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDuration(sec: number): string {
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  if (sec >= 1) return `${sec.toFixed(1)}s`;
  return `${Math.round(sec * 1000)}ms`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function LiveMonitorView({ api, databases }: LiveMonitorViewProps) {
  const { locale, t, tr, formatEnv, formatDateTime } = useI18n();

  const [selectedTargetId, setSelectedTargetId] = useState<string>(
    databases[0]?.id ?? ''
  );
  const [refreshSeconds, setRefreshSeconds] = useState<0 | 5 | 15 | 30>(5);
  const [data, setData] = useState<LiveMonitorResponse | null>(null);
  const [history, setHistory] = useState<LiveTickSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MonitorSubTab>('sessions');
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [sessionSearch, setSessionSearch] = useState('');
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [settingsFilter, setSettingsFilter] = useState<SettingsFilter>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedTargetId && databases.length > 0) {
      setSelectedTargetId(databases[0].id);
    }
  }, [databases, selectedTargetId]);

  const fetchSnapshot = useCallback(
    async (dbId: string, isBackground = false) => {
      if (isBackground) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await api.getLiveMonitor(dbId || undefined);
        if (!mountedRef.current) return;
        setData(res);
        setHistory((prev) => {
          const next = [
            ...prev,
            {
              timestamp: res.collectedAt,
              tps: res.throughput.estimatedTps,
              activeConn: res.throughput.activeConnections,
              cacheHit: res.throughput.cacheHitRatioPct,
            },
          ];
          return next.slice(-24);
        });
      } catch (err) {
        if (!mountedRef.current) return;
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Failed to collect live PostgreSQL telemetry.',
                'တိုက်ရိုက် PostgreSQL အချက်အလက်များကို ရယူ၍ မရပါ။'
              )
        );
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [api, tr]
  );

  useEffect(() => {
    setHistory([]);
    setExpandedPid(null);
    fetchSnapshot(selectedTargetId, false);
  }, [selectedTargetId, fetchSnapshot]);

  useEffect(() => {
    if (refreshSeconds === 0) return;
    const timer = window.setInterval(() => {
      fetchSnapshot(selectedTargetId, true);
    }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refreshSeconds, selectedTargetId, fetchSnapshot]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const filteredSessions = useMemo(() => {
    const list = data?.sessions ?? [];
    const q = sessionSearch.trim().toLowerCase();
    return list.filter((s) => {
      if (sessionFilter === 'active' && s.state !== 'active') return false;
      if (
        sessionFilter === 'idle_tx' &&
        !s.state.startsWith('idle in transaction')
      ) {
        return false;
      }
      if (sessionFilter === 'blocked' && !s.isBlocked) return false;
      if (sessionFilter === 'idle' && s.state !== 'idle') return false;
      if (!q) return true;
      return (
        String(s.pid).includes(q) ||
        s.usename.toLowerCase().includes(q) ||
        s.applicationName.toLowerCase().includes(q) ||
        s.query.toLowerCase().includes(q)
      );
    });
  }, [data?.sessions, sessionFilter, sessionSearch]);

  const filteredSettings = useMemo(() => {
    const list = data?.settingsAudit ?? [];
    if (settingsFilter === 'attention') {
      return list.filter((s) => s.status !== 'OPTIMAL');
    }
    if (settingsFilter === 'optimal') {
      return list.filter((s) => s.status === 'OPTIMAL');
    }
    return list;
  }, [data?.settingsAudit, settingsFilter]);

  const attentionSettingsCount = useMemo(
    () => (data?.settingsAudit ?? []).filter((s) => s.status !== 'OPTIMAL').length,
    [data?.settingsAudit]
  );

  const blockerTreeStats = useMemo(() => {
    const list = data?.sessions ?? [];
    const blockedCount = list.filter(
      (s) => s.isBlocked || (Array.isArray(s.blockingPids) && s.blockingPids.length > 0)
    ).length;
    const longRunningCount = list.filter(
      (s) =>
        s.state !== 'idle' &&
        Math.max(s.durationSeconds, s.xactDurationSeconds ?? 0) >= 5
    ).length;
    return {
      blockedCount,
      longRunningCount,
      badgeCount: Math.max(blockedCount, longRunningCount),
    };
  }, [data?.sessions]);

  const tp = data?.throughput;
  const bg = data?.bgwriter;

  const sparklineCoords = useMemo(() => {
    if (history.length === 0) return { tpsPoints: '', connPoints: '', maxTps: 1, maxConn: 1 };
    const samples =
      history.length === 1 ? [history[0], history[0]] : history;
    const maxTps = Math.max(10, ...samples.map((s) => s.tps));
    const maxConn = Math.max(5, ...samples.map((s) => s.activeConn));
    const w = 520;
    const h = 76;
    const step = w / Math.max(1, samples.length - 1);
    const tpsPoints = samples
      .map((s, i) => {
        const x = i * step;
        const y = h - 8 - ((s.tps / maxTps) * (h - 18));
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const connPoints = samples
      .map((s, i) => {
        const x = i * step;
        const y = h - 8 - ((s.activeConn / maxConn) * (h - 18));
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    return { tpsPoints, connPoints, maxTps, maxConn };
  }, [history]);

  const renderSessionStateLabel = (s: LiveSessionRow) => {
    if (s.isBlocked) {
      return (
        <span className="font-semibold text-red-700 dark:text-red-400">
          {tr('Blocked', 'ပိတ်ဆို့ခံနေရ')}
        </span>
      );
    }
    if (s.state === 'active') {
      return (
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">
          {tr('Active', 'လုပ်ဆောင်နေဆဲ')}
        </span>
      );
    }
    if (s.state.startsWith('idle in transaction')) {
      return (
        <span className="font-semibold text-amber-700 dark:text-amber-400">
          {tr('Idle in Tx', 'Tx အတွင်း ရပ်တန့်')}
        </span>
      );
    }
    return <span className="text-slate-500 dark:text-slate-400">{s.state}</span>;
  };

  const renderSettingStatus = (status: PgSettingAuditRow['status']) => {
    if (status === 'WARNING') {
      return (
        <span className="font-semibold text-red-700 dark:text-red-400">
          {tr('Needs Action', 'ပြင်ဆင်ရန် လိုအပ်')}
        </span>
      );
    }
    if (status === 'ADVISORY') {
      return (
        <span className="font-semibold text-amber-700 dark:text-amber-400">
          {tr('Tuning Advisory', 'ချိန်ညှိ အကြံပြု')}
        </span>
      );
    }
    return (
      <span className="font-semibold text-emerald-700 dark:text-emerald-400">
        {tr('Optimal', 'ကောင်းမွန်')}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Live Polling Controls */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {tr(
              'Live PostgreSQL Operations Monitor',
              'တိုက်ရိုက် PostgreSQL လုပ်ငန်းလည်ပတ်မှု စောင့်ကြည့်ရေး'
            )}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {tr(
              'Real-time TPS, connection pool saturation, active session inspector, checkpoint & BGWriter I/O, XID wraparound safety, and pg_settings tuning audit.',
              'အချိန်နှင့်တစ်ပြေးညီ TPS၊ ချိတ်ဆက်မှု ပမာဏ၊ လုပ်ဆောင်နေဆဲ Session များ၊ Checkpoint/BGWriter I/O၊ XID Wraparound ဘေးကင်းရေးနှင့် pg_settings ချိန်ညှိစစ်ဆေးမှုများ။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span className="whitespace-nowrap">
              {tr('Target', 'ပစ်မှတ်')}
            </span>
            <select
              value={selectedTargetId}
              onChange={(e) => setSelectedTargetId(e.target.value)}
              aria-label={tr('Select PostgreSQL target', 'PostgreSQL ပစ်မှတ် ရွေးချယ်ရန်')}
              className="px-3 py-2 text-xs font-medium text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500 max-w-xs truncate"
            >
              <option value="">
                {tr('Workspace PostgreSQL (Live)', 'လုပ်ငန်းခွင် PostgreSQL (တိုက်ရိုက်)')}
              </option>
              {databases.map((db) => (
                <option key={db.id} value={db.id}>
                  {db.name} ({formatEnv(db.environment)})
                </option>
              ))}
            </select>
          </label>

          <div
            role="group"
            aria-label={tr('Auto-refresh interval', 'အလိုအလျောက် ပြန်စစ်ဆေးချိန်')}
            className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg"
          >
            {([0, 5, 15, 30] as const).map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setRefreshSeconds(sec)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  refreshSeconds === sec
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {sec === 0 ? tr('Paused', 'ရပ်ထား') : `${sec}s`}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={loading || refreshing}
            onClick={() => fetchSnapshot(selectedTargetId, true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading || refreshing ? 'animate-spin' : ''}`}
            />
            <span>{t('action.refresh')}</span>
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-sm text-red-800 dark:text-red-300 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => fetchSnapshot(selectedTargetId, false)}
            className="px-3 py-1 text-xs font-medium text-red-900 dark:text-red-200 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 rounded-md hover:bg-red-100 dark:hover:bg-red-950/70 cursor-pointer"
          >
            {tr('Retry', 'ပြန်စမ်းရန်')}
          </button>
        </div>
      )}

      {/* KPI Summary Strip */}
      {loading && !data ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl grid grid-cols-2 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
          {[0, 1, 2, 3, 4].map((idx) => (
            <div key={idx} className="p-5 space-y-2 animate-pulse">
              <div className="h-3 w-24 bg-slate-200 dark:bg-slate-700 rounded" />
              <div className="h-6 w-20 bg-slate-200 dark:bg-slate-700 rounded" />
              <div className="h-3 w-28 bg-slate-100 dark:bg-slate-800 rounded" />
            </div>
          ))}
        </div>
      ) : (
        tp && (
          <>
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl grid grid-cols-2 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
              <div className="p-5">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {tr('Throughput (TPS)', 'လုပ်ဆောင်နှုန်း (TPS)')}
                </p>
                <p className="mt-1.5 text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                  {tp.estimatedTps.toLocaleString()}{' '}
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">tx/s</span>
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {tr('Rollback', 'ပယ်ဖျက်နှုန်း')} {tp.rollbackRatioPct.toFixed(2)}% ·{' '}
                  {formatCompact(tp.xactCommit)} {tr('commits', 'ပြီးမြောက်')}
                </p>
              </div>

              <div className="p-5">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {tr('Connection Pool', 'ချိတ်ဆက်မှု ပမာဏ')}
                </p>
                <p
                  className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                    tp.connectionUsagePct >= 80
                      ? 'text-red-700 dark:text-red-400'
                      : tp.connectionUsagePct >= 65
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-slate-900 dark:text-slate-100'
                  }`}
                >
                  {tp.totalConnections} / {tp.maxConnections}{' '}
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                    ({tp.connectionUsagePct}%)
                  </span>
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {tp.activeConnections} {tr('active', 'လုပ်ဆောင်')} ·{' '}
                  {tp.idleInTransaction} {tr('idle-in-tx', 'idle-in-tx')} ·{' '}
                  {tp.waitingConnections} {tr('waiting', 'စောင့်ဆိုင်း')}
                </p>
              </div>

              <div className="p-5">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {tr('Buffer Cache Hit', 'Buffer Cache ထိရောက်မှု')}
                </p>
                <p
                  className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                    tp.cacheHitRatioPct < 95
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {tp.cacheHitRatioPct.toFixed(2)}%
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {tp.databaseSizePretty} · {tr('Uptime', 'ဖွင့်ချိန်')}{' '}
                  {formatUptime(tp.uptimeSeconds)}
                </p>
              </div>

              <div className="p-5">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {tr('Temp Spill & Deadlocks', 'Temp Disk နှင့် Deadlock')}
                </p>
                <p
                  className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                    tp.deadlocks > 0 ? 'text-red-700 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'
                  }`}
                >
                  {tp.tempBytesPretty}{' '}
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                    · {tp.deadlocks} {tr('deadlocks', 'deadlock')}
                  </span>
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {tp.tempFiles.toLocaleString()} {tr('temp files spilled', 'temp ဖိုင်')}
                </p>
              </div>

              <div className="p-5">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {tr('XID Wraparound Risk', 'XID Wraparound အန္တရာယ်')}
                </p>
                <p
                  className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                    (data?.databaseXidWraparoundPct ?? 0) >= 40
                      ? 'text-red-700 dark:text-red-400'
                      : (data?.databaseXidWraparoundPct ?? 0) >= 15
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {(data?.databaseXidWraparoundPct ?? 0).toFixed(2)}%
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {tr('Age', 'သက်တမ်း')} {formatCompact(data?.databaseXidAge ?? 0)} / 2.1B
                </p>
              </div>
            </div>

            {/* Live Rolling Telemetry Chart Strip */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Activity className="w-4 h-4 text-blue-700 dark:text-blue-400 shrink-0" />
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {tr('Live Telemetry Stream', 'တိုက်ရိုက် တိုင်းတာမှု စီးဆင်းချက်')}
                  </span>
                  <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-600 dark:text-slate-300">{tp.pgVersion}</span>
                  <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
                  <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                    {tr('Updated', 'နောက်ဆုံးစစ်ချိန်')}{' '}
                    {new Date(data.collectedAt).toLocaleTimeString(
                      locale === 'my' ? 'my-MM' : 'en-US',
                      { hour: '2-digit', minute: '2-digit', second: '2-digit' }
                    )}
                  </span>
                </div>

                <div className="flex items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0.5 bg-blue-700 dark:bg-blue-600 inline-block" />
                    <span>{tr('TPS', 'TPS')}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0.5 bg-emerald-600 inline-block" />
                    <span>{tr('Active Sessions', 'လုပ်ဆောင်နေဆဲ Session')}</span>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-center">
                <div className="lg:col-span-2">
                  <svg
                    viewBox="0 0 520 76"
                    className="w-full h-20 overflow-visible"
                    role="img"
                    aria-label={tr(
                      'Real-time TPS and active session trend',
                      'တိုက်ရိုက် TPS နှင့် လုပ်ဆောင်နေဆဲ Session လမ်းကြောင်း'
                    )}
                  >
                    <line x1="0" y1="18" x2="520" y2="18" className="stroke-slate-200 dark:stroke-slate-800" strokeDasharray="3 3" />
                    <line x1="0" y1="44" x2="520" y2="44" className="stroke-slate-200 dark:stroke-slate-800" strokeDasharray="3 3" />
                    <line x1="0" y1="68" x2="520" y2="68" className="stroke-slate-300 dark:stroke-slate-700" />
                    {sparklineCoords.tpsPoints && (
                      <polyline
                        fill="none"
                        className="stroke-blue-700 dark:stroke-blue-400"
                        strokeWidth="2"
                        strokeLinejoin="round"
                        points={sparklineCoords.tpsPoints}
                      />
                    )}
                    {sparklineCoords.connPoints && (
                      <polyline
                        fill="none"
                        className="stroke-emerald-600 dark:stroke-emerald-400"
                        strokeWidth="2"
                        strokeDasharray="4 2"
                        strokeLinejoin="round"
                        points={sparklineCoords.connPoints}
                      />
                    )}
                  </svg>
                </div>

                {/* Connection Pool Visual Bar */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      {tr('Connection Pool Allocation', 'ချိတ်ဆက်မှု ခွဲဝေမှု')}
                    </span>
                    <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {tp.connectionUsagePct}%
                    </span>
                  </div>
                  <div className="h-2.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex">
                    <div
                      className="bg-emerald-600 h-full"
                      style={{
                        width: `${Math.min(100, (tp.activeConnections / tp.maxConnections) * 100)}%`,
                      }}
                      title={`Active: ${tp.activeConnections}`}
                    />
                    <div
                      className="bg-amber-500 h-full"
                      style={{
                        width: `${Math.min(100, (tp.idleInTransaction / tp.maxConnections) * 100)}%`,
                      }}
                      title={`Idle in Transaction: ${tp.idleInTransaction}`}
                    />
                    <div
                      className="bg-slate-400 h-full"
                      style={{
                        width: `${Math.min(100, (tp.idleConnections / tp.maxConnections) * 100)}%`,
                      }}
                      title={`Idle: ${tp.idleConnections}`}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {tr('Active', 'လုပ်ဆောင်')}: {tp.activeConnections}
                    </span>
                    <span className="text-amber-700 dark:text-amber-400">
                      {tr('Idle-Tx', 'Idle-Tx')}: {tp.idleInTransaction}
                    </span>
                    <span>
                      {tr('Idle', 'အားလပ်')}: {tp.idleConnections}
                    </span>
                    <span>
                      {tr('Free', 'ကျန်')}:{' '}
                      {Math.max(0, tp.maxConnections - tp.totalConnections)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Sub-Navigation Tabs */}
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit max-w-full overflow-x-auto">
              {(
                [
                  {
                    id: 'sessions',
                    label: `${tr('Active Sessions', 'လက်ရှိ Session များ')} (${data.sessions.length})`,
                  },
                  {
                    id: 'blocker-tree',
                    label: `${tr('Long-Running & Blocker Tree', 'ကြာရှည် Query နှင့် ပိတ်ဆို့မှု သစ်ပင်')} (${blockerTreeStats.badgeCount})`,
                  },
                  {
                    id: 'io',
                    label: tr('I/O & Tuple Throughput', 'I/O နှင့် ဒေတာ လုပ်ဆောင်နှုန်း'),
                  },
                  {
                    id: 'checkpoints',
                    label: tr('Checkpoints & BGWriter', 'Checkpoint နှင့် BGWriter'),
                  },
                  {
                    id: 'wraparound',
                    label: `${tr('XID Wraparound & Vacuum', 'XID Wraparound နှင့် Vacuum')} (${data.wraparoundTables.length})`,
                  },
                  {
                    id: 'settings',
                    label: `${tr('Config Tuning (pg_settings)', 'ဆက်တင် ချိန်ညှိမှု')} (${attentionSettingsCount})`,
                  },
                ] as { id: MonitorSubTab; label: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    activeTab === tab.id
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* TAB 1: Active Sessions (pg_stat_activity) */}
            {activeTab === 'sessions' && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
                    {(
                      [
                        { id: 'all', label: tr('All', 'အားလုံး') },
                        { id: 'active', label: tr('Active', 'လုပ်ဆောင်') },
                        { id: 'idle_tx', label: tr('Idle in Tx', 'Idle in Tx') },
                        { id: 'blocked', label: tr('Blocked', 'ပိတ်ဆို့') },
                        { id: 'idle', label: tr('Idle', 'အားလပ်') },
                      ] as { id: SessionFilter; label: string }[]
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSessionFilter(f.id)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          sessionFilter === f.id
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                            : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {blockerTreeStats.blockedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveTab('blocker-tree')}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 bg-red-50/70 dark:bg-red-950/40 border border-red-200 dark:border-red-900/70 hover:bg-red-100/70 dark:hover:bg-red-950/60 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <GitBranch className="w-3.5 h-3.5" />
                        <span>
                          {tr(
                            `View Blocker Tree (${blockerTreeStats.blockedCount} blocked)`,
                            `ပိတ်ဆို့ သစ်ပင်ကြည့်ရန် (${blockerTreeStats.blockedCount} ခု)`
                          )}
                        </span>
                      </button>
                    )}

                    <div className="relative w-full md:w-72">
                      <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="search"
                        value={sessionSearch}
                        onChange={(e) => setSessionSearch(e.target.value)}
                        placeholder={tr(
                          'Filter PID, role, app, or SQL…',
                          'PID၊ role၊ app သို့မဟုတ် SQL ရှာရန်…'
                        )}
                        className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>
                </div>

                {filteredSessions.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                    {tr(
                      'No PostgreSQL sessions match your current filter.',
                      'လက်ရှိ စစ်ထုတ်မှုနှင့် ကိုက်ညီသော PostgreSQL session မရှိပါ။'
                    )}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-medium">
                          <th className="py-2.5 pl-6 pr-3">PID</th>
                          <th className="py-2.5 px-3">{tr('Role & App', 'Role နှင့် App')}</th>
                          <th className="py-2.5 px-3">{tr('State', 'အခြေအနေ')}</th>
                          <th className="py-2.5 px-3">{tr('Wait Event', 'စောင့်ဆိုင်းချက်')}</th>
                          <th className="py-2.5 px-3 text-right">{tr('Duration', 'ကြာချိန်')}</th>
                          <th className="py-2.5 pl-3 pr-6">{tr('Query Preview', 'Query အကျဉ်း')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {filteredSessions.map((s) => {
                          const isExpanded = expandedPid === s.pid;
                          return (
                            <Fragment key={s.pid}>
                              <tr
                                onClick={() =>
                                  setExpandedPid(isExpanded ? null : s.pid)
                                }
                                className="hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer"
                              >
                                <td className="py-3 pl-6 pr-3 font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums whitespace-nowrap">
                                  <span className="inline-flex items-center gap-1">
                                    {isExpanded ? (
                                      <ChevronDown className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                                    ) : (
                                      <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                                    )}
                                    <span>{s.pid}</span>
                                  </span>
                                </td>
                                <td className="py-3 px-3 whitespace-nowrap">
                                  <span className="font-mono text-slate-900 dark:text-slate-100">
                                    {s.usename}
                                  </span>
                                  <span className="text-slate-300 dark:text-slate-700 mx-1.5">·</span>
                                  <span className="text-slate-600 dark:text-slate-300">
                                    {s.applicationName}
                                  </span>
                                </td>
                                <td className="py-3 px-3 whitespace-nowrap">
                                  {renderSessionStateLabel(s)}
                                </td>
                                <td className="py-3 px-3 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                  {s.waitEventType
                                    ? `${s.waitEventType}${s.waitEvent ? ` / ${s.waitEvent}` : ''}`
                                    : 'CPU'}
                                </td>
                                <td
                                  className={`py-3 px-3 text-right font-mono tabular-nums whitespace-nowrap ${
                                    s.durationSeconds >= 30
                                      ? 'font-semibold text-red-700 dark:text-red-400'
                                      : s.durationSeconds >= 5
                                        ? 'font-semibold text-amber-700 dark:text-amber-400'
                                        : 'text-slate-700 dark:text-slate-300'
                                  }`}
                                >
                                  {formatDuration(s.durationSeconds)}
                                </td>
                                <td className="py-3 pl-3 pr-6 font-mono text-slate-700 dark:text-slate-300 max-w-md truncate">
                                  {s.query || '—'}
                                </td>
                              </tr>

                              {isExpanded && (
                                <tr className="bg-slate-50/70 dark:bg-slate-800/60">
                                  <td colSpan={6} className="px-6 py-4 space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
                                      <div className="flex flex-wrap items-center gap-2 font-mono">
                                        <span>Client: {s.clientAddr}</span>
                                        <span className="text-slate-300 dark:text-slate-700">·</span>
                                        <span>
                                          {tr('Xact Start', 'Tx စချိန်')}:{' '}
                                          {s.xactStartIso
                                            ? formatDateTime(s.xactStartIso)
                                            : '—'}
                                        </span>
                                        {Array.isArray(s.blockingPids) &&
                                          s.blockingPids.length > 0 && (
                                            <>
                                              <span className="text-slate-300 dark:text-slate-700">·</span>
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setActiveTab('blocker-tree');
                                                }}
                                                className="text-red-700 dark:text-red-400 hover:underline font-semibold cursor-pointer"
                                              >
                                                {tr('Blocked by PID', 'ပိတ်ဆို့သူ PID')}:{' '}
                                                {s.blockingPids.join(', ')}
                                              </button>
                                            </>
                                          )}
                                      </div>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleCopy(
                                              `cancel-${s.pid}`,
                                              `SELECT pg_cancel_backend(${s.pid});`
                                            );
                                          }}
                                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/70 hover:bg-amber-50 dark:hover:bg-amber-950/50 rounded-md cursor-pointer"
                                        >
                                          {copiedId === `cancel-${s.pid}` ? (
                                            <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                                          ) : (
                                            <Copy className="w-3.5 h-3.5" />
                                          )}
                                          <span>
                                            {tr('Copy Cancel SQL', 'Cancel SQL ကူးရန်')}
                                          </span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleCopy(
                                              `term-${s.pid}`,
                                              `SELECT pg_terminate_backend(${s.pid});`
                                            );
                                          }}
                                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-400 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-md cursor-pointer"
                                        >
                                          {copiedId === `term-${s.pid}` ? (
                                            <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                                          ) : (
                                            <Copy className="w-3.5 h-3.5" />
                                          )}
                                          <span>
                                            {tr('Copy Terminate SQL', 'Terminate SQL ကူးရန်')}
                                          </span>
                                        </button>
                                      </div>
                                    </div>
                                    <pre className="p-3.5 bg-slate-900 dark:bg-slate-950 dark:border dark:border-slate-800 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words leading-relaxed">
                                      {s.query || '-- No query text available'}
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
              </div>
            )}

            {/* TAB 1B: Long-Running Queries & Root Blocker Tree (pg_stat_activity) */}
            {activeTab === 'blocker-tree' && (
              <LongRunningBlockerTree
                sessions={data.sessions}
                targetLabel={data.targetLabel}
                collectedAt={data.collectedAt}
              />
            )}

            {/* TAB 2: I/O & Tuple Throughput */}
            {activeTab === 'io' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(
                        'Tuple DML & Scan Activity (pg_stat_database)',
                        'Tuple DML နှင့် ဖတ်ရှုမှု ပမာဏ (pg_stat_database)'
                      )}
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {tr(
                        'Cumulative row-level reads and writes since statistics reset.',
                        'စာရင်းအင်း ပြန်လည်စတင်ချိန်မှစ၍ စုစုပေါင်း အတန်း ဖတ်ရှု/ရေးသားမှုများ။'
                      )}
                    </p>
                  </div>
                  <div className="space-y-3">
                    {[
                      {
                        label: tr('Rows Returned (Seq/Idx)', 'ပြန်ပေးအတန်း (Returned)'),
                        value: tp.tupReturned,
                        color: 'bg-blue-700 dark:bg-blue-600',
                      },
                      {
                        label: tr('Rows Fetched (Index)', 'Index ဖြင့် ယူအတန်း (Fetched)'),
                        value: tp.tupFetched,
                        color: 'bg-indigo-600',
                      },
                      {
                        label: tr('Rows Inserted', 'အသစ်ထည့်အတန်း (INSERT)'),
                        value: tp.tupInserted,
                        color: 'bg-emerald-600',
                      },
                      {
                        label: tr('Rows Updated', 'ပြင်ဆင်အတန်း (UPDATE)'),
                        value: tp.tupUpdated,
                        color: 'bg-amber-500',
                      },
                      {
                        label: tr('Rows Deleted', 'ဖျက်ပစ်အတန်း (DELETE)'),
                        value: tp.tupDeleted,
                        color: 'bg-red-600',
                      },
                    ].map((metric) => {
                      const maxVal = Math.max(
                        1,
                        tp.tupReturned,
                        tp.tupFetched,
                        tp.tupInserted,
                        tp.tupUpdated,
                        tp.tupDeleted
                      );
                      const pct = Math.max(2, Math.round((metric.value / maxVal) * 100));
                      return (
                        <div key={metric.label} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-700 dark:text-slate-300 font-medium">
                              {metric.label}
                            </span>
                            <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                              {metric.value.toLocaleString()}
                            </span>
                          </div>
                          <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${metric.color}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(
                        'Buffer Pool & Disk I/O Profile',
                        'Buffer Pool နှင့် Disk I/O အခြေအနေ'
                      )}
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {tr(
                        'Shared memory hits vs. physical storage block reads and temporary sort spills.',
                        'Shared memory မှ ဖတ်ရှုမှုနှင့် Disk မှ ဖတ်ရှုမှု၊ ယာယီဖိုင် ရေးသားမှု နှိုင်းယှဉ်ချက်။'
                      )}
                    </p>
                  </div>
                  <dl className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                    {[
                      [
                        tr('Shared Buffer Hits', 'Shared Buffer မှ ဖတ်ရှုမှု'),
                        tp.blksHit.toLocaleString(),
                      ],
                      [
                        tr('Physical Disk Reads', 'Disk မှ တိုက်ရိုက်ဖတ်ရှုမှု'),
                        tp.blksRead.toLocaleString(),
                      ],
                      [
                        tr('Buffer Cache Hit Ratio', 'Buffer Cache ထိရောက်မှုနှုန်း'),
                        `${tp.cacheHitRatioPct.toFixed(2)}%`,
                      ],
                      [
                        tr('Disk Block Read Time', 'Disk ဖတ်ချိန် စုစုပေါင်း'),
                        `${tp.blkReadTimeMs.toLocaleString()} ms`,
                      ],
                      [
                        tr('Disk Block Write Time', 'Disk ရေးချိန် စုစုပေါင်း'),
                        `${tp.blkWriteTimeMs.toLocaleString()} ms`,
                      ],
                      [
                        tr('Temp Files & Spill Volume', 'Temp ဖိုင်နှင့် ပမာဏ'),
                        `${tp.tempFiles.toLocaleString()} files · ${tp.tempBytesPretty}`,
                      ],
                    ].map(([k, v]) => (
                      <div key={k} className="py-2.5 flex items-center justify-between gap-4">
                        <dt className="text-slate-600 dark:text-slate-300">{k}</dt>
                        <dd className="font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            )}

            {/* TAB 3: Checkpoints & BGWriter */}
            {activeTab === 'checkpoints' && bg && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(
                        'Checkpointer & Background Writer Efficiency',
                        'Checkpointer နှင့် Background Writer စွမ်းဆောင်ရည်'
                      )}
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {tr(
                        'High requested checkpoints (>20%) or excessive backend direct writes indicate max_wal_size or shared_buffers tuning is needed.',
                        'Requested checkpoint ၂၀% ကျော်လျှင် သို့မဟုတ် backend တိုက်ရိုက်ရေးသားမှု များလျှင် max_wal_size ကို တိုးမြှင့်ချိန်ညှိသင့်ပါသည်။'
                      )}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-semibold ${
                      bg.requestedCheckpointPct > 20
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {bg.requestedCheckpointPct > 20
                      ? tr(
                          `Elevated Requested Checkpoints (${bg.requestedCheckpointPct}%)`,
                          `Requested Checkpoint မြင့်တက်နေ (${bg.requestedCheckpointPct}%)`
                        )
                      : tr(
                          `Balanced Checkpoint Cadence (${bg.requestedCheckpointPct}% requested)`,
                          `Checkpoint စည်းချက် ကောင်းမွန် (${bg.requestedCheckpointPct}% requested)`
                        )}
                  </span>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 border-t border-slate-200 dark:border-slate-800 pt-5">
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {tr('Scheduled Checkpoints', 'အချိန်ဇယား Checkpoint')}
                    </p>
                    <p className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {bg.checkpointsTimed.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {tr('Requested Checkpoints', 'အရေးပေါ် Checkpoint')}
                    </p>
                    <p
                      className={`mt-1 text-lg font-bold font-mono tabular-nums ${
                        bg.requestedCheckpointPct > 20
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-slate-900 dark:text-slate-100'
                      }`}
                    >
                      {bg.checkpointsReq.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {tr('Checkpoint Write / Sync', 'Checkpoint ရေး / Sync ချိန်')}
                    </p>
                    <p className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {(bg.checkpointWriteTimeMs / 1000).toFixed(1)}s /{' '}
                      {(bg.checkpointSyncTimeMs / 1000).toFixed(1)}s
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {tr('BGWriter Maxwritten Stops', 'BGWriter ရပ်တန့်အကြိမ်')}
                    </p>
                    <p className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {bg.maxwrittenClean.toLocaleString()}
                    </p>
                  </div>
                </div>

                <div className="border-t border-slate-200 dark:border-slate-800 pt-5 space-y-3">
                  <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    {tr('Buffer Write Distribution', 'Buffer ရေးသားမှု ခွဲဝေချက်')}
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                    <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-lg">
                      <p className="text-slate-500 dark:text-slate-400">{tr('Buffers by Checkpoint', 'Checkpoint ရေး Buffer')}</p>
                      <p className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-slate-100 tabular-nums">
                        {bg.buffersCheckpoint.toLocaleString()}
                      </p>
                    </div>
                    <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-lg">
                      <p className="text-slate-500 dark:text-slate-400">{tr('Buffers by BGWriter', 'BGWriter ရေး Buffer')}</p>
                      <p className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-slate-100 tabular-nums">
                        {bg.buffersClean.toLocaleString()}
                      </p>
                    </div>
                    <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-lg">
                      <p className="text-slate-500 dark:text-slate-400">{tr('Direct Backend Writes', 'Backend တိုက်ရိုက်ရေး Buffer')}</p>
                      <p className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-slate-100 tabular-nums">
                        {bg.buffersBackend.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 4: XID Wraparound & Active Autovacuum Progress */}
            {activeTab === 'wraparound' && (
              <div className="space-y-4">
                {data.activeVacuums.length > 0 && (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(
                        'Active Autovacuum / Vacuum Workers (pg_stat_progress_vacuum)',
                        'လုပ်ဆောင်နေဆဲ Autovacuum Worker များ (pg_stat_progress_vacuum)'
                      )}
                    </h2>
                    <div className="space-y-3">
                      {data.activeVacuums.map((v) => (
                        <div key={v.pid} className="space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                              PID {v.pid} · {v.schemaName}.{v.tableName}
                            </span>
                            <span className="font-mono text-slate-600 dark:text-slate-300 tabular-nums">
                              {v.phase} · {v.progressPct.toFixed(1)}% (
                              {v.heapBlksScanned.toLocaleString()} /{' '}
                              {v.heapBlksTotal.toLocaleString()} blks)
                            </span>
                          </div>
                          <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-700 dark:bg-blue-600 rounded-full"
                              style={{ width: `${Math.min(100, v.progressPct)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {tr(
                          'Transaction ID (XID) Wraparound Watchlist',
                          'Transaction ID (XID) Wraparound စောင့်ကြည့်စာရင်း'
                        )}
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {tr(
                          `Tables ordered by age(relfrozenxid) against autovacuum_freeze_max_age (${formatCompact(data.autovacuumFreezeMaxAge)}).`,
                          `autovacuum_freeze_max_age (${formatCompact(data.autovacuumFreezeMaxAge)}) နှင့် နှိုင်းယှဉ်၍ XID သက်တမ်း အကြီးဆုံး ဇယားများ။`
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-medium">
                          <th className="py-2.5 pl-6 pr-3">{tr('Table', 'ဇယား')}</th>
                          <th className="py-2.5 px-3 text-right">{tr('XID Age', 'XID သက်တမ်း')}</th>
                          <th className="py-2.5 px-3 text-right">{tr('% to Freeze', 'Freeze ရာခိုင်နှုန်း')}</th>
                          <th className="py-2.5 px-3 text-right">{tr('% to 2B Limit', '2B ကန့်သတ်ချက် %')}</th>
                          <th className="py-2.5 px-3 text-right">{tr('Dead Tuples', 'Dead Tuples')}</th>
                          <th className="py-2.5 px-3">{tr('Status', 'အခြေအနေ')}</th>
                          <th className="py-2.5 pl-3 pr-6 text-right">{tr('Remediation', 'ပြင်ဆင် SQL')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {data.wraparoundTables.map((row) => (
                          <tr
                            key={`${row.schemaName}.${row.tableName}`}
                            className="hover:bg-slate-50 dark:hover:bg-slate-800/60"
                          >
                            <td className="py-3 pl-6 pr-3 font-mono font-medium text-slate-900 dark:text-slate-100">
                              {row.schemaName}.{row.tableName}
                            </td>
                            <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                              {row.xidAge.toLocaleString()}
                            </td>
                            <td
                              className={`py-3 px-3 text-right font-mono tabular-nums font-semibold ${
                                row.pctTowardFreeze >= 90
                                  ? 'text-red-700 dark:text-red-400'
                                  : row.pctTowardFreeze >= 70
                                    ? 'text-amber-700 dark:text-amber-400'
                                    : 'text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {row.pctTowardFreeze.toFixed(1)}%
                            </td>
                            <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                              {row.pctTowardWraparound.toFixed(2)}%
                            </td>
                            <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                              {row.nDeadTup.toLocaleString()}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap">
                              <span
                                className={`font-semibold ${
                                  row.status === 'CRITICAL'
                                    ? 'text-red-700 dark:text-red-400'
                                    : row.status === 'WARNING'
                                      ? 'text-amber-700 dark:text-amber-400'
                                      : 'text-emerald-700 dark:text-emerald-400'
                                }`}
                              >
                                {row.status}
                              </span>
                            </td>
                            <td className="py-3 pl-3 pr-6 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopy(
                                    `vac-${row.tableName}`,
                                    row.remediationSql
                                  )
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer"
                              >
                                {copiedId === `vac-${row.tableName}` ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                                <span>VACUUM FREEZE</span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 5: PostgreSQL Configuration & Tuning Inspector (pg_settings) */}
            {activeTab === 'settings' && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(
                        'PostgreSQL Configuration Tuning Audit (pg_settings)',
                        'PostgreSQL ဆက်တင် ချိန်ညှိစစ်ဆေးမှု (pg_settings)'
                      )}
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {tr(
                        'Production memory, WAL, timeout, and autovacuum parameters audited against DBA reliability benchmarks.',
                        'Memory၊ WAL၊ timeout နှင့် autovacuum ဆက်တင်များကို DBA စံနှုန်းများနှင့် တိုက်ဆိုင်စစ်ဆေးထားပါသည်။'
                      )}
                    </p>
                  </div>

                  <div className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                    {(
                      [
                        { id: 'all', label: `${tr('All', 'အားလုံး')} (${data.settingsAudit.length})` },
                        {
                          id: 'attention',
                          label: `${tr('Needs Tuning', 'ချိန်ညှိရန်')} (${attentionSettingsCount})`,
                        },
                        {
                          id: 'optimal',
                          label: `${tr('Optimal', 'ကောင်းမွန်')} (${data.settingsAudit.length - attentionSettingsCount})`,
                        },
                      ] as { id: SettingsFilter; label: string }[]
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSettingsFilter(f.id)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          settingsFilter === f.id
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                            : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-medium">
                        <th className="py-2.5 pl-6 pr-3">{tr('Parameter', 'ဆက်တင် အမည်')}</th>
                        <th className="py-2.5 px-3">{tr('Current Value', 'လက်ရှိတန်ဖိုး')}</th>
                        <th className="py-2.5 px-3">{tr('Reload Context', 'သက်ရောက်မှု')}</th>
                        <th className="py-2.5 px-3">{tr('Audit Status', 'အခြေအနေ')}</th>
                        <th className="py-2.5 pl-3 pr-6">{tr('DBA Recommendation', 'DBA အကြံပြုချက်')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {filteredSettings.map((s) => (
                        <tr key={s.name} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                          <td className="py-3 pl-6 pr-3 font-mono font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                            {s.name}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums text-slate-800 dark:text-slate-200 whitespace-nowrap">
                            {s.displayValue}
                          </td>
                          <td className="py-3 px-3 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                            {s.context} · {s.source}
                          </td>
                          <td className="py-3 px-3 whitespace-nowrap">
                            {renderSettingStatus(s.status)}
                          </td>
                          <td className="py-3 pl-3 pr-6 text-slate-600 dark:text-slate-300 space-y-1.5">
                            <p>{s.recommendation ?? tr('Within production best-practice range.', 'လုပ်ငန်းသုံး စံနှုန်းအတွင်း ရှိနေပါသည်။')}</p>
                            {s.tuningSql && (
                              <button
                                type="button"
                                onClick={() => handleCopy(`set-${s.name}`, s.tuningSql!)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/70 hover:bg-blue-100 dark:hover:bg-blue-950/75 rounded cursor-pointer"
                              >
                                {copiedId === `set-${s.name}` ? (
                                  <Check className="w-3 h-3 text-emerald-700 dark:text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                <span>{tr('Copy ALTER SYSTEM SQL', 'ALTER SYSTEM SQL ကူးရန်')}</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
