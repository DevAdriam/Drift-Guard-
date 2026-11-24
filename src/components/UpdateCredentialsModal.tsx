import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, X } from 'lucide-react';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface UpdateCredentialsModalProps {
  isOpen: boolean;
  targetName: string;
  maskedTarget?: string;
  onClose: () => void;
  onSave: (connectionUrl: string) => Promise<void>;
}

export function UpdateCredentialsModal({
  isOpen,
  targetName,
  maskedTarget,
  onClose,
  onSave,
}: UpdateCredentialsModalProps) {
  const { locale, t, tr } = useI18n();
  const [connectionUrl, setConnectionUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setConnectionUrl('');
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = connectionUrl.trim();
    if (!trimmed) {
      setError(
        tr(
          'Please enter a PostgreSQL connection URI.',
          'PostgreSQL ချိတ်ဆက်မှု URI ကို ထည့်သွင်းပါ။'
        )
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Failed to save updated connection URI.',
              'ချိတ်ဆက်မှု URI အသစ်ကို သိမ်းဆည်း၍ မရပါ။'
            )
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-creds-title"
        className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <KeyRound className="w-4 h-4 text-blue-700 shrink-0" />
            <h2
              id="update-creds-title"
              className="text-base font-semibold text-slate-900 truncate"
            >
              {tr('Update Connection URI', 'ချိတ်ဆက်မှု URI ပြင်ဆင်ရန်')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('action.close')}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-1">
            <p className="text-sm text-slate-700">
              {locale === 'my' ? (
                <>
                  <strong className="font-semibold text-slate-900">
                    {targetName}
                  </strong>{' '}
                  အတွက် PostgreSQL ချိတ်ဆက်မှု URI အသစ်ကို ပြန်လည်ထည့်သွင်းပါ။
                  သိမ်းဆည်းထားသော မူလစံများနှင့် သမိုင်းကြောင်း မှတ်တမ်းများ
                  ပျက်စီးမည် မဟုတ်ပါ။
                </>
              ) : (
                <>
                  Re-enter the PostgreSQL connection URI for{' '}
                  <strong className="font-semibold text-slate-900">
                    {targetName}
                  </strong>
                  . All historical baselines, snapshots, and incidents will be
                  preserved.
                </>
              )}
            </p>
            {maskedTarget && (
              <p className="text-xs font-mono text-slate-500 truncate">
                {tr('Current target:', 'လက်ရှိ ပစ်မှတ်:')} {maskedTarget}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="reconnect-postgres-uri"
              className="block text-xs font-semibold text-slate-700"
            >
              {tr('PostgreSQL Connection URI', 'PostgreSQL ချိတ်ဆက်မှု URI')}
            </label>
            <input
              id="reconnect-postgres-uri"
              type="password"
              autoComplete="off"
              required
              value={connectionUrl}
              onChange={(e) => setConnectionUrl(e.target.value)}
              placeholder="postgresql://drift_monitor:password@db.example.com:5432/app_db?sslmode=require"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
            <p className="text-xs text-slate-500">
              {tr(
                'Encrypted on the server with AES-256-GCM using a persistent key and never exposed back to the browser.',
                'ဆာဗာတွင် AES-256-GCM စနစ်ဖြင့် တည်မြဲသော သော့သုံး၍ လုံခြုံစွာ ကုဒ်ဝှက်သိမ်းဆည်းမည်ဖြစ်ပြီး ဘရောက်ဆာသို့ ပြန်လည်ဖော်ပြမည် မဟုတ်ပါ။'
              )}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="px-3.5 py-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-800"
            >
              {error}
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-2.5 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
            >
              {t('action.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              {submitting
                ? tr('Saving…', 'သိမ်းဆည်းနေသည်…')
                : tr('Save & Reconnect', 'သိမ်းဆည်းပြီး ပြန်လည်ချိတ်ဆက်ရန်')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
