import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Eye,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  ExplainPlanAnalysisResponse,
  IndexAdvisorRecommendation,
  IndexAdvisorResponse,
  MonitoredDatabaseDto,
  QueryPlanNodeDto,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface IndexAdvisorPanelProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  selectedTargetId: string;
  onTargetChange: (nextId: string) => void;
}

type AdvisorSubTab = 'recommendations' | 'explain';
type KindFilter = 'all' | 'COMPOSITE' | 'SINGLE_COLUMN';

function severityClass(severity: IndexAdvisorRecommendation['severity']): string {
  switch (severity) {
    case 'CRITICAL':
      return 'text-red-700';
    case 'WARNING':
      return 'text-amber-700';
    default:
      return 'text-blue-700';
  }
}

function buildSimulatedWorkloadReport(
  targetLabel: string,
  locale: 'en' | 'my'
): IndexAdvisorResponse {
  const isMy = locale === 'my';
  return {
    targetLabel,
    databaseId: null,
    collectedAt: new Date().toISOString(),
    tablesAnalyzed: 14,
    highLatencyQueriesAnalyzed: 5,
    seqScanHotspots: [
      {
        schemaname: 'public',
        relname: 'orders',
        seq_scan: 1842,
        seq_tup_read: 94_210_400,
        idx_scan: 310,
        seq_scan_pct: 85.6,
        n_live_tup: 428_500,
        table_size_pretty: '612 MB',
        table_bytes: 641_728_512,
        existing_index_count: 1,
      },
      {
        schemaname: 'public',
        relname: 'audit_events',
        seq_scan: 940,
        seq_tup_read: 31_880_000,
        idx_scan: 215,
        seq_scan_pct: 81.4,
        n_live_tup: 1_240_000,
        table_size_pretty: '890 MB',
        table_bytes: 933_232_640,
        existing_index_count: 1,
      },
      {
        schemaname: 'public',
        relname: 'webhook_deliveries',
        seq_scan: 615,
        seq_tup_read: 8_420_100,
        idx_scan: 490,
        seq_scan_pct: 55.7,
        n_live_tup: 185_200,
        table_size_pretty: '148 MB',
        table_bytes: 155_189_248,
        existing_index_count: 2,
      },
    ],
    recommendations: [
      {
        id: 'sim-orders-composite',
        kind: 'COMPOSITE',
        severity: 'CRITICAL',
        source: 'QUERY_PLAN',
        schemaName: 'public',
        tableName: 'orders',
        columns: ['tenant_id', 'status', 'created_at DESC'],
        indexName: 'idx_orders_tenant_id_status_created_at',
        createIndexSql:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_tenant_id_status_created_at"\n  ON "public"."orders" ("tenant_id", "status", "created_at" DESC);',
        rationale: isMy
          ? 'နှောင့်နှေးမှုမြင့် query (ပျမ်းမျှ 118.4 ms) သည် 428,500 အတန်းကို Seq Scan ဖြင့် ဖတ်ပြီး created_at DESC ဖြင့် စီနေပါသည်။ Equality → Sort အစဉ်အတိုင်း (tenant_id, status, created_at DESC) ပေါင်းစပ် အညွှန်း ဖန်တီးခြင်းဖြင့် Seq Scan နှင့် Sort နှစ်ခုလုံးကို ဖယ်ရှားနိုင်ပါသည်။'
          : 'High-latency query (118.4 ms avg) scans 428,500 heap rows via Seq Scan followed by an external Quicksort on created_at DESC. Ordering keys by Equality → Sort (tenant_id, status, created_at DESC) satisfies both the WHERE predicate and ORDER BY without a Sort node.',
        estimatedSpeedupLabel: isMy
          ? '~၈–၂၀ ဆ ပိုမြန် · Seq Scan နှင့် Sort ဖယ်ရှားပေးသည်'
          : '~8–20× faster · Eliminates Seq Scan & Sort',
        evidence: {
          meanLatencyMs: 118.4,
          seqScans: 1842,
          seqTupRead: 94_210_400,
          idxScans: 310,
          seqScanPct: 85.6,
          tableSizePretty: '612 MB',
          sampleQuery:
            "SELECT id, customer_id, total_cents, created_at\nFROM public.orders\nWHERE tenant_id = 't_8812' AND status = 'PENDING'\nORDER BY created_at DESC\nLIMIT 50;",
        },
      },
      {
        id: 'sim-audit-composite',
        kind: 'COMPOSITE',
        severity: 'CRITICAL',
        source: 'QUERY_PLAN',
        schemaName: 'public',
        tableName: 'audit_events',
        columns: ['workspace_id', 'action', 'created_at DESC'],
        indexName: 'idx_audit_events_workspace_id_action_created_at',
        createIndexSql:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_audit_events_workspace_id_action_created_at"\n  ON "public"."audit_events" ("workspace_id", "action", "created_at" DESC);',
        rationale: isMy
          ? 'public.audit_events သည် ဖတ်ရှုမှု 81.4% ကို sequential scan ဖြင့် ပြုလုပ်နေပါသည် (890 MB အတွင်း 31.8M အတန်း)။ (workspace_id, action, created_at DESC) ပေါင်းစပ် B-Tree အညွှန်း ထည့်သွင်းခြင်းဖြင့် မှတ်တမ်းရှာဖွေမှုများကို လျင်မြန်စေပါသည်။'
          : 'public.audit_events serves 81.4% of reads via sequential scans (31.8M tuples read across 890 MB). Adding a composite B-Tree index on (workspace_id, action, created_at DESC) enables backward index scans for chronological workspace activity feeds.',
        estimatedSpeedupLabel: isMy
          ? '~၆–၁၄ ဆ ပိုမြန် · 890 MB ဇယားတစ်ခုလုံး ဖတ်ခြင်းကို ဖယ်ရှားပေးသည်'
          : '~6–14× faster · Eliminates 890 MB heap scans',
        evidence: {
          meanLatencyMs: 74.2,
          seqScans: 940,
          seqTupRead: 31_880_000,
          idxScans: 215,
          seqScanPct: 81.4,
          tableSizePretty: '890 MB',
        },
      },
      {
        id: 'sim-webhooks-single',
        kind: 'SINGLE_COLUMN',
        severity: 'WARNING',
        source: 'SEQ_SCAN_STATS',
        schemaName: 'public',
        tableName: 'webhook_deliveries',
        columns: ['next_retry_at'],
        indexName: 'idx_webhook_deliveries_next_retry_at',
        createIndexSql:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_webhook_deliveries_next_retry_at"\n  ON "public"."webhook_deliveries" ("next_retry_at");',
        rationale: isMy
          ? 'Webhook ပြန်ပို့သည့် worker သည် next_retry_at <= NOW() ကို sequential scan ဖြင့် ထပ်ခါတလဲလဲ စစ်ဆေးနေပါသည် (615 seq scan, 55.7%)။ next_retry_at တွင် အညွှန်း ဖန်တီးခြင်းဖြင့် index range scan အဖြစ် ပြောင်းလဲပေးပါသည်။'
          : 'Retry queue worker repeatedly performs sequential scans on next_retry_at <= NOW() (615 seq scans, 55.7% scan ratio). Indexing next_retry_at converts worker polling into an index range scan.',
        estimatedSpeedupLabel: isMy
          ? '~၃–၆ ဆ ပိုမြန် · Worker Seq Scan ကို အစားထိုးပေးသည်'
          : '~3–6× faster · Replaces worker Seq Scan',
        evidence: {
          meanLatencyMs: 28.9,
          seqScans: 615,
          seqTupRead: 8_420_100,
          idxScans: 490,
          seqScanPct: 55.7,
          tableSizePretty: '148 MB',
        },
      },
    ],
    sampleQueriesForExplain: [],
  };
}

