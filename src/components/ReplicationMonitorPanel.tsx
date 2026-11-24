import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Eye, RefreshCw } from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  MonitoredDatabaseDto,
  ReplicationMonitorResponse,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface ReplicationMonitorPanelProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  selectedTargetId: string;
  onTargetChange: (nextId: string) => void;
}

function buildPreviewReplication(
  targetLabel: string
): ReplicationMonitorResponse {
  return {
    targetLabel,
    databaseId: null,
    collectedAt: new Date().toISOString(),
    source: 'demo_topology',
    isStandby: false,
    standbys: [
      {
        pid: 41204,
        applicationName: 'pg-read-replica-us-east-1b',
        clientAddr: '10.24.18.42',
        state: 'streaming',
        syncState: 'sync',
        sentLsn: '4C/98A24110',
        replayLsn: '4C/98A1F800',
        writeLagMs: 4.2,
        flushLagMs: 8.6,
        replayLagMs: 14.3,
        replayLagBytes: 18_704,
        replayLagPretty: '18.3 KB',
      },
      {
        pid: 41982,
        applicationName: 'pg-read-replica-eu-west-1a',
        clientAddr: '10.28.4.19',
        state: 'streaming',
        syncState: 'async',
        sentLsn: '4C/98A24110',
        replayLsn: '4C/984B1020',
        writeLagMs: 88.4,
        flushLagMs: 112.7,
        replayLagMs: 642.5,
        replayLagBytes: 5_714_160,
        replayLagPretty: '5.4 MB',
      },
      {
        pid: 42619,
        applicationName: 'bi-analytics-replica-01',
        clientAddr: '10.24.99.104',
        state: 'streaming',
        syncState: 'async',
        sentLsn: '4C/98A24110',
        replayLsn: '4C/7E200400',
        writeLagMs: 195.0,
        flushLagMs: 420.1,
        replayLagMs: 4_850.0,
        replayLagBytes: 444_742_928,
        replayLagPretty: '424.1 MB',
      },
    ],
    slots: [
      {
        slotName: 'debezium_billing_cdc_v1',
        slotType: 'logical',
        database: 'billing_prod',
        active: false,
        walStatus: 'extended',
        retainedWalBytes: 4_512_840_000,
        retainedWalPretty: '4.2 GB',
        remediationSql:
          "SELECT pg_drop_replication_slot('debezium_billing_cdc_v1');",
      },
      {
        slotName: 'replica_us_east_1b_slot',
        slotType: 'physical',
        database: null,
        active: true,
        walStatus: 'reserved',
        retainedWalBytes: 16_777_216,
        retainedWalPretty: '16.0 MB',
        remediationSql: null,
      },
    ],
    peakReplayLagMs: 4850,
    peakReplayLagBytes: 444_742_928,
    peakReplayLagPretty: '424.1 MB',
    inactiveSlotsCount: 1,
    totalRetainedWalBytes: 4_529_617_216,
    totalRetainedWalPretty: '4.2 GB',
  };
}

