import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  FileCheck2,
  GitBranch,
  Globe,
  Maximize2,
  Network,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n/LocaleContext.tsx';
import { HeroCluster3D } from './HeroCluster3D.tsx';
import { TiltCard3D } from './TiltCard3D.tsx';

export type LandingPageId =
  | 'home'
  | 'platform'
  | 'demos'
  | 'gallery'
  | 'security';

export interface SharedLandingProps {
  onNavigate: (page: LandingPageId) => void;
  onSignInGoogle: () => void;
  onTryDemo: () => void;
  demoLoading: boolean;
  authError: string | null;
}

interface ScreenshotItem {
  id: string;
  src: string;
  category: 'ops' | 'telemetry' | 'diagrams' | 'governance' | 'i18n';
  titleEn: string;
  titleMy: string;
  captionEn: string;
  captionMy: string;
  tag: string;
}

const SCREENSHOTS: ScreenshotItem[] = [
  {
    id: 'blocker-tree',
    src: '/screenshots/blocker-tree-dark.png',
    category: 'ops',
    titleEn: 'Long-Running Queries & Root Blocker Tree',
    titleMy: 'ကြာရှည် Query နှင့် အရင်းခံ ပိတ်ဆို့မှု သစ်ပင်ပုံ',
    captionEn:
      'Cycle-safe hierarchical tree from pg_stat_activity and pg_blocking_pids(pid) isolating root blockers with copyable pg_cancel_backend & pg_terminate_backend SQL.',
    captionMy:
      'pg_stat_activity နှင့် pg_blocking_pids(pid) မှ အရင်းခံ ပိတ်ဆို့သူများကို အဆင့်ဆင့် သစ်ပင်ပုံဖြင့် ဖော်ပြပြီး ဘေးကင်းသော SQL အမိန့်များ ကူးယူနိုင်သည်။',
    tag: 'pg_stat_activity · Dark Mode',
  },
  {
    id: 'dark-dashboard',
    src: '/screenshots/dark-mode-dashboard.png',
    category: 'ops',
    titleEn: 'Fleet Dashboard & 24-Hour Error Heat Map (Dark)',
    titleMy: 'ဒေတာဘေ့စ် အုပ်စုနှင့် ၂၄ နာရီ အပူပြဇယား (အမှောင်မုဒ်)',
    captionEn:
      'High-contrast dark telemetry surface tracking fleet health, peak incident hours, and bulk inspection targets across Production, Staging, and Development.',
    captionMy:
      'Production၊ Staging နှင့် Development တစ်လျှောက် ၂၄ နာရီ အမှားနှုန်းနှင့် လှုပ်ရှားမှုများကို ကြည်လင်ပြတ်သားစွာ စောင့်ကြည့်နိုင်သည်။',
    tag: 'Dark Theme · 24h Heat Map',
  },
  {
    id: 'live-monitor',
    src: '/screenshots/live-db-monitor.png',
    category: 'ops',
    titleEn: 'Live PostgreSQL Operations Monitor',
    titleMy: 'တိုက်ရိုက် PostgreSQL လုပ်ငန်းလည်ပတ်မှု စောင့်ကြည့်စနစ်',
    captionEn:
      'Real-time TPS and active session stream, connection pool allocation, buffer cache hit ratio, temp spill tracking, XID wraparound safety, and pg_settings tuning.',
    captionMy:
      'တိုက်ရိုက် TPS၊ ချိတ်ဆက်မှု ခွဲဝေမှု၊ Buffer Cache၊ XID Wraparound နှင့် pg_settings ချိန်ညှိမှုများကို စက္ကန့်အလိုက် စောင့်ကြည့်နိုင်သည်။',
    tag: 'Real-Time Stream · 5s Poll',
  },
  {
    id: 'diagram-studio',
    src: '/screenshots/diagram-studio.png',
    category: 'diagrams',
    titleEn: 'Architecture & UML Diagram Studio',
    titleMy: 'စနစ် ဗိသုကာနှင့် UML ပုံကြမ်း စတူဒီယို',
    captionEn:
      '7 interactive workspace-hydrated diagrams — UML Use Case, Sequence, System Architecture, Data Flow (DFD), State Machine, Live ERD, and Replication Topology — with SVG/PNG/Mermaid export.',
    captionMy:
      'Use Case၊ Sequence၊ System Architecture၊ DFD၊ State Machine၊ Live ERD နှင့် Replication ပုံကြမ်း ၇ မျိုးကို SVG/PNG/Mermaid အဖြစ် ထုတ်ယူနိုင်သည်။',
    tag: '7 Diagram Types · SVG / PNG / Mermaid',
  },
  {
    id: 'target-detail',
    src: '/screenshots/target-detail-timeline.png',
    category: 'ops',
    titleEn: 'SHA-256 Schema Diff & Event Timeline',
    titleMy: 'SHA-256 ဖွဲ့စည်းပုံ ကွာခြားချက်နှင့် ဖြစ်စဉ်အချိန်ဇယား',
    captionEn:
      'Column-level additions, removals, and type modifications against promoted Git commit baselines alongside a chronological Event Timeline and PDF Health Report export.',
    captionMy:
      'Git မူလစံဖွဲ့စည်းပုံနှင့် ကော်လံအလိုက် ကွာခြားချက်များ၊ ဖြစ်စဉ်အချိန်ဇယားနှင့် PDF အစီရင်ခံစာ ထုတ်ယူမှု။',
    tag: 'SHA-256 Baseline · PDF Report',
  },
  {
    id: 'sql-trends',
    src: '/screenshots/sql-telemetry-suite.png',
    category: 'telemetry',
    titleEn: 'SQL Telemetry Suite — 30-Day Performance Trends',
    titleMy: 'SQL စွမ်းဆောင်ရည် — ရက် ၃၀ ကြာချိန် လမ်းကြောင်း',
    captionEn:
      'Compare pg_stat_statements latency over 7, 14, or 30 days against historical baselines to catch query regressions before p99 spikes hit production.',
    captionMy:
      'pg_stat_statements ကြာချိန်များကို ရက် ၃၀ အတွင်း မူလစံနှုန်းနှင့် နှိုင်းယှဉ်ပြီး နှေးကွေးလာသော Query များကို ကြိုတင်ဖော်ထုတ်ပေးသည်။',
    tag: 'pg_stat_statements · Regression Alerts',
  },
  {
    id: 'index-advisor',
    src: '/screenshots/index-advisor.png',
    category: 'telemetry',
    titleEn: 'EXPLAIN Index Advisor & Seq-Scan Hotspots',
    titleMy: 'EXPLAIN Index အကြံပေးစနစ်နှင့် Seq-Scan စစ်ဆေးမှု',
    captionEn:
      'Analyzes sequential scan hotspots and EXPLAIN plans to output copy-ready CREATE INDEX CONCURRENTLY single-column and ESR composite B-Tree index DDL.',
    captionMy:
      'Sequential Scan များပြားသော ဇယားများအတွက် ဘေးကင်းသော CREATE INDEX CONCURRENTLY SQL များကို အလိုအလျောက် အကြံပြုပေးသည်။',
    tag: 'EXPLAIN Plan · ESR Composite Index',
  },
  {
    id: 'governance',
    src: '/screenshots/governance-reports.png',
    category: 'governance',
    titleEn: 'Governance, RBAC & Executive Health Digest',
    titleMy: 'စီမံခန့်ခွဲမှု၊ RBAC နှင့် အမှုဆောင် ကျန်းမာရေး အစီရင်ခံစာ',
    captionEn:
      'Fleet SLA availability, MTTR tracking, 30-day storage forecasts, Production baseline promotion approvals, and Admin/DBA/Viewer role access.',
    captionMy:
      'SLA ရရှိနိုင်မှု၊ MTTR၊ သိုလှောင်မှု ခန့်မှန်းချက်၊ Baseline အတည်ပြုချက်များနှင့် အဖွဲ့ဝင် RBAC စီမံခန့်ခွဲမှု။',
    tag: 'SLA Scorecard · Approvals · PDF/CSV',
  },
  {
    id: 'auto-inspect',
    src: '/screenshots/health-score-auto-inspect.png',
    category: 'governance',
    titleEn: 'Per-Target Health Score Auto-Inspection',
    titleMy: 'ဒေတာဘေ့စ်အလိုက် ကျန်းမာရေး ရမှတ် အလိုအလျောက် စစ်ဆေးမှု',
    captionEn:
      'Configure 0–100 minimum health score rules and anti-loop cooldown windows per database to trigger automatic verification scans on threshold breach.',
    captionMy:
      'ဒေတာဘေ့စ်တစ်ခုချင်းစီအတွက် ကျန်းမာရေး ရမှတ် ကန့်သတ်ချက်နှင့် Cooldown စည်းမျဉ်းများ သတ်မှတ်ပြီး အလိုအလျောက် ပြန်လည်စစ်ဆေးနိုင်သည်။',
    tag: 'Auto Re-Inspect · CI/CD Gates',
  },
  {
    id: 'light-dashboard',
    src: '/screenshots/dashboard-overview.png',
    category: 'ops',
    titleEn: 'Monitored Targets Dashboard (Light Mode)',
    titleMy: 'စောင့်ကြည့်နေသော ဒေတာဘေ့စ်များ (အလင်းမုဒ်)',
    captionEn:
      'Clean daylight engineering surface with instant Light/Dark switching, 7-day health sparklines, and multi-select bulk inspection controls.',
    captionMy:
      'အလင်း/အမှောင် မုဒ်ချက်ချင်းပြောင်းလဲနိုင်မှု၊ ၇ ရက် ကျန်းမာရေး ဂရပ်များနှင့် အများအပြား ရွေးချယ်စစ်ဆေးနိုင်မှု။',
    tag: 'Light Theme · Bulk Operations',
  },
  {
    id: 'burmese-i18n',
    src: '/screenshots/burmese-localization.png',
    category: 'i18n',
    titleEn: 'Full English & Burmese (မြန်မာ) Localization',
    titleMy: 'အင်္ဂလိပ်နှင့် မြန်မာဘာသာစကား အပြည့်အစုံ',
    captionEn:
      'Runtime switching between English and natural Burmese across every navigation item, chart tooltip, blocker tree, migration warning, and timestamp.',
    captionMy:
      'မီနူးများ၊ ဂရပ်များ၊ ပိတ်ဆို့မှု သစ်ပင်ပုံနှင့် သတိပေးချက်အားလုံးကို အင်္ဂလိပ်နှင့် မြန်မာဘာသာ ချက်ချင်းပြောင်းလဲ အသုံးပြုနိုင်သည်။',
    tag: 'i18n · EN / မြန်မာ',
  },
];