function PlanTreeNode({
  node,
  depth = 0,
}: {
  node: QueryPlanNodeDto;
  depth?: number;
}) {
  const { locale, tr } = useI18n();
  const isIndexScan =
    node.nodeType.includes('Index') || node.nodeType.includes('Bitmap Index');
  const isSeqScan = node.nodeType === 'Seq Scan';
  const isSort = node.nodeType === 'Sort';

  return (
    <div
      className={depth > 0 ? 'ml-5 pl-4 border-l border-slate-200 mt-2.5' : ''}
    >
      <div
        className={`rounded-lg border px-3.5 py-2.5 text-xs ${
          isSeqScan
            ? 'bg-red-50/50 border-red-200'
            : isSort
              ? 'bg-amber-50/50 border-amber-200'
              : isIndexScan
                ? 'bg-emerald-50/40 border-emerald-200'
                : 'bg-slate-50/60 border-slate-200'
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={`font-semibold ${
                isSeqScan
                  ? 'text-red-700'
                  : isSort
                    ? 'text-amber-800'
                    : isIndexScan
                      ? 'text-emerald-700'
                      : 'text-slate-900'
              }`}
            >
              {node.nodeType}
            </span>
            {node.relationName && (
              <>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono font-medium text-slate-800">
                  {node.schema ? `${node.schema}.` : ''}
                  {node.relationName}
                  {node.alias && node.alias !== node.relationName
                    ? ` AS ${node.alias}`
                    : ''}
                </span>
              </>
            )}
            {node.indexName && (
              <>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono text-emerald-700">
                  {tr('using', 'အသုံးပြု အညွှန်း')} {node.indexName}
                </span>
              </>
            )}
            {isSeqScan && (
              <>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="font-semibold text-red-700">
                  {tr('Full Table Scan', 'ဇယားတစ်ခုလုံး ဖတ်ခြင်း')}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] text-slate-600 tabular-nums">
            <span>
              {tr('cost', 'ကုန်ကျစရိတ်')} {node.startupCost.toFixed(2)}..
              {node.totalCost.toFixed(2)}
            </span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span>
              {locale === 'my'
                ? `${node.planRows.toLocaleString()} အတန်း`
                : `${node.planRows.toLocaleString()} rows`}
            </span>
          </div>
        </div>

        {(node.filter ||
          node.indexCond ||
          node.sortKey?.length ||
          node.hashCond) && (
          <div className="mt-1.5 space-y-1 font-mono text-[11px] text-slate-600">
            {node.filter && (
              <p className="break-words">
                <span className="text-slate-500 font-sans font-medium">
                  {tr('Filter:', 'စစ်ထုတ်ချက်:')}{' '}
                </span>
                {node.filter}
              </p>
            )}
            {node.indexCond && (
              <p className="break-words">
                <span className="text-slate-500 font-sans font-medium">
                  {tr('Index Cond:', 'အညွှန်း အခြေအနေ:')}{' '}
                </span>
                {node.indexCond}
              </p>
            )}
            {node.sortKey && node.sortKey.length > 0 && (
              <p className="break-words">
                <span className="text-slate-500 font-sans font-medium">
                  {tr('Sort Key:', 'စီစဉ်ကော်လံ:')}{' '}
                </span>
                {node.sortKey.join(', ')}
              </p>
            )}
            {node.hashCond && (
              <p className="break-words">
                <span className="text-slate-500 font-sans font-medium">
                  {tr('Hash Cond:', 'Hash အခြေအနေ:')}{' '}
                </span>
                {node.hashCond}
              </p>
            )}
          </div>
        )}
      </div>

      {node.children.map((child, idx) => (
        <PlanTreeNode
          key={`${child.nodeType}-${child.relationName ?? idx}-${depth}-${idx}`}
          node={child}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function IndexAdvisorPanel({
  api,
  databases,
  selectedTargetId,
  onTargetChange,
}: IndexAdvisorPanelProps) {
  const { locale, t, tr, formatEnv, formatSeverity } = useI18n();

  const [liveReport, setLiveReport] = useState<IndexAdvisorResponse | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [subTab, setSubTab] = useState<AdvisorSubTab>('recommendations');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // EXPLAIN analyzer state
  const [explainSql, setExplainSql] = useState('');
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainResult, setExplainResult] =
    useState<ExplainPlanAnalysisResponse | null>(null);

  const loadAdvisor = useCallback(
    async (dbId: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getIndexAdvisor(dbId || undefined);
        setLiveReport(res);
        setExplainSql((prev) => {
          if (prev.trim()) return prev;
          return res.sampleQueriesForExplain[0]?.sql ?? '';
        });
      } catch (err) {
        setLiveReport(null);
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Unable to run Index Advisor on the selected target.',
                'ရွေးချယ်ထားသော ပစ်မှတ်တွင် အညွှန်း အကြံပေးစနစ်ကို လုပ်ဆောင်၍ မရပါ။'
              )
        );
      } finally {
        setLoading(false);
      }
    },
    [api, tr]
  );

  useEffect(() => {
    setExplainResult(null);
    setExplainError(null);
    setExplainSql('');
    loadAdvisor(selectedTargetId);
  }, [selectedTargetId, loadAdvisor]);

  const activeReport = useMemo(() => {
    if (previewMode) {
      return buildSimulatedWorkloadReport(
        liveReport?.targetLabel ??
          tr(
            'Workspace PostgreSQL (Simulated Preview)',
            'လုပ်ငန်းခွင် PostgreSQL (နမူနာ အစမ်းကြည့်)'
          ),
        locale
      );
    }
    return liveReport;
  }, [previewMode, liveReport, locale, tr]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const runExplain = async (sqlOverride?: string) => {
    const queryToRun = (sqlOverride ?? explainSql).trim();
    if (!queryToRun) {
      setExplainError(
        tr(
          'Enter a read-only SELECT query to analyze.',
          'ခွဲခြမ်းစိတ်ဖြာရန် ဖတ်ရှုသီးသန့် SELECT query တစ်ခု ထည့်သွင်းပါ။'
        )
      );
      return;
    }
    setExplainLoading(true);
    setExplainError(null);
    try {
      const res = await api.explainQueryPlan({
        databaseId: selectedTargetId || undefined,
        sql: queryToRun,
      });
      setExplainResult(res);
    } catch (err) {
      setExplainResult(null);
      setExplainError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to analyze query plan.',
              'Query execution plan ကို ခွဲခြမ်းစိတ်ဖြာ၍ မရပါ။'
            )
      );
    } finally {
      setExplainLoading(false);
    }
  };

  const recommendations = activeReport?.recommendations ?? [];
  const filteredRecommendations = useMemo(() => {
    if (kindFilter === 'all') return recommendations;
    return recommendations.filter((r) => r.kind === kindFilter);
  }, [recommendations, kindFilter]);

  const compositeCount = recommendations.filter(
    (r) => r.kind === 'COMPOSITE'
  ).length;
  const singleCount = recommendations.filter(
    (r) => r.kind === 'SINGLE_COLUMN'
  ).length;
  const elevatedHotspotsCount = (activeReport?.seqScanHotspots ?? []).filter(
    (h) => h.seq_scan >= 5 && h.seq_scan_pct >= 50
  ).length;

  return (
    <section
      aria-labelledby="index-advisor-heading"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
    >
      {/* Panel Header */}
      <div className="px-6 py-5 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="index-advisor-heading"
              className="text-base font-semibold text-slate-900"
            >
              {tr('Index Advisor', 'အညွှန်း အကြံပေးစနစ်')}
            </h2>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500">
              {tr(
                'Query plan & sequential scan analysis',
                'Query plan နှင့် sequential scan ခွဲခြမ်းစိတ်ဖြာခြင်း'
              )}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {tr(
              'Inspects PostgreSQL query plans and sequential scan hotspots to recommend missing single-column and ESR composite B-Tree indexes.',
              'PostgreSQL query plan များနှင့် sequential scan များပြားသော ဇယားများကို စစ်ဆေး၍ လိုအပ်နေသော ကော်လံတစ်ခုနှင့် ESR ပေါင်းစပ် B-Tree အညွှန်းများကို အကြံပြုပေးပါသည်။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <span className="whitespace-nowrap">
              {tr('Source', 'အရင်းအမြစ်')}
            </span>
            <select
              value={selectedTargetId}
              onChange={(e) => {
                setPreviewMode(false);
                onTargetChange(e.target.value);
              }}
              aria-label={tr(
                'Select PostgreSQL target for Index Advisor',
                'အညွှန်း အကြံပေးစနစ်အတွက် PostgreSQL ပစ်မှတ် ရွေးချယ်ရန်'
              )}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 max-w-[200px] truncate"
            >
              <option value="">
                {tr(
                  'Workspace PostgreSQL (Live)',
                  'လုပ်ငန်းခွင် PostgreSQL (တိုက်ရိုက်)'
                )}
              </option>
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({formatEnv(d.environment)})
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setPreviewMode(false);
              loadAdvisor(selectedTargetId);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            <span>
              {loading
                ? tr('Scanning…', 'စစ်ဆေးနေသည်…')
                : t('action.refresh')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSubTab('recommendations');
              setPreviewMode((prev) => !prev);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              previewMode
                ? 'text-amber-900 bg-amber-50 border-amber-300 hover:bg-amber-100'
                : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>
              {previewMode
                ? tr('Return to Live Advisor', 'တိုက်ရိုက် အကြံပေးစနစ်သို့ ပြန်ရန်')
                : tr('Preview Workload', 'နမူနာ အစမ်းကြည့်ရန်')}
            </span>
          </button>
        </div>
      </div>

      {/* Explicit Simulated Preview Banner */}
      {previewMode && (
        <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900">
          <span>
            {tr(
              'Showing simulated high-latency sequential-scan workload to preview composite and single-column index recommendations.',
              'ပေါင်းစပ် အညွှန်းနှင့် ကော်လံတစ်ခု အညွှန်း အကြံပြုချက်များကို အစမ်းကြည့်ရှုရန် နှောင့်နှေးမှုမြင့် sequential-scan နမူနာဒေတာကို ဖော်ပြထားပါသည်။'
            )}
          </span>
          <button
            type="button"
            onClick={() => setPreviewMode(false)}
            className="font-semibold underline hover:text-amber-950 whitespace-nowrap cursor-pointer"
          >
            {tr('Return to live telemetry', 'တိုက်ရိုက် ဒေတာသို့ ပြန်သွားရန်')}
          </button>
        </div>
      )}

      {/* 4-Column Summary Strip */}
      {!loading && (!error || previewMode) && activeReport && (
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/50">
          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Index Opportunities', 'အညွှန်း အကြံပြုချက်များ')}
            </p>
            <p
              className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                recommendations.length > 0
                  ? 'text-blue-700'
                  : 'text-emerald-700'
              }`}
            >
              {recommendations.length}
            </p>
            <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
              {locale === 'my'
                ? `ပေါင်းစပ် ${compositeCount} ခု · ကော်လံတစ်ခု ${singleCount} ခု`
                : `${compositeCount} composite · ${singleCount} single-column`}
            </p>
          </div>

          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Composite Indexes (ESR)', 'ပေါင်းစပ် အညွှန်းများ (ESR)')}
            </p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {compositeCount}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {tr(
                'Multi-column Equality → Sort → Range',
                'ကော်လံများစွာ Equality → Sort → Range'
              )}
            </p>
          </div>

          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Seq-Scan Hotspots', 'Seq-Scan များပြားသော ဇယားများ')}
            </p>
            <p
              className={`mt-1 text-xl font-bold font-mono tabular-nums ${
                elevatedHotspotsCount > 0
                  ? 'text-amber-700'
                  : 'text-emerald-700'
              }`}
            >
              {elevatedHotspotsCount}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {tr(
                'Tables with ≥ 50% sequential scans',
                'Sequential scan 50% နှင့်အထက် ရှိသော ဇယားများ'
              )}
            </p>
          </div>

          <div className="px-6 py-4">
            <p className="text-xs font-medium text-slate-500">
              {tr('Catalog Coverage', 'စစ်ဆေးပြီး Catalog ပမာဏ')}
            </p>
            <p className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
              {locale === 'my'
                ? `ဇယား ${activeReport.tablesAnalyzed} ခု`
                : `${activeReport.tablesAnalyzed} tables`}
            </p>
            <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
              {locale === 'my'
                ? `နှေးကွေးသော SELECT query ${activeReport.highLatencyQueriesAnalyzed} ခု စစ်ဆေးပြီး`
                : `${activeReport.highLatencyQueriesAnalyzed} slow SELECT queries checked`}
            </p>
          </div>
        </div>
      )}

      {/* Sub-Tabs Bar */}
      <div className="px-6 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-white">
        <div
          role="tablist"
          aria-label={tr('Index Advisor views', 'အညွှန်း အကြံပေး မြင်ကွင်းများ')}
          className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'recommendations'}
            onClick={() => setSubTab('recommendations')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              subTab === 'recommendations'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tr(
              'Recommendations & Hotspots',
              'အကြံပြုချက်များနှင့် Seq-Scan ဇယားများ'
            )}{' '}
            ({recommendations.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'explain'}
            onClick={() => setSubTab('explain')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              subTab === 'explain'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tr(
              'Query Plan Analyzer (EXPLAIN)',
              'Query Plan ခွဲခြမ်းစိတ်ဖြာစက် (EXPLAIN)'
            )}
          </button>
        </div>

        {subTab === 'recommendations' && recommendations.length > 0 && (
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                {
                  id: 'all',
                  label: `${tr('All', 'အားလုံး')} (${recommendations.length})`,
                },
                {
                  id: 'COMPOSITE',
                  label: `${tr('Composite', 'ပေါင်းစပ်')} (${compositeCount})`,
                },
                {
                  id: 'SINGLE_COLUMN',
                  label: `${tr('Single-Column', 'ကော်လံတစ်ခု')} (${singleCount})`,
                },
              ] as { id: KindFilter; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setKindFilter(opt.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums cursor-pointer ${
                  kindFilter === opt.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* TAB 1: Recommendations & Sequential-Scan Hotspots */}
      {subTab === 'recommendations' && (
        <>
          {loading && !previewMode ? (
            <div className="p-6 space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-24 bg-slate-100 rounded-lg animate-pulse"
                />
              ))}
            </div>
          ) : error && !previewMode ? (
            <div className="p-8 text-center space-y-3">
              <p className="text-sm font-medium text-red-700">{error}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => loadAdvisor(selectedTargetId)}
                  className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  {tr('Retry', 'ပြန်စမ်းရန်')}
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewMode(true)}
                  className="px-3.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg cursor-pointer"
                >
                  {tr('Preview Workload', 'နမူနာ အစမ်းကြည့်ရန်')}
                </button>
              </div>
            </div>
          ) : (
            <div>
              {filteredRecommendations.length === 0 ? (
                <div className="px-6 py-8 text-center space-y-2 border-b border-slate-200">
                  <p className="text-sm font-semibold text-emerald-700">
                    {tr(
                      'No Missing Index Opportunities Detected',
                      'လိုအပ်နေသော အညွှန်း အကြံပြုချက် မတွေ့ရှိပါ'
                    )}
                  </p>
                  <p className="text-xs text-slate-500 max-w-lg mx-auto">
                    {locale === 'my' ? (
                      <>
                        <span className="font-medium text-slate-700">
                          {activeReport?.targetLabel}
                        </span>{' '}
                        ရှိ စစ်ဆေးပြီး query များနှင့် ဇယားအားလုံးတွင် လက်ရှိ
                        အညွှန်းများ လုံလောက်စွာ ရှိနေပါသည်။ ကိုယ်ပိုင် SELECT
                        query ကို စမ်းသပ်ရန်{' '}
                        <strong className="font-semibold text-slate-800">
                          Query Plan ခွဲခြမ်းစိတ်ဖြာစက် (EXPLAIN)
                        </strong>{' '}
                        သို့ ပြောင်းလဲကြည့်ရှုနိုင်ပါသည်။
                      </>
                    ) : (
                      <>
                        All analyzed queries and sequential-scan tables on{' '}
                        <span className="font-medium text-slate-700">
                          {activeReport?.targetLabel}
                        </span>{' '}
                        are covered by existing indexes. Switch to the{' '}
                        <strong className="font-semibold text-slate-800">
                          Query Plan Analyzer (EXPLAIN)
                        </strong>{' '}
                        tab to test a custom SELECT statement directly against
                        the PostgreSQL planner.
                      </>
                    )}
                  </p>
                  <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSubTab('explain')}
                      className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer"
                    >
                      {tr(
                        'Open EXPLAIN Analyzer',
                        'EXPLAIN ခွဲခြမ်းစိတ်ဖြာစက် ဖွင့်ရန်'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewMode(true)}
                      className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
                    >
                      {tr('Preview Workload', 'နမူနာ အစမ်းကြည့်ရန်')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-slate-200 border-b border-slate-200">
                  {filteredRecommendations.map((rec) => (
                    <div key={rec.id} className="px-6 py-5 space-y-3">
                      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span
                              className={`font-semibold ${severityClass(
                                rec.severity
                              )}`}
                            >
                              {formatSeverity(rec.severity)}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-semibold text-slate-900">
                              {rec.kind === 'COMPOSITE'
                                ? tr(
                                    'Composite Index Opportunity',
                                    'ပေါင်းစပ် အညွှန်း (Composite) အခွင့်အလမ်း'
                                  )
                                : tr(
                                    'Missing Single-Column Index',
                                    'လိုအပ်နေသော ကော်လံတစ်ခု အညွှန်း'
                                  )}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-mono text-slate-700">
                              {rec.schemaName}.{rec.tableName}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              ·
                            </span>
                            <span className="text-emerald-700 font-medium">
                              {rec.estimatedSpeedupLabel}
                            </span>
                          </div>

                          <p className="text-xs font-mono text-slate-800">
                            <span className="font-sans text-slate-500">
                              {tr(
                                'Recommended Key Columns:',
                                'အကြံပြု အဓိက ကော်လံများ:'
                              )}{' '}
                            </span>
                            ({rec.columns.join(', ')})
                          </p>

                          <p className="text-xs text-slate-600 leading-relaxed max-w-4xl">
                            {rec.rationale}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {rec.evidence.sampleQuery && !previewMode && (
                            <button
                              type="button"
                              onClick={() => {
                                setExplainSql(rec.evidence.sampleQuery!);
                                setSubTab('explain');
                                runExplain(rec.evidence.sampleQuery!);
                              }}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Play className="w-3 h-3" />
                              <span>
                                {tr('Run EXPLAIN', 'EXPLAIN စစ်ဆေးရန်')}
                              </span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() =>
                              handleCopy(`rec-${rec.id}`, rec.createIndexSql)
                            }
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            {copiedId === `rec-${rec.id}` ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-700" />
                                <span>
                                  {tr('Copied DDL', 'DDL ကူးယူပြီး')}
                                </span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>{tr('Copy DDL', 'DDL ကူးယူရန်')}</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      <pre className="p-3.5 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
                        {rec.createIndexSql}
                      </pre>
                    </div>
                  ))}
                </div>
              )}

              {/* Sequential Scan Hotspots Table */}
              {activeReport && activeReport.seqScanHotspots.length > 0 && (
                <div>
                  <div className="px-6 py-3.5 bg-slate-50/70 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-slate-900">
                      {tr(
                        'Sequential Scan Hotspots (pg_stat_user_tables)',
                        'Sequential Scan များပြားသော ဇယားများ (pg_stat_user_tables)'
                      )}
                    </h3>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {locale === 'my'
                        ? `Sequential ဖတ်ရှုမှု အများဆုံး ဇယား ${activeReport.seqScanHotspots.length} ခု`
                        : `Top ${activeReport.seqScanHotspots.length} relations by sequential rows read`}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                          <th className="py-2.5 pl-6 pr-3">
                            {tr('Table', 'ဇယား')}
                          </th>
                          <th className="py-2.5 px-3 text-right">
                            {tr('Seq Scans', 'Seq Scan')}
                          </th>
                          <th className="py-2.5 px-3 text-right">
                            {tr('Idx Scans', 'Idx Scan')}
                          </th>
                          <th className="py-2.5 px-3 text-right">
                            {tr('Seq Scan %', 'Seq Scan %')}
                          </th>
                          <th className="py-2.5 px-3 text-right">
                            {tr('Seq Tuples Read', 'Seq ဖတ်ရှုအတန်း')}
                          </th>
                          <th className="py-2.5 px-3 text-right">
                            {tr('Table Size', 'ဇယား အရွယ်အစား')}
                          </th>
                          <th className="py-2.5 pl-3 pr-6 text-right">
                            {tr('Indexes', 'အညွှန်းများ')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {activeReport.seqScanHotspots.map((h) => (
                          <tr
                            key={`${h.schemaname}.${h.relname}`}
                            className="hover:bg-slate-50"
                          >
                            <td className="py-2.5 pl-6 pr-3 font-mono font-medium text-slate-900">
                              {h.schemaname}.{h.relname}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                              {h.seq_scan.toLocaleString()}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                              {h.idx_scan.toLocaleString()}
                            </td>
                            <td
                              className={`py-2.5 px-3 text-right font-mono tabular-nums font-semibold ${
                                h.seq_scan_pct >= 75 && h.seq_scan >= 10
                                  ? 'text-red-700'
                                  : h.seq_scan_pct >= 50 && h.seq_scan >= 5
                                    ? 'text-amber-700'
                                    : 'text-emerald-700'
                              }`}
                            >
                              {h.seq_scan_pct.toFixed(1)}%
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                              {h.seq_tup_read.toLocaleString()}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                              {h.table_size_pretty}
                            </td>
                            <td className="py-2.5 pl-3 pr-6 text-right font-mono tabular-nums text-slate-600">
                              {h.existing_index_count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* TAB 2: Live Read-Only Query Plan Analyzer (EXPLAIN FORMAT JSON) */}
      {subTab === 'explain' && (
        <div className="p-6 space-y-5">
          {liveReport && liveReport.sampleQueriesForExplain.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500 font-medium">
                {tr('Load sample query:', 'နမူနာ query ထည့်ရန်:')}
              </span>
              {liveReport.sampleQueriesForExplain.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  onClick={() => {
                    setExplainSql(sample.sql);
                    setExplainError(null);
                  }}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {sample.label}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2.5">
            <label
              htmlFor="index-advisor-explain-sql"
              className="block text-xs font-medium text-slate-700"
            >
              {tr(
                'Read-Only SELECT Query to Inspect via PostgreSQL Planner',
                'PostgreSQL Planner ဖြင့် စစ်ဆေးမည့် ဖတ်ရှုသီးသန့် SELECT Query'
              )}
            </label>
            <textarea
              id="index-advisor-explain-sql"
              rows={5}
              value={explainSql}
              onChange={(e) => setExplainSql(e.target.value)}
              placeholder="SELECT * FROM public.audit_logs WHERE action = 'INSPECTION_RUN' ORDER BY created_at DESC LIMIT 50;"
              className="w-full p-3.5 text-xs font-mono bg-slate-950 text-slate-100 border border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/30 leading-relaxed"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {locale === 'my' ? (
                  <>
                    ပြန်လည်ပယ်ဖျက်မည့်{' '}
                    <code className="font-mono text-slate-700">READ ONLY</code>{' '}
                    transaction အတွင်း{' '}
                    <code className="font-mono text-slate-700">
                      EXPLAIN (FORMAT JSON, COSTS true)
                    </code>{' '}
                    ကိုသာ လုပ်ဆောင်သဖြင့် ဒေတာ ပြောင်းလဲမှု လုံးဝမရှိပါ။
                  </>
                ) : (
                  <>
                    Runs planner-only{' '}
                    <code className="font-mono text-slate-700">
                      EXPLAIN (FORMAT JSON, COSTS true)
                    </code>{' '}
                    inside a rolled-back{' '}
                    <code className="font-mono text-slate-700">READ ONLY</code>{' '}
                    transaction (zero writes or side-effects).
                  </>
                )}
              </p>
              <button
                type="button"
                disabled={explainLoading || !explainSql.trim()}
                onClick={() => runExplain()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>
                  {explainLoading
                    ? tr('Analyzing Plan…', 'Plan ခွဲခြမ်းစိတ်ဖြာနေသည်…')
                    : tr('Analyze Query Plan', 'Query Plan စစ်ဆေးရန်')}
                </span>
              </button>
            </div>
          </div>

          {explainError && (
            <div
              role="alert"
              className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
            >
              {explainError}
            </div>
          )}

          {explainResult && (
            <div className="space-y-5 pt-2 border-t border-slate-200">
              {/* Plan Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 border border-slate-200 rounded-xl bg-slate-50/50">
                <div className="px-4 py-3">
                  <p className="text-[11px] font-medium text-slate-500">
                    {tr('Total Plan Cost', 'စုစုပေါင်း Plan ကုန်ကျစရိတ်')}
                  </p>
                  <p className="mt-0.5 text-base font-bold font-mono tabular-nums text-slate-900">
                    {explainResult.totalCost.toFixed(2)}
                  </p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-[11px] font-medium text-slate-500">
                    {tr('Estimated Rows', 'ခန့်မှန်း အတန်းအရေအတွက်')}
                  </p>
                  <p className="mt-0.5 text-base font-bold font-mono tabular-nums text-slate-900">
                    {explainResult.estimatedRows.toLocaleString()}
                  </p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-[11px] font-medium text-slate-500">
                    {tr('Seq Scan Nodes', 'Seq Scan အဆင့်များ')}
                  </p>
                  <p
                    className={`mt-0.5 text-base font-bold font-mono tabular-nums ${
                      explainResult.seqScanCount > 0
                        ? 'text-red-700'
                        : 'text-emerald-700'
                    }`}
                  >
                    {explainResult.seqScanCount}
                  </p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-[11px] font-medium text-slate-500">
                    {tr('Sort Nodes', 'Sort အဆင့်များ')}
                  </p>
                  <p
                    className={`mt-0.5 text-base font-bold font-mono tabular-nums ${
                      explainResult.sortNodeCount > 0
                        ? 'text-amber-700'
                        : 'text-slate-900'
                    }`}
                  >
                    {explainResult.sortNodeCount}
                  </p>
                </div>
              </div>

              {/* Plan-Derived Recommendations */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-900">
                  {tr(
                    'Index Suggestions From This Query Plan',
                    'ဤ Query Plan မှ အညွှန်း အကြံပြုချက်များ'
                  )}{' '}
                  ({explainResult.recommendations.length})
                </h3>
                {explainResult.recommendations.length === 0 ? (
                  <p className="text-xs text-emerald-700 font-medium">
                    {tr(
                      'No unindexed Seq Scan filter or sort bottlenecks were found in this plan (or existing indexes already cover the predicates).',
                      'ဤ plan တွင် အညွှန်းမရှိသော Seq Scan သို့မဟုတ် Sort ပိတ်ဆို့မှု မတွေ့ရှိပါ (သို့မဟုတ် လက်ရှိ အညွှန်းများက လုံလောက်စွာ လွှမ်းခြုံထားပါသည်)။'
                    )}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {explainResult.recommendations.map((rec) => (
                      <div
                        key={rec.id}
                        className="border border-slate-200 rounded-xl p-4 space-y-2.5 bg-white"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span
                              className={`font-semibold ${severityClass(
                                rec.severity
                              )}`}
                            >
                              {formatSeverity(rec.severity)}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-semibold text-slate-900">
                              {rec.kind === 'COMPOSITE'
                                ? tr(
                                    'Composite Index',
                                    'ပေါင်းစပ် အညွှန်း (Composite)'
                                  )
                                : tr(
                                    'Single-Column Index',
                                    'ကော်လံတစ်ခု အညွှန်း'
                                  )}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-mono text-slate-700">
                              {rec.schemaName}.{rec.tableName} (
                              {rec.columns.join(', ')})
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              handleCopy(`exp-${rec.id}`, rec.createIndexSql)
                            }
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md cursor-pointer whitespace-nowrap shrink-0"
                          >
                            {copiedId === `exp-${rec.id}` ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-700" />
                                <span>
                                  {tr('Copied DDL', 'DDL ကူးယူပြီး')}
                                </span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>{tr('Copy DDL', 'DDL ကူးယူရန်')}</span>
                              </>
                            )}
                          </button>
                        </div>
                        <p className="text-xs text-slate-600 leading-relaxed">
                          {rec.rationale}
                        </p>
                        <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
                          {rec.createIndexSql}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Execution Plan Tree */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-900">
                  {tr(
                    'PostgreSQL Execution Plan Tree',
                    'PostgreSQL လုပ်ဆောင်မှု အဆင့်ဆင့် (Execution Plan Tree)'
                  )}{' '}
                  ({explainResult.targetLabel})
                </h3>
                <PlanTreeNode node={explainResult.planRoot} />
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