export function ReplicationMonitorPanel({
  api,
  databases,
  selectedTargetId,
  onTargetChange,
}: ReplicationMonitorPanelProps) {
  const { tr, formatEnv } = useI18n();
  const [report, setReport] = useState<ReplicationMonitorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [copiedSlot, setCopiedSlot] = useState<string | null>(null);

  const loadReplication = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getReplicationMonitor(
        selectedTargetId || undefined
      );
      setReport(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Unable to load PostgreSQL replication telemetry.',
              'PostgreSQL Replication နှောင့်နှေးမှု အချက်အလက်ကို ဖတ်၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, selectedTargetId, tr]);

  useEffect(() => {
    loadReplication();
  }, [loadReplication]);

  const activeData = previewMode
    ? buildPreviewReplication(
        report?.targetLabel ?? 'Workspace PostgreSQL (Preview)'
      )
    : report;

  const handleCopySql = async (slotName: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedSlot(slotName);
      setTimeout(() => setCopiedSlot(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                'Replication Lag & WAL Slot Monitor',
                'Replication နှောင့်နှေးမှုနှင့် WAL Slot စောင့်ကြည့်စက်'
              )}
            </h2>
            <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
              pg_stat_replication & pg_replication_slots
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {tr(
              'Tracks primary-to-standby replay lag in bytes and milliseconds and flags inactive replication slots retaining WAL disk space.',
              'ပင်မနှင့် အရန်ဆာဗာများကြား WAL Replay နှောင့်နှေးမှုနှင့် ဒစ်ခ်နေရာ ယူထားသော ပိတ်နေသည့် Replication Slot များကို စောင့်ကြည့်ပေးပါသည်။'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedTargetId}
            onChange={(e) => {
              setPreviewMode(false);
              onTargetChange(e.target.value);
            }}
            aria-label={tr('Replication target', 'Replication ပစ်မှတ်')}
            className="px-3 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          >
            <option value="">
              {tr('Workspace PostgreSQL (Live)', 'လုပ်ငန်းခွင် PostgreSQL (Live)')}
            </option>
            {databases.map((db) => (
              <option key={db.id} value={db.id}>
                {db.name} ({formatEnv(db.environment)})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setPreviewMode((p) => !p)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              previewMode
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border-amber-300 dark:border-amber-800/70'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>
              {previewMode
                ? tr('Return to Live', 'Live သို့ ပြန်သွားရန်')
                : tr('Preview Topology', 'ပုံစံ အစမ်းကြည့်ရန်')}
            </span>
          </button>

          <button
            type="button"
            onClick={loadReplication}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{tr('Refresh', 'ပြန်စစ်ရန်')}</span>
          </button>
        </div>
      </div>

      {error && !previewMode && (
        <div className="px-5 py-3 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900/70 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {activeData && (
        <>
          {/* 4-Column KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800 border-b border-slate-200 dark:border-slate-800">
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr('Streaming Replicas', 'ချိတ်ဆက်နေသော Replica များ')}
              </p>
              <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {activeData.standbys.length}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {activeData.isStandby
                  ? tr('Target is in standby recovery', 'အရန်ဆာဗာ အခြေအနေ')
                  : tr('Primary WAL sender', 'ပင်မ WAL ပို့ဆောင်သူ')}
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr('Peak Replay Lag', 'အမြင့်ဆုံး Replay နှောင့်နှေးမှု')}
              </p>
              <p
                className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                  activeData.peakReplayLagMs >= 2000
                    ? 'text-red-700 dark:text-red-400'
                    : activeData.peakReplayLagMs >= 500
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                {activeData.peakReplayLagMs >= 1000
                  ? `${(activeData.peakReplayLagMs / 1000).toFixed(2)} s`
                  : `${activeData.peakReplayLagMs.toFixed(1)} ms`}
              </p>
              <p className="mt-1 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {activeData.peakReplayLagPretty} {tr('WAL behind', 'WAL နောက်ကျ')}
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr('Inactive / Orphaned Slots', 'ပိတ်နေသော Slot များ')}
              </p>
              <p
                className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                  activeData.inactiveSlotsCount > 0
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                {activeData.inactiveSlotsCount}
                <span className="text-sm font-normal text-slate-400 dark:text-slate-500">
                  /{activeData.slots.length}
                </span>
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {activeData.inactiveSlotsCount > 0
                  ? tr('Disk exhaustion risk', 'ဒစ်ခ်ပြည့်နိုင်ခြေ ရှိသည်')
                  : tr('All slots active', 'Slot အားလုံး ပုံမှန်')}
              </p>
            </div>

            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {tr('Total Retained WAL', 'သိမ်းဆည်းထားသော WAL ပမာဏ')}
              </p>
              <p
                className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                  activeData.totalRetainedWalBytes > 1024 * 1024 * 1024
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                {activeData.totalRetainedWalPretty}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {tr('Held by replication slots', 'Slot များမှ ထိန်းထားသည်')}
              </p>
            </div>
          </div>

          {activeData.standbys.length === 0 && activeData.slots.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {tr(
                  'No streaming standbys or replication slots detected on this PostgreSQL instance.',
                  'ဤ PostgreSQL တွင် ချိတ်ဆက်ထားသော Standby သို့မဟုတ် Replication Slot မတွေ့ရှိပါ။'
                )}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {tr(
                  'Click "Preview Topology" above to inspect a multi-region streaming replica & orphaned CDC slot scenario.',
                  'အရန်ဆာဗာနှင့် WAL Slot စောင့်ကြည့်မှု ပုံစံကို ကြည့်ရန် အပေါ်ရှိ "ပုံစံ အစမ်းကြည့်ရန်" ကို နှိပ်ပါ။'
                )}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {/* Streaming Standbys Table */}
              {activeData.standbys.length > 0 && (
                <div className="overflow-x-auto">
                  <div className="px-5 py-3 bg-slate-50/60 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200">
                    {tr('Streaming Standby Replicas', 'ချိတ်ဆက်နေသော Standby Replica များ')}
                  </div>
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">
                          {tr('Replica / Client', 'Replica အမည် / IP')}
                        </th>
                        <th className="px-4 py-2.5 font-medium">
                          {tr('Mode', 'စနစ်')}
                        </th>
                        <th className="px-4 py-2.5 font-medium">
                          {tr('Sent → Replay LSN', 'Sent → Replay LSN')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-right">
                          {tr('Write / Flush', 'Write / Flush')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-right">
                          {tr('Replay Lag', 'Replay နှောင့်နှေးမှု')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {activeData.standbys.map((s) => {
                        const lagCls =
                          s.replayLagMs >= 2000
                            ? 'text-red-700 dark:text-red-400 font-semibold'
                            : s.replayLagMs >= 500
                              ? 'text-amber-700 dark:text-amber-400 font-semibold'
                              : 'text-emerald-700 dark:text-emerald-400 font-medium';
                        return (
                          <tr
                            key={`${s.pid}-${s.applicationName}`}
                            className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60"
                          >
                            <td className="px-4 py-3">
                              <p className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                                {s.applicationName}
                              </p>
                              <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                                PID {s.pid} · {s.clientAddr}
                              </p>
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-700 dark:text-slate-300">
                              {s.state} · {s.syncState}
                            </td>
                            <td className="px-4 py-3 font-mono text-[11px] text-slate-600 dark:text-slate-300 tabular-nums">
                              {s.sentLsn} → {s.replayLsn}
                            </td>
                            <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                              {s.writeLagMs.toFixed(1)} ms / {s.flushLagMs.toFixed(1)} ms
                            </td>
                            <td className={`px-4 py-3 text-right font-mono tabular-nums ${lagCls}`}>
                              <div>
                                {s.replayLagMs >= 1000
                                  ? `${(s.replayLagMs / 1000).toFixed(2)} s`
                                  : `${s.replayLagMs.toFixed(1)} ms`}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                                {s.replayLagPretty}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Replication Slots Table */}
              {activeData.slots.length > 0 && (
                <div className="overflow-x-auto">
                  <div className="px-5 py-3 bg-slate-50/60 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200">
                    {tr('WAL Replication Slots', 'WAL Replication Slot များ')}
                  </div>
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">
                          {tr('Slot Name', 'Slot အမည်')}
                        </th>
                        <th className="px-4 py-2.5 font-medium">
                          {tr('Type', 'အမျိုးအစား')}
                        </th>
                        <th className="px-4 py-2.5 font-medium">
                          {tr('Status', 'အခြေအနေ')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-right">
                          {tr('Retained WAL', 'ထိန်းထားသော WAL')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-right">
                          {tr('Action', 'လုပ်ဆောင်ချက်')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {activeData.slots.map((slot) => (
                        <tr key={slot.slotName} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60">
                          <td className="px-4 py-3 font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {slot.slotName}
                            {slot.database && (
                              <span className="ml-2 text-[11px] font-normal text-slate-500 dark:text-slate-400">
                                ({slot.database})
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-300">
                            {slot.slotType} · {slot.walStatus}
                          </td>
                          <td className="px-4 py-3 font-semibold">
                            <span
                              className={
                                slot.active
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-red-700 dark:text-red-400'
                              }
                            >
                              {slot.active
                                ? tr('Active', 'လုပ်ဆောင်နေ')
                                : tr('Inactive (Retaining WAL)', 'ပိတ်နေ (WAL စုပုံနေ)')}
                            </span>
                          </td>
                          <td
                            className={`px-4 py-3 text-right font-mono tabular-nums ${
                              !slot.active &&
                              slot.retainedWalBytes > 512 * 1024 * 1024
                                ? 'text-red-700 dark:text-red-400 font-semibold'
                                : 'text-slate-800 dark:text-slate-200'
                            }`}
                          >
                            {slot.retainedWalPretty}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {slot.remediationSql ? (
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopySql(
                                    slot.slotName,
                                    slot.remediationSql!
                                  )
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-red-700 dark:text-red-400 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-md cursor-pointer whitespace-nowrap"
                              >
                                {copiedSlot === slot.slotName ? (
                                  <Check className="w-3 h-3" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                <span>
                                  {copiedSlot === slot.slotName
                                    ? tr('Copied Drop SQL', 'Drop SQL ကူးယူပြီး')
                                    : tr('Copy Drop Slot SQL', 'Drop Slot SQL ကူးယူရန်')}
                                </span>
                              </button>
                            ) : (
                              <span className="text-slate-400 dark:text-slate-500">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