interface DemoVideoSpec {
  id: string;
  src: string;
  poster: string;
  duration: string;
  titleEn: string;
  titleMy: string;
  summaryEn: string;
  summaryMy: string;
  highlightsEn: string[];
  highlightsMy: string[];
}

const DEMO_VIDEOS: DemoVideoSpec[] = [
  {
    id: 'blocker-tree-walkthrough',
    src: '/videos/demo-blocker-tree.webm',
    poster: '/screenshots/blocker-tree-dark.png',
    duration: '0:12',
    titleEn: 'Live Blocker Tree Triage in Dark Mode',
    titleMy: 'အမှောင်မုဒ်တွင် အရင်းခံ ပိတ်ဆို့မှု သစ်ပင် စစ်ဆေးခြင်း',
    summaryEn:
      'Watch DriftGuard open Live DB Monitor, switch into the pg_stat_activity Blocker Tree, trace a multi-level lock chain from leaf waiters back to idle-in-transaction Root Blocker PID 28109, and copy pg_terminate_backend(28109).',
    summaryMy:
      'Live DB Monitor မှတစ်ဆင့် pg_stat_activity ပိတ်ဆို့မှု သစ်ပင်ပုံကို ဖွင့်ပြီး အဆင့်ဆင့် ပိတ်ဆို့မှုများမှ အရင်းခံ PID 28109 ကို ရှာဖွေကာ SQL ကူးယူပုံကို ကြည့်ရှုပါ။',
    highlightsEn: [
      'Live pg_blocking_pids(pid) parent-child hierarchy',
      '1-click jump from blocked leaf PID 28540 to Root PID 28109',
      'Copy-ready pg_cancel_backend & pg_terminate_backend commands',
    ],
    highlightsMy: [
      'pg_blocking_pids(pid) မှ အဆင့်ဆင့် ပိတ်ဆို့မှု သစ်ပင်ပုံ',
      'ပိတ်ဆို့ခံ PID မှ အရင်းခံ PID 28109 သို့ တစ်ချက်နှိပ် ခုန်ကူးနိုင်မှု',
      'ဘေးကင်းသော Cancel နှင့် Terminate SQL ကူးယူနိုင်မှု',
    ],
  },
  {
    id: 'dashboard-heatmap-walkthrough',
    src: '/videos/demo-dashboard-heatmap.webm',
    poster: '/screenshots/dark-mode-dashboard.png',
    duration: '0:10',
    titleEn: '24h Heat Map, Instant Dark Mode & Schema Drift Drilldown',
    titleMy: '၂၄ နာရီ အပူပြဇယား၊ အမှောင်မုဒ်နှင့် Schema Drift စစ်ဆေးမှု',
    summaryEn:
      'See the fleet dashboard switch between Error Rate and Combined heat map modes, flip seamlessly from Light to Dark theme in real time, and drill straight into prod-billing-pg to inspect column-level SHA-256 drift.',
    summaryMy:
      '၂၄ နာရီ အပူပြဇယား မုဒ်များ ပြောင်းလဲခြင်း၊ အလင်းမှ အမှောင်မုဒ်သို့ ချက်ချင်းပြောင်းခြင်းနှင့် prod-billing-pg ၏ SHA-256 ကွာခြားချက် စစ်ဆေးပုံ။',
    highlightsEn: [
      'Rolling 24-hour fleet activity & incident error heat map',
      'Zero-flicker Light ↔ Dark theme toggle across all charts',
      'Instant drilldown into column diffs and chronological timeline',
    ],
    highlightsMy: [
      '၂၄ နာရီ ဒေတာဘေ့စ် လှုပ်ရှားမှုနှင့် အမှားနှုန်း အပူပြဇယား',
      'အလင်း ↔ အမှောင် မုဒ် ချက်ချင်းပြောင်းလဲနိုင်မှု',
      'ကော်လံ ကွာခြားချက်နှင့် ဖြစ်စဉ်အချိန်ဇယား တိုက်ရိုက်ကြည့်ရှုနိုင်မှု',
    ],
  },
  {
    id: 'diagram-studio-walkthrough',
    src: '/videos/demo-diagram-studio.webm',
    poster: '/screenshots/diagram-studio.png',
    duration: '0:09',
    titleEn: 'Architecture & UML Diagram Studio Walkthrough',
    titleMy: 'စနစ် ဗိသုကာနှင့် UML ပုံကြမ်း စတူဒီယို လက်တွေ့ပြသမှု',
    summaryEn:
      'Explore live workspace-hydrated engineering diagrams in seconds — switching smoothly across UML Use Case, Sequence Diagram, System Architecture, Live ERD & Data Model, and Replication HA Topology.',
    summaryMy:
      'UML Use Case၊ Sequence၊ System Architecture၊ Live ERD နှင့် Replication ပုံကြမ်းများကို တစ်ချက်နှိပ် ပြောင်းလဲကြည့်ရှုပုံ။',
    highlightsEn: [
      '7 interactive diagram views hydrated from live workspace metadata',
      'Pan, zoom, and click any node to inspect technical specifications',
      '1-click export to SVG, PNG, Mermaid.js, and PlantUML',
    ],
    highlightsMy: [
      'လုပ်ငန်းခွင် ဒေတာဖြင့် တိုက်ရိုက်ဖန်တီးထားသော ပုံကြမ်း ၇ မျိုး',
      'ချဲ့/ချုံ့ခြင်းနှင့် Node တစ်ခုချင်း အသေးစိတ် စစ်ဆေးနိုင်မှု',
      'SVG၊ PNG၊ Mermaid.js နှင့် PlantUML ထုတ်ယူနိုင်မှု',
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* 1. HOME / OVERVIEW PAGE                                                    */
/* -------------------------------------------------------------------------- */
export function OverviewPage({
  onNavigate,
  onSignInGoogle,
  onTryDemo,
  demoLoading,
  authError,
}: SharedLandingProps) {
  const { tr } = useI18n();
  const [featuredShotIdx, setFeaturedShotIdx] = useState(0);
  const featuredShots = SCREENSHOTS.slice(0, 6);
  const activeShot = featuredShots[featuredShotIdx];

  return (
    <div className="space-y-20 pb-20">
      {/* HERO SECTION: Kinetic Copy + Live Interactive Three.js 3D Cluster */}
      <section className="relative overflow-hidden border-b border-slate-200 dark:border-slate-800/90">
        <div className="max-w-7xl mx-auto px-6 pt-10 pb-14 lg:pt-14 lg:pb-20 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-8 items-center">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-6 space-y-6"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono font-medium text-blue-700 dark:text-blue-400">
              <span>
                {tr(
                  'READ-ONLY POSTGRESQL OBSERVABILITY',
                  'ဘေးကင်းသော READ-ONLY POSTGRESQL စောင့်ကြည့်ရေး'
                )}
              </span>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span className="text-slate-600 dark:text-slate-400">
                PG 13–17+
              </span>
            </div>

            <h1 className="font-display text-[clamp(2.25rem,4.1vw,3.65rem)] font-bold tracking-tight text-slate-900 dark:text-slate-50 leading-[1.08] max-w-xl">
              {tr(
                'Catch schema drift, root blockers, and risky deploys in real time.',
                'ဒေတာဘေ့စ် ဖွဲ့စည်းပုံ ပြောင်းလဲမှု၊ ပိတ်ဆို့မှုနှင့် Deploy အန္တရာယ်များကို အချိန်နှင့်တစ်ပြေးညီ တားဆီးပါ။'
              )}
            </h1>

            <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
              {tr(
                'DriftGuard inspects PostgreSQL clusters in strict read-only mode—never touching customer rows. Fingerprint schemas with SHA-256 baselines, trace pg_stat_activity blocker trees, lint locking DDL before deploy, and export live architecture diagrams.',
                'DriftGuard သည် PostgreSQL များကို Read-Only စနစ်ဖြင့်သာ စောင့်ကြည့်ပြီး သုံးစွဲသူဒေတာများကို မထိပါးပါ။ SHA-256 ဖွဲ့စည်းပုံ စစ်ဆေးခြင်း၊ pg_stat_activity ပိတ်ဆို့မှု သစ်ပင်ပုံ ရှာဖွေခြင်းနှင့် UML ပုံကြမ်းများ ထုတ်ယူနိုင်ပါသည်။'
              )}
            </p>

            <div className="pt-1 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onSignInGoogle}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-2"
              >
                <span>
                  {tr('Continue with Google', 'Google ဖြင့် ဝင်ရောက်ရန်')}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                type="button"
                disabled={demoLoading}
                onClick={onTryDemo}
                className="px-4 py-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 inline-flex items-center gap-2"
              >
                <Play className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
                <span>
                  {demoLoading
                    ? tr('Launching Demo…', 'စမ်းသပ်ခန်း ဖွင့်နေသည်…')
                    : tr('Try Live Demo Workspace', 'တိုက်ရိုက် စမ်းသပ်ခန်း ဖွင့်ရန်')}
                </span>
              </button>
            </div>

            {authError && (
              <div
                role="alert"
                className="p-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-300 max-w-lg"
              >
                {authError}
              </div>
            )}

            {/* Concrete Quantified Proof Strip (tabular-nums) */}
            <div className="pt-4 grid grid-cols-3 gap-4 border-t border-slate-200 dark:border-slate-800 max-w-lg">
              <div>
                <p className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-100">
                  &lt; 4s
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {tr('Read-only scan cap', 'Read-only စစ်ဆေးချိန်')}
                </p>
              </div>
              <div>
                <p className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-100">
                  7 UML
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {tr('Live diagram exports', 'တိုက်ရိုက် ပုံကြမ်းများ')}
                </p>
              </div>
              <div>
                <p className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-100">
                  AES-256
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {tr('GCM credential vault', 'GCM လုံခြုံရေး သိမ်းဆည်းမှု')}
                </p>
              </div>
            </div>
          </motion.div>

          {/* RIGHT STAGE: Interactive Three.js 3D PostgreSQL Cluster */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-6"
          >
            <HeroCluster3D initialPreset="overview" />
          </motion.div>
        </div>
      </section>

      {/* SECTION 2: LIVE DEMO VIDEO REEL (Real Recorded Walkthroughs) */}
      <section className="max-w-7xl mx-auto px-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-xs font-mono font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
              {tr('01. Live Product Walkthroughs', '၀၁. လက်တွေ့ အသုံးပြုပုံ ဗီဒီယိုများ')}
            </p>
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {tr(
                'Watch the real workspace running live.',
                'တကယ့် လုပ်ငန်းခွင် အလုပ်လုပ်ပုံကို ဗီဒီယိုဖြင့် ကြည့်ရှုပါ။'
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('demos')}
            className="text-sm font-semibold text-blue-700 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>
              {tr('Open Full Video Theater (3 Clips)', 'ဗီဒီယို ပြခန်းအပြည့် ဖွင့်ရန် (၃ ခု)')}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Primary Auto-Playing Hero Video Card */}
          <div className="lg:col-span-7">
            <TiltCard3D
              maxTiltDeg={4}
              className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden h-full flex flex-col"
            >
              <div className="relative aspect-video bg-slate-950 overflow-hidden">
                <video
                  src={DEMO_VIDEOS[0].src}
                  poster={DEMO_VIDEOS[0].poster}
                  autoPlay
                  muted
                  loop
                  playsInline
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-3 left-3 px-2.5 py-1 rounded-md bg-slate-950/90 border border-slate-700 text-[11px] font-mono text-slate-100">
                  LIVE CAPTURE · {DEMO_VIDEOS[0].duration}
                </div>
              </div>
              <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                    {tr(DEMO_VIDEOS[0].titleEn, DEMO_VIDEOS[0].titleMy)}
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {tr(DEMO_VIDEOS[0].summaryEn, DEMO_VIDEOS[0].summaryMy)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('demos')}
                  className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {tr('Watch with Controls', 'အပြည့်ကြည့်ရန်')}
                </button>
              </div>
            </TiltCard3D>
          </div>

          {/* Two Stacked Auto-Playing Secondary Video Clips */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            {DEMO_VIDEOS.slice(1).map((clip) => (
              <TiltCard3D
                key={clip.id}
                maxTiltDeg={5}
                onClick={() => onNavigate('demos')}
                className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden cursor-pointer flex-1 flex flex-col"
              >
                <div className="relative aspect-[16/8.2] bg-slate-950 overflow-hidden">
                  <video
                    src={clip.src}
                    poster={clip.poster}
                    autoPlay
                    muted
                    loop
                    playsInline
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-slate-950/90 border border-slate-700 text-[11px] font-mono text-slate-200">
                    {clip.duration}
                  </div>
                </div>
                <div className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                      {tr(clip.titleEn, clip.titleMy)}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {tr(clip.highlightsEn[0], clip.highlightsMy[0])}
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
                </div>
              </TiltCard3D>
            ))}
          </div>
        </div>
      </section>

      {/* SECTION 3: INTERACTIVE 3D UI SCREENSHOT SHOWCASE */}
      <section className="max-w-7xl mx-auto px-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-xs font-mono font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
              {tr('02. Real Interface Preview', '၀၂. လက်တွေ့ မျက်နှာပြင် နမူနာများ')}
            </p>
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {tr(
                'Every PostgreSQL view, engineered for fast triage.',
                'PostgreSQL စောင့်ကြည့်ရေး မျက်နှာပြင်တိုင်းကို မြန်ဆန်စွာ စစ်ဆေးနိုင်ရန် ဖန်တီးထားသည်။'
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('gallery')}
            className="text-sm font-semibold text-blue-700 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>
              {tr('Explore All 11 UI Screenshots', 'မျက်နှာပြင်ပုံ ၁၁ ပုံလုံး ကြည့်ရန်')}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        {/* Interactive Feature Tab Selector */}
        <div className="flex flex-wrap items-center gap-1.5 p-1.5 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-fit max-w-full">
          {featuredShots.map((shot, idx) => (
            <button
              key={shot.id}
              type="button"
              onClick={() => setFeaturedShotIdx(idx)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                featuredShotIdx === idx
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {tr(shot.titleEn, shot.titleMy)}
            </button>
          ))}
        </div>

        {/* 3D Tilting Interactive Screenshot Frame */}
        <TiltCard3D
          maxTiltDeg={3.5}
          className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
        >
          <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                driftguard.app / {activeShot.tag}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() =>
                  setFeaturedShotIdx(
                    (i) => (i - 1 + featuredShots.length) % featuredShots.length
                  )
                }
                aria-label="Previous screenshot"
                className="p-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setFeaturedShotIdx((i) => (i + 1) % featuredShots.length)
                }
                aria-label="Next screenshot"
                className="p-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={activeShot.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="bg-slate-950"
            >
              <img
                src={activeShot.src}
                alt={activeShot.titleEn}
                className="w-full max-h-[560px] object-cover object-top"
              />
            </motion.div>
          </AnimatePresence>

          <div className="px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 border-t border-slate-200 dark:border-slate-800">
            <div className="space-y-0.5">
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {tr(activeShot.titleEn, activeShot.titleMy)}
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 max-w-3xl">
                {tr(activeShot.captionEn, activeShot.captionMy)}
              </p>
            </div>
            <button
              type="button"
              onClick={onTryDemo}
              disabled={demoLoading}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              {tr('Open Live in Demo', 'စမ်းသပ်ခန်းတွင် ဖွင့်ကြည့်ရန်')}
            </button>
          </div>
        </TiltCard3D>
      </section>

      {/* SECTION 4: ASYMMETRIC CAPABILITY BENTO */}
      <section className="max-w-7xl mx-auto px-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-xs font-mono font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
              {tr('03. Built for DBA & SRE Teams', '၀၃. DBA နှင့် SRE အဖွဲ့များအတွက်')}
            </p>
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {tr(
                'One control plane from pre-flight DDL to live lock trees.',
                'Deploy မတိုင်မီ DDL စစ်ဆေးမှုမှ တိုက်ရိုက် Lock သစ်ပင်ပုံအထိ တစ်နေရာတည်းတွင်။'
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('platform')}
            className="text-sm font-semibold text-blue-700 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>{tr('Inspect Full Platform', 'စနစ်အပြည့်အစုံ ကြည့်ရန်')}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Wide Feature Card (col-span-2) */}
          <TiltCard3D
            maxTiltDeg={4}
            onClick={() => onNavigate('platform')}
            className="md:col-span-2 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 cursor-pointer flex flex-col justify-between gap-6"
          >
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-mono text-red-700 dark:text-red-400 font-semibold">
                <Activity className="w-4 h-4" />
                <span>pg_stat_activity · pg_blocking_pids(pid)</span>
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                {tr(
                  'Live DB Monitor & Cycle-Safe Root Blocker Trees',
                  'တိုက်ရိုက် ဒေတာဘေ့စ် စောင့်ကြည့်ရေးနှင့် အရင်းခံ ပိတ်ဆို့မှု သစ်ပင်ပုံ'
                )}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
                {tr(
                  'Stop hunting through flat session tables during an outage. DriftGuard maps blocking chains from leaf waiters directly up to the idle-in-transaction or DDL root blocker, tracks XID wraparound age, and hands you exact cancel/terminate SQL.',
                  'ပြဿနာဖြစ်ချိန်တွင် ဇယားရှည်ကြီးထဲ ရှာဖွေနေစရာမလိုပါ။ ပိတ်ဆို့ခံ Query များမှ အရင်းခံ ပိတ်ဆို့သူအထိ သစ်ပင်ပုံဖြင့် ချက်ချင်းပြသပေးသည်။'
                )}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-slate-200 dark:border-slate-800 text-xs font-mono tabular-nums">
              <div>
                <p className="text-slate-500 dark:text-slate-400">Polling</p>
                <p className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  5s / 15s / 30s
                </p>
              </div>
              <div>
                <p className="text-slate-500 dark:text-slate-400">Coverage</p>
                <p className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  Sessions · I/O · XID
                </p>
              </div>
              <div>
                <p className="text-slate-500 dark:text-slate-400">Safety</p>
                <p className="font-semibold text-emerald-700 dark:text-emerald-400 mt-0.5">
                  100% Read-Only
                </p>
              </div>
            </div>
          </TiltCard3D>

          {/* Compact Card 2 */}
          <TiltCard3D
            maxTiltDeg={5}
            onClick={() => onNavigate('platform')}
            className="p-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 cursor-pointer flex flex-col justify-between gap-4"
          >
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-mono text-blue-700 dark:text-blue-400 font-semibold">
                <Network className="w-4 h-4" />
                <span>SVG · PNG · Mermaid · PlantUML</span>
              </div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                {tr(
                  '7 Live Architecture & UML Diagrams',
                  'တိုက်ရိုက် ဗိသုကာနှင့် UML ပုံကြမ်း ၇ မျိုး'
                )}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {tr(
                  'Auto-hydrated Use Case, Sequence, System Architecture, DFD, State Machine, ERD, and HA Replication topology diagrams ready for design reviews.',
                  'Use Case၊ Sequence၊ System Architecture၊ DFD၊ State Machine၊ Live ERD နှင့် Replication ပုံကြမ်းများကို အသင့်ထုတ်ယူနိုင်သည်။'
                )}
              </p>
            </div>
            <span className="text-xs font-semibold text-blue-700 dark:text-blue-400 inline-flex items-center gap-1">
              <span>{tr('View Studio', 'စတူဒီယို ကြည့်ရန်')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </span>
          </TiltCard3D>

          {/* Compact Card 3 */}
          <TiltCard3D
            maxTiltDeg={5}
            onClick={() => onNavigate('security')}
            className="p-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 cursor-pointer flex flex-col justify-between gap-4"
          >
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-mono text-emerald-700 dark:text-emerald-400 font-semibold">
                <FileCheck2 className="w-4 h-4" />
                <span>CI/CD Gate · HTTP 409</span>
              </div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                {tr(
                  'Pre-Flight Migration Linter & Drift Gate',
                  'Migration စစ်ဆေးစက်နှင့် Drift Gate'
                )}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {tr(
                  'Catch AccessExclusiveLock rewrites and missing CONCURRENTLY indexes before deploy, and block drifted pull requests directly from GitHub Actions.',
                  'ဇယားပိတ်ဆို့စေသော DDL များကို Deploy မတိုင်မီ ဖမ်းယူပြီး GitHub Actions မှတစ်ဆင့် အလိုအလျောက် တားဆီးပေးသည်။'
                )}
              </p>
            </div>
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
              <span>{tr('See CI/CD Setup', 'CI/CD ချိတ်ဆက်ပုံ')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </span>
          </TiltCard3D>

          {/* Wide Feature Card 4 (col-span-2) */}
          <TiltCard3D
            maxTiltDeg={4}
            onClick={() => onNavigate('gallery')}
            className="md:col-span-2 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 cursor-pointer flex flex-col justify-between gap-4"
          >
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-mono text-amber-700 dark:text-amber-400 font-semibold">
                <ShieldCheck className="w-4 h-4" />
                <span>RBAC · Auto-Inspect · Executive Digest</span>
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                {tr(
                  'Per-Target Health Score Auto-Inspection & Governance Suite',
                  'ကျန်းမာရေး ရမှတ် အလိုအလျောက် စစ်ဆေးမှုနှင့် စီမံခန့်ခွဲမှု စနစ်'
                )}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
                {tr(
                  'Set 0–100 minimum health score rules with anti-loop cooldown windows per database, schedule maintenance windows to silence deploy noise, enforce Production baseline approval gates, and export weekly Executive SLA PDFs.',
                  'ဒေတာဘေ့စ်အလိုက် ကျန်းမာရေး ရမှတ် ကန့်သတ်ချက်များ၊ ပြုပြင်ထိန်းသိမ်းချိန် စည်းမျဉ်းများနှင့် Executive SLA PDF အစီရင်ခံစာများ ထုတ်ယူနိုင်သည်။'
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-slate-400 font-mono">
              <span>PDF / CSV / JSON Exports</span>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span>Light &amp; Dark Theme</span>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span>English &amp; Burmese (မြန်မာ)</span>
            </div>
          </TiltCard3D>
        </div>
      </section>

      {/* SECTION 5: BOTTOM CONVERSION STRIP */}
      <section className="max-w-7xl mx-auto px-6">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 sm:p-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {tr(
                'Launch the pre-seeded 4-cluster demo workspace in one click.',
                'ဒေတာဘေ့စ် ၄ ခု အသင့်ထည့်သွင်းထားသော စမ်းသပ်ခန်းကို တစ်ချက်နှိပ် ဖွင့်ကြည့်ပါ။'
              )}
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {tr(
                'No PostgreSQL credentials required to explore live blocker trees, 24-hour heat maps, 30-day SQL regressions, and UML diagrams.',
                'PostgreSQL စကားဝှက် မလိုဘဲ ပိတ်ဆို့မှု သစ်ပင်ပုံ၊ အပူပြဇယား၊ SQL စွမ်းဆောင်ရည်နှင့် UML ပုံကြမ်းအားလုံးကို ချက်ချင်း စမ်းသပ်နိုင်သည်။'
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              disabled={demoLoading}
              onClick={onTryDemo}
              className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {demoLoading
                ? tr('Launching Demo…', 'ဖွင့်နေသည်…')
                : tr('Launch Live Demo Workspace', 'တိုက်ရိုက် စမ်းသပ်ခန်း ဖွင့်ရန်')}
            </button>
            <button
              type="button"
              onClick={onSignInGoogle}
              className="px-4 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {tr('Sign in with Google', 'Google ဖြင့် ဝင်ရောက်ရန်')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. PLATFORM ARCHITECTURE PAGE (With 3D Exploded Engine + Module Explorer)  */
/* -------------------------------------------------------------------------- */
export function PlatformPage({
  onTryDemo,
  demoLoading,
  onNavigate,
}: SharedLandingProps) {
  const { tr } = useI18n();
  const [selectedMod, setSelectedMod] = useState(0);

  const modules = [
    {
      icon: Activity,
      nameEn: 'Live DB Monitor & Blocker Tree',
      nameMy: 'တိုက်ရိုက် စောင့်ကြည့်ရေးနှင့် ပိတ်ဆို့ သစ်ပင်',
      views: 'pg_stat_activity · pg_blocking_pids · pg_stat_bgwriter · pg_settings',
      descEn:
        'Streams live TPS, connection pool saturation, active sessions, and a cycle-safe hierarchical blocker tree that exposes root blockers and generates copy-ready cancel/terminate commands.',
      descMy:
        'တိုက်ရိုက် TPS၊ ချိတ်ဆက်မှု ခွဲဝေမှုနှင့် pg_stat_activity ပိတ်ဆို့မှု သစ်ပင်ပုံကို ပြသပြီး အရင်းခံ ပိတ်ဆို့သူကို ချက်ချင်း ဖော်ထုတ်ပေးသည်။',
      screenshot: '/screenshots/blocker-tree-dark.png',
    },
    {
      icon: Database,
      nameEn: 'Canonical SHA-256 Drift & Time Machine',
      nameMy: 'SHA-256 ဖွဲ့စည်းပုံ စစ်ဆေးမှုနှင့် Time Machine',
      views: 'information_schema.columns · pg_constraint · historical baselines',
      descEn:
        'Computes deterministic SHA-256 fingerprints for every table and column, diffs live clusters against promoted Git commits, and generates forward Up-Migration and Down-Rollback SQL.',
      descMy:
        'ဇယားနှင့် ကော်လံတိုင်းကို SHA-256 ဖြင့် မှတ်တမ်းတင်ပြီး Git baseline နှင့် နှိုင်းယှဉ်ကာ Sync SQL နှင့် Rollback SQL များ ထုတ်ပေးသည်။',
      screenshot: '/screenshots/target-detail-timeline.png',
    },
    {
      icon: Network,
      nameEn: 'Architecture & UML Diagram Studio',
      nameMy: 'ဗိသုကာနှင့် UML ပုံကြမ်း စတူဒီယို',
      views: 'Live ERD · Use Case · Sequence · Architecture · DFD · State · Replication',
      descEn:
        'Generates 7 interactive workspace-hydrated diagrams with drag-pan, zoom, element specification inspection, and one-click SVG, PNG, Mermaid.js, and PlantUML export.',
      descMy:
        'အလုပ်လုပ်နေသော ဒေတာဘေ့စ်များမှ UML နှင့် ဗိသုကာ ပုံကြမ်း ၇ မျိုးကို SVG/PNG/Mermaid အဖြစ် တိုက်ရိုက် ထုတ်ယူနိုင်သည်။',
      screenshot: '/screenshots/diagram-studio.png',
    },
    {
      icon: Code2,
      nameEn: 'SQL Telemetry Suite & Index Advisor',
      nameMy: 'SQL စွမ်းဆောင်ရည်နှင့် Index အကြံပေးစနစ်',
      views: 'pg_stat_statements · EXPLAIN (FORMAT JSON) · pg_stat_user_tables',
      descEn:
        'Tracks 30-day query latency regressions against rolling baselines, detects sequential scan hotspots, and synthesizes safe CREATE INDEX CONCURRENTLY composite recommendations.',
      descMy:
        'ရက် ၃၀ အတွင်း Query ကြာချိန် ပြောင်းလဲမှုများကို စောင့်ကြည့်ပြီး CREATE INDEX CONCURRENTLY SQL များ အကြံပြုပေးသည်။',
      screenshot: '/screenshots/index-advisor.png',
    },
    {
      icon: SlidersHorizontal,
      nameEn: 'Governance, RBAC & Health Auto-Inspect',
      nameMy: 'စီမံခန့်ခွဲမှု၊ RBAC နှင့် အလိုအလျောက် စစ်ဆေးမှု',
      views: 'Executive PDF Digest · Approvals · Maintenance Windows · 0-100 Rules',
      descEn:
        'Enforces Admin/DBA/Viewer roles, Production baseline approval workflows, maintenance silence windows, and automatic re-inspection whenever a target breaches its custom health score.',
      descMy:
        'Admin/DBA/Viewer အခန်းကဏ္ဍများ၊ Baseline အတည်ပြုချက်များနှင့် ကျန်းမာရေး ရမှတ် ကန့်သတ်ချက် ကျော်လွန်ပါက အလိုအလျောက် စစ်ဆေးပေးသည်။',
      screenshot: '/screenshots/governance-reports.png',
    },
  ];

  const active = modules[selectedMod];

  return (
    <div className="max-w-7xl mx-auto px-6 py-12 space-y-14">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
        <div className="lg:col-span-5 space-y-5">
          <p className="text-xs font-mono font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
            {tr('3D Telemetry Architecture', '3D စောင့်ကြည့်ရေး ဗိသုကာ')}
          </p>
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50 leading-tight">
            {tr(
              'Explore the layered PostgreSQL inspection core in 3D.',
              'PostgreSQL စောင့်ကြည့်ရေး အလွှာများကို 3D ဖြင့် လေ့လာပါ။'
            )}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {tr(
              'Rotate, zoom, or click any orbiting cluster pod. The exploded core separates the three strictly read-only telemetry strata: Catalog Schema Hashing, Live Session & Lock Contention, and WAL / Replication Health.',
              '3D မော်ဒယ်ကို လှည့်ပတ်ကြည့်ရှုပြီး အလွှာခွဲထားသော Read-Only စောင့်ကြည့်ရေး အဆင့် ၃ ဆင့်ကို စစ်ဆေးနိုင်ပါသည်။'
            )}
          </p>

          <div className="space-y-2.5 pt-2 text-xs">
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-2">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                Layer 01 · Catalog Stratum
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400">
                information_schema · SHA-256
              </span>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-2">
              <span className="font-semibold text-blue-700 dark:text-blue-400">
                Layer 02 · Live Session &amp; Lock Stratum
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400">
                pg_stat_activity · pg_blocking_pids
              </span>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-2">
              <span className="font-semibold text-amber-700 dark:text-amber-400">
                Layer 03 · Storage, XID &amp; WAL Stratum
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400">
                pg_stat_bgwriter · pg_replication
              </span>
            </div>
          </div>
        </div>

        <div className="lg:col-span-7">
          <HeroCluster3D
            initialPreset="exploded"
            heightClassName="h-[420px] sm:h-[470px]"
          />
        </div>
      </div>

      {/* Interactive Subsystem Explorer */}
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            {tr('Interactive Platform Modules', 'စနစ်အစိတ်အပိုင်းများ အသေးစိတ်')}
          </h2>
          <button
            type="button"
            onClick={() => onNavigate('demos')}
            className="text-xs font-semibold text-blue-700 dark:text-blue-400 inline-flex items-center gap-1 cursor-pointer"
          >
            <span>{tr('Watch Live Videos', 'ဗီဒီယိုများ ကြည့်ရန်')}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-4 space-y-2">
            {modules.map((mod, idx) => {
              const Icon = mod.icon;
              const isSelected = idx === selectedMod;
              return (
                <button
                  key={mod.nameEn}
                  type="button"
                  onClick={() => setSelectedMod(idx)}
                  className={`w-full text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-blue-50/70 dark:bg-blue-950/35 border-blue-300 dark:border-blue-800'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isSelected
                          ? 'text-blue-700 dark:text-blue-400'
                          : 'text-slate-400 dark:text-slate-500'
                      }`}
                    />
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr(mod.nameEn, mod.nameMy)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    {mod.views}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="lg:col-span-8">
            <TiltCard3D
              maxTiltDeg={3}
              className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
            >
              <AnimatePresence mode="wait">
                <motion.div
                  key={active.nameEn}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                >
                  <div className="bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                    <img
                      src={active.screenshot}
                      alt={active.nameEn}
                      className="w-full max-h-[440px] object-cover object-top"
                    />
                  </div>
                  <div className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1.5">
                      <p className="text-xs font-mono text-blue-700 dark:text-blue-400">
                        {active.views}
                      </p>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                        {tr(active.nameEn, active.nameMy)}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
                        {tr(active.descEn, active.descMy)}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={demoLoading}
                      onClick={onTryDemo}
                      className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {tr('Try Live Now', 'တိုက်ရိုက် စမ်းသပ်ရန်')}
                    </button>
                  </div>
                </motion.div>
              </AnimatePresence>
            </TiltCard3D>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. LIVE DEMO VIDEO THEATER PAGE                                            */
/* -------------------------------------------------------------------------- */
export function LiveDemosPage({ onTryDemo, demoLoading }: SharedLandingProps) {
  const { tr } = useI18n();
  const [activeClipIdx, setActiveClipIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const activeClip = DEMO_VIDEOS[activeClipIdx];

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => undefined);
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const restartClip = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => undefined);
    setPlaying(true);
  };

  const changeSpeed = (nextSpeed: 1 | 1.5 | 2) => {
    setSpeed(nextSpeed);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed;
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-12 space-y-10">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-2 max-w-2xl">
          <p className="text-xs font-mono font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
            {tr('Live Product Video Theater', 'တိုက်ရိုက် စမ်းသပ် ဗီဒီယို ပြခန်း')}
          </p>
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            {tr(
              'Real recordings from the running DriftGuard workspace.',
              'လက်တွေ့ အလုပ်လုပ်နေသော DriftGuard ၏ တိုက်ရိုက် ဗီဒီယိုမှတ်တမ်းများ။'
            )}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {tr(
              'Every clip is captured directly from the live Demo Workspace (demo@driftguard.dev) with zero mock animations.',
              'ဗီဒီယိုအားလုံးကို တကယ့် Demo Workspace မှ တိုက်ရိုက် ရိုက်ကူးထားပါသည်။'
            )}
          </p>
        </div>

        <button
          type="button"
          disabled={demoLoading}
          onClick={onTryDemo}
          className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-2"
        >
          <Play className="w-4 h-4" />
          <span>
            {demoLoading
              ? tr('Launching Workspace…', 'ဖွင့်နေသည်…')
              : tr('Launch Interactive Demo Now', 'တိုက်ရိုက် စမ်းသပ်ခန်း ဖွင့်ရန်')}
          </span>
        </button>
      </div>

      {/* Main Theater Player + Chapter Selector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="relative aspect-video bg-slate-950">
            <video
              key={activeClip.id}
              ref={videoRef}
              src={activeClip.src}
              poster={activeClip.poster}
              autoPlay
              muted={muted}
              loop
              playsInline
              onLoadedMetadata={(e) => {
                e.currentTarget.playbackRate = speed;
                setPlaying(true);
              }}
              className="w-full h-full object-contain"
            />
          </div>

          {/* Fast Custom Playback Bar */}
          <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50 dark:bg-slate-900">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePlay}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg cursor-pointer"
              >
                {playing ? (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    <span>{tr('Pause', 'ခဏရပ်')}</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>{tr('Play', 'ဖွင့်ရန်')}</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={restartClip}
                className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Restart clip"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Toggle mute"
              >
                {muted ? (
                  <VolumeX className="w-3.5 h-3.5" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800 text-xs font-mono">
              {([1, 1.5, 2] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => changeSpeed(s)}
                  className={`px-2 py-0.5 rounded cursor-pointer ${
                    speed === s
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 font-semibold'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          <div className="p-6 space-y-3 border-t border-slate-200 dark:border-slate-800">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
              {tr(activeClip.titleEn, activeClip.titleMy)}
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {tr(activeClip.summaryEn, activeClip.summaryMy)}
            </p>
            <ul className="pt-2 grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs text-slate-700 dark:text-slate-300">
              {(tr('en', 'my') === 'my'
                ? activeClip.highlightsMy
                : activeClip.highlightsEn
              ).map((point) => (
                <li
                  key={point}
                  className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 flex items-start gap-2"
                >
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Playlist Rail */}
        <div className="lg:col-span-4 space-y-3">
          <p className="text-xs font-mono font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {tr('Recorded Demo Reel (3 Clips)', 'မှတ်တမ်းတင်ထားသော ဗီဒီယိုများ (၃ ခု)')}
          </p>
          {DEMO_VIDEOS.map((clip, idx) => {
            const isCurrent = idx === activeClipIdx;
            return (
              <TiltCard3D
                key={clip.id}
                maxTiltDeg={4}
                onClick={() => setActiveClipIdx(idx)}
                className={`rounded-xl border overflow-hidden cursor-pointer transition-colors ${
                  isCurrent
                    ? 'border-blue-500 dark:border-blue-500 bg-blue-50/50 dark:bg-blue-950/30'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="relative aspect-video bg-slate-950">
                  <img
                    src={clip.poster}
                    alt={clip.titleEn}
                    className="w-full h-full object-cover object-top"
                  />
                  <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-950/90 text-[11px] font-mono text-white">
                    {clip.duration}
                  </div>
                </div>
                <div className="p-3.5 space-y-1">
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    0{idx + 1}. {tr(clip.titleEn, clip.titleMy)}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                    {tr(clip.summaryEn, clip.summaryMy)}
                  </p>
                </div>
              </TiltCard3D>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. 3D UI SCREENSHOT GALLERY + LIGHT/DARK INTERACTIVE DRAG SLIDER           */
/* -------------------------------------------------------------------------- */
export function GalleryPage({ onTryDemo, demoLoading }: SharedLandingProps) {
  const { tr } = useI18n();
  const [category, setCategory] = useState<'all' | ScreenshotItem['category']>(
    'all'
  );
  const [sliderPct, setSliderPct] = useState(52);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const filtered =
    category === 'all'
      ? SCREENSHOTS
      : SCREENSHOTS.filter((s) => s.category === category);

  const lightboxItem =
    lightboxIdx !== null ? filtered[lightboxIdx] ?? null : null;

  return (
    <div className="max-w-7xl mx-auto px-6 py-12 space-y-14">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="space-y-2 max-w-2xl">
          <p className="text-xs font-mono font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
            {tr('Interactive UI Showcase', 'မျက်နှာပြင် ပြခန်း')}
          </p>
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            {tr(
              '11 authentic product captures across Light & Dark mode.',
              'အလင်းနှင့် အမှောင်မုဒ် မျက်နှာပြင် ဓာတ်ပုံ ၁၁ ပုံ။'
            )}
          </h1>
        </div>
        <button
          type="button"
          disabled={demoLoading}
          onClick={onTryDemo}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
        >
          {tr('Explore Live Workspace', 'တိုက်ရိုက် ဖွင့်ကြည့်ရန်')}
        </button>
      </div>

      {/* Interactive Light vs. Dark Mode Comparison Slider */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-slate-900 dark:text-slate-100">
            {tr(
              'Interactive Theme Compare — Drag slider to compare Light vs. Dark telemetry',
              'အလင်းနှင့် အမှောင်မုဒ် နှိုင်းယှဉ်မှု — Slider ကို ဆွဲကြည့်ပါ'
            )}
          </span>
          <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
            Light {sliderPct}% · Dark {100 - sliderPct}%
          </span>
        </div>

        <div className="relative rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-950 aspect-[16/9.4] select-none">
          {/* Underlying Dark Mode Capture */}
          <img
            src="/screenshots/dark-mode-dashboard.png"
            alt="DriftGuard Dark Mode Dashboard"
            className="absolute inset-0 w-full h-full object-cover object-top"
          />
          {/* Clipped Light Mode Capture */}
          <div
            style={{ clipPath: `inset(0 ${100 - sliderPct}% 0 0)` }}
            className="absolute inset-0"
          >
            <img
              src="/screenshots/dashboard-overview.png"
              alt="DriftGuard Light Mode Dashboard"
              className="w-full h-full object-cover object-top"
            />
          </div>

          {/* Crisp Vertical Divider Line */}
          <div
            aria-hidden="true"
            style={{ left: `${sliderPct}%` }}
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-blue-500"
          >
            <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-blue-600 text-white border-2 border-white flex items-center justify-center shadow-md text-xs font-bold">
              ↔
            </div>
          </div>

          {/* Accessible Range Slider Overlay */}
          <input
            type="range"
            min={5}
            max={95}
            value={sliderPct}
            onChange={(e) => setSliderPct(Number(e.target.value))}
            aria-label="Compare Light and Dark Mode"
            className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize z-10"
          />
        </div>
      </section>

      {/* Filter Bar + 3D Tilt Grid */}
      <section className="space-y-6">
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-fit">
          {(
            [
              { id: 'all', label: `${tr('All', 'အားလုံး')} (${SCREENSHOTS.length})` },
              { id: 'ops', label: tr('Live Ops & Blocker Tree', 'တိုက်ရိုက် စောင့်ကြည့်') },
              { id: 'telemetry', label: tr('SQL Telemetry', 'SQL စွမ်းဆောင်ရည်') },
              { id: 'diagrams', label: tr('UML Diagrams', 'UML ပုံကြမ်း') },
              { id: 'governance', label: tr('Governance & Auto-Inspect', 'စီမံခန့်ခွဲမှု') },
              { id: 'i18n', label: tr('Localization', 'ဘာသာစကား') },
            ] as { id: 'all' | ScreenshotItem['category']; label: string }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setCategory(tab.id);
                setLightboxIdx(null);
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                category === tab.id
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.map((item, idx) => (
            <TiltCard3D
              key={item.id}
              maxTiltDeg={6}
              onClick={() => setLightboxIdx(idx)}
              className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden cursor-pointer flex flex-col"
            >
              <div className="relative aspect-[16/10] bg-slate-950 overflow-hidden group">
                <img
                  src={item.src}
                  alt={item.titleEn}
                  loading="lazy"
                  className="w-full h-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]"
                />
                <span className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg bg-slate-950/85 text-white border border-slate-700">
                  <Maximize2 className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="p-4 space-y-1.5 flex-1 flex flex-col justify-between">
                <div>
                  <p className="text-[11px] font-mono text-blue-700 dark:text-blue-400">
                    {item.tag}
                  </p>
                  <h3 className="mt-0.5 text-sm font-bold text-slate-900 dark:text-slate-100">
                    {tr(item.titleEn, item.titleMy)}
                  </h3>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
                  {tr(item.captionEn, item.captionMy)}
                </p>
              </div>
            </TiltCard3D>
          ))}
        </div>
      </section>

      {/* Full-Resolution Lightbox Modal */}
      <AnimatePresence>
        {lightboxItem && lightboxIdx !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setLightboxIdx(null)}
            className="fixed inset-0 z-50 bg-slate-950/90 p-4 sm:p-8 flex items-center justify-center"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
              className="max-w-6xl w-full rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden"
            >
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-100 truncate">
                    {tr(lightboxItem.titleEn, lightboxItem.titleMy)}
                  </p>
                  <p className="text-xs font-mono text-slate-400">
                    {lightboxItem.tag}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setLightboxIdx(
                        (lightboxIdx - 1 + filtered.length) % filtered.length
                      )
                    }
                    className="p-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setLightboxIdx((lightboxIdx + 1) % filtered.length)
                    }
                    className="p-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setLightboxIdx(null)}
                    className="p-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <img
                src={lightboxItem.src}
                alt={lightboxItem.titleEn}
                className="w-full max-h-[74vh] object-contain bg-slate-950"
              />
              <div className="px-5 py-3 border-t border-slate-800 text-xs text-slate-300">
                {tr(lightboxItem.captionEn, lightboxItem.captionMy)}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. SECURITY, READ-ONLY ROLE & CI/CD GATE PAGE                              */
/* -------------------------------------------------------------------------- */
export function SecurityPage({ onSignInGoogle, onTryDemo, demoLoading }: SharedLandingProps) {
  const { tr } = useI18n();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const readOnlySql = `CREATE ROLE driftguard_ro WITH LOGIN PASSWORD 'replace-with-strong-password';
GRANT pg_monitor TO driftguard_ro;
GRANT CONNECT ON DATABASE your_database TO driftguard_ro;
GRANT USAGE ON SCHEMA public TO driftguard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA information_schema TO driftguard_ro;`;

  const ciYaml = `name: DriftGuard Schema Gate
on: [pull_request, push]
jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - name: Fail deploy on undocumented schema drift (HTTP 409)
        run: |
          curl --fail-with-body -sS -X POST "\${{ vars.DRIFTGUARD_URL }}/api/ci/check-drift" \\
            -H "Content-Type: application/json" \\
            -H "X-DriftGuard-Key: \${{ secrets.DRIFTGUARD_API_KEY }}" \\
            -d '{"databaseId":"\${{ vars.DRIFTGUARD_TARGET_ID }}"}'`;

  const copyText = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((curr) => (curr === id ? null : curr));
    }, 1800);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-12 space-y-12">
      <div className="max-w-3xl space-y-2.5">
        <p className="text-xs font-mono font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
          {tr('Security & CI/CD Architecture', 'လုံခြုံရေးနှင့် CI/CD ဗိသုကာ')}
        </p>
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          {tr(
            'Zero-trust read-only PostgreSQL guardrails.',
            'အန္တရာယ်ကင်းသော Read-Only PostgreSQL လုံခြုံရေး စနစ်။'
          )}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
          {tr(
            'Every scan executes inside BEGIN READ ONLY with strict 4-second statement timeouts. Credentials are encrypted with AES-256-GCM HKDF and outbound hosts pass DNS SSRF validation before connecting.',
            'စစ်ဆေးမှုတိုင်းကို BEGIN READ ONLY နှင့် ၄ စက္ကန့် ကန့်သတ်ချက်အတွင်းသာ လုပ်ဆောင်ပြီး စကားဝှက်များကို AES-256-GCM ဖြင့် သိမ်းဆည်းပါသည်။'
          )}
        </p>
      </div>

      {/* 4 Defense-in-Depth Pillars */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {[
          {
            icon: ShieldCheck,
            titleEn: 'AES-256-GCM Vault',
            titleMy: 'AES-256-GCM သိမ်းဆည်းမှု',
            bodyEn:
              'External PostgreSQL URIs and webhook URLs are encrypted at rest with HKDF key derivation and never returned in plaintext.',
            bodyMy:
              'PostgreSQL URI နှင့် Webhook URL များကို AES-256-GCM ဖြင့် လုံခြုံစွာ သိမ်းဆည်းထားသည်။',
          },
          {
            icon: Globe,
            titleEn: 'SSRF DNS Guard',
            titleMy: 'SSRF ကွန်ရက် ကာကွယ်မှု',
            bodyEn:
              'Resolves hostnames and blocks loopback, link-local, and cloud metadata IP ranges before opening any TCP socket.',
            bodyMy:
              'မလိုလားအပ်သော အတွင်းပိုင်း IP များနှင့် Metadata endpoint များသို့ ချိတ်ဆက်မှုကို တားဆီးပေးသည်။',
          },
          {
            icon: Terminal,
            titleEn: 'BEGIN READ ONLY + 4s Cap',
            titleMy: 'READ ONLY + ၄ စက္ကန့် ကန့်သတ်',
            bodyEn:
              'All target telemetry queries run inside explicit read-only transactions; EXPLAIN strictly rejects non-SELECT DDL/DML.',
            bodyMy:
              'စစ်ဆေးမှုအားလုံးကို Read-Only Transaction အတွင်းသာ လုပ်ဆောင်ပြီး ဒေတာပြင်ဆင်မှု လုံးဝမပြုလုပ်ပါ။',
          },
          {
            icon: GitBranch,
            titleEn: 'Tenant Isolation & Audit',
            titleMy: 'အကောင့် သီးခြားခွဲခြားမှု',
            bodyEn:
              'Every target, baseline, incident, threshold rule, and bulk action is isolated by verified Firebase UID and logged.',
            bodyMy:
              'အသုံးပြုသူတစ်ဦးချင်းစီ၏ ဒေတာများကို Firebase UID ဖြင့် သီးခြားခွဲထားပြီး Audit Log မှတ်တမ်းတင်သည်။',
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.titleEn}
              className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2.5"
            >
              <Icon className="w-5 h-5 text-blue-700 dark:text-blue-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {tr(item.titleEn, item.titleMy)}
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {tr(item.bodyEn, item.bodyMy)}
              </p>
            </div>
          );
        })}
      </div>

      {/* Copyable Provisioning SQL & GitHub Actions Gate */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                '1. Provision Least-Privilege Read-Only Role (PostgreSQL 13+)',
                '၁. Read-Only Role ဖန်တီးရန် SQL (PostgreSQL 13+)'
              )}
            </span>
            <button
              type="button"
              onClick={() => copyText('ro-sql', readOnlySql)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer"
            >
              {copiedId === 'ro-sql' ? (
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{tr('Copy SQL', 'SQL ကူးရန်')}</span>
            </button>
          </div>
          <pre className="p-5 bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed flex-1">
            {readOnlySql}
          </pre>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                '2. GitHub Actions Schema Drift Gate (HTTP 409 on Drift)',
                '၂. GitHub Actions Schema Drift Gate YAML'
              )}
            </span>
            <button
              type="button"
              onClick={() => copyText('ci-yaml', ciYaml)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer"
            >
              {copiedId === 'ci-yaml' ? (
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{tr('Copy YAML', 'YAML ကူးရန်')}</span>
            </button>
          </div>
          <pre className="p-5 bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed flex-1">
            {ciYaml}
          </pre>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSignInGoogle}
          className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg cursor-pointer"
        >
          {tr('Connect Your Cluster', 'သင့်ဒေတာဘေ့စ် ချိတ်ဆက်ရန်')}
        </button>
        <button
          type="button"
          disabled={demoLoading}
          onClick={onTryDemo}
          className="px-4 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
        >
          {tr('Try Live Demo Workspace', 'တိုက်ရိုက် စမ်းသပ်ခန်း ဖွင့်ရန်')}
        </button>
      </div>
    </div>
  );
}
