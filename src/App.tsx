import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Bell,
  Code2,
  Database,
  FileCheck2,
  LayoutGrid,
  List,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import {
  LanguageSwitcher,
  LocaleProvider,
  useI18n,
} from './i18n/LocaleContext.tsx';
import { ApiClient } from './lib/api.ts';
import { SignInView } from './components/SignInView.tsx';
import { AddDatabaseModal } from './components/AddDatabaseModal.tsx';
import { TargetDetailView } from './components/TargetDetailView.tsx';
import { IncidentFeedView } from './components/IncidentFeedView.tsx';
import { TelemetrySuiteView } from './components/TelemetrySuiteView.tsx';
import { WebhooksView } from './components/WebhooksView.tsx';
import { CompareEnvironmentsView } from './components/CompareEnvironmentsView.tsx';
import { MigrationLinterView } from './components/MigrationLinterView.tsx';
import { AutomationSettingsView } from './components/AutomationSettingsView.tsx';
import { ActivityHeatmapCard } from './components/ActivityHeatmapCard.tsx';
import { HealthTrendSparkline } from './components/HealthTrendSparkline.tsx';
import type {
  AlertWebhookDto,
  EnvironmentType,
  MonitoredDatabaseDto,
} from './types/telemetry.ts';

type WorkspaceSection =
  | 'targets'
  | 'compare'
  | 'migrations'
  | 'incidents'
  | 'sql-suite'
  | 'webhooks'
  | 'automation';

