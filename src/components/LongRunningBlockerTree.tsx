import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Eye,
  GitBranch,
  Search,
  Terminal,
  UnfoldHorizontal,
  X,
} from 'lucide-react';
import type { LiveSessionRow } from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface LongRunningBlockerTreeProps {
  sessions: LiveSessionRow[];
  targetLabel: string;
  collectedAt: string;
}

type DurationThreshold = 0 | 1 | 5 | 30 | 60;
type ScopeFilter = 'all' | 'blockers' | 'standalone';

type NodeRole =
  | 'ROOT_BLOCKER'
  | 'TRANSITIVE_BLOCKER'
  | 'BLOCKED_LEAF'
  | 'STANDALONE_LONG';

interface BlockerTreeNode {
  pid: number;
  session: LiveSessionRow;
  isExternalPlaceholder: boolean;
  isCycleBackEdge: boolean;
  role: NodeRole;
  depth: number;
  rootPid: number;
  parentPid: number | null;
  effectiveDurationSec: number;
  directBlockedPids: number[];
  descendantCount: number;
  maxSubtreeDepth: number;
  cumulativeWaitSec: number;
  children: BlockerTreeNode[];
}

interface BlockerForestResult {
  rootTrees: BlockerTreeNode[];
  standaloneLong: BlockerTreeNode[];
  sessionMap: Map<number, LiveSessionRow>;
  nodeMetaByPid: Map<number, BlockerTreeNode>;
  stats: {
    rootBlockerCount: number;
    blockedSessionsCount: number;
    maxChainDepth: number;
    standaloneLongCount: number;
    totalLongRunningCount: number;
    longestDurationSec: number;
    cumulativeBlockedWaitSec: number;
  };
}

function formatDuration(sec: number): string {
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  if (sec >= 1) return `${sec.toFixed(1)}s`;
  return `${Math.round(sec * 1000)}ms`;
}

function getEffectiveDuration(s: LiveSessionRow): number {
  return Math.max(s.durationSeconds || 0, s.xactDurationSeconds ?? 0);
}

function buildSampleScenarioSessions(): LiveSessionRow[] {
  const now = Date.now();
  return [
    {
      pid: 41022,
      usename: 'migration_runner',
      applicationName: 'flyway-release-v42',
      clientAddr: '10.42.8.14',
      state: 'idle in transaction',
      waitEventType: 'Client',
      waitEvent: 'ClientRead',
      durationSeconds: 248.4,
      xactDurationSeconds: 254.1,
      xactStartIso: new Date(now - 254_100).toISOString(),
      queryStartIso: new Date(now - 248_400).toISOString(),
      query:
        'SELECT id, stripe_customer_id, credit_limit_cents FROM public.accounts WHERE id = $1 FOR UPDATE;',
      isBlocked: false,
      blockingPids: [],
    },
    {
      pid: 41205,
      usename: 'billing_worker',
      applicationName: 'invoice-settlement-svc',
      clientAddr: '10.42.14.91',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'transactionid',
      durationSeconds: 84.2,
      xactDurationSeconds: 86.5,
      xactStartIso: new Date(now - 86_500).toISOString(),
      queryStartIso: new Date(now - 84_200).toISOString(),
      query:
        "UPDATE public.invoices SET status = 'settled', settled_at = NOW() WHERE account_id = $1 AND billing_cycle = $2 RETURNING id, total_cents;",
      isBlocked: true,
      blockingPids: [41022],
    },
    {
      pid: 41318,
      usename: 'checkout_svc',
      applicationName: 'stripe-webhook-worker',
      clientAddr: '10.42.18.62',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'tuple',
      durationSeconds: 51.6,
      xactDurationSeconds: 52.0,
      xactStartIso: new Date(now - 52_000).toISOString(),
      queryStartIso: new Date(now - 51_600).toISOString(),
      query:
        'UPDATE public.invoices SET payment_intent_id = $1, paid_at = NOW() WHERE id = $2;',
      isBlocked: true,
      blockingPids: [41205],
    },
    {
      pid: 41390,
      usename: 'dunning_job',
      applicationName: 'retry-scheduler',
      clientAddr: '10.42.19.15',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'tuple',
      durationSeconds: 33.9,
      xactDurationSeconds: 34.4,
      xactStartIso: new Date(now - 34_400).toISOString(),
      queryStartIso: new Date(now - 33_900).toISOString(),
      query:
        'SELECT id, status, total_cents FROM public.invoices WHERE account_id = $1 FOR NO KEY UPDATE;',
      isBlocked: true,
      blockingPids: [41205],
    },
    {
      pid: 41411,
      usename: 'api_gateway',
      applicationName: 'checkout-api-v4',
      clientAddr: '10.42.18.44',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'transactionid',
      durationSeconds: 47.8,
      xactDurationSeconds: 48.2,
      xactStartIso: new Date(now - 48_200).toISOString(),
      queryStartIso: new Date(now - 47_800).toISOString(),
      query:
        'UPDATE public.accounts SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE id = $2;',
      isBlocked: true,
      blockingPids: [41022],
    },
    {
      pid: 41580,
      usename: 'schema_ops',
      applicationName: 'pg-online-ddl',
      clientAddr: '10.42.10.7',
      state: 'active',
      waitEventType: 'IO',
      waitEvent: 'DataFileWrite',
      durationSeconds: 71.5,
      xactDurationSeconds: 73.0,
      xactStartIso: new Date(now - 73_000).toISOString(),
      queryStartIso: new Date(now - 71_500).toISOString(),
      query:
        'ALTER TABLE public.ledger_entries ADD COLUMN settlement_batch_id uuid;',
      isBlocked: false,
      blockingPids: [],
    },
    {
      pid: 41604,
      usename: 'reconciler_job',
      applicationName: 'nightly-ledger-sync',
      clientAddr: '10.42.16.70',
      state: 'active',
      waitEventType: 'Lock',
      waitEvent: 'relation',
      durationSeconds: 56.3,
      xactDurationSeconds: 56.9,
      xactStartIso: new Date(now - 56_900).toISOString(),
      queryStartIso: new Date(now - 56_300).toISOString(),
      query:
        "INSERT INTO public.ledger_entries (account_id, amount_cents, currency) VALUES ($1, $2, 'USD');",
      isBlocked: true,
      blockingPids: [41580],
    },
    {
      pid: 41720,
      usename: 'analytics_ro',
      applicationName: 'metabase-bi-pool',
      clientAddr: '10.42.22.108',
      state: 'active',
      waitEventType: 'IO',
      waitEvent: 'DataFileRead',
      durationSeconds: 29.4,
      xactDurationSeconds: 29.8,
      xactStartIso: new Date(now - 29_800).toISOString(),
      queryStartIso: new Date(now - 29_400).toISOString(),
      query:
        "SELECT date_trunc('day', created_at) AS day, count(*), sum(amount_cents) FROM public.ledger_entries WHERE created_at >= NOW() - INTERVAL '180 days' GROUP BY 1 ORDER BY 1 DESC;",
      isBlocked: false,
      blockingPids: [],
    },
  ];
}

