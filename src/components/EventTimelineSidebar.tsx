import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  GitBranch,
  PanelRightClose,
  RefreshCw,
  ScanSearch,
  Search,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';
import type { ApiClient } from '../lib/api.ts';
import type {
  DatabaseTimelineEvent,
  DatabaseTimelineResponse,
  TimelineEventCategory,
} from '../types/telemetry.ts';

type FilterCategory = 'all' | TimelineEventCategory;
type JumpTab = 'diff' | 'catalog' | 'health' | 'locks' | 'bloat' | 'baselines';

interface EventTimelineSidebarProps {
  api: ApiClient;
  databaseId: string;
  databaseName: string;
  refreshKey: number;
  onInspectNow?: () => void;
  onJumpToTab?: (tab: JumpTab) => void;
  onClose?: () => void;
}

function severityTextClass(severity: DatabaseTimelineEvent['severity']): string {
  switch (severity) {
    case 'CRITICAL':
      return 'text-red-700 dark:text-red-400';
    case 'WARNING':
      return 'text-amber-700 dark:text-amber-400';
    case 'SUCCESS':
      return 'text-emerald-700 dark:text-emerald-400';
    default:
      return 'text-blue-700 dark:text-blue-400';
  }
}

function nodeSurfaceClass(
  category: TimelineEventCategory,
  severity: DatabaseTimelineEvent['severity']
): string {
  if (severity === 'CRITICAL') {
    return 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/70 text-red-700 dark:text-red-400';
  }
  if (severity === 'WARNING') {
    return 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/70 text-amber-700 dark:text-amber-400';
  }
  if (severity === 'SUCCESS') {
    return 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/70 text-emerald-700 dark:text-emerald-400';
  }
  if (category === 'schema_change') {
    return 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/70 text-blue-700 dark:text-blue-400';
  }
  return 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300';
}

function CategoryIcon({ category }: { category: TimelineEventCategory }) {
  switch (category) {
    case 'schema_change':
      return <GitBranch className="w-3.5 h-3.5" />;
    case 'alert_trigger':
      return <BellRing className="w-3.5 h-3.5" />;
    case 'manual_inspection':
      return <ScanSearch className="w-3.5 h-3.5" />;
  }
}

