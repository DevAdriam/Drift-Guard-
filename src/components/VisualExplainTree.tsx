import { useMemo, useState } from 'react';
import type { QueryPlanNodeDto } from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface VisualExplainTreeProps {
  root: QueryPlanNodeDto;
  totalCost: number;
}

interface FlattenedPlanNode {
  id: string;
  node: QueryPlanNodeDto;
  depth: number;
  parentId: string | null;
  exclusiveCost: number;
  costSharePct: number;
}

function flattenPlan(
  root: QueryPlanNodeDto,
  totalCost: number
): FlattenedPlanNode[] {
  const out: FlattenedPlanNode[] = [];
  let seq = 0;

  const walk = (node: QueryPlanNodeDto, depth: number, parentId: string | null) => {
    const id = `node-${seq++}`;
    const childrenCost = node.children.reduce(
      (sum, c) => sum + (c.totalCost || 0),
      0
    );
    const exclusiveCost = Math.max(0, node.totalCost - childrenCost);
    const costSharePct =
      totalCost > 0
        ? Math.min(100, Math.round((node.totalCost / totalCost) * 1000) / 10)
        : 0;
    out.push({ id, node, depth, parentId, exclusiveCost, costSharePct });
    for (const child of node.children) {
      walk(child, depth + 1, id);
    }
  };

  walk(root, 0, null);
  return out;
}