function makePlaceholderSession(pid: number): LiveSessionRow {
  return {
    pid,
    usename: 'external / restricted',
    applicationName: 'other database or superuser backend',
    clientAddr: '—',
    state: 'other',
    waitEventType: null,
    waitEvent: null,
    durationSeconds: 0,
    xactDurationSeconds: null,
    xactStartIso: null,
    queryStartIso: null,
    query:
      '-- Session metadata unavailable (outside current database or restricted by pg_read_all_stats privileges)',
    isBlocked: false,
    blockingPids: [],
  };
}

function buildBlockerForest(
  sessions: LiveSessionRow[],
  minDurationSec: DurationThreshold
): BlockerForestResult {
  const sessionMap = new Map<number, LiveSessionRow>();
  for (const s of sessions) {
    sessionMap.set(s.pid, s);
  }

  // Adjacency map: blockerPid -> blocked child PIDs
  const childrenByPid = new Map<number, Set<number>>();
  const parentsByPid = new Map<number, number[]>();
  const externalPlaceholderPids = new Set<number>();

  for (const s of sessions) {
    const rawParents = Array.isArray(s.blockingPids)
      ? s.blockingPids.filter((p) => Number.isInteger(p) && p > 0 && p !== s.pid)
      : [];
    const uniqueParents = Array.from(new Set(rawParents));
    if (uniqueParents.length > 0) {
      parentsByPid.set(s.pid, uniqueParents);
      for (const parentPid of uniqueParents) {
        if (!sessionMap.has(parentPid)) {
          externalPlaceholderPids.add(parentPid);
          sessionMap.set(parentPid, makePlaceholderSession(parentPid));
        }
        const set = childrenByPid.get(parentPid) ?? new Set<number>();
        set.add(s.pid);
        childrenByPid.set(parentPid, set);
      }
    }
  }

  // Identify every PID participating in any blocking edge
  const inBlockingGraph = new Set<number>();
  for (const [blockerPid, childSet] of childrenByPid.entries()) {
    if (childSet.size > 0) {
      inBlockingGraph.add(blockerPid);
      for (const c of childSet) inBlockingGraph.add(c);
    }
  }

  // Identify root blockers: PIDs in blocking graph that are not blocked by any other PID
  const rootCandidatePids: number[] = [];
  for (const pid of inBlockingGraph) {
    const parents = parentsByPid.get(pid) ?? [];
    const hasChildren = (childrenByPid.get(pid)?.size ?? 0) > 0;
    if (hasChildren && parents.length === 0) {
      rootCandidatePids.push(pid);
    }
  }

  // Track visited PIDs to also handle deadlock cycles where every participant has a blocker
  const coveredInAnyTree = new Set<number>();
  const nodeMetaByPid = new Map<number, BlockerTreeNode>();

  function buildSubtree(
    pid: number,
    rootPid: number,
    parentPid: number | null,
    depth: number,
    ancestorPath: Set<number>
  ): BlockerTreeNode {
    const session = sessionMap.get(pid) ?? makePlaceholderSession(pid);
    const isExternal = externalPlaceholderPids.has(pid);
    const effectiveDurationSec = getEffectiveDuration(session);
    const directBlockedPids = Array.from(childrenByPid.get(pid) ?? []).sort(
      (a, b) => {
        const sa = sessionMap.get(a);
        const sb = sessionMap.get(b);
        return (
          (sb ? getEffectiveDuration(sb) : 0) -
          (sa ? getEffectiveDuration(sa) : 0)
        );
      }
    );

    coveredInAnyTree.add(pid);

    const nextAncestors = new Set(ancestorPath);
    nextAncestors.add(pid);

    const children: BlockerTreeNode[] = directBlockedPids.map((childPid) => {
      if (nextAncestors.has(childPid)) {
        const childSession =
          sessionMap.get(childPid) ?? makePlaceholderSession(childPid);
        return {
          pid: childPid,
          session: childSession,
          isExternalPlaceholder: externalPlaceholderPids.has(childPid),
          isCycleBackEdge: true,
          role: 'BLOCKED_LEAF',
          depth: depth + 1,
          rootPid,
          parentPid: pid,
          effectiveDurationSec: getEffectiveDuration(childSession),
          directBlockedPids: [],
          descendantCount: 0,
          maxSubtreeDepth: depth + 1,
          cumulativeWaitSec: 0,
          children: [],
        };
      }
      return buildSubtree(childPid, rootPid, pid, depth + 1, nextAncestors);
    });

    // Aggregate unique descendants below this node
    const uniqueDescendants = new Map<number, number>();
    let maxSubtreeDepth = depth;

    function collectDescendants(node: BlockerTreeNode) {
      for (const child of node.children) {
        if (child.isCycleBackEdge) continue;
        if (!uniqueDescendants.has(child.pid)) {
          uniqueDescendants.set(child.pid, child.session.durationSeconds);
        }
        if (child.maxSubtreeDepth > maxSubtreeDepth) {
          maxSubtreeDepth = child.maxSubtreeDepth;
        }
        collectDescendants(child);
      }
    }

    const role: NodeRole =
      depth === 0
        ? 'ROOT_BLOCKER'
        : children.length > 0
          ? 'TRANSITIVE_BLOCKER'
          : 'BLOCKED_LEAF';

    const built: BlockerTreeNode = {
      pid,
      session,
      isExternalPlaceholder: isExternal,
      isCycleBackEdge: false,
      role,
      depth,
      rootPid,
      parentPid,
      effectiveDurationSec,
      directBlockedPids,
      descendantCount: 0,
      maxSubtreeDepth: depth,
      cumulativeWaitSec: 0,
      children,
    };

    collectDescendants(built);
    built.descendantCount = uniqueDescendants.size;
    built.maxSubtreeDepth = maxSubtreeDepth;
    built.cumulativeWaitSec = Array.from(uniqueDescendants.values()).reduce(
      (acc, val) => acc + val,
      0
    );

    if (!nodeMetaByPid.has(pid) || depth < (nodeMetaByPid.get(pid)?.depth ?? 99)) {
      nodeMetaByPid.set(pid, built);
    }

    return built;
  }

  const allRootTrees: BlockerTreeNode[] = rootCandidatePids.map((rootPid) =>
    buildSubtree(rootPid, rootPid, null, 0, new Set<number>())
  );

  // If any PIDs in the blocking graph were part of an isolated deadlock cycle (no unblocked root),
  // pick the longest-running uncovered PID as a cycle entry root so it is never hidden.
  const remainingCyclePids = Array.from(inBlockingGraph)
    .filter((pid) => !coveredInAnyTree.has(pid))
    .sort((a, b) => {
      const sa = sessionMap.get(a);
      const sb = sessionMap.get(b);
      return (
        (sb ? getEffectiveDuration(sb) : 0) - (sa ? getEffectiveDuration(sa) : 0)
      );
    });

  for (const pid of remainingCyclePids) {
    if (coveredInAnyTree.has(pid)) continue;
    allRootTrees.push(buildSubtree(pid, pid, null, 0, new Set<number>()));
  }

  // Filter root trees by duration threshold: keep tree if threshold === 0 or any node in tree >= threshold
  function treeMeetsDuration(node: BlockerTreeNode): boolean {
    if (minDurationSec === 0) return true;
    if (node.effectiveDurationSec >= minDurationSec) return true;
    return node.children.some((c) => treeMeetsDuration(c));
  }

  const rootTrees = allRootTrees
    .filter(treeMeetsDuration)
    .sort(
      (a, b) =>
        b.descendantCount - a.descendantCount ||
        b.effectiveDurationSec - a.effectiveDurationSec
    );

  // Build standalone long-running queries (non-idle, not in any blocking chain)
  const standaloneLong: BlockerTreeNode[] = sessions
    .filter((s) => {
      if (inBlockingGraph.has(s.pid)) return false;
      if (s.state === 'idle') return false;
      const eff = getEffectiveDuration(s);
      return minDurationSec === 0 ? true : eff >= minDurationSec;
    })
    .sort((a, b) => getEffectiveDuration(b) - getEffectiveDuration(a))
    .map((s) => {
      const node: BlockerTreeNode = {
        pid: s.pid,
        session: s,
        isExternalPlaceholder: false,
        isCycleBackEdge: false,
        role: 'STANDALONE_LONG',
        depth: 0,
        rootPid: s.pid,
        parentPid: null,
        effectiveDurationSec: getEffectiveDuration(s),
        directBlockedPids: [],
        descendantCount: 0,
        maxSubtreeDepth: 0,
        cumulativeWaitSec: 0,
        children: [],
      };
      nodeMetaByPid.set(s.pid, node);
      return node;
    });

  // Compute summary metrics across visible forest
  const blockedPidSet = new Set<number>();
  let maxChainDepth = 0;
  let longestDurationSec = 0;
  let cumulativeBlockedWaitSec = 0;
  let longRunningInTrees = 0;
  const countedLongPids = new Set<number>();

  function walkStats(node: BlockerTreeNode) {
    if (node.isCycleBackEdge) return;
    if (node.effectiveDurationSec > longestDurationSec) {
      longestDurationSec = node.effectiveDurationSec;
    }
    if (node.depth > maxChainDepth) {
      maxChainDepth = node.depth;
    }
    if (
      (minDurationSec === 0 || node.effectiveDurationSec >= minDurationSec) &&
      !countedLongPids.has(node.pid)
    ) {
      countedLongPids.add(node.pid);
      longRunningInTrees += 1;
    }
    if (node.depth > 0 && !blockedPidSet.has(node.pid)) {
      blockedPidSet.add(node.pid);
      cumulativeBlockedWaitSec += node.session.durationSeconds;
    }
    for (const child of node.children) {
      walkStats(child);
    }
  }

  for (const tree of rootTrees) {
    walkStats(tree);
  }
  for (const node of standaloneLong) {
    if (node.effectiveDurationSec > longestDurationSec) {
      longestDurationSec = node.effectiveDurationSec;
    }
  }

  return {
    rootTrees,
    standaloneLong,
    sessionMap,
    nodeMetaByPid,
    stats: {
      rootBlockerCount: rootTrees.length,
      blockedSessionsCount: blockedPidSet.size,
      maxChainDepth,
      standaloneLongCount: standaloneLong.length,
      totalLongRunningCount: longRunningInTrees + standaloneLong.length,
      longestDurationSec,
      cumulativeBlockedWaitSec,
    },
  };
}

