import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Download,
  FileDown,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  BaselineApprovalRequestDto,
  ExecutiveDigestResponse,
  MonitoredDatabaseDto,
  TeamMemberDto,
  WorkspaceRole,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface GovernanceReportsViewProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  onDatabasesChanged?: () => Promise<void> | void;
}

type GovernanceTab = 'digest' | 'approvals' | 'team';

export function GovernanceReportsView({
  api,
  databases,
  onDatabasesChanged,
}: GovernanceReportsViewProps) {
  const { tr, formatEnv, formatDateTime, formatIncidentType } = useI18n();
  const [activeTab, setActiveTab] = useState<GovernanceTab>('digest');
  const [digestDays, setDigestDays] = useState<7 | 30>(7);
  const [digest, setDigest] = useState<ExecutiveDigestResponse | null>(null);
  const [approvals, setApprovals] = useState<BaselineApprovalRequestDto[]>([]);
  const [members, setMembers] = useState<TeamMemberDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  // Request approval form state
  const [reqDbId, setReqDbId] = useState(databases[0]?.id ?? '');
  const [reqSha, setReqSha] = useState('');
  const [reqNote, setReqNote] = useState('');
  const [submittingReq, setSubmittingReq] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  // Invite team member form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('dba');
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (!reqDbId && databases.length > 0) {
      const drifted = databases.find((d) => d.lastHealthStatus === 'DRIFT');
      setReqDbId(drifted?.id ?? databases[0].id);
    }
  }, [databases, reqDbId]);

  const loadAll = useCallback(
    async (days: 7 | 30 = digestDays) => {
      setError(null);
      try {
        const [digestRes, approvalsRes, teamRes] = await Promise.all([
          api.getExecutiveDigest(days),
          api.listBaselineApprovals(),
          api.listTeamMembers(),
        ]);
        setDigest(digestRes);
        setApprovals(approvalsRes.approvals);
        setMembers(teamRes.members);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Failed to load governance & executive reports.',
                'စီမံခန့်ခွဲမှုနှင့် အစီရင်ခံစာ အချက်အလက်များကို ရယူ၍ မရပါ။'
              )
        );
      } finally {
        setLoading(false);
      }
    },
    [api, digestDays, tr]
  );

  useEffect(() => {
    loadAll(digestDays);
  }, [digestDays, loadAll]);

  const triggerDownload = (filename: string, content: BlobPart, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    if (!digest) return;
    triggerDownload(
      `driftguard-executive-digest-${digest.periodDays}d.json`,
      JSON.stringify(digest, null, 2),
      'application/json'
    );
  };

  const handleExportCsv = () => {
    if (!digest) return;
    const headers = [
      'database_name',
      'environment',
      'health_status',
      'health_score',
      'sla_availability_pct',
      'open_incidents',
      'resolved_incidents',
      'drift_events',
      'mttr_minutes',
      'database_size',
      'cache_hit_pct',
    ];
    const esc = (v: unknown) => {
      const raw = v == null ? '' : String(v);
      const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = [
      headers.join(','),
      ...digest.scorecards.map((s) =>
        [
          s.name,
          s.environment,
          s.healthStatus,
          s.healthScore,
          s.slaAvailabilityPct,
          s.openIncidentsCount,
          s.resolvedIncidentsCount,
          s.driftEventsCount,
          s.mttrMinutes ?? '',
          s.databaseSizePretty,
          s.cacheHitRatioPct ?? '',
        ]
          .map(esc)
          .join(',')
      ),
    ];
    triggerDownload(
      `driftguard-executive-digest-${digest.periodDays}d.csv`,
      rows.join('\n'),
      'text/csv;charset=utf-8'
    );
  };

  const handleDownloadPdf = async () => {
    setDownloadingPdf(true);
    setError(null);
    setNotice(null);
    try {
      const { blob, filename } = await api.downloadExecutiveDigestPdf(digestDays);
      triggerDownload(filename, blob, 'application/pdf');
      setNotice(
        tr(
          `Executive Health Digest PDF downloaded (${filename}).`,
          `အမှုဆောင် ကျန်းမာရေး အနှစ်ချုပ် PDF ကို ဒေါင်းလုဒ်လုပ်ပြီးပါပြီ (${filename})။`
        )
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to export PDF digest.', 'PDF အစီရင်ခံစာ ထုတ်ယူ၍ မရပါ။')
      );
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleCreateApproval = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reqDbId) return;
    setSubmittingReq(true);
    setError(null);
    setNotice(null);
    try {
      await api.createBaselineApprovalRequest({
        databaseId: reqDbId,
        gitCommitSha: reqSha.trim() || undefined,
        note: reqNote.trim() || undefined,
      });
      setReqSha('');
      setReqNote('');
      setNotice(
        tr(
          'Baseline promotion approval request submitted for review.',
          'မူလစံဖွဲ့စည်းပုံ အတည်ပြုချက် တောင်းဆိုမှု ပေးပို့ပြီးပါပြီ။'
        )
      );
      await loadAll(digestDays);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to submit approval request.', 'တောင်းဆိုမှု မအောင်မြင်ပါ။')
      );
    } finally {
      setSubmittingReq(false);
    }
  };

  const handleReviewApproval = async (
    id: string,
    decision: 'APPROVED' | 'REJECTED'
  ) => {
    setReviewingId(id);
    setError(null);
    setNotice(null);
    try {
      await api.reviewBaselineApproval(id, {
        decision,
        reviewNote: reviewNotes[id]?.trim() || undefined,
      });
      setNotice(
        decision === 'APPROVED'
          ? tr(
              'Approved and promoted schema baseline. Matching drift incidents resolved.',
              'အတည်ပြုပြီး မူလစံဖွဲ့စည်းပုံအဖြစ် တင်သွင်းပြီးပါပြီ။ သက်ဆိုင်ရာ Drift သတိပေးချက်များကို ဖြေရှင်းပြီးပါပြီ။'
            )
          : tr(
              'Baseline promotion request rejected and recorded in audit log.',
              'တောင်းဆိုမှုကို ငြင်းပယ်ပြီး မှတ်တမ်းတင်ပြီးပါပြီ။'
            )
      );
      await loadAll(digestDays);
      await onDatabasesChanged?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to review approval.', 'အတည်ပြုမှု မအောင်မြင်ပါ။')
      );
    } finally {
      setReviewingId(null);
    }
  };

  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || !inviteName.trim()) return;
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      await api.inviteTeamMember({
        email: inviteEmail.trim(),
        displayName: inviteName.trim(),
        role: inviteRole,
      });
      setInviteEmail('');
      setInviteName('');
      setNotice(
        tr(
          'Team member added to workspace RBAC directory.',
          'အဖွဲ့ဝင်အသစ်ကို RBAC စာရင်းထဲသို့ ထည့်သွင်းပြီးပါပြီ။'
        )
      );
      await loadAll(digestDays);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to invite team member.', 'အဖွဲ့ဝင် ဖိတ်ခေါ်မှု မအောင်မြင်ပါ။')
      );
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (memberId: string, role: WorkspaceRole) => {
    setError(null);
    try {
      await api.updateTeamMemberRole(memberId, role);
      await loadAll(digestDays);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to update role.', 'အခန်းကဏ္ဍ ပြောင်းလဲမှု မအောင်မြင်ပါ။')
      );
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    setError(null);
    try {
      await api.removeTeamMember(memberId);
      await loadAll(digestDays);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Failed to remove member.', 'အဖွဲ့ဝင် ဖယ်ရှားမှု မအောင်မြင်ပါ။')
      );
    }
  };

  const pendingApprovalsCount = approvals.filter(
    (a) => a.status === 'PENDING'
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {tr(
            'Governance, Team RBAC & Executive Reports',
            'စီမံခန့်ခွဲမှု၊ အဖွဲ့အခွင့်အာဏာ (RBAC) နှင့် အမှုဆောင် အစီရင်ခံစာများ'
          )}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {tr(
            'Export fleet-wide SLA & MTTR health digests, enforce approval gates for Production baseline promotions, and manage workspace Admin/DBA/Viewer roles.',
            'ဒေတာဘေ့စ်အားလုံး၏ SLA နှင့် MTTR အနှစ်ချုပ် အစီရင်ခံစာများ ထုတ်ယူရန်၊ ထုတ်လုပ်ရေး ဖွဲ့စည်းပုံ အတည်ပြုချက်များ စီမံရန်နှင့် အဖွဲ့ဝင် RBAC အခွင့်အာဏာများ သတ်မှတ်နိုင်ပါသည်။'
          )}
        </p>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('digest')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
            activeTab === 'digest'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
              : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          {tr('Executive Health Digest', 'အမှုဆောင် ကျန်းမာရေး အနှစ်ချုပ်')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('approvals')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
            activeTab === 'approvals'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
              : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          {tr('Promotion Approvals', 'အတည်ပြုချက် တောင်းဆိုမှုများ')}{' '}
          {pendingApprovalsCount > 0 ? `(${pendingApprovalsCount})` : ''}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('team')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
            activeTab === 'team'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
              : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          {tr('Team & RBAC', 'အဖွဲ့ဝင်နှင့် RBAC')} ({members.length})
        </button>
      </div>

      {notice && (
        <div className="px-4 py-3 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50 dark:bg-blue-950/40 text-xs text-blue-900 dark:text-blue-200">
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* TAB 1: EXECUTIVE HEALTH DIGEST */}
      {activeTab === 'digest' && (
        <div className="space-y-5">
          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
              {([7, 30] as const).map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setDigestDays(days)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    digestDays === days
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {days === 7
                    ? tr('Weekly Digest (7d)', 'အပတ်စဉ် (၇ ရက်)')
                    : tr('Monthly Digest (30d)', 'လစဉ် (၃၀ ရက်)')}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleExportCsv}
                disabled={!digest}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>{tr('Export CSV', 'CSV ထုတ်ယူရန်')}</span>
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                disabled={!digest}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{tr('Export JSON', 'JSON ထုတ်ယူရန်')}</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadPdf}
                disabled={downloadingPdf || !digest}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-60"
              >
                <FileDown className="w-3.5 h-3.5" />
                <span>
                  {downloadingPdf
                    ? tr('Building PDF…', 'PDF ထုတ်နေသည်…')
                    : tr('Download PDF Digest', 'PDF အစီရင်ခံစာ ဒေါင်းလုဒ်')}
                </span>
              </button>
            </div>
          </div>

          {loading || !digest ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 animate-pulse space-y-4">
              <div className="h-6 bg-slate-200 dark:bg-slate-700 rounded w-56" />
              <div className="h-32 bg-slate-100 dark:bg-slate-800 rounded-lg" />
            </div>
          ) : (
            <>
              {/* 4-Column Executive KPI Strip */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {tr('Fleet SLA Availability', 'ဒေတာဘေ့စ်အားလုံး SLA')}
                  </p>
                  <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    {digest.fleetSlaPct.toFixed(2)}%
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {tr(
                      `${digest.healthyTargetsCount}/${digest.totalTargets} targets nominal`,
                      `ပစ်မှတ် ${digest.totalTargets} ခုအနက် ${digest.healthyTargetsCount} ခု ပုံမှန်`
                    )}
                  </p>
                </div>

                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {tr('Average Health Score', 'ပျမ်းမျှ ကျန်းမာရေး ရမှတ်')}
                  </p>
                  <p
                    className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                      digest.avgHealthScore >= 85
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : digest.avgHealthScore >= 65
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {digest.avgHealthScore}
                    <span className="text-sm font-normal text-slate-400 dark:text-slate-500">
                      /100
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {tr(
                      `${digest.driftedTargetsCount} drifted target(s)`,
                      `ဖွဲ့စည်းပုံ ပြောင်းလဲမှု ${digest.driftedTargetsCount} ခု`
                    )}
                  </p>
                </div>

                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {tr('Incident MTTR', 'ပျမ်းမျှ ဖြေရှင်းချိန် (MTTR)')}
                  </p>
                  <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {digest.avgMttrMinutes != null
                      ? digest.avgMttrMinutes >= 60
                        ? `${(digest.avgMttrMinutes / 60).toFixed(1)}h`
                        : `${digest.avgMttrMinutes}m`
                      : '—'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {tr(
                      `${digest.resolvedIncidentsInPeriod} resolved · ${digest.openIncidentsCount} open`,
                      `ဖြေရှင်းပြီး ${digest.resolvedIncidentsInPeriod} · ဖွင့်ထား ${digest.openIncidentsCount}`
                    )}
                  </p>
                </div>

                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {tr('Fleet Storage & 30d Growth', 'စုစုပေါင်း သိုလှောင်မှုနှင့် ၃၀ ရက် တိုးနှုန်း')}
                  </p>
                  <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {digest.totalStoragePretty}
                  </p>
                  <p className="mt-1 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    +{digest.projected30dGrowthPretty}{' '}
                    {tr('projected / 30d', 'ခန့်မှန်း / ၃၀ ရက်')}
                  </p>
                </div>
              </div>

              {/* Executive Highlights + Incident Breakdown */}
              {(digest.highlights.length > 0 ||
                digest.incidentsByType.length > 0) && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr('Executive Summary Highlights', 'အမှုဆောင် အနှစ်ချုပ် အဓိကအချက်များ')}
                    </h2>
                    <ul className="space-y-2.5 text-xs text-slate-700 dark:text-slate-300">
                      {digest.highlights.map((h, i) => (
                        <li
                          key={i}
                          className="flex items-baseline gap-2 leading-relaxed"
                        >
                          <span
                            className={`font-semibold shrink-0 ${
                              h.severity === 'CRITICAL'
                                ? 'text-red-700 dark:text-red-400'
                                : h.severity === 'WARNING'
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-blue-700 dark:text-blue-400'
                            }`}
                          >
                            {h.severity}
                          </span>
                          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                            ·
                          </span>
                          <span>{h.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(
                        `Incidents by Category (${digest.periodDays}d)`,
                        `အမျိုးအစားအလိုက် ဖြစ်စဉ်များ (${digest.periodDays} ရက်)`
                      )}
                    </h2>
                    {digest.incidentsByType.length === 0 ? (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {tr('Zero incidents in this reporting window.', 'ဤကာလအတွင်း ဖြစ်စဉ် မရှိပါ။')}
                      </p>
                    ) : (
                      <div className="space-y-2 text-xs">
                        {digest.incidentsByType.map((row) => (
                          <div
                            key={row.type}
                            className="flex items-center justify-between"
                          >
                            <span className="text-slate-700 dark:text-slate-300">
                              {formatIncidentType(row.type)}
                            </span>
                            <span className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                              {row.count}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Per-Database Executive Scorecard */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Per-Target SLA, Health & Storage Scorecard',
                      'ဒေတာဘေ့စ်အလိုက် SLA၊ ကျန်းမာရေးနှင့် သိုလှောင်မှု ဇယား'
                    )}
                  </h2>
                  <button
                    type="button"
                    onClick={() => loadAll(digestDays)}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{tr('Refresh', 'ပြန်စစ်ရန်')}</span>
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">{tr('Database', 'ဒေတာဘေ့စ်')}</th>
                        <th className="px-4 py-2.5 font-medium">{tr('Status', 'အခြေအနေ')}</th>
                        <th className="px-4 py-2.5 font-medium text-right">{tr('Health', 'ရမှတ်')}</th>
                        <th className="px-4 py-2.5 font-medium text-right">SLA %</th>
                        <th className="px-4 py-2.5 font-medium text-right">{tr('Open / Resolved', 'ဖွင့် / ဖြေရှင်း')}</th>
                        <th className="px-4 py-2.5 font-medium text-right">MTTR</th>
                        <th className="px-4 py-2.5 font-medium text-right">{tr('Storage', 'အရွယ်အစား')}</th>
                        <th className="px-4 py-2.5 font-medium text-right">{tr('Cache Hit', 'Cache နှုန်း')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {digest.scorecards.map((s) => (
                        <tr key={s.databaseId} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60">
                          <td className="px-4 py-3">
                            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                              {s.name}
                            </span>
                            <span className="mx-1.5 text-slate-300 dark:text-slate-700">·</span>
                            <span className="text-slate-500 dark:text-slate-400">
                              {formatEnv(s.environment, true)}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-semibold">
                            <span
                              className={
                                s.healthStatus === 'HEALTHY'
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : s.healthStatus === 'DRIFT'
                                    ? 'text-red-700 dark:text-red-400'
                                    : 'text-amber-700 dark:text-amber-400'
                              }
                            >
                              {s.healthStatus}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                            {s.healthScore}/100
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                            {s.slaAvailabilityPct.toFixed(2)}%
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {s.openIncidentsCount} / {s.resolvedIncidentsCount}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            {s.mttrMinutes != null ? `${s.mttrMinutes}m` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {s.databaseSizePretty}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            {s.cacheHitRatioPct != null
                              ? `${s.cacheHitRatioPct.toFixed(1)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: BASELINE PROMOTION APPROVALS */}
      {activeTab === 'approvals' && (
        <div className="space-y-6">
          <form
            onSubmit={handleCreateApproval}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
          >
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {tr(
                  'Request Schema Baseline Promotion Approval',
                  'မူလစံဖွဲ့စည်းပုံ အတည်ပြုချက် တောင်းဆိုရန်'
                )}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {tr(
                  'Submit a target’s latest scanned catalog for peer/Admin sign-off before promoting it as the official canonical SHA-256 baseline.',
                  'နောက်ဆုံးစစ်ဆေးထားသော ဖွဲ့စည်းပုံကို တရားဝင် မူလစံဖွဲ့စည်းပုံအဖြစ် မတင်သွင်းမီ Admin အတည်ပြုချက် တောင်းခံနိုင်ပါသည်။'
                )}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {tr('Target Database', 'ပစ်မှတ် ဒေတာဘေ့စ်')}
                </label>
                <select
                  value={reqDbId}
                  onChange={(e) => setReqDbId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                >
                  {databases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name} ({formatEnv(db.environment, true)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {tr('Git Commit SHA (optional)', 'Git Commit SHA (ရွေးချယ်ရန်)')}
                </label>
                <input
                  type="text"
                  value={reqSha}
                  onChange={(e) => setReqSha(e.target.value)}
                  placeholder="e.g. f82c91d"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>
              <div className="md:col-span-2 space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {tr('Change Justification Note', 'ပြောင်းလဲမှု အကြောင်းရင်း မှတ်ချက်')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={reqNote}
                    onChange={(e) => setReqNote(e.target.value)}
                    placeholder={tr(
                      'e.g. Verified migration PR #418 on staging',
                      'ဥပမာ — Staging တွင် PR #418 စစ်ဆေးပြီး'
                    )}
                    className="flex-1 px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="submit"
                    disabled={submittingReq || !reqDbId}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{tr('Submit Request', 'တောင်းဆိုမည်')}</span>
                  </button>
                </div>
              </div>
            </div>
          </form>

          {/* Approval Queue */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {tr('Baseline Promotion Approval Queue', 'မူလစံဖွဲ့စည်းပုံ အတည်ပြုချက် တန်းစီစာရင်း')}
              </h3>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {pendingApprovalsCount} {tr('pending', 'စောင့်ဆိုင်းဆဲ')} ·{' '}
                {approvals.length} {tr('total', 'စုစုပေါင်း')}
              </span>
            </div>

            {approvals.length === 0 ? (
              <div className="p-10 text-center space-y-1.5">
                <ShieldCheck className="w-6 h-6 text-slate-400 dark:text-slate-500 mx-auto" />
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {tr('No baseline approval requests yet', 'အတည်ပြုချက် တောင်းဆိုမှု မရှိသေးပါ')}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {approvals.map((req) => (
                  <div key={req.id} className="p-5 space-y-3">
                    <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span
                            className={`font-semibold ${
                              req.status === 'PENDING'
                                ? 'text-amber-700 dark:text-amber-400'
                                : req.status === 'APPROVED'
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-red-700 dark:text-red-400'
                            }`}
                          >
                            {req.status === 'PENDING'
                              ? tr('Pending Review', 'စစ်ဆေးရန် စောင့်ဆိုင်းဆဲ')
                              : req.status === 'APPROVED'
                                ? tr('Approved & Promoted', 'အတည်ပြုပြီး')
                                : tr('Rejected', 'ငြင်းပယ်ပြီး')}
                          </span>
                          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                            ·
                          </span>
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {req.databaseName}
                          </span>
                          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-slate-500 dark:text-slate-400">
                            {formatEnv(req.environment)}
                          </span>
                          {req.gitCommitSha && (
                            <>
                              <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                                ·
                              </span>
                              <span className="font-mono text-slate-600 dark:text-slate-300">
                                commit {req.gitCommitSha.slice(0, 7)}
                              </span>
                            </>
                          )}
                        </div>
                        <p className="text-xs text-slate-800 dark:text-slate-200">{req.diffSummary}</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                          {tr('Requested by', 'တောင်းဆိုသူ')} {req.requestedByEmail} ·{' '}
                          {formatDateTime(req.createdAt)} · SHA{' '}
                          {req.proposedSchemaHash.slice(0, 12)}
                        </p>
                        {req.reviewedByEmail && (
                          <p className="text-[11px] text-slate-600 dark:text-slate-300">
                            {tr('Reviewed by', 'စစ်ဆေးသူ')}{' '}
                            <span className="font-mono">{req.reviewedByEmail}</span>
                            {req.reviewNote ? ` — "${req.reviewNote}"` : ''}
                          </p>
                        )}
                      </div>

                      {req.status === 'PENDING' && (
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <input
                            type="text"
                            value={reviewNotes[req.id] ?? ''}
                            onChange={(e) =>
                              setReviewNotes((prev) => ({
                                ...prev,
                                [req.id]: e.target.value,
                              }))
                            }
                            placeholder={tr('Review note…', 'စစ်ဆေးချက် မှတ်ချက်…')}
                            className="px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 w-44"
                          />
                          <button
                            type="button"
                            disabled={reviewingId === req.id}
                            onClick={() => handleReviewApproval(req.id, 'APPROVED')}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-60"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>{tr('Approve & Promote', 'အတည်ပြုပြီး တင်သွင်းမည်')}</span>
                          </button>
                          <button
                            type="button"
                            disabled={reviewingId === req.id}
                            onClick={() => handleReviewApproval(req.id, 'REJECTED')}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-red-700 dark:text-red-400 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-60"
                          >
                            <X className="w-3.5 h-3.5" />
                            <span>{tr('Reject', 'ငြင်းပယ်မည်')}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: TEAM & RBAC */}
      {activeTab === 'team' && (
        <div className="space-y-6">
          {/* Role Capabilities Matrix */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-800">
            <div className="p-5 space-y-1">
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-400">Admin</p>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {tr(
                  'Full control: approve production baselines, manage API keys, configure webhooks, maintenance windows, and RBAC roles.',
                  'အပြည့်အဝ ထိန်းချုပ်ခွင့် — ထုတ်လုပ်ရေး ဖွဲ့စည်းပုံ အတည်ပြုခြင်း၊ API သော့၊ Webhook နှင့် အဖွဲ့ဝင် အခွင့်အာဏာများ စီမံခန့်ခွဲနိုင်သည်။'
                )}
              </p>
            </div>
            <div className="p-5 space-y-1">
              <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">DBA</p>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {tr(
                  'Run target inspections, analyze EXPLAIN query plans, submit baseline promotion requests, and resolve telemetry incidents.',
                  'ဒေတာဘေ့စ် စစ်ဆေးခြင်း၊ EXPLAIN ခွဲခြမ်းစိတ်ဖြာခြင်း၊ မူလစံဖွဲ့စည်းပုံ တင်သွင်းရန် တောင်းဆိုခြင်းနှင့် သတိပေးချက် ဖြေရှင်းခြင်း ပြုလုပ်နိုင်သည်။'
                )}
              </p>
            </div>
            <div className="p-5 space-y-1">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">Viewer</p>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {tr(
                  'Read-only access to dashboards, ERD diagrams, schema history, incident feed, and executive SLA health reports.',
                  'ဒက်ရှ်ဘုတ်၊ ERD ပုံများ၊ ဖွဲ့စည်းပုံ မှတ်တမ်းနှင့် အမှုဆောင် SLA အစီရင်ခံစာများကို ကြည့်ရှုရုံသာ ခွင့်ပြုသည်။'
                )}
              </p>
            </div>
          </div>

          {/* Invite Member Form */}
          <form
            onSubmit={handleInviteMember}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
          >
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {tr('Invite Workspace Member', 'လုပ်ငန်းခွင် အဖွဲ့ဝင်အသစ် ဖိတ်ခေါ်ရန်')}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {tr('Full Name', 'အမည်')}
                </label>
                <input
                  type="text"
                  required
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="e.g. Su Myat Noe"
                  className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {tr('Work Email', 'အီးမေးလ်')}
                </label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="dba@company.com"
                  className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {tr('RBAC Role', 'အခန်းကဏ္ဍ (Role)')}
                </label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                >
                  <option value="admin">Admin</option>
                  <option value="dba">DBA</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={inviting}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-60"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>
                  {inviting
                    ? tr('Inviting…', 'ဖိတ်ခေါ်နေသည်…')
                    : tr('Invite Member', 'ဖိတ်ခေါ်မည်')}
                </span>
              </button>
            </div>
          </form>

          {/* Team Directory Table */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {tr('Workspace Members & Role Assignments', 'လုပ်ငန်းခွင် အဖွဲ့ဝင်များနှင့် အခွင့်အာဏာများ')}
              </h3>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {members.length} {tr('members', 'ဦး')}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">{tr('Member', 'အဖွဲ့ဝင်')}</th>
                    <th className="px-4 py-2.5 font-medium">{tr('Status', 'အခြေအနေ')}</th>
                    <th className="px-4 py-2.5 font-medium">{tr('Role', 'အခန်းကဏ္ဍ')}</th>
                    <th className="px-4 py-2.5 font-medium">{tr('Added', 'ထည့်သွင်းရက်')}</th>
                    <th className="px-4 py-2.5 font-medium text-right">{tr('Action', 'လုပ်ဆောင်ချက်')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {members.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900 dark:text-slate-100">
                          {m.displayName}
                          {m.isOwner && (
                            <span className="ml-2 text-[11px] font-medium text-blue-700 dark:text-blue-400">
                              · {tr('Owner', 'ပိုင်ရှင်')}
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {m.email}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-medium">
                        <span
                          className={
                            m.status === 'active'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-700 dark:text-amber-400'
                          }
                        >
                          {m.status === 'active'
                            ? tr('Active', 'တက်ကြွ')
                            : tr('Invited', 'ဖိတ်ခေါ်ထား')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {m.isOwner ? (
                          <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                            ADMIN
                          </span>
                        ) : (
                          <select
                            value={m.role}
                            onChange={(e) =>
                              handleRoleChange(
                                m.id,
                                e.target.value as WorkspaceRole
                              )
                            }
                            aria-label={`Role for ${m.email}`}
                            className="px-2.5 py-1 text-xs font-mono border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                          >
                            <option value="admin">ADMIN</option>
                            <option value="dba">DBA</option>
                            <option value="viewer">VIEWER</option>
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {formatDateTime(m.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {m.isOwner ? (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(m.id)}
                            aria-label={tr('Remove member', 'ဖယ်ရှားရန်')}
                            className="p-1.5 text-slate-400 dark:text-slate-500 hover:text-red-700 dark:hover:text-red-400 rounded-md cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