export function EventTimelineSidebar({
  api,
  databaseId,
  databaseName,
  refreshKey,
  onInspectNow,
  onJumpToTab,
  onClose,
}: EventTimelineSidebarProps) {
  const { locale, t, tr, formatRelativeTime } = useI18n();
  const [timeline, setTimeline] = useState<DatabaseTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<FilterCategory>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const formatTimeOnly = useCallback(
    (iso: string) => {
      const d = new Date(iso);
      return d.toLocaleTimeString(locale === 'my' ? 'my-MM' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    },
    [locale]
  );

  const getDayGroupLabel = useCallback(
    (iso: string) => {
      const d = new Date(iso);
      const now = new Date();
      const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      ).getTime();
      const startOfEventDay = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate()
      ).getTime();
      const dayDiff = Math.round((startOfToday - startOfEventDay) / 86_400_000);
      if (dayDiff === 0) return tr('Today', 'ယနေ့');
      if (dayDiff === 1) return tr('Yesterday', 'မနေ့က');
      return d.toLocaleDateString(locale === 'my' ? 'my-MM' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
    },
    [locale, tr]
  );

  const categoryTextLabel = useCallback(
    (category: TimelineEventCategory) => {
      switch (category) {
        case 'schema_change':
          return tr('Schema Change', 'ဖွဲ့စည်းပုံ ပြောင်းလဲမှု');
        case 'alert_trigger':
          return tr('Alert Trigger', 'သတိပေးချက်');
        case 'manual_inspection':
          return tr('Inspection', 'စစ်ဆေးမှု');
      }
    },
    [tr]
  );

  const tabLabel = useCallback(
    (tab: JumpTab) => {
      switch (tab) {
        case 'diff':
          return tr('Schema Diff', 'ဖွဲ့စည်းပုံ ကွာခြားချက်');
        case 'catalog':
          return tr('Live Catalog', 'လက်ရှိ Catalog');
        case 'health':
          return tr('Table Health', 'ဇယား ကျန်းမာရေး');
        case 'locks':
          return tr('Lock Tree', 'Lock ပိတ်ဆို့မှု');
        case 'bloat':
          return tr('Index Bloat', 'အညွှန်း ဖောင်းပွမှု');
        case 'baselines':
          return tr('Baselines', 'မူလစံ မှတ်တမ်းများ');
      }
    },
    [tr]
  );

  const loadTimeline = useCallback(
    async (silent = false) => {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await api.getDatabaseTimeline(databaseId);
        setTimeline(res);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : tr(
                'Failed to load event timeline.',
                'ဖြစ်ရပ် အချိန်ဇယား ရယူ၍ မရပါ။'
              )
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, databaseId, tr]
  );

  useEffect(() => {
    loadTimeline(timeline !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, refreshKey]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const filteredEvents = useMemo(() => {
    const raw = timeline?.events ?? [];
    const term = searchTerm.trim().toLowerCase();

    const matched = raw.filter((ev) => {
      if (categoryFilter !== 'all' && ev.category !== categoryFilter) {
        return false;
      }
      if (!term) return true;
      return (
        ev.title.toLowerCase().includes(term) ||
        ev.summary.toLowerCase().includes(term) ||
        (ev.actor ?? '').toLowerCase().includes(term) ||
        (ev.schemaHash ?? '').toLowerCase().includes(term) ||
        (ev.statusLabel ?? '').toLowerCase().includes(term) ||
        ev.meta.some(
          (m) =>
            m.label.toLowerCase().includes(term) ||
            m.value.toLowerCase().includes(term)
        )
      );
    });

    if (sortOrder === 'oldest') {
      return [...matched].reverse();
    }
    return matched;
  }, [timeline?.events, categoryFilter, searchTerm, sortOrder]);

  const groupedByDay = useMemo(() => {
    const groups: { day: string; items: DatabaseTimelineEvent[] }[] = [];
    for (const ev of filteredEvents) {
      const day = getDayGroupLabel(ev.timestamp);
      const last = groups[groups.length - 1];
      if (last && last.day === day) {
        last.items.push(ev);
      } else {
        groups.push({ day, items: [ev] });
      }
    }
    return groups;
  }, [filteredEvents, getDayGroupLabel]);

  const counts = timeline?.counts ?? {
    all: 0,
    schema_change: 0,
    alert_trigger: 0,
    manual_inspection: 0,
  };

  return (
    <aside
      aria-label={tr(
        `Event Timeline for ${databaseName}`,
        `${databaseName} အတွက် ဖြစ်ရပ် အချိန်ဇယား`
      )}
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col overflow-hidden w-full xl:w-[368px] 2xl:w-[396px] shrink-0 xl:sticky xl:top-6"
    >
      {/* Sidebar Header */}
      <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
            {tr('Event Timeline', 'ဖြစ်ရပ် အချိန်ဇယား')}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums truncate">
            {tr(
              `${counts.all} logged event${counts.all === 1 ? '' : 's'}`,
              `မှတ်တမ်း ${counts.all} ခု`
            )}{' '}
            · {databaseName}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() =>
              setSortOrder((prev) => (prev === 'newest' ? 'oldest' : 'newest'))
            }
            title={
              sortOrder === 'newest'
                ? tr(
                    'Showing newest first (click for oldest first)',
                    'အသစ်ဆုံးမှ အဟောင်းဆုံးသို့ ပြသနေသည် (ပြောင်းရန် နှိပ်ပါ)'
                  )
                : tr(
                    'Showing oldest first (click for newest first)',
                    'အဟောင်းဆုံးမှ အသစ်ဆုံးသို့ ပြသနေသည် (ပြောင်းရန် နှိပ်ပါ)'
                  )
            }
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Clock className="w-3 h-3" />
            <span>
              {sortOrder === 'newest'
                ? tr('Newest', 'အသစ်ဆုံး')
                : tr('Oldest', 'အဟောင်းဆုံး')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => loadTimeline(true)}
            disabled={refreshing || loading}
            aria-label={tr(
              'Refresh event timeline',
              'ဖြစ်ရပ် အချိန်ဇယား ပြန်တင်ရန်'
            )}
            title={t('action.refresh')}
            className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
            />
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={tr(
                'Hide event timeline sidebar',
                'ဖြစ်ရပ် အချိန်ဇယား ပိတ်ရန်'
              )}
              title={tr('Collapse sidebar', 'ဘေးဘောင် ပိတ်ရန်')}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
            >
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Category Filter Bar + Search */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5 bg-slate-50/60 dark:bg-slate-800/50">
        <div
          role="tablist"
          aria-label={tr(
            'Filter timeline events by category',
            'အမျိုးအစားအလိုက် စစ်ထုတ်ရန်'
          )}
          className="grid grid-cols-4 gap-1 p-1 bg-slate-200/70 dark:bg-slate-700/70 rounded-lg"
        >
          {(
            [
              { id: 'all', label: tr('All', 'အားလုံး'), count: counts.all },
              {
                id: 'schema_change',
                label: tr('Schema', 'ဖွဲ့စည်းပုံ'),
                count: counts.schema_change,
              },
              {
                id: 'alert_trigger',
                label: tr('Alerts', 'သတိပေး'),
                count: counts.alert_trigger,
              },
              {
                id: 'manual_inspection',
                label: tr('Scans', 'စစ်ဆေးမှု'),
                count: counts.manual_inspection,
              },
            ] as { id: FilterCategory; label: string; count: number }[]
          ).map((tab) => {
            const active = categoryFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategoryFilter(tab.id)}
                className={`px-1.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums cursor-pointer truncate ${
                  active
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {tab.label} {tab.count}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={tr(
              'Filter by column, hash, actor, alert…',
              'ကော်လံ၊ Hash၊ ပြုလုပ်သူ၊ သတိပေးချက် ရှာရန်…'
            )}
            aria-label={tr(
              'Filter timeline events',
              'ဖြစ်ရပ်များ ရှာဖွေရန်'
            )}
            className="w-full pl-8 pr-7 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30 focus:border-blue-700 dark:focus:border-blue-500"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              aria-label={tr('Clear search', 'ရှာဖွေမှု ရှင်းလင်းရန်')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Chronological Feed */}
      <div className="flex-1 overflow-y-auto xl:max-h-[calc(100vh-15rem)]">
        {loading ? (
          <div className="p-4 space-y-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3 animate-pulse">
                <div className="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 shrink-0" />
                <div className="flex-1 space-y-2 pt-0.5">
                  <div className="h-3 w-28 bg-slate-200 dark:bg-slate-700 rounded" />
                  <div className="h-3.5 w-48 bg-slate-200 dark:bg-slate-700 rounded" />
                  <div className="h-3 w-full bg-slate-100 dark:bg-slate-800 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-6 text-center space-y-2.5">
            <p className="text-xs font-medium text-red-700 dark:text-red-400">{error}</p>
            <button
              type="button"
              onClick={() => loadTimeline(false)}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer"
            >
              {tr('Retry', 'ထပ်မံကြိုးစားရန်')}
            </button>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-7 text-center space-y-2.5">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {counts.all === 0
                ? tr(
                    'No timeline events recorded yet',
                    'ဖြစ်ရပ် မှတ်တမ်း မရှိသေးပါ'
                  )
                : tr(
                    'No matching timeline events',
                    'ကိုက်ညီသော ဖြစ်ရပ် မတွေ့ရှိပါ'
                  )}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {counts.all === 0
                ? tr(
                    'Schema baselines, drift alerts, and manual inspections for this database will appear here in chronological order.',
                    'ဤဒေတာဘေ့စ်၏ ဖွဲ့စည်းပုံ ပြောင်းလဲမှုများ၊ သတိပေးချက်များနှင့် စစ်ဆေးမှု မှတ်တမ်းများကို အချိန်အစဉ်လိုက် ဤနေရာတွင် ဖော်ပြပေးပါမည်။'
                  )
                : tr(
                    'Try switching the category filter or clearing your search query.',
                    'အမျိုးအစား စစ်ထုတ်မှု ပြောင်းကြည့်ပါ သို့မဟုတ် ရှာဖွေမှု စာသားကို ရှင်းလင်းပါ။'
                  )}
            </p>
            {counts.all === 0 && onInspectNow ? (
              <button
                type="button"
                onClick={onInspectNow}
                className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>
                  {tr('Run First Inspection', 'ပထမဆုံး စစ်ဆေးမှု စတင်ရန်')}
                </span>
              </button>
            ) : (
              (categoryFilter !== 'all' || searchTerm) && (
                <button
                  type="button"
                  onClick={() => {
                    setCategoryFilter('all');
                    setSearchTerm('');
                  }}
                  className="mt-1 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors cursor-pointer"
                >
                  {t('action.clearFilters')}
                </button>
              )
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {groupedByDay.map((group) => (
              <section key={group.day} className="px-4 py-3.5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {group.day}
                  </h3>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                    {tr(
                      `${group.items.length} event${
                        group.items.length === 1 ? '' : 's'
                      }`,
                      `ဖြစ်ရပ် ${group.items.length} ခု`
                    )}
                  </span>
                </div>

                <ol className="relative space-y-3.5">
                  <span
                    aria-hidden="true"
                    className="absolute left-[13px] top-3 bottom-3 w-px bg-slate-200 dark:bg-slate-700"
                  />

                  {group.items.map((ev) => {
                    const isExpanded = expandedId === ev.id;
                    return (
                      <li key={ev.id} className="relative pl-9">
                        <span
                          aria-hidden="true"
                          className={`absolute left-0 top-0.5 w-7 h-7 rounded-full border flex items-center justify-center ${nodeSurfaceClass(
                            ev.category,
                            ev.severity
                          )}`}
                        >
                          <CategoryIcon category={ev.category} />
                        </span>

                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedId((prev) =>
                                prev === ev.id ? null : ev.id
                              )
                            }
                            aria-expanded={isExpanded}
                            className="w-full text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700/30 rounded-md"
                          >
                            <div className="flex items-center gap-1.5 text-[11px] leading-tight flex-wrap">
                              <span
                                className={`font-semibold ${severityTextClass(
                                  ev.severity
                                )}`}
                              >
                                {categoryTextLabel(ev.category)}
                              </span>
                              {ev.statusLabel && (
                                <>
                                  <span
                                    className="text-slate-300 dark:text-slate-700"
                                    aria-hidden="true"
                                  >
                                    ·
                                  </span>
                                  <span className="font-medium text-slate-600 dark:text-slate-300">
                                    {ev.statusLabel}
                                  </span>
                                </>
                              )}
                              <span
                                className="text-slate-300 dark:text-slate-700"
                                aria-hidden="true"
                              >
                                ·
                              </span>
                              <time
                                dateTime={ev.timestamp}
                                title={new Date(ev.timestamp).toLocaleString()}
                                className="font-mono text-slate-400 dark:text-slate-500 tabular-nums"
                              >
                                {formatRelativeTime(ev.timestamp)}
                              </time>
                            </div>

                            <div className="mt-1 flex items-start justify-between gap-2">
                              <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors leading-snug">
                                {ev.title}
                              </p>
                              <span className="text-slate-400 dark:text-slate-500 group-hover:text-slate-700 dark:group-hover:text-slate-300 shrink-0 mt-0.5">
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                              </span>
                            </div>

                            <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-2">
                              {ev.summary}
                            </p>

                            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 font-mono tabular-nums truncate">
                              <span>{formatTimeOnly(ev.timestamp)}</span>
                              {ev.actor && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-sans text-slate-500 dark:text-slate-400 truncate">
                                    {ev.actor}
                                  </span>
                                </>
                              )}
                            </div>
                          </button>

                          {isExpanded && (
                            <div className="mt-2.5 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-800 space-y-2.5 text-xs">
                              {ev.meta.length > 0 && (
                                <dl className="space-y-1.5">
                                  {ev.meta.map((item) => (
                                    <div
                                      key={`${ev.id}-${item.label}`}
                                      className="flex items-baseline justify-between gap-3"
                                    >
                                      <dt className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
                                        {item.label}
                                      </dt>
                                      <dd
                                        className={`text-[11px] text-slate-800 dark:text-slate-200 text-right break-all ${
                                          item.mono
                                            ? 'font-mono tabular-nums'
                                            : ''
                                        }`}
                                      >
                                        {item.value}
                                      </dd>
                                    </div>
                                  ))}
                                </dl>
                              )}

                              {ev.remediationSql && (
                                <div className="pt-2 border-t border-slate-200/80 dark:border-slate-800 space-y-1">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                      {tr('Remediation SQL', 'ပြင်ဆင်ရေး SQL')}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleCopy(
                                          `sql-${ev.id}`,
                                          ev.remediationSql!
                                        )
                                      }
                                      className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 cursor-pointer"
                                    >
                                      {copiedId === `sql-${ev.id}` ? (
                                        <>
                                          <Check className="w-3 h-3 text-emerald-700 dark:text-emerald-400" />
                                          <span>{t('action.copied')}</span>
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-3 h-3" />
                                          <span>
                                            {tr('Copy SQL', 'SQL ကူးယူရန်')}
                                          </span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                  <pre className="p-2 bg-slate-900 dark:bg-slate-950 dark:border dark:border-slate-800 text-slate-100 rounded text-[11px] font-mono overflow-x-auto leading-relaxed">
                                    {ev.remediationSql}
                                  </pre>
                                </div>
                              )}

                              <div className="pt-2 border-t border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-2">
                                {ev.schemaHash ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleCopy(
                                        `hash-${ev.id}`,
                                        ev.schemaHash!
                                      )
                                    }
                                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
                                  >
                                    {copiedId === `hash-${ev.id}` ? (
                                      <>
                                        <Check className="w-3 h-3 text-emerald-700 dark:text-emerald-400" />
                                        <span>
                                          {tr('Hash copied', 'Hash ကူးယူပြီး')}
                                        </span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="w-3 h-3" />
                                        <span>
                                          {tr(
                                            'Copy full hash',
                                            'Hash အပြည့် ကူးယူရန်'
                                          )}
                                        </span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <span />
                                )}

                                {ev.targetTab && onJumpToTab && (
                                  <button
                                    type="button"
                                    onClick={() => onJumpToTab(ev.targetTab!)}
                                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 cursor-pointer whitespace-nowrap"
                                  >
                                    <span>
                                      {tr(
                                        `View ${tabLabel(ev.targetTab)}`,
                                        `${tabLabel(ev.targetTab)} ကြည့်ရန်`
                                      )}
                                    </span>
                                    <ArrowUpRight className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
