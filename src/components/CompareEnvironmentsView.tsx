import { useState } from 'react';
import { ArrowLeftRight, Check, Copy, Download } from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';
import type { ApiClient } from '../lib/api.ts';
import type {
  EnvironmentCompareResult,
  MonitoredDatabaseDto,
} from '../types/telemetry.ts';

interface CompareEnvironmentsViewProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  onOpenAddModal: () => void;
}

export function CompareEnvironmentsView({
  api,
  databases,
  onOpenAddModal,
}: CompareEnvironmentsViewProps) {
  const { t, tr, formatEnv } = useI18n();
  const [sourceId, setSourceId] = useState<string>(databases[0]?.id ?? '');
  const [targetId, setTargetId] = useState<string>(
    databases[1]?.id ?? databases[0]?.id ?? ''
  );
  const [result, setResult] = useState<EnvironmentCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);

  const handleCompare = async () => {
    if (!sourceId || !targetId) {
      setError(
        tr(
          'Select both a source and destination database target.',
          'မူရင်း ဒေတာဘေ့စ်နှင့် နှိုင်းယှဉ်မည့် ပစ်မှတ် ဒေတာဘေ့စ် နှစ်ခုလုံးကို ရွေးချယ်ပါ။'
        )
      );
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await api.compareEnvironments(sourceId, targetId);
      setResult(res);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to compare schemas.',
              'ဖွဲ့စည်းပုံ နှိုင်းယှဉ်ခြင်း မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSwap = () => {
    const prevSource = sourceId;
    setSourceId(targetId);
    setTargetId(prevSource);
  };

  const handleCopySql = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.syncSql);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleDownloadSql = () => {
    if (!result) return;
    const blob = new Blob([result.syncSql], {
      type: 'application/sql;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sync_${result.source.name}_to_${result.target.name}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          {tr('Compare Environments', 'ပတ်ဝန်းကျင် ဖွဲ့စည်းပုံ နှိုင်းယှဉ်ခြင်း')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {tr(
            'Diff any two databases (such as Staging vs. Production) side by side and generate ready-to-review PostgreSQL synchronization SQL.',
            'Staging နှင့် Production ကဲ့သို့ မည်သည့် ဒေတာဘေ့စ် နှစ်ခုကိုမဆို ယှဉ်တွဲစစ်ဆေးပြီး အသင့်စစ်ဆေးအသုံးပြုနိုင်သော PostgreSQL ညှိနှိုင်းရေး SQL ကို ထုတ်ယူနိုင်ပါသည်။'
          )}
        </p>
      </div>

      {databases.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-900">
            {tr(
              'Register at least one monitored database to compare schemas',
              'ဖွဲ့စည်းပုံ နှိုင်းယှဉ်ရန် အနည်းဆုံး ဒေတာဘေ့စ်တစ်ခု ထည့်သွင်းထားရန် လိုအပ်ပါသည်'
            )}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            {tr(
              'Add Staging and Production targets to inspect column differences and auto-generate alignment migrations.',
              'Staging နှင့် Production ဒေတာဘေ့စ်များ ထည့်သွင်းပြီး ကော်လံကွာခြားချက်များနှင့် ညှိနှိုင်းရေး Migration များကို အလိုအလျောက် ထုတ်ယူနိုင်ပါသည်။'
            )}
          </p>
          <button
            type="button"
            onClick={onOpenAddModal}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
          >
            {tr('Register Target Database', 'ဒေတာဘေ့စ် ပစ်မှတ် ထည့်သွင်းရန်')}
          </button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-11 gap-3 items-end">
            <div className="lg:col-span-4">
              <label
                htmlFor="cmp-source"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                {tr(
                  'Source Schema (Desired State, e.g. Staging)',
                  'မူရင်း ဖွဲ့စည်းပုံ (စံထားလိုသော အခြေအနေ၊ ဥပမာ — Staging)'
                )}
              </label>
              <select
                id="cmp-source"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900"
              >
                {databases.map((db) => (
                  <option key={db.id} value={db.id}>
                    {db.name} ({formatEnv(db.environment, true)})
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-1 flex justify-center">
              <button
                type="button"
                onClick={handleSwap}
                aria-label={tr(
                  'Swap source and target',
                  'မူရင်းနှင့် ပစ်မှတ် နေရာလဲလှယ်ရန်'
                )}
                className="p-2.5 text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </button>
            </div>

            <div className="lg:col-span-4">
              <label
                htmlFor="cmp-target"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                {tr(
                  'Destination Schema (To Align, e.g. Production)',
                  'ပစ်မှတ် ဖွဲ့စည်းပုံ (ညှိနှိုင်းလိုသော အခြေအနေ၊ ဥပမာ — Production)'
                )}
              </label>
              <select
                id="cmp-target"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900"
              >
                {databases.map((db) => (
                  <option key={db.id} value={db.id}>
                    {db.name} ({formatEnv(db.environment, true)})
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-2">
              <button
                type="button"
                onClick={handleCompare}
                disabled={loading}
                className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                {loading
                  ? tr('Comparing…', 'နှိုင်းယှဉ်နေသည်…')
                  : tr('Compare', 'နှိုင်းယှဉ်ရန်')}
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800"
            >
              {error}
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          {/* Summary Strip */}
          <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200">
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Source', 'မူရင်း')} · {formatEnv(result.source.environment, true)}
              </p>
              <p className="text-base font-semibold text-slate-900 mt-1">
                {result.source.name}
              </p>
              <p className="text-xs font-mono text-slate-500 mt-1 tabular-nums">
                SHA {result.source.schemaHash.slice(0, 12)} ·{' '}
                <span className="font-sans">
                  {tr(
                    `${result.source.tableCount}t / ${result.source.columnCount}c`,
                    `ဇယား ${result.source.tableCount} / ကော်လံ ${result.source.columnCount}`
                  )}
                </span>
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Destination', 'ပစ်မှတ်')} ·{' '}
                {formatEnv(result.target.environment, true)}
              </p>
              <p className="text-base font-semibold text-slate-900 mt-1">
                {result.target.name}
              </p>
              <p className="text-xs font-mono text-slate-500 mt-1 tabular-nums">
                SHA {result.target.schemaHash.slice(0, 12)} ·{' '}
                <span className="font-sans">
                  {tr(
                    `${result.target.tableCount}t / ${result.target.columnCount}c`,
                    `ဇယား ${result.target.tableCount} / ကော်လံ ${result.target.columnCount}`
                  )}
                </span>
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500">
                {tr('Parity Verdict', 'ကိုက်ညီမှု ရလဒ်')}
              </p>
              <p
                className={`text-base font-semibold mt-1 ${
                  result.identical ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {result.identical
                  ? tr('100% Schema Parity', 'ဖွဲ့စည်းပုံ ၁၀၀% တူညီပါသည်')
                  : tr(
                      `${result.diffs.length} Column Difference${
                        result.diffs.length === 1 ? '' : 's'
                      }`,
                      `ကော်လံ ကွာခြားချက် ${result.diffs.length} ခု တွေ့ရှိသည်`
                    )}
              </p>
              <p className="text-xs text-slate-500 mt-1 tabular-nums">
                {tr(
                  `+${result.addedCount} added · -${result.removedCount} extra · ~${result.modifiedCount} modified`,
                  `+${result.addedCount} ထပ်တိုး · -${result.removedCount} အပို · ~${result.modifiedCount} ပြင်ဆင်ထား`
                )}
              </p>
            </div>
          </div>

          {/* Diff Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200">
              <h2 className="text-sm font-semibold text-slate-900">
                {tr(
                  'Column-by-Column Differences',
                  'ကော်လံအလိုက် ကွာခြားချက်များ'
                )}
              </h2>
            </div>

            {result.diffs.length === 0 ? (
              <div className="p-8 text-center text-sm font-medium text-emerald-700">
                {tr(
                  `No schema differences found between ${result.source.name} and ${result.target.name}.`,
                  `${result.source.name} နှင့် ${result.target.name} အကြား ဖွဲ့စည်းပုံ ကွာခြားချက် မရှိပါ။`
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                      <th className="py-2.5 px-4">
                        {tr('Change', 'ပြောင်းလဲမှု')}
                      </th>
                      <th className="py-2.5 px-4">{tr('Table', 'ဇယား')}</th>
                      <th className="py-2.5 px-4">{tr('Column', 'ကော်လံ')}</th>
                      <th className="py-2.5 px-4">
                        {tr('Destination', 'ပစ်မှတ်')} ({result.target.name})
                      </th>
                      <th className="py-2.5 px-4">
                        {tr('Source', 'မူရင်း')} ({result.source.name})
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono">
                    {result.diffs.map((d, idx) => (
                      <tr key={`${d.table_name}-${d.column_name}-${idx}`}>
                        <td className="py-2.5 px-4 font-sans font-semibold whitespace-nowrap">
                          <span
                            className={
                              d.kind === 'ADDED'
                                ? 'text-emerald-700'
                                : d.kind === 'REMOVED'
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                            }
                          >
                            {d.kind === 'ADDED'
                              ? tr('+ Missing in Dest', '+ ပစ်မှတ်တွင် မရှိပါ')
                              : d.kind === 'REMOVED'
                                ? tr('- Only in Dest', '- ပစ်မှတ်တွင်သာ ရှိသည်')
                                : tr('~ Modified', '~ ပြောင်းလဲထားသည်')}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-slate-700">
                          {d.table_schema}.{d.table_name}
                        </td>
                        <td className="py-2.5 px-4 font-semibold text-slate-900">
                          {d.column_name}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600">
                          {d.baseline
                            ? `${d.baseline.data_type} (${d.baseline.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'})`
                            : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-slate-900">
                          {d.live
                            ? `${d.live.data_type} (${d.live.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'})`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Generated Sync SQL */}
          <div className="bg-slate-900 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <span className="text-xs font-medium text-slate-300">
                {tr(
                  `Auto-Generated Reconciliation DDL (Aligns ${result.target.name} to ${result.source.name})`,
                  `အလိုအလျောက် ထုတ်ပေးထားသော ညှိနှိုင်းရေး DDL (${result.target.name} ကို ${result.source.name} နှင့် ကိုက်ညီစေရန်)`
                )}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCopySql}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  {copiedSql ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>{t('action.copied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>{tr('Copy SQL', 'SQL ကူးယူရန်')}</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadSql}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{tr('Download .sql', '.sql ဒေါင်းလုဒ်ဆွဲရန်')}</span>
                </button>
              </div>
            </div>
            <pre className="p-5 text-xs font-mono text-slate-100 overflow-x-auto leading-relaxed">
              {result.syncSql}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
