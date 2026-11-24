import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { Globe } from 'lucide-react';
import { TRANSLATIONS, type Locale, type TranslationKey } from './translations';

const STORAGE_KEY = 'driftguard_locale';

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  tr: (en: string, my: string) => string;
  formatEnv: (env: string, compact?: boolean) => string;
  formatHealthStatus: (status: string) => string;
  formatSeverity: (severity: string) => string;
  formatIncidentStatus: (status: string) => string;
  formatIncidentType: (type: string) => string;
  formatRelativeTime: (iso: string | null | undefined) => string;
  formatDateTime: (iso: string | null | undefined) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getInitialLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'my' || saved === 'en') return saved;
  } catch {
    // ignore storage errors
  }
  return 'en';
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = TRANSLATIONS[locale]['brand.title'];
  }, [locale]);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      let text: string = TRANSLATIONS[locale][key] ?? TRANSLATIONS.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    [locale]
  );

  const tr = useCallback((en: string, my: string) => (locale === 'my' ? my : en), [locale]);

  const formatEnv = useCallback(
    (env: string, compact = false) => {
      const normalized = env.toLowerCase();
      if (normalized === 'production' || normalized === 'prod') {
        return t(compact ? 'env.prodShort' : 'env.production');
      }
      if (normalized === 'staging') {
        return t(compact ? 'env.stagingShort' : 'env.staging');
      }
      if (normalized === 'development' || normalized === 'dev') {
        return t(compact ? 'env.devShort' : 'env.development');
      }
      return env;
    },
    [t]
  );

  const formatHealthStatus = useCallback(
    (status: string) => {
      const normalized = status.toLowerCase();
      if (normalized === 'healthy' || normalized === 'nominal' || normalized === 'ok') {
        return t('status.healthy');
      }
      if (normalized === 'warning' || normalized === 'degraded' || normalized === 'elevated') {
        return t('status.warning');
      }
      if (normalized === 'critical' || normalized === 'error' || normalized === 'unreachable') {
        return t('status.critical');
      }
      return t('status.unknown');
    },
    [t]
  );

  const formatSeverity = useCallback(
    (severity: string) => {
      const normalized = severity.toLowerCase();
      if (normalized === 'critical' || normalized === 'high') return t('severity.critical');
      if (normalized === 'warning' || normalized === 'medium') return t('severity.warning');
      if (normalized === 'info' || normalized === 'low') return t('severity.info');
      return severity;
    },
    [t]
  );

  const formatIncidentStatus = useCallback(
    (status: string) => {
      const normalized = status.toLowerCase();
      if (normalized === 'open') return t('status.open');
      if (normalized === 'acknowledged') return t('status.acknowledged');
      if (normalized === 'resolved') return t('status.resolved');
      return status;
    },
    [t]
  );

  const formatIncidentType = useCallback(
    (type: string) => {
      const key = `incidentType.${type.toLowerCase()}` as TranslationKey;
      if (key in TRANSLATIONS.en) {
        return t(key);
      }
      return type.replace(/_/g, ' ');
    },
    [t]
  );

  const formatRelativeTime = useCallback(
    (iso: string | null | undefined) => {
      if (!iso) return t('common.never');
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diffSec < 60) return t('common.justNow');
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) {
        return locale === 'my' ? `${diffMin} မိနစ်အကြာက` : `${diffMin}m ago`;
      }
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) {
        return locale === 'my' ? `${diffHr} နာရီအကြာက` : `${diffHr}h ago`;
      }
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) {
        return locale === 'my' ? `${diffDay} ရက်အကြာက` : `${diffDay}d ago`;
      }
      return d.toLocaleDateString(locale === 'my' ? 'my-MM' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    },
    [locale, t]
  );

  const formatDateTime = useCallback(
    (iso: string | null | undefined) => {
      if (!iso) return t('common.never');
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(locale === 'my' ? 'my-MM' : 'en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    },
    [locale, t]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t,
      tr,
      formatEnv,
      formatHealthStatus,
      formatSeverity,
      formatIncidentStatus,
      formatIncidentType,
      formatRelativeTime,
      formatDateTime,
    }),
    [
      locale,
      setLocale,
      t,
      tr,
      formatEnv,
      formatHealthStatus,
      formatSeverity,
      formatIncidentStatus,
      formatIncidentType,
      formatRelativeTime,
      formatDateTime,
    ]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within a LocaleProvider');
  }
  return ctx;
}

export function LanguageSwitcher({
  variant = 'sidebar',
}: {
  variant?: 'sidebar' | 'header';
}) {
  const { locale, setLocale, t } = useI18n();

  if (variant === 'header') {
    return (
      <div
        className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 p-0.5 shrink-0"
        role="group"
        aria-label={t('lang.label')}
      >
        <button
          type="button"
          onClick={() => setLocale('en')}
          className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
            locale === 'en'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {t('lang.en')}
        </button>
        <button
          type="button"
          onClick={() => setLocale('my')}
          className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
            locale === 'my'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {t('lang.my')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 px-1 py-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 min-w-0">
        <Globe className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="truncate">{t('lang.label')}</span>
      </div>
      <div
        className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100/80 p-0.5 shrink-0"
        role="group"
        aria-label={t('lang.label')}
      >
        <button
          type="button"
          onClick={() => setLocale('en')}
          className={`px-2 py-0.5 text-[11px] font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
            locale === 'en'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {t('lang.en')}
        </button>
        <button
          type="button"
          onClick={() => setLocale('my')}
          className={`px-2 py-0.5 text-[11px] font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
            locale === 'my'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {t('lang.my')}
        </button>
      </div>
    </div>
  );
}
