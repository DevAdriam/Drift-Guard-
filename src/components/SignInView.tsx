import {
  ArrowLeftRight,
  Database,
  FileCheck2,
  GitBranch,
  Layers,
  Lock,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { ThemeSwitcher } from '../context/ThemeContext.tsx';
import { LanguageSwitcher, useI18n } from '../i18n/LocaleContext.tsx';

export function SignInView() {
  const { signInWithGoogle, signInAsDemo, demoLoading, authError } = useAuth();
  const { t, tr } = useI18n();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <header className="w-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-4 sm:gap-8">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            DriftGuard
          </span>
          <nav className="hidden lg:flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-300">
            <span className="whitespace-nowrap shrink-0">
              {tr('Drift Radar', 'ဖွဲ့စည်းပုံ စောင့်ကြည့်ရေး')}
            </span>
            <span className="whitespace-nowrap shrink-0">
              {t('nav.linter')}
            </span>
            <span className="whitespace-nowrap shrink-0">
              {t('nav.compare')}
            </span>
            <span className="whitespace-nowrap shrink-0">
              {tr('Health & Locks', 'ကျန်းမာရေးနှင့် Lock များ')}
            </span>
          </nav>
          <div className="flex items-center gap-2.5 shrink-0">
            <ThemeSwitcher variant="header" />
            <LanguageSwitcher variant="header" />
            <button
              type="button"
              onClick={signInWithGoogle}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              {t('action.signInGoogle')}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <div className="max-w-6xl mx-auto w-full px-6 py-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-6 space-y-6">
            <p className="text-sm font-medium text-blue-700 dark:text-blue-400">
              {tr(
                'Safe, Read-Only PostgreSQL Guardrails',
                'ဘေးကင်းသော Read-Only PostgreSQL ကာကွယ်ရေးစနစ်'
              )}
            </p>
            <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-slate-900 dark:text-slate-100 leading-[1.2] max-w-xl">
              {tr(
                'Stop unexpected database changes and table-locking deploys before users notice.',
                'မမျှော်လင့်သော ဒေတာဘေ့စ် ပြောင်းလဲမှုများနှင့် ဇယားပိတ်ဆို့စေသော Deploy များကို အသုံးပြုသူများ မသိမီ ကြိုတင်တားဆီးပါ။'
              )}
            </h1>
            <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
              {tr(
                'DriftGuard watches your PostgreSQL clusters in read-only mode—never touching customer records. Catch manual production edits, check SQL migrations for locking traps, compare Staging vs. Production, and get instant Slack or Discord alerts with copy-paste fixes.',
                'DriftGuard သည် သင့် PostgreSQL ဒေတာဘေ့စ်များကို Read-Only စနစ်ဖြင့်သာ စောင့်ကြည့်ပေးပြီး အသုံးပြုသူဒေတာများကို လုံးဝ မထိပါးပါ။ Production တွင် တိုက်ရိုက်ပြင်ဆင်မှုများကို ဖမ်းယူခြင်း၊ SQL Migration များ၏ Lock အန္တရာယ်ကို ကြိုတင်စစ်ဆေးခြင်း၊ Staging နှင့် Production နှိုင်းယှဉ်ခြင်းနှင့် Slack/Discord မှတစ်ဆင့် ချက်ချင်း သတိပေးချက်များ ရယူနိုင်ပါသည်။'
              )}
            </p>

            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={signInWithGoogle}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              >
                {tr('Continue with Google', 'Google ဖြင့် ဆက်လက်ဝင်ရောက်ရန်')}
              </button>
              <button
                type="button"
                disabled={demoLoading}
                onClick={signInAsDemo}
                className="px-4 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                {demoLoading
                  ? tr('Loading Demo…', 'စမ်းသပ်ခန်း ဖွင့်နေသည်…')
                  : tr('Try Live Demo Workspace', 'စမ်းသပ် အကောင့်ဖြင့် ကြည့်ရှုရန်')}
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tr(
                'Zero-risk read-only role · 4s query timeout · Pre-seeded demo workspace available',
                'အန္တရာယ်ကင်းသော ဖတ်ရုံသက်သက် အကောင့် · ၄ စက္ကန့် Query ကန့်သတ်ချက် · စမ်းသပ်ဒေတာအပြည့်အစုံဖြင့် ကြည့်ရှုနိုင်သည်'
              )}
            </p>

            {authError && (
              <div
                role="alert"
                className="p-3.5 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-sm text-red-800 dark:text-red-300 max-w-lg"
              >
                {authError}
              </div>
            )}
          </div>

          <div className="lg:col-span-6">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="flex items-start gap-3">
                <Database className="w-5 h-5 text-blue-700 dark:text-blue-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Unexpected Change Alerts',
                      'မမျှော်လင့်သော ပြောင်းလဲမှု သတိပေးချက်'
                    )}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                    {tr(
                      'Fingerprints every table and column against your Git baseline and shows exact column diffs.',
                      'ဇယားနှင့် ကော်လံတိုင်းကို Git မူလစံဖွဲ့စည်းပုံနှင့် တိုက်ဆိုင်စစ်ဆေးပြီး ကွာခြားချက်အတိအကျကို ပြသပေးပါသည်။'
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <FileCheck2 className="w-5 h-5 text-emerald-700 dark:text-emerald-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Pre-Flight Migration Linter',
                      'Deploy မတိုင်မီ Migration စစ်ဆေးစက်'
                    )}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                    {tr(
                      'Flags table-freezing DDL, missing CONCURRENTLY indexes, and rewrites before deploy.',
                      'ဇယားပိတ်ဆို့စေသော DDL များ၊ CONCURRENTLY မပါသော Index များနှင့် ဇယားအသစ်ပြန်ရေးမှုများကို ကြိုတင်ထောက်ပြပေးပါသည်။'
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <ArrowLeftRight className="w-5 h-5 text-slate-700 dark:text-slate-300 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Staging vs. Production Diff',
                      'Staging နှင့် Production နှိုင်းယှဉ်ချက်'
                    )}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                    {tr(
                      'Compare any two environments side by side and auto-generate sync SQL.',
                      'မည်သည့် ပတ်ဝန်းကျင် နှစ်ခုကိုမဆို ယှဉ်တွဲစစ်ဆေးပြီး ညှိနှိုင်းပေးမည့် Sync SQL ကို အလိုအလျောက် ထုတ်ပေးပါသည်။'
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Lock className="w-5 h-5 text-amber-700 dark:text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Database Traffic Jam Radar',
                      'Lock ပိတ်ဆို့မှု စောင့်ကြည့်ရေးစနစ်'
                    )}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                    {tr(
                      'Finds queries blocking other sessions with sensitive values automatically redacted.',
                      'အခြား Session များကို ပိတ်ဆို့နေသော Query များကို ရှာဖွေပေးပြီး အရေးကြီးတန်ဖိုးများကို အလိုအလျောက် ဖုံးအုပ်ပေးပါသည်။'
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Layers className="w-5 h-5 text-slate-700 dark:text-slate-300 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'Bloat, Vacuum & Unused Indexes',
                      'ဖောင်းပွမှု၊ VACUUM နှင့် အသုံးမပြုသော အညွှန်းများ'
                    )}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                    {tr(
                      'Spots dead tuples, unused indexes, and bloated storage with safe online cleanup commands.',
                      'Dead Tuple များ၊ အသုံးမပြုသော အညွှန်းများနှင့် ဖောင်းပွနေသော သိုလှောင်မှုများကို ဘေးကင်းသော ရှင်းလင်းရေး SQL များနှင့်တကွ ဖော်ပြပေးပါသည်။'
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <GitBranch className="w-5 h-5 text-blue-700 dark:text-blue-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tr(
                      'GitHub Actions Drift Gate',
                      'GitHub Actions အလိုအလျောက် စစ်ဆေးဂိတ်'
                    )}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                    {tr(
                      'Block drifted pull requests via API key and auto-promote baselines on deploy.',
                      'API Key ဖြင့် ဖွဲ့စည်းပုံ မကိုက်ညီသော Pull Request များကို တားဆီးပြီး Deploy အပြီး မူလစံဖွဲ့စည်းပုံကို အလိုအလျောက် မြှင့်တင်ပေးပါသည်။'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