export function VisualExplainTree({ root, totalCost }: VisualExplainTreeProps) {
  const { tr } = useI18n();
  const nodes = useMemo(
    () => flattenPlan(root, totalCost),
    [root, totalCost]
  );
  const [selectedId, setSelectedId] = useState<string>(nodes[0]?.id ?? 'node-0');

  const selected =
    nodes.find((n) => n.id === selectedId) ?? nodes[0] ?? null;

  // Group nodes by depth level for visual flow graph rendering
  const byDepth = useMemo(() => {
    const map = new Map<number, FlattenedPlanNode[]>();
    for (const item of nodes) {
      const list = map.get(item.depth) ?? [];
      list.push(item);
      map.set(item.depth, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [nodes]);

  return (
    <div className="space-y-4">
      {/* Visual Hierarchical Flow Graph */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 p-4 overflow-x-auto">
        <div className="space-y-5 min-w-[600px]">
          {byDepth.map(([depth, levelNodes]) => (
            <div key={depth} className="space-y-2">
              <div className="flex items-center gap-2 text-[11px] font-medium text-slate-400 dark:text-slate-500">
                <span className="font-mono tabular-nums">
                  {tr(`Stage ${depth + 1}`, `အဆင့် ${depth + 1}`)}
                </span>
                <div className="h-px bg-slate-200 dark:bg-slate-700 flex-1" />
              </div>

              <div className="flex flex-wrap items-stretch justify-center gap-4">
                {levelNodes.map((item) => {
                  const n = item.node;
                  const isSeq = n.nodeType === 'Seq Scan' || n.isSeqScanBottleneck;
                  const isSort = n.nodeType.includes('Sort');
                  const isIndex = n.nodeType.includes('Index');
                  const isSelected = selected?.id === item.id;

                  const borderCls = isSelected
                    ? 'border-blue-700 dark:border-blue-500 ring-2 ring-blue-700/15 bg-white dark:bg-slate-900'
                    : isSeq
                      ? 'border-red-300 dark:border-red-800/70 bg-red-50/40 dark:bg-red-950/35 hover:bg-white dark:hover:bg-slate-800'
                      : isSort
                        ? 'border-amber-300 dark:border-amber-800/70 bg-amber-50/40 dark:bg-amber-950/35 hover:bg-white dark:hover:bg-slate-800'
                        : isIndex
                          ? 'border-emerald-300 dark:border-emerald-800/70 bg-emerald-50/35 dark:bg-emerald-950/35 hover:bg-white dark:hover:bg-slate-800'
                          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700';

                  const barColor = isSeq
                    ? 'bg-red-600'
                    : isSort
                      ? 'bg-amber-500'
                      : isIndex
                        ? 'bg-emerald-600'
                        : 'bg-blue-600';

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className={`w-64 text-left rounded-lg border p-3 transition-all cursor-pointer ${borderCls}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={`text-xs font-semibold truncate ${
                            isSeq
                              ? 'text-red-700 dark:text-red-400'
                              : isSort
                                ? 'text-amber-800 dark:text-amber-300'
                                : isIndex
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-slate-900 dark:text-slate-100'
                          }`}
                        >
                          {n.nodeType}
                        </span>
                        <span className="text-[11px] font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                          {item.costSharePct}%
                        </span>
                      </div>

                      {n.relationName && (
                        <p className="mt-0.5 text-[11px] font-mono text-slate-600 dark:text-slate-300 truncate">
                          {n.schema ? `${n.schema}.` : ''}
                          {n.relationName}
                        </p>
                      )}

                      {/* Cost % Bar */}
                      <div className="mt-2 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${barColor}`}
                          style={{
                            width: `${Math.max(4, Math.min(100, item.costSharePct))}%`,
                          }}
                        />
                      </div>

                      <div className="mt-2 flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        <span>
                          {tr('cost', 'ကုန်ကျစရိတ်')} {n.totalCost.toFixed(1)}
                        </span>
                        <span>
                          {n.planRows.toLocaleString()} {tr('rows', 'တန်း')}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Selected Node Inspector */}
      {selected && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2.5 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {tr('Selected Plan Node', 'ရွေးချယ်ထားသော Plan Node')}:{' '}
                {selected.node.nodeType}
              </span>
              {selected.node.relationName && (
                <>
                  <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-mono text-slate-700 dark:text-slate-300">
                    {selected.node.schema ? `${selected.node.schema}.` : ''}
                    {selected.node.relationName}
                  </span>
                </>
              )}
              {selected.node.isSeqScanBottleneck && (
                <>
                  <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-semibold text-red-700 dark:text-red-400">
                    {tr('Sequential Scan Bottleneck', 'Seq Scan နှေးကွေးမှု')}
                  </span>
                </>
              )}
            </div>
            <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
              {tr('Startup', 'အစ')}: {selected.node.startupCost.toFixed(2)} ·{' '}
              {tr('Total', 'စုစုပေါင်း')}: {selected.node.totalCost.toFixed(2)} ·{' '}
              {tr('Exclusive', 'သီးသန့်')}: {selected.exclusiveCost.toFixed(2)} ·{' '}
              {tr('Width', 'အကျယ်')}: {selected.node.planWidth} B
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
            {selected.node.filter && (
              <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 font-mono text-slate-700 dark:text-slate-300">
                <span className="text-slate-400 dark:text-slate-500">Filter: </span>
                {selected.node.filter}
              </div>
            )}
            {selected.node.indexName && (
              <div className="bg-emerald-50/50 dark:bg-emerald-950/35 border border-emerald-200 dark:border-emerald-900/70 rounded-lg px-3 py-2 font-mono text-emerald-900 dark:text-emerald-200">
                <span className="text-emerald-700 dark:text-emerald-400 font-semibold">Index: </span>
                {selected.node.indexName}
                {selected.node.indexCond ? ` (${selected.node.indexCond})` : ''}
              </div>
            )}
            {selected.node.sortKey && selected.node.sortKey.length > 0 && (
              <div className="bg-amber-50/50 dark:bg-amber-950/35 border border-amber-200 dark:border-amber-900/70 rounded-lg px-3 py-2 font-mono text-amber-900 dark:text-amber-200">
                <span className="text-amber-700 dark:text-amber-400 font-semibold">Sort Key: </span>
                {selected.node.sortKey.join(', ')}
              </div>
            )}
            {selected.node.hashCond && (
              <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 font-mono text-slate-700 dark:text-slate-300">
                <span className="text-slate-400 dark:text-slate-500">Hash Cond: </span>
                {selected.node.hashCond}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
