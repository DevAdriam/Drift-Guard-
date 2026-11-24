import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  History,
  RefreshCw,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type { SchemaTimeMachineResponse } from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface SchemaTimeMachinePanelProps {
  api: ApiClient;
  databaseId: string;
}

export function SchemaTimeMachinePanel({
  api,
  databaseId,
}: SchemaTimeMachinePanelProps) {
  const { tr, formatDateTime } = useI18n();
  const [data, setData] = useState<SchemaTimeMachineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromId, setFromId] = useState<string>('');
  const [toId, setToId] = useState<string>('');
  const [sqlTab, setSqlTab] = useState<'up' | 'down'>('down');
  const [copied, setCopied] = useState(false);

  const loadTimeMachine = useCallback(
    async (nextFrom?: string, nextTo?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getDatabaseTimeMachine(
          databaseId,
          nextFrom || undefined,
          nextTo || undefined
        );
        setData(res);
        if (res.comparison) {
          setFromId(res.comparison.fromRevision.id);
          setToId(res.comparison.toRevision.id);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Failed to load schema snapshot time machine.',
                'ဖွဲ့စည်းပုံ မှတ်တမ်း Time Machine ကို ဖွင့်၍ မရပါ။'
              )
        );
      } finally {
        setLoading(false);
      }
    },
    [api, databaseId, tr]
  );

  useEffect(() => {
    loadTimeMachine();
  }, [loadTimeMachine]);

  const handleCompare = () => {
    if (!fromId || !toId) return;
    loadTimeMachine(fromId, toId);
  };

  const activeSql =
    sqlTab === 'up'
      ? data?.comparison?.upMigrationSql ?? ''
      : data?.comparison?.downRollbackSql ?? '';

  const handleCopySql = async () => {
    if (!activeSql) return;
    try {
      await navigator.clipboard.writeText(activeSql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleDownloadSql = () => {
    if (!activeSql || !data?.comparison) return;
    const suffix = sqlTab === 'up' ? 'up_migration' : 'down_rollback';
    const blob = new Blob([activeSql], { type: 'text/sql;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.databaseName}_${suffix}_${data.comparison.fromRevision.schemaHash.slice(0, 6)}_to_${data.comparison.toRevision.schemaHash.slice(0, 6)}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 animate-pulse">
        <div className="h-5 bg-slate-200 dark:bg-slate-700 rounded w-56" />
        <div className="h-44 bg-slate-100 dark:bg-slate-800 rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 rounded-xl p-6 text-sm text-red-700 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (!data || data.revisions.length < 2) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-2">
        <History className="w-6 h-6 text-slate-400 dark:text-slate-500 mx-auto" />
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {tr(
            'At least two schema snapshots or baselines are needed for Time Machine diffing.',
            'Time Machine နှိုင်းယှဉ်မှုအတွက် အနည်းဆုံး ဖွဲ့စည်းပုံ မှတ်တမ်း ၂ ခု လိုအပ်ပါသည်။'
          )}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {tr(
            'Run another inspection or promote a baseline to unlock historical UP/DOWN rollback script generation.',
            'UP/DOWN Rollback SQL များ ထုတ်ယူနိုင်ရန် နောက်ထပ် စစ်ဆေးမှုတစ်ခု ပြုလုပ်ပါ။'
          )}
        </p>
      </div>
    );
  }

  const cmp = data.comparison;

  return (
    <div className="space-y-5">
      {/* Revision Selector & Timeline Strip */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                'Schema Snapshot Time Machine & Rollback Generator',
                'ဖွဲ့စည်းပုံ မှတ်တမ်း Time Machine နှင့် Rollback SQL ထုတ်စက်'
              )}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {tr(
                'Select any two historical baselines or live scan snapshots to inspect column deltas and generate lock-safe UP and DOWN rollback DDL.',
                'မည်သည့် မူလစံဖွဲ့စည်းပုံ သို့မဟုတ် စစ်ဆေးမှု မှတ်တမ်း ၂ ခုကိုမဆို ရွေးချယ်ပြီး UP နှင့် DOWN Rollback SQL များကို အလိုအလျောက် ထုတ်ယူနိုင်ပါသည်။'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadTimeMachine(fromId, toId)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{tr('Refresh History', 'မှတ်တမ်း ပြန်စစ်ရန်')}</span>
          </button>
        </div>

        {/* Version A -> Version B Pickers */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto] items-end gap-3 pt-1">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              {tr('From Revision (Earlier / Base)', 'မူလ ဗားရှင်း (အဟောင်း)')}
            </label>
            <select
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30"
            >
              {data.revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {r.schemaHash.slice(0, 8)} · {r.tableCount}t/{r.columnCount}c ({formatDateTime(r.createdAt)})
                </option>
              ))}
            </select>
          </div>

          <div className="hidden md:flex items-center justify-center pb-2.5 text-slate-400 dark:text-slate-500">
            <ArrowRight className="w-4 h-4" />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              {tr('To Revision (Newer / Target)', 'ပစ်မှတ် ဗားရှင်း (အသစ်)')}
            </label>
            <select
              value={toId}
              onChange={(e) => setToId(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30"
            >
              {data.revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {r.schemaHash.slice(0, 8)} · {r.tableCount}t/{r.columnCount}c ({formatDateTime(r.createdAt)})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={handleCompare}
            disabled={loading || !fromId || !toId || fromId === toId}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {tr('Diff & Generate SQL', 'နှိုင်းယှဉ်ပြီး SQL ထုတ်ရန်')}
          </button>
        </div>

        {/* Clickable Historical Revision Strip */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">
            {tr(
              `Recorded Schema Revisions (${data.revisions.length})`,
              `မှတ်တမ်းတင်ထားသော ဖွဲ့စည်းပုံ ဗားရှင်းများ (${data.revisions.length})`
            )}
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {data.revisions.slice(0, 10).map((rev) => {
              const isFrom = rev.id === fromId;
              const isTo = rev.id === toId;
              return (
                <button
                  key={rev.id}
                  type="button"
                  onClick={() => {
                    if (isTo) return;
                    setFromId(rev.id);
                    loadTimeMachine(rev.id, toId);
                  }}
                  className={`shrink-0 text-left px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                    isTo
                      ? 'border-blue-600 dark:border-blue-500 bg-blue-50/70 dark:bg-blue-950/40'
                      : isFrom
                        ? 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/40'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-medium text-slate-900 dark:text-slate-100">
                    <span>{rev.label}</span>
                    {isTo && (
                      <span className="text-[10px] font-semibold text-blue-700 dark:text-blue-400">
                        · TO
                      </span>
                    )}
                    {isFrom && (
                      <span className="text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                        · FROM
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    {rev.schemaHash.slice(0, 10)} · {rev.columnCount} cols
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Comparison Results & UP/DOWN SQL Generator */}
      {cmp && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {cmp.identical
                  ? tr('No Schema Changes Between Revisions', 'ဗားရှင်း ၂ ခုကြား ဖွဲ့စည်းပုံ ကွာခြားမှု မရှိပါ')
                  : tr('Schema Delta Summary', 'ဖွဲ့စည်းပုံ ပြောင်းလဲမှု အနှစ်ချုပ်')}
              </span>
              <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 tabular-nums font-semibold">
                +{cmp.addedCount} {tr('added', 'အသစ်')}
              </span>
              <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-amber-700 dark:text-amber-400 tabular-nums font-semibold">
                ~{cmp.modifiedCount} {tr('modified', 'ပြောင်းလဲ')}
              </span>
              <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-red-700 dark:text-red-400 tabular-nums font-semibold">
                -{cmp.removedCount} {tr('removed', 'ဖယ်ရှား')}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setSqlTab('down')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    sqlTab === 'down'
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {tr('DOWN Rollback SQL', 'DOWN ပြန်လှည့် SQL')}
                </button>
                <button
                  type="button"
                  onClick={() => setSqlTab('up')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    sqlTab === 'up'
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {tr('UP Migration SQL', 'UP ပြောင်းရွှေ့ SQL')}
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopySql}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap cursor-pointer"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>
                  {copied
                    ? tr('Copied', 'ကူးယူပြီး')
                    : tr('Copy SQL', 'SQL ကူးယူရန်')}
                </span>
              </button>

              <button
                type="button"
                onClick={handleDownloadSql}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>.sql</span>
              </button>
            </div>
          </div>

          {cmp.diffs.length > 0 && (
            <div className="overflow-x-auto border-b border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">
                      {tr('Change', 'ပြောင်းလဲမှု')}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {tr('Table', 'ဇယား')}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {tr('Column', 'ကော်လံ')}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {tr('From Definition', 'မူလ သတ်မှတ်ချက်')}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {tr('To Definition', 'အသစ် သတ်မှတ်ချက်')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {cmp.diffs.map((d) => (
                    <tr
                      key={`${d.kind}-${d.table_schema}.${d.table_name}.${d.column_name}`}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60"
                    >
                      <td className="px-4 py-2.5 font-semibold whitespace-nowrap">
                        <span
                          className={
                            d.kind === 'ADDED'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : d.kind === 'REMOVED'
                                ? 'text-red-700 dark:text-red-400'
                                : 'text-amber-700 dark:text-amber-400'
                          }
                        >
                          {d.kind === 'ADDED'
                            ? `+ ${tr('Added', 'အသစ်')}`
                            : d.kind === 'REMOVED'
                              ? `- ${tr('Removed', 'ဖယ်ရှား')}`
                              : `~ ${tr('Modified', 'ပြောင်းလဲ')}`}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-700 dark:text-slate-300">
                        {d.table_schema}.{d.table_name}
                      </td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {d.column_name}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-500 dark:text-slate-400">
                        {d.baseline
                          ? `${d.baseline.data_type} · ${d.baseline.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`
                          : '—'}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-900 dark:text-slate-100">
                        {d.live
                          ? `${d.live.data_type} · ${d.live.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* SQL Preview Code Block */}
          <div className="bg-slate-950 p-4 overflow-x-auto">
            <pre className="text-xs font-mono text-slate-100 leading-relaxed whitespace-pre">
              {activeSql}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
