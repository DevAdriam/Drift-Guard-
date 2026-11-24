import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type { SecurityAuditResponse } from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface SecurityAuditPanelProps {
  api: ApiClient;
  databaseId: string;
}

export function SecurityAuditPanel({
  api,
  databaseId,
}: SecurityAuditPanelProps) {
  const { tr, formatSeverity } = useI18n();
  const [audit, setAudit] = useState<SecurityAuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getDatabaseSecurityAudit(databaseId);
      setAudit(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Unable to run PostgreSQL security & privilege audit.',
              'PostgreSQL လုံခြုံရေးနှင့် အခွင့်အာဏာ စစ်ဆေးမှု မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, databaseId, tr]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  const handleCopy = async (id: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 animate-pulse">
        <div className="h-5 bg-slate-200 dark:bg-slate-700 rounded w-60" />
        <div className="grid grid-cols-4 gap-4">
          <div className="h-20 bg-slate-100 dark:bg-slate-800 rounded-lg" />
          <div className="h-20 bg-slate-100 dark:bg-slate-800 rounded-lg" />
          <div className="h-20 bg-slate-100 dark:bg-slate-800 rounded-lg" />
          <div className="h-20 bg-slate-100 dark:bg-slate-800 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !audit) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 rounded-xl p-6 text-sm text-red-700 dark:text-red-400">
        {error ?? tr('Security audit unavailable.', 'လုံခြုံရေး စစ်ဆေးချက် မရရှိပါ။')}
      </div>
    );
  }

  const scoreColor =
    audit.securityScore >= 85
      ? 'text-emerald-700 dark:text-emerald-400'
      : audit.securityScore >= 60
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-red-700 dark:text-red-400';

  return (
    <div className="space-y-5">
      {/* Header + 4-Column Security Posture KPI Strip */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                'PostgreSQL Security, Roles & RLS Privilege Auditor',
                'PostgreSQL လုံခြုံရေး၊ Role နှင့် RLS အခွင့်အာဏာ စစ်ဆေးစက်'
              )}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {tr(
                'Audits pg_roles superuser grants, Row-Level Security (RLS) enforcement, PUBLIC schema exposure, and TLS/SSL client session coverage.',
                'SUPERUSER အခွင့်အာဏာများ၊ Row-Level Security (RLS) ဖွင့်ထားမှု၊ PUBLIC ခွင့်ပြုချက်များနှင့် SSL/TLS ချိတ်ဆက်မှုများကို စစ်ဆေးပေးပါသည်။'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={loadAudit}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{tr('Re-Scan Security', 'လုံခြုံရေး ပြန်စစ်ရန်')}</span>
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
          <div className="p-5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {tr('Security Posture Score', 'လုံခြုံရေး ရမှတ်')}
            </p>
            <p className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${scoreColor}`}>
              {audit.securityScore}
              <span className="text-sm font-normal text-slate-400 dark:text-slate-500">/100</span>
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {tr(
                `${audit.findings.length} finding(s) detected`,
                `တွေ့ရှိချက် ${audit.findings.length} ခု`
              )}
            </p>
          </div>

          <div className="p-5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {tr('Superuser Roles', 'Superuser အကောင့်များ')}
            </p>
            <p
              className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                audit.superuserCount > 1 ? 'text-red-700 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'
              }`}
            >
              {audit.superuserCount}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {tr(
                `Out of ${audit.roles.length} database roles`,
                `စုစုပေါင်း Role ${audit.roles.length} ခုအနက်`
              )}
            </p>
          </div>

          <div className="p-5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {tr('Tables Missing RLS', 'RLS မဖွင့်ထားသော ဇယားများ')}
            </p>
            <p
              className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                audit.tablesWithoutRlsCount > 0
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {audit.tablesWithoutRlsCount}
              <span className="text-sm font-normal text-slate-400 dark:text-slate-500">
                /{audit.tablesTotal}
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {tr(
                `${audit.publicGrantsCount} table(s) with PUBLIC grants`,
                `PUBLIC ခွင့်ပြုချက် ရှိသော ဇယား ${audit.publicGrantsCount} ခု`
              )}
            </p>
          </div>

          <div className="p-5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {tr('SSL / TLS Coverage', 'SSL / TLS လွှမ်းခြုံမှု')}
            </p>
            <p
              className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                audit.nonSslSessionsCount > 0
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {audit.sslCoveragePct}%
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {tr(
                `${audit.sslSessionsCount} TLS · ${audit.nonSslSessionsCount} plaintext`,
                `TLS ${audit.sslSessionsCount} · ရိုးရိုး ${audit.nonSslSessionsCount}`
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Security Findings with Remediation SQL */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {tr(
              'Actionable Security & Privilege Findings',
              'ပြုပြင်ရန် လိုအပ်သော လုံခြုံရေး တွေ့ရှိချက်များ'
            )}
          </h3>
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {audit.findings.length} {tr('total', 'စုစုပေါင်း')}
          </span>
        </div>

        {audit.findings.length === 0 ? (
          <div className="p-8 text-center space-y-1.5">
            <ShieldCheck className="w-6 h-6 text-emerald-700 dark:text-emerald-400 mx-auto" />
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {tr(
                'No privilege drift or security exposures detected',
                'လုံခြုံရေးနှင့် အခွင့်အာဏာ ချို့ယွင်းချက် မတွေ့ရှိပါ'
              )}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tr(
                'All inspected roles, RLS policies, and client sessions meet least-privilege standards.',
                'စစ်ဆေးခဲ့သော Role များ၊ RLS မူဝါဒများနှင့် ချိတ်ဆက်မှုများအားလုံး လုံခြုံမှု စံနှုန်းနှင့် ကိုက်ညီပါသည်။'
              )}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {audit.findings.map((f) => (
              <div key={f.id} className="p-5 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span
                        className={`font-semibold ${
                          f.severity === 'CRITICAL'
                            ? 'text-red-700 dark:text-red-400'
                            : f.severity === 'WARNING'
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-blue-700 dark:text-blue-400'
                        }`}
                      >
                        {formatSeverity(f.severity)}
                      </span>
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                        {f.title}
                      </span>
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono text-slate-600 dark:text-slate-300">
                        {f.targetObject}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                      {f.description}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCopy(f.id, f.remediationSql)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedId === f.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {copiedId === f.id
                        ? tr('Copied', 'ကူးယူပြီး')
                        : tr('Copy Fix SQL', 'ပြုပြင်ရန် SQL ကူးယူရန်')}
                    </span>
                  </button>
                </div>

                <div className="bg-slate-950 rounded-lg px-3.5 py-2.5 overflow-x-auto">
                  <pre className="text-xs font-mono text-slate-100 whitespace-pre">
                    {f.remediationSql}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Roles & RLS Tables Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {tr('Database Roles Inventory (pg_roles)', 'ဒေတာဘေ့စ် Role စာရင်း (pg_roles)')}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{tr('Role', 'Role အမည်')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('Login', 'ဝင်ရောက်ခွင့်')}</th>
                  <th className="px-4 py-2.5 font-medium">Superuser</th>
                  <th className="px-4 py-2.5 font-medium">Bypass RLS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {audit.roles.map((r) => (
                  <tr key={r.roleName} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60">
                    <td className="px-4 py-2.5 font-mono font-medium text-slate-900 dark:text-slate-100">
                      {r.roleName}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                      {r.canLogin ? tr('Yes', 'ရှိ') : tr('No', 'မရှိ')}
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      <span
                        className={
                          r.isSuperuser ? 'text-red-700 dark:text-red-400 font-semibold' : 'text-slate-500 dark:text-slate-400'
                        }
                      >
                        {r.isSuperuser ? tr('Yes', 'ဟုတ်') : tr('No', 'မဟုတ်')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      <span
                        className={
                          r.bypassRls ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-slate-500 dark:text-slate-400'
                        }
                      >
                        {r.bypassRls ? tr('Yes', 'ဟုတ်') : tr('No', 'မဟုတ်')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {tr('Row-Level Security & PUBLIC Grants', 'RLS နှင့် PUBLIC အခွင့်အာဏာ စစ်ဆေးချက်')}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{tr('Table', 'ဇယား')}</th>
                  <th className="px-4 py-2.5 font-medium">RLS</th>
                  <th className="px-4 py-2.5 font-medium text-right">
                    {tr('Policies', 'မူဝါဒ')}
                  </th>
                  <th className="px-4 py-2.5 font-medium text-right">PUBLIC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {audit.rlsTables.map((tbl) => (
                  <tr
                    key={`${tbl.schemaName}.${tbl.tableName}`}
                    className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60"
                  >
                    <td className="px-4 py-2.5 font-mono text-slate-900 dark:text-slate-100">
                      {tbl.schemaName}.{tbl.tableName}
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      <span
                        className={
                          tbl.rlsEnabled
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-amber-700 dark:text-amber-400 font-semibold'
                        }
                      >
                        {tbl.rlsEnabled
                          ? tr('Enabled', 'ဖွင့်ထား')
                          : tr('Disabled', 'ပိတ်ထား')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {tbl.policyCount}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium">
                      {tbl.hasPublicGrant ? (
                        <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-semibold">
                          <ShieldAlert className="w-3.5 h-3.5" />
                          {tr('Exposed', 'ဖွင့်ထား')}
                        </span>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">
                          {tr('Revoked', 'ပိတ်ထား')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