function nodeMatchesSearch(node: BlockerTreeNode, q: string): boolean {
  if (!q) return true;
  const s = node.session;
  if (
    String(node.pid).includes(q) ||
    s.usename.toLowerCase().includes(q) ||
    s.applicationName.toLowerCase().includes(q) ||
    s.clientAddr.toLowerCase().includes(q) ||
    s.state.toLowerCase().includes(q) ||
    (s.waitEventType ?? '').toLowerCase().includes(q) ||
    (s.waitEvent ?? '').toLowerCase().includes(q) ||
    s.query.toLowerCase().includes(q)
  ) {
    return true;
  }
  return node.children.some((c) => nodeMatchesSearch(c, q));
}

export function LongRunningBlockerTree({
  sessions,
  targetLabel,
  collectedAt,
}: LongRunningBlockerTreeProps) {
  const { tr, formatDateTime } = useI18n();

  const [thresholdSec, setThresholdSec] = useState<DurationThreshold>(5);
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [search, setSearch] = useState('');
  const [previewSample, setPreviewSample] = useState(false);
  const [collapsedPids, setCollapsedPids] = useState<Set<number>>(new Set());
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const activeSessions = useMemo(
    () => (previewSample ? buildSampleScenarioSessions() : sessions),
    [previewSample, sessions]
  );

  const forest = useMemo(
    () => buildBlockerForest(activeSessions, thresholdSec),
    [activeSessions, thresholdSec]
  );

  const normalizedQuery = search.trim().toLowerCase();

  const visibleRootTrees = useMemo(() => {
    if (scope === 'standalone') return [];
    if (!normalizedQuery) return forest.rootTrees;
    return forest.rootTrees.filter((t) => nodeMatchesSearch(t, normalizedQuery));
  }, [forest.rootTrees, scope, normalizedQuery]);

  const visibleStandalone = useMemo(() => {
    if (scope === 'blockers') return [];
    if (!normalizedQuery) return forest.standaloneLong;
    return forest.standaloneLong.filter((n) =>
      nodeMatchesSearch(n, normalizedQuery)
    );
  }, [forest.standaloneLong, scope, normalizedQuery]);

  // Auto-select first root blocker (or first standalone long query) when current selection disappears
  useEffect(() => {
    if (selectedPid !== null && forest.nodeMetaByPid.has(selectedPid)) {
      return;
    }
    if (visibleRootTrees.length > 0) {
      setSelectedPid(visibleRootTrees[0].pid);
    } else if (visibleStandalone.length > 0) {
      setSelectedPid(visibleStandalone[0].pid);
    } else {
      setSelectedPid(null);
    }
  }, [selectedPid, forest.nodeMetaByPid, visibleRootTrees, visibleStandalone]);

  const selectedNode =
    selectedPid !== null ? forest.nodeMetaByPid.get(selectedPid) ?? null : null;

  // Collect all expandable parent PIDs for Expand All / Collapse All
  const allExpandablePids = useMemo(() => {
    const pids: number[] = [];
    function visit(node: BlockerTreeNode) {
      if (node.children.length > 0) {
        pids.push(node.pid);
        for (const c of node.children) visit(c);
      }
    }
    for (const root of visibleRootTrees) visit(root);
    return pids;
  }, [visibleRootTrees]);

  const allCollapsed =
    allExpandablePids.length > 0 &&
    allExpandablePids.every((pid) => collapsedPids.has(pid));

  const toggleCollapsePid = (pid: number) => {
    setCollapsedPids((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  const toggleExpandAll = () => {
    if (allCollapsed) {
      setCollapsedPids(new Set());
    } else {
      setCollapsedPids(new Set(allExpandablePids));
    }
  };

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 1800);
  };

  const renderRoleText = (node: BlockerTreeNode) => {
    if (node.isCycleBackEdge) {
      return (
        <span className="text-[11px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
          {tr('Deadlock Cycle', 'Deadlock စက်ဝိုင်း')}
        </span>
      );
    }
    if (node.role === 'ROOT_BLOCKER') {
      return (
        <span className="text-[11px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
          {tr('Root Blocker', 'အရင်းခံ ပိတ်ဆို့သူ')}
        </span>
      );
    }
    if (node.role === 'TRANSITIVE_BLOCKER') {
      return (
        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
          {tr('Transitive Blocker', 'ကြားခံ ပိတ်ဆို့သူ')}
        </span>
      );
    }
    if (node.role === 'BLOCKED_LEAF') {
      return (
        <span className="text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
          {tr('Blocked', 'ပိတ်ဆို့ခံ')}
        </span>
      );
    }
    return (
      <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
        {tr('Long Query', 'ကြာရှည် Query')}
      </span>
    );
  };

  const renderStateText = (state: LiveSessionRow['state']) => {
    if (state === 'idle in transaction' || state === 'idle in transaction (aborted)') {
      return (
        <span className="text-amber-700 dark:text-amber-400 font-medium">
          {state}
        </span>
      );
    }
    if (state === 'active') {
      return (
        <span className="text-emerald-700 dark:text-emerald-400 font-medium">
          active
        </span>
      );
    }
    return <span className="text-slate-500 dark:text-slate-400">{state}</span>;
  };

  const renderTreeNode = (
    node: BlockerTreeNode,
    isLastSibling: boolean,
    parentKey: string
  ) => {
    const nodeKey = `${parentKey}-${node.pid}-${node.isCycleBackEdge ? 'cyc' : 'n'}`;
    const hasChildren = node.children.length > 0 && !node.isCycleBackEdge;
    const isCollapsed = collapsedPids.has(node.pid);
    const isSelected = selectedPid === node.pid && !node.isCycleBackEdge;
    const s = node.session;

    const durationColor =
      node.effectiveDurationSec >= 60
        ? 'text-red-700 dark:text-red-400 font-semibold'
        : node.effectiveDurationSec >= 15
          ? 'text-amber-700 dark:text-amber-400 font-semibold'
          : 'text-slate-700 dark:text-slate-300';

    const directMatch =
      normalizedQuery.length > 0 &&
      (String(node.pid).includes(normalizedQuery) ||
        s.usename.toLowerCase().includes(normalizedQuery) ||
        s.applicationName.toLowerCase().includes(normalizedQuery) ||
        s.query.toLowerCase().includes(normalizedQuery));

    return (
      <div key={nodeKey} className="relative">
        <div
          className={`relative flex items-start ${
            node.depth > 0 ? 'pl-6 sm:pl-8' : ''
          }`}
        >
          {/* Orthogonal Tree Connectors for child branches */}
          {node.depth > 0 && (
            <>
              {/* Vertical stem from parent */}
              <span
                aria-hidden="true"
                className={`absolute left-2.5 sm:left-3.5 top-0 w-px bg-slate-300 dark:bg-slate-700 ${
                  isLastSibling ? 'h-5' : 'bottom-0'
                }`}
              />
              {/* Horizontal elbow connecting into node row */}
              <span
                aria-hidden="true"
                className="absolute left-2.5 sm:left-3.5 top-5 w-3.5 sm:w-4.5 h-px bg-slate-300 dark:bg-slate-700"
              />
            </>
          )}

          {/* Node Interactive Row */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSelectedPid(node.pid)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSelectedPid(node.pid);
              }
            }}
            className={`group flex-1 min-w-0 my-1 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
              isSelected
                ? 'bg-blue-50/80 dark:bg-blue-950/35 border-blue-300 dark:border-blue-800'
                : directMatch
                  ? 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/60 hover:bg-amber-50/80 dark:hover:bg-amber-950/30'
                  : 'bg-white dark:bg-slate-900 border-slate-200/90 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
            }`}
          >
            {/* Top metadata line */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapsePid(node.pid);
                    }}
                    aria-label={
                      isCollapsed
                        ? tr('Expand blocked children', 'ပိတ်ဆို့ခံအောက်ပိုင်း ဖွင့်ရန်')
                        : tr('Collapse blocked children', 'ပိတ်ဆို့ခံအောက်ပိုင်း ခေါက်ရန်')
                    }
                    className="p-0.5 -ml-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer shrink-0"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                ) : (
                  <span
                    aria-hidden="true"
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      node.role === 'ROOT_BLOCKER'
                        ? 'bg-red-600 dark:bg-red-400'
                        : node.role === 'BLOCKED_LEAF'
                          ? 'bg-amber-500 dark:bg-amber-400'
                          : 'bg-blue-600 dark:bg-blue-400'
                    }`}
                  />
                )}

                {renderRoleText(node)}
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span className="text-xs font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                  PID {node.pid}
                </span>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span className="text-xs">{renderStateText(s.state)}</span>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span className="text-xs font-mono text-slate-600 dark:text-slate-300 truncate">
                  {s.usename}
                  <span className="text-slate-400 dark:text-slate-500"> / </span>
                  {s.applicationName}
                </span>
              </div>

              {/* Right-aligned tabular duration & impact */}
              <div className="flex items-center gap-2.5 text-xs font-mono tabular-nums whitespace-nowrap shrink-0">
                {node.descendantCount > 0 && (
                  <span className="text-red-700 dark:text-red-400 font-medium">
                    {tr(
                      `blocks ${node.descendantCount}`,
                      `${node.descendantCount} ခု ပိတ်ဆို့`
                    )}
                  </span>
                )}
                {s.waitEventType && (
                  <span className="text-slate-500 dark:text-slate-400 hidden sm:inline">
                    {s.waitEventType}
                    {s.waitEvent ? `/${s.waitEvent}` : ''}
                  </span>
                )}
                <span className={durationColor}>
                  {formatDuration(node.effectiveDurationSec)}
                </span>
              </div>
            </div>

            {/* Second line: single-line truncated SQL preview */}
            <div className="mt-1.5 pl-4 flex items-center justify-between gap-2">
              <p className="text-xs font-mono text-slate-600 dark:text-slate-300 truncate">
                {s.query || '—'}
              </p>
              {node.isExternalPlaceholder && (
                <span className="text-[11px] text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0">
                  {tr('External PID', 'ပြင်ပ PID')}
                </span>
              )}
              {isCollapsed && node.descendantCount > 0 && (
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                  +{node.descendantCount}{' '}
                  {tr('hidden', 'ဖုံးထား')}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Render Children recursively */}
        {hasChildren && !isCollapsed && (
          <div className={node.depth > 0 ? 'pl-6 sm:pl-8 relative' : 'relative'}>
            {node.depth > 0 && !isLastSibling && (
              <span
                aria-hidden="true"
                className="absolute left-2.5 sm:left-3.5 top-0 bottom-0 w-px bg-slate-300 dark:bg-slate-700"
              />
            )}
            {node.children.map((child, idx) =>
              renderTreeNode(child, idx === node.children.length - 1, nodeKey)
            )}
          </div>
        )}
      </div>
    );
  };

  const renderDiagnosticHint = (node: BlockerTreeNode) => {
    const s = node.session;
    if (node.role === 'ROOT_BLOCKER') {
      if (s.state.startsWith('idle in transaction')) {
        return tr(
          `Root cause: PID ${node.pid} is idle inside an open transaction holding locks for ${formatDuration(node.effectiveDurationSec)}, blocking ${node.descendantCount} downstream session(s). Committing/rolling back the client transaction or terminating PID ${node.pid} will immediately release the queue.`,
          `အရင်းအမြစ်: PID ${node.pid} သည် Transaction ဖွင့်ထားလျက် idle ဖြစ်နေပြီး ${formatDuration(node.effectiveDurationSec)} ကြာ Lock ကိုင်ထားသဖြင့် အောက်ပိုင်း Session ${node.descendantCount} ခု ပိတ်ဆို့နေပါသည်။ ဤ PID ကို ပိတ်သိမ်းခြင်းဖြင့် စောင့်ဆိုင်းမှုများ ချက်ချင်း ပြေလည်မည်။`
        );
      }
      if (/^\s*(ALTER|DROP|TRUNCATE|REINDEX|VACUUM\s+FULL)/i.test(s.query)) {
        return tr(
          `Root cause: PID ${node.pid} is executing a heavy DDL statement acquiring AccessExclusiveLock, queueing ${node.descendantCount} active session(s). Prefer SET lock_timeout or CONCURRENTLY patterns to prevent production stalls.`,
          `အရင်းအမြစ်: PID ${node.pid} သည် AccessExclusiveLock ယူသော DDL ကို လုပ်ဆောင်နေသဖြင့် Session ${node.descendantCount} ခု စောင့်ဆိုင်းနေပါသည်။`
        );
      }
      return tr(
        `Root cause: PID ${node.pid} is at the head of a blocking tree affecting ${node.descendantCount} session(s) (${formatDuration(node.cumulativeWaitSec)} cumulative wait). Resolve or cancel PID ${node.pid} first.`,
        `အရင်းအမြစ်: PID ${node.pid} သည် Session ${node.descendantCount} ခုကို ပိတ်ဆို့နေသော အရင်းခံ ဖြစ်ပါသည်။ ဤ PID ကို ဦးစားပေး ဖြေရှင်းပါ။`
      );
    }

    if (node.role === 'TRANSITIVE_BLOCKER') {
      return tr(
        `Transitive waiter: PID ${node.pid} is waiting on PID ${node.parentPid} while simultaneously holding locks that block ${node.descendantCount} downstream session(s). Resolve Root Blocker PID ${node.rootPid} first.`,
        `ကြားခံပိတ်ဆို့သူ: PID ${node.pid} သည် PID ${node.parentPid} ကို စောင့်နေစဉ် အောက်ပိုင်း Session ${node.descendantCount} ခုကို ဆက်လက်ပိတ်ဆို့နေပါသည်။ အရင်းခံ PID ${node.rootPid} ကို အရင်ဖြေရှင်းပါ။`
      );
    }

    if (node.role === 'BLOCKED_LEAF') {
      return tr(
        `Waiting session: PID ${node.pid} is blocked on ${s.waitEventType ?? 'Lock'}${s.waitEvent ? ` (${s.waitEvent})` : ''}. Canceling this waiter alone will not clear locks held by Root Blocker PID ${node.rootPid}.`,
        `စောင့်ဆိုင်းနေသော Session: PID ${node.pid} သည် Lock စောင့်နေပါသည်။ အရင်းခံ PID ${node.rootPid} ကို ဖြေရှင်းမှသာ ပြေလည်ပါမည်။`
      );
    }

    return tr(
      `Standalone long-running query: PID ${node.pid} is not blocking other sessions, but has been running for ${formatDuration(node.effectiveDurationSec)}. Inspect its execution plan or wait event (${s.waitEventType ?? 'CPU'}) for missing indexes or I/O bottlenecks.`,
      `သီးခြား ကြာရှည် Query: PID ${node.pid} သည် အခြား Session များကို မပိတ်ဆို့သော်လည်း ${formatDuration(node.effectiveDurationSec)} ကြာ လုပ်ဆောင်နေပါသည်။ Index လိုအပ်ချက် သို့မဟုတ် I/O နှောင့်နှေးမှုကို စစ်ဆေးပါ။`
    );
  };

  const hasAnyVisibleItems =
    visibleRootTrees.length > 0 || visibleStandalone.length > 0;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      {/* Sample Preview Notice Banner (only when user explicitly toggles preview mode) */}
      {previewSample && (
        <div className="px-6 py-2.5 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/70 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-amber-900 dark:text-amber-300">
            <Eye className="w-3.5 h-3.5 shrink-0" />
            <span>
              {tr(
                'Previewing a multi-level pg_stat_activity contention scenario (2 root blockers, 5 blocked waiters, 1 standalone long query).',
                'အဆင့်ဆင့် ပိတ်ဆို့မှု နမူနာ pg_stat_activity မြင်ကွင်းကို ပြသထားပါသည်။'
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPreviewSample(false)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-900 dark:text-amber-200 bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-950/60 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            <X className="w-3 h-3" />
            <span>{tr('Return to Live Data', 'တိုက်ရိုက်ဒေတာသို့ ပြန်ရန်')}</span>
          </button>
        </div>
      )}

      {/* Compact 4-Column Telemetry Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800 border-b border-slate-200 dark:border-slate-800">
        <div className="px-6 py-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Root Blockers', 'အရင်းခံ ပိတ်ဆို့သူများ')}
          </p>
          <p
            className={`mt-1 text-xl font-bold font-mono tabular-nums ${
              forest.stats.rootBlockerCount > 0
                ? 'text-red-700 dark:text-red-400'
                : 'text-emerald-700 dark:text-emerald-400'
            }`}
          >
            {forest.stats.rootBlockerCount}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {forest.stats.rootBlockerCount > 0
              ? tr('Heads of pg_blocking_pids trees', 'pg_blocking_pids သစ်ပင် အရင်းခံများ')
              : tr('No active lock heads detected', 'ပိတ်ဆို့နေသော အရင်းခံ မရှိပါ')}
          </p>
        </div>

        <div className="px-6 py-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Blocked Waiters', 'ပိတ်ဆို့ခံ စောင့်ဆိုင်းမှုများ')}
          </p>
          <p
            className={`mt-1 text-xl font-bold font-mono tabular-nums ${
              forest.stats.blockedSessionsCount > 0
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {forest.stats.blockedSessionsCount}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {tr('Max Depth', 'အနက်ဆုံးအဆင့်')}: {forest.stats.maxChainDepth}{' '}
            · {tr('Total Wait', 'စုစုပေါင်းစောင့်ချိန်')}:{' '}
            {formatDuration(forest.stats.cumulativeBlockedWaitSec)}
          </p>
        </div>

        <div className="px-6 py-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Long-Running Queries', 'ကြာရှည် Query များ')}
          </p>
          <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {forest.stats.totalLongRunningCount}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {thresholdSec === 0
              ? tr('All active / blocking', 'လုပ်ဆောင်/ပိတ်ဆို့ အားလုံး')
              : tr(`Threshold ≥ ${thresholdSec}s`, `သတ်မှတ်ချက် ≥ ${thresholdSec}s`)}{' '}
            · {forest.stats.standaloneLongCount}{' '}
            {tr('unblocked', 'မပိတ်ဆို့')}
          </p>
        </div>

        <div className="px-6 py-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {tr('Longest Query / Tx Age', 'အကြာဆုံး Query / Tx သက်တမ်း')}
          </p>
          <p
            className={`mt-1 text-xl font-bold font-mono tabular-nums ${
              forest.stats.longestDurationSec >= 60
                ? 'text-red-700 dark:text-red-400'
                : forest.stats.longestDurationSec >= 15
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {forest.stats.longestDurationSec > 0
              ? formatDuration(forest.stats.longestDurationSec)
              : '0ms'}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">
            {targetLabel} · {formatDateTime(collectedAt)}
          </p>
        </div>
      </div>

      {/* Filter & Controls Toolbar */}
      <div className="px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Duration Threshold Selector */}
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <span className="px-2 text-[11px] font-medium text-slate-500 dark:text-slate-400 inline-flex items-center gap-1 whitespace-nowrap">
              <Clock className="w-3 h-3" />
              <span>{tr('Min Age', 'အနည်းဆုံး')}</span>
            </span>
            {([0, 1, 5, 30, 60] as DurationThreshold[]).map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setThresholdSec(sec)}
                className={`px-2 py-1 text-xs font-mono tabular-nums rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  thresholdSec === sec
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 font-semibold shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {sec === 0 ? tr('All', 'အားလုံး') : `≥${sec}s`}
              </button>
            ))}
          </div>

          {/* Scope Selector */}
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            {(
              [
                { id: 'all', label: tr('All', 'အားလုံး') },
                {
                  id: 'blockers',
                  label: `${tr('Blocker Trees', 'ပိတ်ဆို့ သစ်ပင်')} (${forest.rootTrees.length})`,
                },
                {
                  id: 'standalone',
                  label: `${tr('Standalone Long', 'သီးခြား ကြာရှည်')} (${forest.standaloneLong.length})`,
                },
              ] as { id: ScopeFilter; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setScope(opt.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  scope === opt.id
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-60">
            <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr(
                'Filter PID, role, app, SQL…',
                'PID၊ role၊ app၊ SQL ရှာရန်…'
              )}
              className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          {allExpandablePids.length > 0 && (
            <button
              type="button"
              onClick={toggleExpandAll}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <UnfoldHorizontal className="w-3.5 h-3.5" />
              <span>
                {allCollapsed
                  ? tr('Expand All', 'အားလုံးဖွင့်')
                  : tr('Collapse All', 'အားလုံးခေါက်')}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setPreviewSample((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border rounded-lg whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              previewSample
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>
              {previewSample
                ? tr('Live Data', 'တိုက်ရိုက်ဒေတာ')
                : tr('Preview Scenario', 'နမူနာကြည့်ရန်')}
            </span>
          </button>
        </div>
      </div>

      {/* Main Content: Empty State OR Split-Pane Tree + Inspector */}
      {!hasAnyVisibleItems ? (
        <div className="px-6 py-12 text-center space-y-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 mx-auto flex items-center justify-center border border-emerald-200 dark:border-emerald-900/60">
            <GitBranch className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-md mx-auto">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {normalizedQuery
                ? tr(
                    'No blocking chains or long-running queries match your search.',
                    'ရှာဖွေမှုနှင့် ကိုက်ညီသော ပိတ်ဆို့မှု သို့မဟုတ် ကြာရှည် Query မရှိပါ။'
                  )
                : tr(
                    'No root blockers or long-running queries detected',
                    'အရင်းခံ ပိတ်ဆို့သူ သို့မဟုတ် ကြာရှည် Query မတွေ့ရှိပါ'
                  )}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tr(
                `All observed pg_stat_activity sessions are running cleanly below the ${thresholdSec}s threshold with zero lock waits.`,
                `လက်ရှိ pg_stat_activity Session များအားလုံးသည် ${thresholdSec}s အောက်တွင် Lock ပိတ်ဆို့မှုမရှိဘဲ ပုံမှန်အလုပ်လုပ်နေပါသည်။`
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {thresholdSec > 0 && (
              <button
                type="button"
                onClick={() => setThresholdSec(0)}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                {tr('Show All Active Sessions', 'လုပ်ဆောင်နေဆဲ အားလုံးပြရန်')}
              </button>
            )}
            {!previewSample && (
              <button
                type="button"
                onClick={() => setPreviewSample(true)}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-700 rounded-lg cursor-pointer"
              >
                {tr(
                  'Preview Blocker Tree Scenario',
                  'ပိတ်ဆို့မှု သစ်ပင် နမူနာကြည့်ရန်'
                )}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 divide-y xl:divide-y-0 xl:divide-x divide-slate-200 dark:divide-slate-800">
          {/* LEFT PANE: Hierarchical Tree & Standalone Long Queries */}
          <div className="xl:col-span-8 p-5 space-y-6 min-w-0">
            {/* Section 1: Root Blocker Trees */}
            {visibleRootTrees.length > 0 && (
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-red-700 dark:text-red-400" />
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                      {tr(
                        'Root Blocker Hierarchy (pg_blocking_pids)',
                        'အရင်းခံ ပိတ်ဆို့မှု အဆင့်ဆင့် (pg_blocking_pids)'
                      )}
                    </h3>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {visibleRootTrees.length}{' '}
                    {tr('tree(s)', 'သစ်ပင်')} · {forest.stats.blockedSessionsCount}{' '}
                    {tr('blocked', 'ပိတ်ဆို့ခံ')}
                  </span>
                </div>

                <div className="space-y-4">
                  {visibleRootTrees.map((rootNode) => (
                    <div
                      key={`tree-${rootNode.pid}`}
                      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 mb-2 border-b border-slate-200/80 dark:border-slate-800 text-[11px]">
                        <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300">
                          <span className="font-mono font-semibold text-red-700 dark:text-red-400">
                            {tr('Chain Head', 'သစ်ပင်ထိပ်')}: PID {rootNode.pid}
                          </span>
                          <span className="text-slate-300 dark:text-slate-700">·</span>
                          <span className="font-mono tabular-nums">
                            {rootNode.descendantCount}{' '}
                            {tr('blocked downstream', 'အောက်ပိုင်း ပိတ်ဆို့ခံ')}
                          </span>
                          <span className="text-slate-300 dark:text-slate-700">·</span>
                          <span className="font-mono tabular-nums">
                            {tr('Depth', 'အနက်')} {rootNode.maxSubtreeDepth}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                          {tr('Cumulative Wait', 'စုစုပေါင်းစောင့်ချိန်')}:{' '}
                          <strong className="text-slate-800 dark:text-slate-200">
                            {formatDuration(rootNode.cumulativeWaitSec)}
                          </strong>
                        </span>
                      </div>
                      {renderTreeNode(rootNode, true, `root-${rootNode.pid}`)}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Section 2: Standalone Long-Running Queries */}
            {visibleStandalone.length > 0 && (
              <section className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                      {tr(
                        'Standalone Long-Running Queries (Unblocked)',
                        'သီးခြား ကြာရှည် Query များ (ပိတ်ဆို့မှုမရှိ)'
                      )}
                    </h3>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {visibleStandalone.length} {tr('session(s)', 'ခု')}
                  </span>
                </div>

                <div>
                  {visibleStandalone.map((node, idx) =>
                    renderTreeNode(
                      node,
                      idx === visibleStandalone.length - 1,
                      'standalone'
                    )
                  )}
                </div>
              </section>
            )}
          </div>

          {/* RIGHT PANE: Selected Session Inspector & Safe Remediation */}
          <aside className="xl:col-span-4 p-5 bg-slate-50/40 dark:bg-slate-950/30 min-w-0">
            {selectedNode ? (
              <div className="space-y-4 xl:sticky xl:top-6">
                {/* Inspector Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {renderRoleText(selectedNode)}
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        {tr('Depth', 'အနက်')} {selectedNode.depth}
                      </span>
                    </div>
                    <h3 className="mt-1 text-base font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      PID {selectedNode.pid}
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-300 font-mono truncate">
                      {selectedNode.session.usename} ·{' '}
                      {selectedNode.session.applicationName}
                    </p>
                  </div>

                  {selectedNode.depth > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedPid(selectedNode.rootPid)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-400 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <span>{tr('Root PID', 'အရင်းခံ PID')} {selectedNode.rootPid}</span>
                      <ArrowUpRight className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Diagnostic Advisory Note */}
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-700 dark:text-slate-300 leading-relaxed flex items-start gap-2">
                  <AlertTriangle
                    className={`w-4 h-4 shrink-0 mt-0.5 ${
                      selectedNode.role === 'ROOT_BLOCKER'
                        ? 'text-red-700 dark:text-red-400'
                        : selectedNode.role === 'STANDALONE_LONG'
                          ? 'text-blue-700 dark:text-blue-400'
                          : 'text-amber-700 dark:text-amber-400'
                    }`}
                  />
                  <span>{renderDiagnosticHint(selectedNode)}</span>
                </div>

                {/* Key Telemetry Facts Grid */}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs py-3 border-y border-slate-200 dark:border-slate-800">
                  <div>
                    <dt className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tr('State', 'အခြေအနေ')}
                    </dt>
                    <dd className="mt-0.5 font-mono">
                      {renderStateText(selectedNode.session.state)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tr('Wait Event', 'စောင့်ဆိုင်းချက်')}
                    </dt>
                    <dd className="mt-0.5 font-mono text-slate-800 dark:text-slate-200 truncate">
                      {selectedNode.session.waitEventType
                        ? `${selectedNode.session.waitEventType}${
                            selectedNode.session.waitEvent
                              ? ` / ${selectedNode.session.waitEvent}`
                              : ''
                          }`
                        : 'CPU'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tr('Query Duration', 'Query ကြာချိန်')}
                    </dt>
                    <dd className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {formatDuration(selectedNode.session.durationSeconds)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tr('Transaction Age', 'Tx သက်တမ်း')}
                    </dt>
                    <dd className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {selectedNode.session.xactDurationSeconds !== null
                        ? formatDuration(selectedNode.session.xactDurationSeconds)
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tr('Client Address', 'Client IP')}
                    </dt>
                    <dd className="mt-0.5 font-mono text-slate-700 dark:text-slate-300">
                      {selectedNode.session.clientAddr}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tr('Query Started', 'Query စချိန်')}
                    </dt>
                    <dd className="mt-0.5 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {selectedNode.session.queryStartIso
                        ? formatDateTime(selectedNode.session.queryStartIso)
                        : '—'}
                    </dd>
                  </div>
                </dl>

                {/* Blocking Lineage Links */}
                {(selectedNode.session.blockingPids.length > 0 ||
                  selectedNode.directBlockedPids.length > 0) && (
                  <div className="space-y-2.5 text-xs">
                    {selectedNode.session.blockingPids.length > 0 && (
                      <div>
                        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                          {tr('Blocked By (Upstream)', 'ပိတ်ဆို့နေသော အထက် PID')}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {selectedNode.session.blockingPids.map((p) => (
                            <button
                              key={`up-${p}`}
                              type="button"
                              onClick={() => setSelectedPid(p)}
                              className="px-2 py-0.5 text-xs font-mono tabular-nums text-red-700 dark:text-red-400 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/50 rounded cursor-pointer"
                            >
                              PID {p}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedNode.directBlockedPids.length > 0 && (
                      <div>
                        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                          {tr(
                            `Directly Blocking (${selectedNode.directBlockedPids.length})`,
                            `တိုက်ရိုက် ပိတ်ဆို့ခံ (${selectedNode.directBlockedPids.length})`
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {selectedNode.directBlockedPids.map((c) => (
                            <button
                              key={`down-${c}`}
                              type="button"
                              onClick={() => setSelectedPid(c)}
                              className="px-2 py-0.5 text-xs font-mono tabular-nums text-amber-800 dark:text-amber-300 bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/70 hover:bg-amber-50 dark:hover:bg-amber-950/50 rounded cursor-pointer"
                            >
                              PID {c}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Full Redacted SQL Preview */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <span>{tr('Active / Last SQL Statement', 'လက်ရှိ / နောက်ဆုံး SQL')}</span>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          `sql-${selectedNode.pid}`,
                          selectedNode.session.query || ''
                        )
                      }
                      className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
                    >
                      {copiedKey === `sql-${selectedNode.pid}` ? (
                        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      <span>{tr('Copy SQL', 'SQL ကူးရန်')}</span>
                    </button>
                  </div>
                  <pre className="p-3 bg-slate-900 dark:bg-slate-950 border border-slate-800 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words leading-relaxed max-h-48">
                    {selectedNode.session.query || '-- No query text available'}
                  </pre>
                </div>

                {/* Safe Copyable DBA Remediation Commands */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <Terminal className="w-3.5 h-3.5" />
                    <span>
                      {tr(
                        'DBA Remediation Commands (Copy to psql)',
                        'DBA ပြင်ဆင်မှု SQL အမိန့်များ'
                      )}
                    </span>
                  </div>

                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          `cancel-${selectedNode.pid}`,
                          `SELECT pg_cancel_backend(${selectedNode.pid});`
                        )
                      }
                      className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-amber-800 dark:text-amber-300 bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/70 hover:bg-amber-50 dark:hover:bg-amber-950/50 rounded-lg cursor-pointer"
                    >
                      <span className="font-mono truncate">
                        SELECT pg_cancel_backend({selectedNode.pid});
                      </span>
                      {copiedKey === `cancel-${selectedNode.pid}` ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 shrink-0" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          `term-${selectedNode.pid}`,
                          `SELECT pg_terminate_backend(${selectedNode.pid});`
                        )
                      }
                      className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-400 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-lg cursor-pointer"
                    >
                      <span className="font-mono truncate">
                        SELECT pg_terminate_backend({selectedNode.pid});
                      </span>
                      {copiedKey === `term-${selectedNode.pid}` ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 shrink-0" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          `diag-${selectedNode.pid}`,
                          `SELECT pid, usename, state, wait_event_type, wait_event, now() - xact_start AS xact_age, pg_blocking_pids(pid) AS blocked_by, left(query, 200) AS query\nFROM pg_stat_activity\nWHERE pid = ${selectedNode.pid} OR ${selectedNode.pid} = ANY(pg_blocking_pids(pid));`
                        )
                      }
                      className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
                    >
                      <span className="truncate">
                        {tr(
                          'Copy pg_stat_activity Lineage Query',
                          'pg_stat_activity စစ်ဆေး SQL ကူးရန်'
                        )}
                      </span>
                      {copiedKey === `diag-${selectedNode.pid}` ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 shrink-0" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
                {tr(
                  'Select any session node in the tree to inspect its SQL, lock lineage, and safe remediation commands.',
                  'SQL၊ ပိတ်ဆို့မှု အဆက်အသွယ် နှင့် ပြင်ဆင်မှု SQL များ ကြည့်ရှုရန် သစ်ပင်ပုံရှိ Session တစ်ခုကို ရွေးချယ်ပါ။'
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
