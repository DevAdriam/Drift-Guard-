import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Eye,
  GitBranch,
  LayoutGrid,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  LiveLockContentionResponse,
  LiveLockEdge,
  MonitoredDatabaseDto,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface LockContentionPanelProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  selectedTargetId: string;
  onTargetChange: (databaseId: string) => void;
}

interface ProcessNodeInfo {
  pid: number;
  user: string;
  app: string;
  state: string;
  statement: string;
  parentPids: number[];
  childPids: number[];
  incomingEdges: LiveLockEdge[];
  outgoingEdges: LiveLockEdge[];
  maxWaitSeconds: number;
  heldModes: string[];
  waitingModes: string[];
  relations: string[];
}

interface LockTreeNode {
  pid: number;
  depth: number;
  edgeFromParent: LiveLockEdge | null;
  info: ProcessNodeInfo;
  children: LockTreeNode[];
  subtreeBlockedCount: number;
  subtreeCumulativeWaitSec: number;
}

const SAMPLE_LOCK_EDGES: LiveLockEdge[] = [
  {
    blocking_pid: 41820,
    blocking_user: 'deploy_migrator',
    blocking_app: 'prisma-migrate',
    blocking_state: 'active',
    blocking_statement:
      "ALTER TABLE public.orders ADD COLUMN tax_jurisdiction VARCHAR(32) NOT NULL DEFAULT 'US';",
    blocked_pid: 41845,
    blocked_user: 'api_service',
    blocked_app: 'checkout-api-pod-2',
    blocked_state: 'active',
    blocked_statement:
      'UPDATE public.orders SET status = $1, updated_at = NOW() WHERE id = $2;',
    lock_type: 'relation',
    held_mode: 'AccessExclusiveLock',
    waiting_mode: 'RowExclusiveLock',
    target_relation: 'public.orders',
    wait_duration_seconds: 38.4,
    wait_duration_display: '00:00:38.4',
  },
  {
    blocking_pid: 41820,
    blocking_user: 'deploy_migrator',
    blocking_app: 'prisma-migrate',
    blocking_state: 'active',
    blocking_statement:
      "ALTER TABLE public.orders ADD COLUMN tax_jurisdiction VARCHAR(32) NOT NULL DEFAULT 'US';",
    blocked_pid: 41902,
    blocked_user: 'api_service',
    blocked_app: 'checkout-api-pod-5',
    blocked_state: 'active',
    blocked_statement:
      'SELECT id, total_cents, status FROM public.orders WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20;',
    lock_type: 'relation',
    held_mode: 'AccessExclusiveLock',
    waiting_mode: 'AccessShareLock',
    target_relation: 'public.orders',
    wait_duration_seconds: 24.9,
    wait_duration_display: '00:00:24.9',
  },
  {
    blocking_pid: 41845,
    blocking_user: 'api_service',
    blocking_app: 'checkout-api-pod-2',
    blocking_state: 'active',
    blocking_statement:
      'UPDATE public.orders SET status = $1, updated_at = NOW() WHERE id = $2;',
    blocked_pid: 41918,
    blocked_user: 'billing_worker',
    blocked_app: 'stripe-sync-worker',
    blocked_state: 'active',
    blocked_statement:
      'SELECT * FROM public.orders WHERE id = $1 FOR UPDATE;',
    lock_type: 'transactionid',
    held_mode: 'ExclusiveLock',
    waiting_mode: 'ShareLock',
    target_relation: 'public.orders',
    wait_duration_seconds: 17.6,
    wait_duration_display: '00:00:17.6',
  },
  {
    blocking_pid: 41845,
    blocking_user: 'api_service',
    blocking_app: 'checkout-api-pod-2',
    blocking_state: 'active',
    blocking_statement:
      'UPDATE public.orders SET status = $1, updated_at = NOW() WHERE id = $2;',
    blocked_pid: 41934,
    blocked_user: 'analytics_ro',
    blocked_app: 'metabase-dashboard',
    blocked_state: 'active',
    blocked_statement:
      'SELECT date_trunc($1, created_at), SUM(total_cents) FROM public.orders GROUP BY 1;',
    lock_type: 'relation',
    held_mode: 'RowExclusiveLock',
    waiting_mode: 'AccessShareLock',
    target_relation: 'public.orders',
    wait_duration_seconds: 9.2,
    wait_duration_display: '00:00:09.2',
  },
  {
    blocking_pid: 42110,
    blocking_user: 'erp_sync',
    blocking_app: 'nightly-ledger-job',
    blocking_state: 'idle in transaction',
    blocking_statement:
      'UPDATE public.invoices SET reconciled = true WHERE batch_id = $1;',
    blocked_pid: 42156,
    blocked_user: 'api_service',
    blocked_app: 'invoice-pdf-worker',
    blocked_state: 'active',
    blocked_statement:
      'UPDATE public.invoices SET pdf_url = $1 WHERE invoice_id = $2;',
    lock_type: 'tuple',
    held_mode: 'ExclusiveLock',
    waiting_mode: 'RowExclusiveLock',
    target_relation: 'public.invoices',
    wait_duration_seconds: 14.1,
    wait_duration_display: '00:00:14.1',
  },
  {
    blocking_pid: 42110,
    blocking_user: 'erp_sync',
    blocking_app: 'nightly-ledger-job',
    blocking_state: 'idle in transaction',
    blocking_statement:
      'UPDATE public.invoices SET reconciled = true WHERE batch_id = $1;',
    blocked_pid: 42179,
    blocked_user: 'api_service',
    blocked_app: 'webhooks-dispatcher',
    blocked_state: 'active',
    blocked_statement:
      'UPDATE public.invoices SET webhook_sent_at = NOW() WHERE invoice_id = $1;',
    lock_type: 'tuple',
    held_mode: 'ExclusiveLock',
    waiting_mode: 'RowExclusiveLock',
    target_relation: 'public.invoices',
    wait_duration_seconds: 4.8,
    wait_duration_display: '00:00:04.8',
  },
];

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0s';
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const rem = (seconds % 60).toFixed(1);
    return `${mins}m ${rem}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function getWaitSeverity(
  seconds: number,
  tr: (en: string, my: string) => string
): {
  label: string;
  textClass: string;
  tileClass: string;
} {
  if (seconds >= 15) {
    return {
      label: tr('Critical', 'အရေးကြီး'),
      textClass: 'text-red-700',
      tileClass: 'bg-red-50/75 border-red-200 hover:bg-red-50',
    };
  }
  if (seconds >= 5) {
    return {
      label: tr('Elevated', 'မြင့်တက်နေသည်'),
      textClass: 'text-amber-700',
      tileClass: 'bg-amber-50/75 border-amber-200 hover:bg-amber-50',
    };
  }
  return {
    label: tr('Waiting', 'စောင့်ဆိုင်းနေသည်'),
    textClass: 'text-blue-700',
    tileClass: 'bg-blue-50/60 border-blue-200 hover:bg-blue-50',
  };
}

function buildContentionHierarchy(edges: LiveLockEdge[]): {
  nodesByPid: Map<number, ProcessNodeInfo>;
  roots: LockTreeNode[];
  maxDepth: number;
  totalBlocked: number;
  maxWaitSeconds: number;
} {
  const nodesByPid = new Map<number, ProcessNodeInfo>();

  const ensureNode = (
    pid: number,
    user: string,
    app: string,
    state: string,
    statement: string
  ): ProcessNodeInfo => {
    let existing = nodesByPid.get(pid);
    if (!existing) {
      existing = {
        pid,
        user,
        app,
        state,
        statement,
        parentPids: [],
        childPids: [],
        incomingEdges: [],
        outgoingEdges: [],
        maxWaitSeconds: 0,
        heldModes: [],
        waitingModes: [],
        relations: [],
      };
      nodesByPid.set(pid, existing);
    }
    return existing;
  };

  for (const edge of edges) {
    const blocker = ensureNode(
      edge.blocking_pid,
      edge.blocking_user,
      edge.blocking_app,
      edge.blocking_state,
      edge.blocking_statement
    );
    const blocked = ensureNode(
      edge.blocked_pid,
      edge.blocked_user,
      edge.blocked_app,
      edge.blocked_state,
      edge.blocked_statement
    );

    if (!blocker.childPids.includes(edge.blocked_pid)) {
      blocker.childPids.push(edge.blocked_pid);
    }
    blocker.outgoingEdges.push(edge);
    if (!blocker.heldModes.includes(edge.held_mode)) {
      blocker.heldModes.push(edge.held_mode);
    }
    if (!blocker.relations.includes(edge.target_relation)) {
      blocker.relations.push(edge.target_relation);
    }

    if (!blocked.parentPids.includes(edge.blocking_pid)) {
      blocked.parentPids.push(edge.blocking_pid);
    }
    blocked.incomingEdges.push(edge);
    blocked.maxWaitSeconds = Math.max(
      blocked.maxWaitSeconds,
      edge.wait_duration_seconds
    );
    if (!blocked.waitingModes.includes(edge.waiting_mode)) {
      blocked.waitingModes.push(edge.waiting_mode);
    }
    if (!blocked.relations.includes(edge.target_relation)) {
      blocked.relations.push(edge.target_relation);
    }
  }

  let rootPids = Array.from(nodesByPid.values())
    .filter((n) => n.outgoingEdges.length > 0 && n.incomingEdges.length === 0)
    .map((n) => n.pid);

  if (rootPids.length === 0 && nodesByPid.size > 0) {
    const topBlocker = Array.from(nodesByPid.values()).sort(
      (a, b) => b.outgoingEdges.length - a.outgoingEdges.length
    )[0];
    if (topBlocker) rootPids = [topBlocker.pid];
  }

  let maxDepth = 0;

  const buildNode = (
    pid: number,
    depth: number,
    edgeFromParent: LiveLockEdge | null,
    ancestors: Set<number>
  ): LockTreeNode => {
    maxDepth = Math.max(maxDepth, depth);
    const info = nodesByPid.get(pid)!;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(pid);

    const children: LockTreeNode[] = [];
    const seenChild = new Set<number>();

    const sortedOutgoing = [...info.outgoingEdges].sort(
      (a, b) => b.wait_duration_seconds - a.wait_duration_seconds
    );

    for (const edge of sortedOutgoing) {
      if (
        nextAncestors.has(edge.blocked_pid) ||
        seenChild.has(edge.blocked_pid)
      ) {
        continue;
      }
      seenChild.add(edge.blocked_pid);
      children.push(buildNode(edge.blocked_pid, depth + 1, edge, nextAncestors));
    }

    const subtreeBlockedCount = children.reduce(
      (sum, child) => sum + 1 + child.subtreeBlockedCount,
      0
    );
    const subtreeCumulativeWaitSec = children.reduce(
      (sum, child) =>
        sum +
        (child.edgeFromParent?.wait_duration_seconds ?? 0) +
        child.subtreeCumulativeWaitSec,
      0
    );

    return {
      pid,
      depth,
      edgeFromParent,
      info,
      children,
      subtreeBlockedCount,
      subtreeCumulativeWaitSec,
    };
  };

  const roots = rootPids
    .map((pid) => buildNode(pid, 0, null, new Set()))
    .sort((a, b) => b.subtreeCumulativeWaitSec - a.subtreeCumulativeWaitSec);

  const totalBlocked = Array.from(nodesByPid.values()).filter(
    (n) => n.incomingEdges.length > 0
  ).length;

  const maxWaitSeconds = edges.reduce(
    (max, e) => Math.max(max, e.wait_duration_seconds),
    0
  );

  return { nodesByPid, roots, maxDepth, totalBlocked, maxWaitSeconds };
}

function flattenSubtreeWaiters(root: LockTreeNode): LockTreeNode[] {
  const result: LockTreeNode[] = [];
  const walk = (node: LockTreeNode) => {
    for (const child of node.children) {
      result.push(child);
      walk(child);
    }
  };
  walk(root);
  return result.sort(
    (a, b) =>
      (b.edgeFromParent?.wait_duration_seconds ?? 0) -
      (a.edgeFromParent?.wait_duration_seconds ?? 0)
  );
}

export function LockContentionPanel({
  api,
  databases,
  selectedTargetId,
  onTargetChange,
}: LockContentionPanelProps) {
  const { locale, t, tr, formatEnv } = useI18n();

  const [liveData, setLiveData] = useState<LiveLockContentionResponse | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<'hierarchy' | 'treemap'>(
    'hierarchy'
  );
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [previewSample, setPreviewSample] = useState(false);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchLocks = useCallback(
    async (dbId: string, silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res = await api.getLiveLockContention(dbId || undefined);
        setLiveData(res);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Unable to inspect live PostgreSQL lock contention.',
                'တိုက်ရိုက် PostgreSQL Lock ပိတ်ဆို့မှုကို စစ်ဆေး၍ မရပါ။'
              )
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, tr]
  );

  useEffect(() => {
    setPreviewSample(false);
    setSelectedPid(null);
    fetchLocks(selectedTargetId);
  }, [selectedTargetId, fetchLocks]);

  useEffect(() => {
    if (!autoRefresh || previewSample) return;
    const timer = window.setInterval(() => {
      fetchLocks(selectedTargetId, true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, previewSample, selectedTargetId, fetchLocks]);

  const activeEdges = previewSample
    ? SAMPLE_LOCK_EDGES
    : (liveData?.edges ?? []);

  const hierarchy = useMemo(
    () => buildContentionHierarchy(activeEdges),
    [activeEdges]
  );

  useEffect(() => {
    if (hierarchy.roots.length === 0) {
      setSelectedPid(null);
      return;
    }
    if (selectedPid === null || !hierarchy.nodesByPid.has(selectedPid)) {
      setSelectedPid(hierarchy.roots[0].pid);
    }
  }, [hierarchy, selectedPid]);

  const selectedNode =
    selectedPid !== null ? hierarchy.nodesByPid.get(selectedPid) ?? null : null;

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const totalCumulativeWait = hierarchy.roots.reduce(
    (sum, r) => sum + r.subtreeCumulativeWaitSec,
    0
  );

  return (
    <section
      aria-labelledby="lock-contention-heading"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
    >
      {/* Header Bar */}
      <div className="px-6 py-5 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="lock-contention-heading"
              className="text-base font-semibold text-slate-900"
            >
              {tr(
                'Real-Time Lock Contention',
                'အချိန်နှင့်တစ်ပြေးညီ Lock ပိတ်ဆို့မှု'
              )}
            </h2>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500">
              pg_locks &amp; pg_stat_activity
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {tr(
              'Visualizes blocking-to-blocked PostgreSQL process ID (PID) chains so you can pinpoint the root blocker causing downstream query queues.',
              'ပိတ်ဆို့နေသော PID မှ ပိတ်ဆို့ခံ PID အဆင့်ဆင့် ကွင်းဆက်ကို ပုံဖော်ပြသပေးပြီး query များ တန်းစီစောင့်ဆိုင်းရခြင်း၏ အဓိက အကြောင်းရင်းကို ချက်ချင်းရှာဖွေနိုင်ပါသည်။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {/* Layout Segmented Switcher */}
          <div
            className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
            role="group"
            aria-label={tr(
              'Lock contention layout mode',
              'Lock ပိတ်ဆို့မှု ပြသပုံစံ'
            )}
          >
            <button
              type="button"
              onClick={() => setLayoutMode('hierarchy')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                layoutMode === 'hierarchy'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" />
              <span>{tr('Hierarchy Tree', 'အဆင့်ဆင့် သစ်ပင်ပုံ')}</span>
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode('treemap')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                layoutMode === 'treemap'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>{tr('Tree-Map', 'အချိုးကျ ဇယားကွက်')}</span>
            </button>
          </div>

          <select
            value={selectedTargetId}
            onChange={(e) => onTargetChange(e.target.value)}
            aria-label={tr(
              'Select PostgreSQL target for lock contention',
              'Lock ပိတ်ဆို့မှု စစ်ဆေးရန် PostgreSQL ပစ်မှတ် ရွေးချယ်ရန်'
            )}
            className="px-3 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 max-w-[210px] truncate"
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

          <button
            type="button"
            onClick={() => {
              if (previewSample) setPreviewSample(false);
              setAutoRefresh((prev) => !prev);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              autoRefresh && !previewSample
                ? 'bg-blue-700 text-white border-blue-700 hover:bg-blue-800'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {autoRefresh && !previewSample ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>{tr('Live (5s)', 'တိုက်ရိုက် (၅ စက္ကန့်)')}</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>{tr('Auto-Refresh', 'အလိုအလျောက် စစ်ဆေးရန်')}</span>
              </>
            )}
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setPreviewSample(false);
              fetchLocks(selectedTargetId);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            <span>{t('action.refresh')}</span>
          </button>
        </div>
      </div>

      {/* Simulated Preview Banner */}
      {previewSample && (
        <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-900">
          <span>
            {locale === 'my' ? (
              <>
                <code className="font-mono">public.orders</code> နှင့်{' '}
                <code className="font-mono">public.invoices</code> တွင် PID ၇ ခုပါဝင်သော
                အဆင့် ၃ ဆင့် Lock ပိတ်ဆို့မှု နမူနာကို ပြသထားပါသည်။ လက်ရှိ
                တိုက်ရိုက် ဒေတာဘေ့စ်တွင် ပိတ်ဆို့နေသော Lock မရှိပါ။
              </>
            ) : (
              <>
                Showing a sample 3-level lock contention scenario (7 PIDs across{' '}
                <code className="font-mono">public.orders</code> and{' '}
                <code className="font-mono">public.invoices</code>). No active
                blocking locks were present on your live target.
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              setPreviewSample(false);
              fetchLocks(selectedTargetId);
            }}
            className="px-3 py-1.5 text-xs font-medium text-amber-950 bg-white border border-amber-300 hover:bg-amber-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            {tr('Return to Live Telemetry', 'တိုက်ရိုက် ဒေတာသို့ ပြန်သွားရန်')}
          </button>
        </div>
      )}

      {/* Summary KPI Strip */}
      {!loading && !error && (
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/50">
          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Root Blockers', 'အဓိက ပိတ်ဆို့သူများ')}
            </p>
            <p
              className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                hierarchy.roots.length > 0 ? 'text-red-700' : 'text-slate-900'
              }`}
            >
              {hierarchy.roots.length}
            </p>
            <p className="text-xs text-slate-500 mt-0.5 truncate">
              {previewSample
                ? tr('Sample Contention Preview', 'နမူနာ Lock ပိတ်ဆို့မှု')
                : (liveData?.targetLabel ??
                  tr('Workspace PostgreSQL', 'လုပ်ငန်းခွင် PostgreSQL'))}
            </p>
          </div>

          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Blocked Processes', 'ပိတ်ဆို့ခံ Process များ')}
            </p>
            <p
              className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                hierarchy.totalBlocked > 0
                  ? 'text-amber-700'
                  : 'text-slate-900'
              }`}
            >
              {hierarchy.totalBlocked}
            </p>
            <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
              {locale === 'my'
                ? `လက်ရှိ Lock ဆက်စပ်မှု ${activeEdges.length} ခု`
                : `${activeEdges.length} active lock edge${activeEdges.length === 1 ? '' : 's'}`}
            </p>
          </div>

          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Longest Wait', 'အကြာဆုံး စောင့်ဆိုင်းချိန်')}
            </p>
            <p
              className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                hierarchy.maxWaitSeconds >= 15
                  ? 'text-red-700'
                  : hierarchy.maxWaitSeconds >= 5
                    ? 'text-amber-700'
                    : 'text-slate-900'
              }`}
            >
              {hierarchy.totalBlocked > 0
                ? formatDuration(hierarchy.maxWaitSeconds)
                : '0.0s'}
            </p>
            <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
              {locale === 'my'
                ? `စုစုပေါင်း စောင့်ဆိုင်းချိန် ${formatDuration(totalCumulativeWait)}`
                : `${formatDuration(totalCumulativeWait)} cumulative wait`}
            </p>
          </div>

          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Max Chain Depth', 'အများဆုံး ကွင်းဆက် အနက်')}
            </p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {hierarchy.roots.length > 0 ? hierarchy.maxDepth : 0}
            </p>
            <p className="text-xs text-slate-500 tabular-nums mt-0.5">
              {liveData?.collectedAt
                ? `${tr('Updated', 'နောက်ဆုံး စစ်ဆေးချိန်')} ${new Date(
                    liveData.collectedAt
                  ).toLocaleTimeString(locale === 'my' ? 'my-MM' : 'en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}`
                : tr('Ready', 'အသင့်ရှိသည်')}
            </p>
          </div>
        </div>
      )}

      {/* Body States */}
      {loading ? (
        <div className="p-6 space-y-3 animate-pulse">
          <div className="h-16 bg-slate-100 rounded-lg" />
          <div className="ml-8 h-14 bg-slate-100 rounded-lg" />
          <div className="ml-16 h-14 bg-slate-100 rounded-lg" />
        </div>
      ) : error ? (
        <div className="p-6">
          <div
            role="alert"
            className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => fetchLocks(selectedTargetId)}
              className="px-3 py-1.5 text-xs font-medium text-red-900 bg-white border border-red-200 hover:bg-red-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              {tr('Retry Inspection', 'ပြန်လည်စစ်ဆေးရန်')}
            </button>
          </div>
        </div>
      ) : !previewSample && liveData?.permissionWarning ? (
        <div className="p-6">
          <div className="px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900">
            {liveData.permissionWarning}
          </div>
        </div>
      ) : hierarchy.roots.length === 0 ? (
        <div className="p-10 text-center space-y-4">
          <div className="space-y-1 max-w-md mx-auto">
            <p className="text-sm font-semibold text-slate-900">
              {tr(
                'No active lock contention detected',
                'လက်ရှိ Lock ပိတ်ဆို့မှု မတွေ့ရှိပါ'
              )}
            </p>
            <p className="text-xs text-slate-500">
              {locale === 'my' ? (
                <>
                  <span className="font-medium text-slate-700">
                    {liveData?.targetLabel ?? 'ဤဒေတာဘေ့စ်'}
                  </span>{' '}
                  ရှိ session အားလုံးသည်{' '}
                  <code className="font-mono">pg_locks</code> တွင် စောင့်ဆိုင်းမှုမရှိဘဲ
                  ချောမွေ့စွာ လုပ်ဆောင်နေပါသည်။ အလိုအလျောက် စစ်ဆေးမှု ဖွင့်ထားနိုင်သည်
                  သို့မဟုတ် နမူနာ PID ကွင်းဆက်ကို ကြည့်ရှုနိုင်ပါသည်။
                </>
              ) : (
                <>
                  All sessions on{' '}
                  <span className="font-medium text-slate-700">
                    {liveData?.targetLabel ?? 'this database'}
                  </span>{' '}
                  are running cleanly with zero waiting lock edges in{' '}
                  <code className="font-mono">pg_locks</code>. Enable
                  Auto-Refresh to watch live deployments, or preview the
                  contention tree layout with sample PID chains.
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setPreviewSample(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>
                {tr('Preview Sample Lock Tree', 'နမူနာ Lock ပုံစံ ကြည့်ရန်')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setAutoRefresh(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>
                {tr('Watch Live (5s Polling)', 'တိုက်ရိုက် စောင့်ကြည့်ရန် (၅ စက္ကန့်)')}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
          {/* Visualization Canvas (8 cols) */}
          <div className="lg:col-span-8 p-6 space-y-5">
            {layoutMode === 'hierarchy' ? (
              <div className="space-y-6">
                {hierarchy.roots.map((root) => (
                  <HierarchyTreeBranch
                    key={root.pid}
                    node={root}
                    selectedPid={selectedPid}
                    onSelectPid={setSelectedPid}
                  />
                ))}
              </div>
            ) : (
              <ContentionTreeMap
                roots={hierarchy.roots}
                selectedPid={selectedPid}
                onSelectPid={setSelectedPid}
              />
            )}
          </div>

          {/* Process Relationship Inspector (4 cols) */}
          <div className="lg:col-span-4 p-6 bg-slate-50/40 space-y-5">
            {selectedNode ? (
              <>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-500">
                      {tr('Process Inspector', 'Process အသေးစိတ် စစ်ဆေးမှု')}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        selectedNode.incomingEdges.length === 0
                          ? 'text-red-700'
                          : selectedNode.outgoingEdges.length > 0
                            ? 'text-amber-700'
                            : 'text-blue-700'
                      }`}
                    >
                      {selectedNode.incomingEdges.length === 0
                        ? tr('Root Blocker', 'အဓိက ပိတ်ဆို့သူ')
                        : selectedNode.outgoingEdges.length > 0
                          ? tr('Transitive Blocker', 'တစ်ဆင့်ခံ ပိတ်ဆို့သူ')
                          : tr('Blocked Waiter', 'စောင့်ဆိုင်းနေသော Session')}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold font-mono tabular-nums text-slate-900">
                    PID {selectedNode.pid}
                  </h3>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    <span className="font-mono text-slate-700">
                      {selectedNode.user}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{selectedNode.state}</span>
                    {selectedNode.app && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono truncate max-w-[160px]">
                          {selectedNode.app}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Upstream / Downstream PID Relationships */}
                <div className="space-y-3 pt-3 border-t border-slate-200 text-xs">
                  <div>
                    <p className="font-medium text-slate-500 mb-1.5">
                      {tr('Blocked By (Upstream)', 'ပိတ်ဆို့ထားသော အထက် PID')}
                    </p>
                    {selectedNode.parentPids.length === 0 ? (
                      <p className="text-slate-700">
                        {tr(
                          'None — root cause of blocking chain',
                          'မရှိပါ — ပိတ်ဆို့မှု ကွင်းဆက်၏ အဓိက အရင်းအမြစ် ဖြစ်သည်'
                        )}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedNode.parentPids.map((parentPid) => (
                          <button
                            key={parentPid}
                            type="button"
                            onClick={() => setSelectedPid(parentPid)}
                            className="px-2.5 py-1 font-mono font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-md cursor-pointer tabular-nums"
                          >
                            PID {parentPid}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="font-medium text-slate-500 mb-1.5">
                      {tr(
                        'Directly Blocking (Downstream)',
                        'တိုက်ရိုက် ပိတ်ဆို့ခံနေရသော PID များ'
                      )}
                    </p>
                    {selectedNode.childPids.length === 0 ? (
                      <p className="text-slate-600">
                        {tr(
                          'No downstream sessions waiting on this PID',
                          'ဤ PID ကို စောင့်ဆိုင်းနေသော အခြား session မရှိပါ'
                        )}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedNode.childPids.map((childPid) => (
                          <button
                            key={childPid}
                            type="button"
                            onClick={() => setSelectedPid(childPid)}
                            className="px-2.5 py-1 font-mono font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-md cursor-pointer tabular-nums"
                          >
                            PID {childPid}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Lock Metadata */}
                <dl className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-200 text-xs">
                  <div>
                    <dt className="text-slate-500">
                      {tr('Target Relation', 'သက်ဆိုင်ရာ ဇယား')}
                    </dt>
                    <dd className="font-mono text-slate-900 mt-0.5 break-all">
                      {selectedNode.relations.join(', ') || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">
                      {tr('Wait Duration', 'စောင့်ဆိုင်းချိန်')}
                    </dt>
                    <dd className="font-mono font-semibold tabular-nums text-slate-900 mt-0.5">
                      {selectedNode.maxWaitSeconds > 0
                        ? formatDuration(selectedNode.maxWaitSeconds)
                        : tr('Holding Lock', 'Lock ထိန်းထားသည်')}
                    </dd>
                  </div>
                  {selectedNode.heldModes.length > 0 && (
                    <div className="col-span-2">
                      <dt className="text-slate-500">
                        {tr('Held Lock Mode', 'ထိန်းထားသော Lock အမျိုးအစား')}
                      </dt>
                      <dd className="font-mono text-red-700 mt-0.5">
                        {selectedNode.heldModes.join(', ')}
                      </dd>
                    </div>
                  )}
                  {selectedNode.waitingModes.length > 0 && (
                    <div className="col-span-2">
                      <dt className="text-slate-500">
                        {tr(
                          'Waiting For Lock Mode',
                          'စောင့်ဆိုင်းနေသော Lock အမျိုးအစား'
                        )}
                      </dt>
                      <dd className="font-mono text-amber-700 mt-0.5">
                        {selectedNode.waitingModes.join(', ')}
                      </dd>
                    </div>
                  )}
                </dl>

                {/* Redacted Statement */}
                <div className="space-y-1.5 pt-3 border-t border-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">
                      {tr(
                        'Redacted SQL Statement',
                        'ဖုံးအုပ်ထားသော SQL စာသား'
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          `stmt-${selectedNode.pid}`,
                          selectedNode.statement
                        )
                      }
                      className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                      {copiedId === `stmt-${selectedNode.pid}` ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-600" />
                          <span>{t('action.copied')}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>{t('action.copy')}</span>
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words leading-relaxed">
                    {selectedNode.statement}
                  </pre>
                </div>

                {/* Remediation Commands */}
                <div className="space-y-2 pt-3 border-t border-slate-200">
                  <p className="text-xs font-medium text-slate-500">
                    {tr('Safe Remediation Commands', 'ဘေးကင်း ဖြေရှင်းရေး အမိန့်များ')}
                  </p>
                  <RemediationSqlRow
                    id={`cancel-${selectedNode.pid}`}
                    label={tr('Cancel active query', 'လက်ရှိ query ကို ရပ်ဆိုင်းရန်')}
                    sql={`SELECT pg_cancel_backend(${selectedNode.pid});`}
                    copied={copiedId === `cancel-${selectedNode.pid}`}
                    onCopy={handleCopy}
                    copyLabel={t('action.copy')}
                    copiedLabel={t('action.copied')}
                  />
                  <RemediationSqlRow
                    id={`term-${selectedNode.pid}`}
                    label={tr(
                      'Terminate blocking session',
                      'ပိတ်ဆို့နေသော session ကို ပိတ်သိမ်းရန်'
                    )}
                    sql={`SELECT pg_terminate_backend(${selectedNode.pid});`}
                    copied={copiedId === `term-${selectedNode.pid}`}
                    onCopy={handleCopy}
                    copyLabel={t('action.copy')}
                    copiedLabel={t('action.copied')}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-500">
                {tr(
                  'Select any PID in the hierarchy or tree-map to inspect its blocking relationships and remediation SQL.',
                  'ပိတ်ဆို့မှု ဆက်စပ်ချက်နှင့် ဖြေရှင်းရေး SQL ကြည့်ရှုရန် အဆင့်ဆင့် သစ်ပင်ပုံ သို့မဟုတ် ဇယားကွက်ရှိ PID တစ်ခုခုကို ရွေးချယ်ပါ။'
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function HierarchyTreeBranch({
  node,
  selectedPid,
  onSelectPid,
}: {
  node: LockTreeNode;
  selectedPid: number | null;
  onSelectPid: (pid: number) => void;
}) {
  const { locale, tr } = useI18n();
  const isRoot = node.depth === 0;
  const isTransitive = !isRoot && node.children.length > 0;
  const isSelected = selectedPid === node.pid;
  const waitSec = node.edgeFromParent?.wait_duration_seconds ?? 0;
  const waitSeverity = getWaitSeverity(waitSec, tr);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onSelectPid(node.pid)}
        className={`w-full text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
          isSelected
            ? 'border-blue-700 bg-blue-50/40 ring-1 ring-blue-700'
            : isRoot
              ? 'border-red-200 bg-red-50/40 hover:bg-red-50/70'
              : 'border-slate-200 bg-white hover:bg-slate-50'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
              PID {node.pid}
            </span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span
              className={`text-xs font-semibold ${
                isRoot
                  ? 'text-red-700'
                  : isTransitive
                    ? 'text-amber-700'
                    : waitSeverity.textClass
              }`}
            >
              {isRoot
                ? tr('Root Blocker', 'အဓိက ပိတ်ဆို့သူ')
                : isTransitive
                  ? tr('Transitive Blocker', 'တစ်ဆင့်ခံ ပိတ်ဆို့သူ')
                  : `${tr('Blocked', 'ပိတ်ဆို့ခံ')} (${waitSeverity.label})`}
            </span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-600">
              {node.info.user}
            </span>
            {node.edgeFromParent && (
              <>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="text-xs font-mono text-slate-500 tabular-nums">
                  {locale === 'my'
                    ? `PID ${node.edgeFromParent.blocking_pid} မှ ပိတ်ဆို့ထား`
                    : `blocked by PID ${node.edgeFromParent.blocking_pid}`}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs font-mono tabular-nums whitespace-nowrap">
            {isRoot ? (
              <span className="font-semibold text-red-700">
                {locale === 'my'
                  ? `PID ${node.subtreeBlockedCount} ခုကို ပိတ်ဆို့နေ`
                  : `Blocking ${node.subtreeBlockedCount} PID${node.subtreeBlockedCount === 1 ? '' : 's'}`}
              </span>
            ) : (
              <span className={`font-semibold ${waitSeverity.textClass}`}>
                {tr('Waiting', 'စောင့်ဆိုင်းချိန်')} {formatDuration(waitSec)}
              </span>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono">
          <span>
            {isRoot
              ? `${tr('Holds', 'ထိန်းထား')} ${node.info.heldModes[0] ?? 'Lock'}`
              : `${tr('Needs', 'လိုအပ်')} ${node.edgeFromParent?.waiting_mode ?? 'Lock'}`}
          </span>
          <span aria-hidden="true">·</span>
          <span className="text-slate-700">
            {node.edgeFromParent?.target_relation ??
              node.info.relations[0] ??
              'relation'}
          </span>
          {node.info.state === 'idle in transaction' && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-700 font-sans font-semibold">
                idle in transaction
              </span>
            </>
          )}
        </div>

        <p className="mt-2 text-xs font-mono text-slate-600 truncate">
          {node.info.statement}
        </p>
      </button>

      {node.children.length > 0 && (
        <div className="ml-4 pl-5 border-l border-slate-200 space-y-2.5">
          {node.children.map((child) => (
            <div key={child.pid} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-5 top-6 w-5 h-px bg-slate-200"
              />
              <HierarchyTreeBranch
                node={child}
                selectedPid={selectedPid}
                onSelectPid={onSelectPid}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContentionTreeMap({
  roots,
  selectedPid,
  onSelectPid,
}: {
  roots: LockTreeNode[];
  selectedPid: number | null;
  onSelectPid: (pid: number) => void;
}) {
  const { locale, tr } = useI18n();
  const totalWeight = roots.reduce(
    (sum, r) => sum + Math.max(1, r.subtreeCumulativeWaitSec),
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {tr(
            "Regions represent root blockers; nested tile area scales proportionally with each blocked PID's wait duration.",
            'အကွက်ကြီးများသည် အဓိက ပိတ်ဆို့သူများဖြစ်ပြီး အတွင်းရှိ အကွက်အရွယ်အစားသည် ပိတ်ဆို့ခံ PID တစ်ခုချင်းစီ၏ စောင့်ဆိုင်းချိန်အလိုက် အချိုးကျ ဖော်ပြထားပါသည်။'
          )}
        </span>
        <div className="flex flex-wrap items-center gap-3 font-medium">
          <span className="text-red-700">
            {tr('Critical (≥15s)', 'အရေးကြီး (≥15s)')}
          </span>
          <span className="text-amber-700">
            {tr('Elevated (5–15s)', 'မြင့်တက် (5–15s)')}
          </span>
          <span className="text-blue-700">
            {tr('Waiting (<5s)', 'စောင့်ဆိုင်း (<5s)')}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {roots.map((root) => {
          const rootWeight = Math.max(1, root.subtreeCumulativeWaitSec);
          const rootSharePct = Math.round((rootWeight / totalWeight) * 100);
          const waiters = flattenSubtreeWaiters(root);
          const maxChildWait = Math.max(
            1,
            ...waiters.map((w) => w.edgeFromParent?.wait_duration_seconds ?? 1)
          );
          const isRootSelected = selectedPid === root.pid;

          return (
            <div
              key={root.pid}
              className="rounded-xl border border-slate-300 bg-slate-50 overflow-hidden"
            >
              {/* Root Blocker Header Region */}
              <button
                type="button"
                onClick={() => onSelectPid(root.pid)}
                className={`w-full text-left px-4 py-3 border-b border-slate-200 transition-colors cursor-pointer ${
                  isRootSelected
                    ? 'bg-blue-50/70'
                    : 'bg-white hover:bg-slate-50'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                      PID {root.pid}
                    </span>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-xs font-semibold text-red-700">
                      {tr('Root Blocker', 'အဓိက ပိတ်ဆို့သူ')}
                    </span>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-xs font-mono text-slate-600">
                      {root.info.heldModes[0] ?? 'Lock'} ·{' '}
                      {root.info.relations[0] ?? 'relation'}
                    </span>
                  </div>
                  <span className="text-xs font-mono font-semibold text-slate-700 tabular-nums whitespace-nowrap">
                    {locale === 'my'
                      ? `ပိတ်ဆို့ခံ ${root.subtreeBlockedCount} ခု · စုစုပေါင်း ${formatDuration(root.subtreeCumulativeWaitSec)} (${rootSharePct}% သက်ရောက်မှု)`
                      : `${root.subtreeBlockedCount} blocked · ${formatDuration(root.subtreeCumulativeWaitSec)} total (${rootSharePct}% impact)`}
                  </span>
                </div>
                <p className="mt-1 text-xs font-mono text-slate-500 truncate">
                  {root.info.statement}
                </p>
              </button>

              {/* Nested Proportional Blocked PID Tiles */}
              <div className="p-3 flex flex-wrap gap-2.5">
                {waiters.map((waiter) => {
                  const waitSec =
                    waiter.edgeFromParent?.wait_duration_seconds ?? 0;
                  const ratio = Math.max(0.28, waitSec / maxChildWait);
                  const basisPct = Math.max(
                    26,
                    Math.min(100, Math.round(ratio * 58))
                  );
                  const minHeightPx = Math.round(92 + ratio * 54);
                  const sev = getWaitSeverity(waitSec, tr);
                  const isSelected = selectedPid === waiter.pid;

                  return (
                    <button
                      key={waiter.pid}
                      type="button"
                      onClick={() => onSelectPid(waiter.pid)}
                      style={{
                        flexGrow: Math.max(1, Math.round(waitSec * 10)),
                        flexBasis: `${basisPct}%`,
                        minHeight: `${minHeightPx}px`,
                      }}
                      className={`text-left rounded-lg border p-3.5 flex flex-col justify-between gap-2 transition-colors cursor-pointer min-w-[180px] ${
                        isSelected
                          ? 'border-blue-700 bg-blue-50/70 ring-1 ring-blue-700'
                          : sev.tileClass
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-bold text-slate-900 tabular-nums">
                            PID {waiter.pid}
                          </span>
                          <span
                            className={`font-mono text-xs font-bold tabular-nums ${sev.textClass}`}
                          >
                            {formatDuration(waitSec)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono text-slate-600 tabular-nums">
                          <span>
                            ← PID {waiter.edgeFromParent?.blocking_pid}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {tr('Depth', 'အဆင့်')} {waiter.depth}
                          </span>
                          {waiter.children.length > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-700 font-semibold">
                                {locale === 'my'
                                  ? `${waiter.children.length} ခု ပိတ်ဆို့နေ`
                                  : `blocks ${waiter.children.length}`}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <p className="text-[11px] font-mono text-slate-700 truncate">
                          {waiter.edgeFromParent?.waiting_mode} ·{' '}
                          {waiter.info.user}
                        </p>
                        <p className="text-[11px] font-mono text-slate-600 line-clamp-2 break-words">
                          {waiter.info.statement}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RemediationSqlRow({
  id,
  label,
  sql,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
}: {
  id: string;
  label: string;
  sql: string;
  copied: boolean;
  onCopy: (id: string, sql: string) => void;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-[11px] text-slate-500">{label}</p>
        <p className="text-xs font-mono text-slate-900 truncate">{sql}</p>
      </div>
      <button
        type="button"
        onClick={() => onCopy(id, sql)}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
      >
        {copied ? (
          <>
            <Check className="w-3 h-3 text-emerald-600" />
            <span>{copiedLabel}</span>
          </>
        ) : (
          <>
            <Copy className="w-3 h-3" />
            <span>{copyLabel}</span>
          </>
        )}
      </button>
    </div>
  );
}