function DashboardShell() {
  const { user, loading: authLoading, signOut, getIdToken } = useAuth();
  const { t, tr, formatEnv, formatRelativeTime } = useI18n();
  const api = useMemo(() => new ApiClient(getIdToken), [getIdToken]);

  const [section, setSection] = useState<WorkspaceSection>('targets');
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string | null>(
    null
  );
  const [databases, setDatabases] = useState<MonitoredDatabaseDto[]>([]);
  const [webhooks, setWebhooks] = useState<AlertWebhookDto[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');
  const [envFilter, setEnvFilter] = useState<'all' | EnvironmentType>('all');
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [sweepingAll, setSweepingAll] = useState(false);
  const [heatmapRefreshKey, setHeatmapRefreshKey] = useState(0);
  const [targetsViewMode, setTargetsViewMode] = useState<'grid' | 'table'>(
    'grid'
  );
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [bulkActionBusy, setBulkActionBusy] = useState<
    'inspect' | 'delete' | null
  >(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const loadWorkspaceData = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const [dbRes, whRes] = await Promise.all([
        api.listDatabases(),
        api.listWebhooks(),
      ]);
      setDatabases(dbRes.databases);
      const validIds = new Set(dbRes.databases.map((d) => d.id));
      setSelectedTargetIds((prev) => {
        const next = prev.filter((id) => validIds.has(id));
        return next.length === prev.length ? prev : next;
      });
      setWebhooks(whRes.webhooks);
      setHeatmapRefreshKey((k) => k + 1);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Unable to load workspace telemetry.',
              'လုပ်ငန်းခွင် စောင့်ကြည့်ရေး အချက်အလက်များကို ရယူ၍ မရပါ။'
            )
      );
    } finally {
      setLoadingData(false);
    }
  }, [api, user, tr]);

  useEffect(() => {
    if (user) {
      setLoadingData(true);
      loadWorkspaceData();
    }
  }, [user, loadWorkspaceData]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-sm font-medium text-slate-500">
          {tr(
            'Loading DriftGuard workspace…',
            'DriftGuard လုပ်ငန်းခွင်ကို ဖွင့်နေပါသည်…'
          )}
        </p>
      </div>
    );
  }

  if (!user) {
    return <SignInView />;
  }

  const totalOpenIncidents = databases.reduce(
    (sum, d) => sum + d.openIncidentsCount,
    0
  );
  const totalCriticalIncidents = databases.reduce(
    (sum, d) => sum + d.criticalIncidentsCount,
    0
  );
  const activeWebhooksCount = webhooks.filter((w) => w.isActive).length;

  const filteredDatabases = databases.filter((db) => {
    if (envFilter !== 'all' && db.environment !== envFilter) return false;
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    return (
      db.name.toLowerCase().includes(q) ||
      db.maskedTarget.toLowerCase().includes(q) ||
      db.environment.toLowerCase().includes(q)
    );
  });

  const selectedDbName = selectedDatabaseId
    ? databases.find((d) => d.id === selectedDatabaseId)?.name ??
      tr('Target Detail', 'ဒေတာဘေ့စ် အသေးစိတ်')
    : null;

  const handleQuickInspect = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setInspectingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.inspectDatabase(id);
      setNotice(
        tr(
          `Scanned ${res.snapshot.tableCount} tables (${res.snapshot.columnCount} columns) in ${res.snapshot.durationMs}ms.`,
          `ဇယား ${res.snapshot.tableCount} ခု (ကော်လံ ${res.snapshot.columnCount} ခု) ကို ${res.snapshot.durationMs}ms အတွင်း စစ်ဆေးပြီးစီးပါသည်။`
        )
      );
      await loadWorkspaceData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Inspection failed.', 'စစ်ဆေးမှု မအောင်မြင်ပါ။')
      );
    } finally {
      setInspectingId(null);
    }
  };

  const selectedSet = new Set(selectedTargetIds);
  const visibleIds = filteredDatabases.map((d) => d.id);
  const visibleSelectedCount = visibleIds.filter((id) =>
    selectedSet.has(id)
  ).length;
  const allVisibleSelected =
    visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && !allVisibleSelected;

  const toggleSelectOne = (id: string) => {
    setConfirmBulkDelete(false);
    setSelectedTargetIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const toggleSelectAllVisible = () => {
    setConfirmBulkDelete(false);
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleIds);
      setSelectedTargetIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      setSelectedTargetIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const clearSelection = () => {
    setSelectedTargetIds([]);
    setConfirmBulkDelete(false);
  };

  const handleBulkInspect = async () => {
    if (selectedTargetIds.length === 0 || bulkActionBusy) return;
    setBulkActionBusy('inspect');
    setConfirmBulkDelete(false);
    setError(null);
    setNotice(null);
    try {
      const res = await api.bulkInspectDatabases(selectedTargetIds);
      setNotice(
        tr(
          `Bulk inspection finished: ${res.succeededCount}/${res.scannedCount} selected target${
            res.scannedCount === 1 ? '' : 's'
          } scanned${
            res.failedCount > 0 ? ` (${res.failedCount} unreachable)` : ''
          }.`,
          `အများအပြား စစ်ဆေးမှု ပြီးဆုံးပါပြီ — ရွေးချယ်ထားသော ဒေတာဘေ့စ် ${res.scannedCount} ခုအနက် ${res.succeededCount} ခု အောင်မြင်${
            res.failedCount > 0 ? ` (${res.failedCount} ခု ချိတ်ဆက်မရပါ)` : 'ပါသည်'
          }။`
        )
      );
      if (res.failedCount === 0) {
        setSelectedTargetIds([]);
      }
      await loadWorkspaceData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Bulk inspection failed.',
              'အများအပြား စစ်ဆေးမှု မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setBulkActionBusy(null);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedTargetIds.length === 0 || bulkActionBusy) return;
    setBulkActionBusy('delete');
    setError(null);
    setNotice(null);
    try {
      const res = await api.bulkDeleteDatabases(selectedTargetIds);
      setSelectedTargetIds([]);
      setConfirmBulkDelete(false);
      setNotice(
        tr(
          `Deleted ${res.deletedCount} monitored target${
            res.deletedCount === 1 ? '' : 's'
          } and associated telemetry history.`,
          `စောင့်ကြည့်နေသော ဒေတာဘေ့စ် ${res.deletedCount} ခုနှင့် သက်ဆိုင်ရာ မှတ်တမ်းများကို ဖျက်ပြီးပါပြီ။`
        )
      );
      await loadWorkspaceData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Bulk delete failed.',
              'အများအပြား ဖျက်သိမ်းမှု မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setBulkActionBusy(null);
    }
  };

  const handleInspectAll = async () => {
    setSweepingAll(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.inspectAllDatabases();
      setNotice(
        tr(
          `Fleet sweep finished: ${res.succeededCount}/${res.scannedCount} active targets scanned${
            res.failedCount > 0 ? ` (${res.failedCount} unreachable)` : ''
          }.`,
          `ဒေတာဘေ့စ်အားလုံး စစ်ဆေးမှု ပြီးဆုံးပါပြီ — လုပ်ဆောင်နေသော ပစ်မှတ် ${res.scannedCount} ခုအနက် ${res.succeededCount} ခု အောင်မြင်${
            res.failedCount > 0 ? ` (${res.failedCount} ခု ချိတ်ဆက်မရပါ)` : 'ပါသည်'
          }။`
        )
      );
      await loadWorkspaceData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Fleet inspection failed.',
              'ဒေတာဘေ့စ်အားလုံး စစ်ဆေးမှု မအောင်မြင်ပါ။'
            )
      );
    } finally {
      setSweepingAll(false);
    }
  };

  const handleQuickRegisterWorkspaceDb = async () => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.createDatabase({
        name: 'workspace-primary-pg',
        environment: 'production',
        connectionMode: 'workspace_pg',
        pollIntervalSeconds: 60,
        gitCommitSha: 'a9f4c21',
        autoCaptureBaseline: true,
      });
      await loadWorkspaceData();
      setSelectedDatabaseId(res.database.id);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to register target.',
              'ဒေတာဘေ့စ် ပစ်မှတ် မှတ်ပုံတင်ခြင်း မအောင်မြင်ပါ။'
            )
      );
    }
  };

  const navigateTo = (next: WorkspaceSection) => {
    setSection(next);
    setSelectedDatabaseId(null);
    setMobileNavOpen(false);
  };

  const navItems: {
    id: WorkspaceSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }[] = [
    {
      id: 'targets',
      label: t('nav.targets'),
      icon: Database,
      count: databases.length,
    },
    {
      id: 'compare',
      label: t('nav.compare'),
      icon: ArrowLeftRight,
    },
    {
      id: 'migrations',
      label: t('nav.linter'),
      icon: FileCheck2,
    },
    {
      id: 'incidents',
      label: t('nav.incidents'),
      icon: AlertTriangle,
      count: totalOpenIncidents,
    },
    {
      id: 'sql-suite',
      label: t('nav.telemetry'),
      icon: Code2,
    },
    {
      id: 'webhooks',
      label: t('nav.webhooks'),
      icon: Bell,
      count: activeWebhooksCount,
    },
    {
      id: 'automation',
      label: t('nav.automation'),
      icon: SlidersHorizontal,
    },
  ];

  const breadcrumbLabel =
    section === 'targets'
      ? selectedDbName
        ? `${tr('Targets', 'ဒေတာဘေ့စ်များ')} / ${selectedDbName}`
        : t('nav.targets')
      : section === 'compare'
        ? t('nav.compare')
        : section === 'migrations'
          ? tr(
              'Pre-Flight Migration Linter',
              'Migration ဘေးကင်းရေး စစ်ဆေးစက်'
            )
          : section === 'incidents'
            ? t('nav.incidents')
            : section === 'sql-suite'
              ? t('nav.telemetry')
              : section === 'webhooks'
                ? t('nav.webhooks')
                : tr('CI/CD Gates & Threshold Rules', 'CI/CD နှင့် စည်းမျဉ်းများ');

  const formatTargetHealth = (status: string) => {
    if (status === 'HEALTHY') return t('status.healthy');
    if (status === 'DRIFT') return tr('Schema Drift', 'ဖွဲ့စည်းပုံ ပြောင်းလဲမှု');
    if (status === 'WARNING') return t('status.warning');
    if (status === 'ERROR') return tr('Poll Error', 'ချိတ်ဆက်မှု အမှား');
    return t('status.unknown');
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-68 shrink-0 border-r border-slate-200 bg-white">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <button
            type="button"
            onClick={() => navigateTo('targets')}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap cursor-pointer"
          >
            DriftGuard
          </button>
        </div>

        <nav
          className="flex-1 p-4 space-y-1 overflow-y-auto"
          aria-label={tr('Primary', 'ပင်မ မီနူး')}
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      active ? 'text-blue-700' : 'text-slate-400'
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {typeof item.count === 'number' && item.count > 0 && (
                  <span
                    className={`text-xs font-mono tabular-nums shrink-0 ${
                      item.id === 'incidents' && totalCriticalIncidents > 0
                        ? 'text-red-700 font-semibold'
                        : 'text-slate-500'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <LanguageSwitcher variant="sidebar" />
          <div className="min-w-0 pt-2 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-900 truncate">
              {user.displayName ||
                tr('Workspace Operator', 'လုပ်ငန်းခွင် စီမံခန့်ခွဲသူ')}
            </p>
            <p className="text-xs text-slate-500 truncate">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{t('action.signOut')}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] bg-white h-full flex flex-col border-r border-slate-200 z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="font-display text-lg font-bold text-slate-900">
                DriftGuard
              </span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label={tr('Close navigation', 'မီနူး ပိတ်ရန်')}
                className="p-2 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigateTo(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium ${
                      active
                        ? 'bg-slate-100 text-slate-900'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200 space-y-3">
              <LanguageSwitcher variant="sidebar" />
              <p className="text-xs text-slate-500 truncate pt-1 border-t border-slate-100">
                {user.email}
              </p>
              <button
                type="button"
                onClick={signOut}
                className="w-full py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg"
              >
                {t('action.signOut')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb on left, 1 primary action on right */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label={tr('Open navigation', 'မီနူး ဖွင့်ရန်')}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 whitespace-nowrap">
                DriftGuard
              </span>
              <span className="text-slate-300" aria-hidden="true">
                /
              </span>
              <span className="font-medium text-slate-900 truncate">
                {breadcrumbLabel}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setAddModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{t('action.addTarget')}</span>
          </button>
        </header>

        <main className="flex-1 p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {section === 'targets' && selectedDatabaseId ? (
            <TargetDetailView
              api={api}
              databaseId={selectedDatabaseId}
              onBack={() => setSelectedDatabaseId(null)}
              onChanged={loadWorkspaceData}
            />
          ) : section === 'targets' ? (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                    {tr(
                      'Monitored PostgreSQL Targets',
                      'စောင့်ကြည့်နေသော PostgreSQL ဒေတာဘေ့စ်များ'
                    )}
                  </h1>
                  <p className="text-sm text-slate-500 mt-1">
                    {tr(
                      'Safe, read-only monitoring for unexpected schema changes, blocking queries, table bloat, and unused indexes.',
                      'မမျှော်လင့်သော ဖွဲ့စည်းပုံ ပြောင်းလဲမှုများ၊ Lock ပိတ်ဆို့နေသော Query များ၊ ဇယား ဖောင်းပွမှုနှင့် အသုံးမပြုသော အညွှန်းများကို Read-Only စနစ်ဖြင့် ဘေးကင်းစွာ စောင့်ကြည့်ပေးပါသည်။'
                    )}
                  </p>
                </div>
                {databases.length > 0 && (
                  <button
                    type="button"
                    disabled={sweepingAll}
                    onClick={handleInspectAll}
                    className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${sweepingAll ? 'animate-spin' : ''}`}
                    />
                    <span>
                      {sweepingAll
                        ? tr('Scanning Fleet…', 'အားလုံးကို စစ်ဆေးနေသည်…')
                        : tr(
                            'Inspect All Active Targets',
                            'ဒေတာဘေ့စ်အားလုံး စစ်ဆေးရန်'
                          )}
                    </span>
                  </button>
                )}
              </div>

              {notice && (
                <div className="px-4 py-3 rounded-lg border border-blue-200 bg-blue-50 text-sm text-blue-900">
                  {notice}
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800"
                >
                  {error}
                </div>
              )}

              {/* 4-Column KPI Strip */}
              <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {t('nav.targets')}
                  </p>
                  <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {databases.length}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 tabular-nums">
                    {tr(
                      `${databases.filter((d) => d.isActive).length} active polling`,
                      `${databases.filter((d) => d.isActive).length} ခု အလိုအလျောက် စောင့်ကြည့်နေသည်`
                    )}
                  </p>
                </div>

                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {tr(
                      'Critical Schema Drifts',
                      'အရေးကြီး ဖွဲ့စည်းပုံ ပြောင်းလဲမှုများ'
                    )}
                  </p>
                  <p
                    className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                      totalCriticalIncidents > 0
                        ? 'text-red-700'
                        : 'text-slate-900'
                    }`}
                  >
                    {totalCriticalIncidents}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {tr(
                      'SHA-256 baseline mismatches',
                      'SHA-256 မူလစံဖွဲ့စည်းပုံနှင့် မကိုက်ညီမှုများ'
                    )}
                  </p>
                </div>

                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {tr(
                      'Open Telemetry Incidents',
                      'ဖွင့်ထားသော သတိပေးချက်များ'
                    )}
                  </p>
                  <p
                    className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
                      totalOpenIncidents > 0
                        ? 'text-amber-700'
                        : 'text-slate-900'
                    }`}
                  >
                    {totalOpenIncidents}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {tr(
                      'Drift, locks, bloat & vacuum',
                      'ဖွဲ့စည်းပုံ၊ Lock၊ ဖောင်းပွမှုနှင့် VACUUM'
                    )}
                  </p>
                </div>

                <div className="p-5">
                  <p className="text-xs font-medium text-slate-500">
                    {tr(
                      'Active Alert Channels',
                      'ဖွင့်ထားသော သတိပေးချက် လမ်းကြောင်းများ'
                    )}
                  </p>
                  <p className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {activeWebhooksCount}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {tr(
                      'Slack, Discord & HTTPS hooks',
                      'Slack၊ Discord နှင့် HTTPS Webhook များ'
                    )}
                  </p>
                </div>
              </div>

              {/* 24-Hour PostgreSQL Target Activity & Error Rate Heat Map */}
              <ActivityHeatmapCard
                api={api}
                databases={databases}
                envFilter={envFilter}
                refreshKey={heatmapRefreshKey}
                onSelectDatabase={(dbId) => setSelectedDatabaseId(dbId)}
                onViewIncidents={() => navigateTo('incidents')}
                onInspectAll={
                  databases.length > 0 ? handleInspectAll : undefined
                }
              />

              {/* Filter, Search & Layout Toolbar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
                  {(
                    ['all', 'production', 'staging', 'development'] as const
                  ).map((env) => (
                    <button
                      key={env}
                      type="button"
                      onClick={() => setEnvFilter(env)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        envFilter === env
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {env === 'all' ? t('env.all') : formatEnv(env, true)}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2.5 w-full sm:w-auto">
                  <div className="relative flex-1 sm:w-64">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder={tr(
                        'Search targets…',
                        'ဒေတာဘေ့စ် အမည် ရှာဖွေရန်…'
                      )}
                      className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
                    />
                  </div>

                  <div
                    role="group"
                    aria-label={tr('Targets layout', 'ဒေတာဘေ့စ် ပြသမှု ပုံစံ')}
                    className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0"
                  >
                    <button
                      type="button"
                      onClick={() => setTargetsViewMode('grid')}
                      aria-pressed={targetsViewMode === 'grid'}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        targetsViewMode === 'grid'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                      <span>{tr('Grid', 'ကတ်များ')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTargetsViewMode('table')}
                      aria-pressed={targetsViewMode === 'table'}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        targetsViewMode === 'table'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <List className="w-3.5 h-3.5" />
                      <span>{tr('Table', 'ဇယား')}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Contextual Bulk Selection Bar */}
              {!loadingData && filteredDatabases.length > 0 && (
                selectedTargetIds.length > 0 ? (
                  <div
                    role="region"
                    aria-label={tr(
                      'Bulk target actions',
                      'ဒေတာဘေ့စ် အများအပြား လုပ်ဆောင်ချက်များ'
                    )}
                    className="bg-white border border-blue-200 rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="flex flex-wrap items-center gap-3 min-w-0">
                      <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          disabled={bulkActionBusy !== null}
                          ref={(el) => {
                            if (el) el.indeterminate = someVisibleSelected;
                          }}
                          onChange={toggleSelectAllVisible}
                          aria-label={tr(
                            'Select all visible targets',
                            'ပြသထားသော ဒေတာဘေ့စ်အားလုံး ရွေးချယ်ရန်'
                          )}
                          className="h-4 w-4 rounded border-slate-300 text-blue-700 accent-blue-700 focus:ring-2 focus:ring-blue-700/30 cursor-pointer"
                        />
                        <span className="text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                          {tr(
                            `${selectedTargetIds.length} selected`,
                            `${selectedTargetIds.length} ခု ရွေးချယ်ထားသည်`
                          )}
                        </span>
                      </label>
                      {selectedTargetIds.length > visibleSelectedCount && (
                        <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {tr(
                            `(${visibleSelectedCount} shown)`,
                            `(${visibleSelectedCount} ခု ပြသထား)`
                          )}
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={bulkActionBusy !== null}
                        onClick={clearSelection}
                        className="text-xs font-medium text-slate-500 hover:text-slate-900 underline underline-offset-2 whitespace-nowrap cursor-pointer disabled:opacity-50"
                      >
                        {tr('Clear', 'ရှင်းလင်းရန်')}
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {confirmBulkDelete ? (
                        <>
                          <span className="text-xs font-medium text-red-800 whitespace-nowrap">
                            {tr(
                              `Delete ${selectedTargetIds.length} target${
                                selectedTargetIds.length === 1 ? '' : 's'
                              } permanently?`,
                              `ရွေးချယ်ထားသော ဒေတာဘေ့စ် ${selectedTargetIds.length} ခုကို အပြီးတိုင် ဖျက်မည်လား?`
                            )}
                          </span>
                          <button
                            type="button"
                            disabled={bulkActionBusy !== null}
                            onClick={handleBulkDelete}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>
                              {bulkActionBusy === 'delete'
                                ? tr('Deleting…', 'ဖျက်နေသည်…')
                                : tr('Confirm Delete', 'ဖျက်ရန် အတည်ပြုမည်')}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={bulkActionBusy !== null}
                            onClick={() => setConfirmBulkDelete(false)}
                            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                          >
                            {tr('Cancel', 'မလုပ်တော့ပါ')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={bulkActionBusy !== null}
                            onClick={handleBulkInspect}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                          >
                            <RefreshCw
                              className={`w-3.5 h-3.5 ${
                                bulkActionBusy === 'inspect'
                                  ? 'animate-spin'
                                  : ''
                              }`}
                            />
                            <span>
                              {bulkActionBusy === 'inspect'
                                ? tr('Inspecting…', 'စစ်ဆေးနေသည်…')
                                : tr(
                                    'Inspect Selected',
                                    'ရွေးချယ်ထားသည်များ စစ်ဆေးရန်'
                                  )}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={bulkActionBusy !== null}
                            onClick={() => setConfirmBulkDelete(true)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>
                              {tr(
                                'Delete Selected',
                                'ရွေးချယ်ထားသည်များ ဖျက်ရန်'
                              )}
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : targetsViewMode === 'grid' ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none hover:text-slate-900">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        disabled={bulkActionBusy !== null}
                        ref={(el) => {
                          if (el) el.indeterminate = someVisibleSelected;
                        }}
                        onChange={toggleSelectAllVisible}
                        aria-label={tr(
                          'Select all visible targets',
                          'ပြသထားသော ဒေတာဘေ့စ်အားလုံး ရွေးချယ်ရန်'
                        )}
                        className="h-4 w-4 rounded border-slate-300 text-blue-700 accent-blue-700 focus:ring-2 focus:ring-blue-700/30 cursor-pointer"
                      />
                      <span className="font-medium tabular-nums">
                        {tr(
                          `Select all (${filteredDatabases.length})`,
                          `အားလုံး ရွေးချယ်ရန် (${filteredDatabases.length})`
                        )}
                      </span>
                    </label>
                    <span>
                      {tr(
                        'Select targets to inspect or delete in bulk',
                        'အများအပြား စစ်ဆေးရန် သို့မဟုတ် ဖျက်ရန် ရွေးချယ်နိုင်သည်'
                      )}
                    </span>
                  </div>
                ) : null
              )}

              {/* Monitored Targets Grid / Table */}
              {loadingData ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[1, 2, 3, 4].map((card) => (
                    <div
                      key={card}
                      className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 animate-pulse"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1.5 w-2/3">
                          <div className="h-4 bg-slate-200 rounded w-40" />
                          <div className="h-3 bg-slate-100 rounded w-56" />
                        </div>
                        <div className="h-7 bg-slate-100 rounded w-20" />
                      </div>
                      <div className="h-12 bg-slate-100 rounded" />
                      <div className="h-4 bg-slate-100 rounded w-3/4" />
                    </div>
                  ))}
                </div>
              ) : databases.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-4">
                  <div className="space-y-1.5 max-w-md mx-auto">
                    <h2 className="text-base font-semibold text-slate-900">
                      {tr(
                        'No PostgreSQL targets registered yet',
                        'စောင့်ကြည့်မည့် PostgreSQL ဒေတာဘေ့စ် မရှိသေးပါ'
                      )}
                    </h2>
                    <p className="text-sm text-slate-500">
                      {tr(
                        "Connect an external PostgreSQL 13+ cluster with a read-only role, or inspect this workspace's live provisioned PostgreSQL instance right away.",
                        'ပြင်ပ PostgreSQL 13+ ဒေတာဘေ့စ်ကို Read-Only အကောင့်ဖြင့် ချိတ်ဆက်နိုင်ပြီး သို့မဟုတ် ဤလုပ်ငန်းခွင်၏ PostgreSQL ဒေတာဘေ့စ်ကို ချက်ချင်း စတင်စောင့်ကြည့်နိုင်ပါသည်။'
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={handleQuickRegisterWorkspaceDb}
                      className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {tr(
                        'Monitor Workspace PostgreSQL Now',
                        'လုပ်ငန်းခွင် PostgreSQL ကို ယခု စောင့်ကြည့်ရန်'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddModalOpen(true)}
                      className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {tr(
                        'Register External URI',
                        'ပြင်ပ URI ဖြင့် ချိတ်ဆက်ရန်'
                      )}
                    </button>
                  </div>
                </div>
              ) : filteredDatabases.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                  {tr(
                    'No targets match your current search or environment filter.',
                    'လက်ရှိ ရှာဖွေမှု သို့မဟုတ် ပတ်ဝန်းကျင် စစ်ထုတ်မှုနှင့် ကိုက်ညီသော ဒေတာဘေ့စ် မတွေ့ရှိပါ။'
                  )}
                </div>
              ) : targetsViewMode === 'grid' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredDatabases.map((db) => {
                    const isSelected = selectedSet.has(db.id);
                    return (
                      <article
                        key={db.id}
                        onClick={() => setSelectedDatabaseId(db.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedDatabaseId(db.id);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`${db.name} (${formatEnv(db.environment, true)}) — ${formatTargetHealth(db.lastHealthStatus)}`}
                        className={`border rounded-xl p-5 flex flex-col justify-between gap-4 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700/40 ${
                          isSelected
                            ? 'bg-blue-50/20 border-blue-600/70'
                            : 'bg-white border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {/* Top Header: Checkbox, Title, Environment, Health Status & Inspect CTA */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <label
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              className="pt-0.5 shrink-0 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                disabled={bulkActionBusy !== null}
                                onChange={() => toggleSelectOne(db.id)}
                                aria-label={tr(
                                  `Select ${db.name}`,
                                  `${db.name} ကို ရွေးချယ်ရန်`
                                )}
                                className="h-4 w-4 rounded border-slate-300 text-blue-700 accent-blue-700 focus:ring-2 focus:ring-blue-700/30 cursor-pointer"
                              />
                            </label>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <h3 className="text-sm font-semibold text-slate-900 truncate">
                                  {db.name}
                                </h3>
                                <span
                                  className="text-slate-300"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span className="text-xs text-slate-500 whitespace-nowrap">
                                  {formatEnv(db.environment, true)}
                                </span>
                                <span
                                  className="text-slate-300"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span
                                  className={`text-xs font-semibold whitespace-nowrap ${
                                    db.lastHealthStatus === 'HEALTHY'
                                      ? 'text-emerald-700'
                                      : db.lastHealthStatus === 'DRIFT' ||
                                          db.lastHealthStatus === 'ERROR'
                                        ? 'text-red-700'
                                        : db.lastHealthStatus === 'WARNING'
                                          ? 'text-amber-700'
                                          : 'text-slate-500'
                                  }`}
                                >
                                  {formatTargetHealth(db.lastHealthStatus)}
                                </span>
                              </div>
                              <p className="text-xs font-mono text-slate-500 mt-1 truncate">
                                {db.maskedTarget}
                              </p>
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={
                              inspectingId === db.id || bulkActionBusy !== null
                            }
                            onClick={(e) => handleQuickInspect(e, db.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${
                                inspectingId === db.id ? 'animate-spin' : ''
                              }`}
                            />
                            <span>
                              {inspectingId === db.id
                                ? tr('Scanning…', 'စစ်ဆေးနေသည်…')
                                : tr('Inspect', 'စစ်ဆေးရန်')}
                            </span>
                          </button>
                        </div>

                        {/* 7-Day Health Status Trend Sparkline */}
                        <div
                          className="pt-3.5 border-t border-slate-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <HealthTrendSparkline
                            points={db.healthTrend7d}
                            currentStatus={db.lastHealthStatus}
                            variant="card"
                          />
                        </div>

                        {/* Footer Telemetry Metadata */}
                        <div className="pt-3 border-t border-slate-100 grid grid-cols-3 gap-3 text-xs">
                          <div className="min-w-0">
                            <p className="text-[11px] text-slate-500">
                              {tr('Baseline SHA-256', 'မူလစံ SHA-256')}
                            </p>
                            <p className="mt-0.5 font-mono text-slate-800 tabular-nums truncate">
                              {db.latestBaseline
                                ? db.latestBaseline.schemaHash.slice(0, 10)
                                : tr('None', 'မရှိပါ')}
                            </p>
                          </div>

                          <div>
                            <p className="text-[11px] text-slate-500">
                              {tr('Open Alerts', 'သတိပေးချက်')}
                            </p>
                            <p
                              className={`mt-0.5 font-mono tabular-nums ${
                                db.criticalIncidentsCount > 0
                                  ? 'font-semibold text-red-700'
                                  : db.openIncidentsCount > 0
                                    ? 'font-semibold text-amber-700'
                                    : 'text-slate-700'
                              }`}
                            >
                              {db.openIncidentsCount}
                              {db.criticalIncidentsCount > 0
                                ? ` (${db.criticalIncidentsCount} ${tr('crit', 'အရေးကြီး')})`
                                : ''}
                            </p>
                          </div>

                          <div className="text-right">
                            <p className="text-[11px] text-slate-500">
                              {tr('Last Polled', 'နောက်ဆုံး စစ်ဆေး')}
                            </p>
                            <p className="mt-0.5 text-slate-700 tabular-nums whitespace-nowrap">
                              {formatRelativeTime(db.lastPolledAt)}
                            </p>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                          <th className="py-3 pl-5 pr-2 w-10">
                            <input
                              type="checkbox"
                              checked={allVisibleSelected}
                              disabled={bulkActionBusy !== null}
                              ref={(el) => {
                                if (el) el.indeterminate = someVisibleSelected;
                              }}
                              onChange={toggleSelectAllVisible}
                              aria-label={tr(
                                'Select all visible targets',
                                'ပြသထားသော ဒေတာဘေ့စ်အားလုံး ရွေးချယ်ရန်'
                              )}
                              className="h-4 w-4 rounded border-slate-300 text-blue-700 accent-blue-700 focus:ring-2 focus:ring-blue-700/30 cursor-pointer align-middle"
                            />
                          </th>
                          <th className="py-3 pl-2 pr-4">
                            {tr('Target Database', 'ဒေတာဘေ့စ် ပစ်မှတ်')}
                          </th>
                          <th className="py-3 px-4">
                            {tr('Health', 'ကျန်းမာရေး အခြေအနေ')}
                          </th>
                          <th className="py-3 px-4">
                            {tr('7-Day Trend', '၇ ရက် လမ်းကြောင်း')}
                          </th>
                          <th className="py-3 px-4">
                            {tr('Baseline SHA-256', 'မူလ စံဖွဲ့စည်းပုံ SHA-256')}
                          </th>
                          <th className="py-3 px-4 text-right">
                            {tr('Open Alerts', 'ဖွင့်ထားသော သတိပေးချက်')}
                          </th>
                          <th className="py-3 px-4 text-right">
                            {tr('Last Polled', 'နောက်ဆုံး စစ်ဆေးချိန်')}
                          </th>
                          <th className="py-3 px-6 text-right">
                            {tr('Action', 'လုပ်ဆောင်ချက်')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-sm">
                        {filteredDatabases.map((db) => {
                          const isSelected = selectedSet.has(db.id);
                          return (
                            <tr
                              key={db.id}
                              onClick={() => setSelectedDatabaseId(db.id)}
                              className={`transition-colors cursor-pointer ${
                                isSelected
                                  ? 'bg-blue-50/40 hover:bg-blue-50/60'
                                  : 'hover:bg-slate-50'
                              }`}
                            >
                              <td
                                className="py-3.5 pl-5 pr-2 w-10"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={bulkActionBusy !== null}
                                  onChange={() => toggleSelectOne(db.id)}
                                  aria-label={tr(
                                    `Select ${db.name}`,
                                    `${db.name} ကို ရွေးချယ်ရန်`
                                  )}
                                  className="h-4 w-4 rounded border-slate-300 text-blue-700 accent-blue-700 focus:ring-2 focus:ring-blue-700/30 cursor-pointer align-middle"
                                />
                              </td>
                              <td className="py-3.5 pl-2 pr-4">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-slate-900">
                                    {db.name}
                                  </span>
                                  <span
                                    className="text-slate-300"
                                    aria-hidden="true"
                                  >
                                    ·
                                  </span>
                                  <span className="text-xs text-slate-500">
                                    {formatEnv(db.environment, true)}
                                  </span>
                                </div>
                                <p className="text-xs font-mono text-slate-500 mt-0.5 truncate max-w-sm">
                                  {db.maskedTarget}
                                </p>
                              </td>

                              <td className="py-3.5 px-4 text-xs font-semibold whitespace-nowrap">
                                <span
                                  className={
                                    db.lastHealthStatus === 'HEALTHY'
                                      ? 'text-emerald-700'
                                      : db.lastHealthStatus === 'DRIFT' ||
                                          db.lastHealthStatus === 'ERROR'
                                        ? 'text-red-700'
                                        : db.lastHealthStatus === 'WARNING'
                                          ? 'text-amber-700'
                                          : 'text-slate-500'
                                  }
                                >
                                  {formatTargetHealth(db.lastHealthStatus)}
                                </span>
                              </td>

                              <td className="py-3.5 px-4 whitespace-nowrap">
                                <HealthTrendSparkline
                                  points={db.healthTrend7d}
                                  currentStatus={db.lastHealthStatus}
                                  variant="compact"
                                />
                              </td>

                              <td className="py-3.5 px-4 text-xs font-mono text-slate-700 tabular-nums">
                                {db.latestBaseline ? (
                                  <div>
                                    <span>
                                      {db.latestBaseline.schemaHash.slice(0, 12)}
                                    </span>
                                    <span className="text-slate-400 ml-1.5 font-sans">
                                      (
                                      {tr(
                                        `${db.latestBaseline.tableCount}t / ${db.latestBaseline.columnCount}c`,
                                        `ဇယား ${db.latestBaseline.tableCount} / ကော်လံ ${db.latestBaseline.columnCount}`
                                      )}
                                      )
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-slate-400 font-sans">
                                    {tr('No baseline', 'မူလစံ မရှိသေးပါ')}
                                  </span>
                                )}
                              </td>

                              <td className="py-3.5 px-4 text-right text-xs font-mono tabular-nums">
                                <span
                                  className={
                                    db.criticalIncidentsCount > 0
                                      ? 'font-semibold text-red-700'
                                      : db.openIncidentsCount > 0
                                        ? 'font-semibold text-amber-700'
                                        : 'text-slate-500'
                                  }
                                >
                                  {db.openIncidentsCount}
                                </span>
                              </td>

                              <td className="py-3.5 px-4 text-right text-xs text-slate-500 tabular-nums whitespace-nowrap">
                                {formatRelativeTime(db.lastPolledAt)}
                              </td>

                              <td className="py-3.5 px-6 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  disabled={
                                    inspectingId === db.id ||
                                    bulkActionBusy !== null
                                  }
                                  onClick={(e) => handleQuickInspect(e, db.id)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                                >
                                  <RefreshCw
                                    className={`w-3 h-3 ${
                                      inspectingId === db.id
                                        ? 'animate-spin'
                                        : ''
                                    }`}
                                  />
                                  <span>
                                    {inspectingId === db.id
                                      ? tr('Scanning…', 'စစ်ဆေးနေသည်…')
                                      : tr('Inspect', 'စစ်ဆေးရန်')}
                                  </span>
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : section === 'compare' ? (
            <CompareEnvironmentsView
              api={api}
              databases={databases}
              onOpenAddModal={() => setAddModalOpen(true)}
            />
          ) : section === 'migrations' ? (
            <MigrationLinterView api={api} databases={databases} />
          ) : section === 'incidents' ? (
            <IncidentFeedView
              api={api}
              onIncidentChanged={loadWorkspaceData}
              onSelectDatabase={(dbId) => {
                setSection('targets');
                setSelectedDatabaseId(dbId);
              }}
            />
          ) : section === 'sql-suite' ? (
            <TelemetrySuiteView
              api={api}
              databases={databases}
              onIncidentCreated={loadWorkspaceData}
              onDatabasesChanged={loadWorkspaceData}
            />
          ) : section === 'webhooks' ? (
            <WebhooksView api={api} onChanged={loadWorkspaceData} />
          ) : (
            <AutomationSettingsView
              api={api}
              databases={databases}
              onDatabasesChanged={loadWorkspaceData}
            />
          )}
        </main>
      </div>

      <AddDatabaseModal
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onCreate={async (payload) => {
          const res = await api.createDatabase(payload);
          await loadWorkspaceData();
          setSection('targets');
          setSelectedDatabaseId(res.database.id);
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <LocaleProvider>
      <AuthProvider>
        <DashboardShell />
      </AuthProvider>
    </LocaleProvider>
  );
}
