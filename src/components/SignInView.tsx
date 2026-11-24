import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Menu, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { ThemeSwitcher } from '../context/ThemeContext.tsx';
import { LanguageSwitcher, useI18n } from '../i18n/LocaleContext.tsx';
import {
  GalleryPage,
  LiveDemosPage,
  OverviewPage,
  PlatformPage,
  SecurityPage,
} from './landing/LandingPages.tsx';
import type { LandingPageId } from './landing/LandingPages.tsx';

function readPageFromHash(): LandingPageId {
  const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  if (
    hash === 'platform' ||
    hash === 'demos' ||
    hash === 'gallery' ||
    hash === 'security'
  ) {
    return hash;
  }
  return 'home';
}

export function SignInView() {
  const { signInWithGoogle, signInAsDemo, demoLoading, authError } = useAuth();
  const { t, tr } = useI18n();

  const [activePage, setActivePage] = useState<LandingPageId>(() =>
    readPageFromHash()
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const onHashChange = () => {
      setActivePage(readPageFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigateTo = useCallback((page: LandingPageId) => {
    setActivePage(page);
    setMobileMenuOpen(false);
    const nextHash = page === 'home' ? '#/' : `#/${page}`;
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navItems: { id: LandingPageId; label: string }[] = [
    { id: 'home', label: tr('Home', 'ပင်မ') },
    { id: 'platform', label: tr('Platform & 3D', 'စနစ်နှင့် 3D') },
    { id: 'demos', label: tr('Live Demos', 'တိုက်ရိုက် ဗီဒီယို') },
    { id: 'gallery', label: tr('UI Gallery', 'မျက်နှာပြင် ပြခန်း') },
    { id: 'security', label: tr('Security & CI/CD', 'လုံခြုံရေးနှင့် CI/CD') },
  ];

  const sharedProps = {
    onNavigate: navigateTo,
    onSignInGoogle: signInWithGoogle,
    onTryDemo: signInAsDemo,
    demoLoading,
    authError,
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Sticky Single-Elevation Top Navigation */}
      <header className="sticky top-0 z-40 w-full border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-7 min-w-0">
            <button
              type="button"
              onClick={() => navigateTo('home')}
              className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              DriftGuard
            </button>

            <nav
              aria-label={tr('Landing navigation', 'ပင်မ လမ်းညွှန်')}
              className="hidden lg:flex items-center gap-1"
            >
              {navItems.map((item) => {
                const isActive = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigateTo(item.id)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isActive
                        ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-50 font-semibold'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100/70 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden sm:flex items-center gap-2">
              <ThemeSwitcher variant="header" />
              <LanguageSwitcher variant="header" />
            </div>

            <button
              type="button"
              onClick={signInWithGoogle}
              className="px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              {t('action.signInGoogle')}
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle menu"
              className="lg:hidden p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
            >
              {mobileMenuOpen ? (
                <X className="w-4 h-4" />
              ) : (
                <Menu className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile Dropdown Navigation */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.16 }}
              className="lg:hidden border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
            >
              <div className="px-6 py-4 space-y-2">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigateTo(item.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium cursor-pointer ${
                      activePage === item.id
                        ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
                <div className="pt-3 mt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 sm:hidden">
                  <ThemeSwitcher variant="header" />
                  <LanguageSwitcher variant="header" />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Fast Spring-Animated Multi-Page Viewport */}
      <main className="flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={activePage}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {activePage === 'home' && <OverviewPage {...sharedProps} />}
            {activePage === 'platform' && <PlatformPage {...sharedProps} />}
            {activePage === 'demos' && <LiveDemosPage {...sharedProps} />}
            {activePage === 'gallery' && <GalleryPage {...sharedProps} />}
            {activePage === 'security' && <SecurityPage {...sharedProps} />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Quiet Editorial SaaS Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row md:items-center justify-between gap-6 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
              DriftGuard
            </span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span>
              {tr(
                'Read-only PostgreSQL schema drift, live operations & governance',
                'Read-Only PostgreSQL စောင့်ကြည့်ရေးနှင့် စီမံခန့်ခွဲမှု စနစ်'
              )}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            {navItems.map((item) => (
              <button
                key={`ft-${item.id}`}
                type="button"
                onClick={() => navigateTo(item.id)}
                className="hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={signInAsDemo}
              disabled={demoLoading}
              className="font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
            >
              {tr('Try Demo', 'စမ်းသပ်ခန်း')}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
