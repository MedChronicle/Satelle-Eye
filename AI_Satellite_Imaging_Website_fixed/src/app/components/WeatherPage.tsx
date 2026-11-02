import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { X } from 'lucide-react';
import { DashboardWeather } from './DashboardWeather';
import { useLanguage } from '../contexts/LanguageContext';

interface WeatherPageProps {
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WeatherPage({ onClose }: WeatherPageProps) {
  const { t } = useLanguage();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="weather-page-title"
      aria-describedby="weather-page-desc"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 bg-black overflow-auto overscroll-contain"
    >
      <div className="min-h-screen p-4 sm:p-6 relative z-10">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 mb-6 backdrop-blur-md bg-black/60 border border-white/10 rounded-2xl px-4 sm:px-6 py-4">
          <div className="min-w-0">
            <h2 id="weather-page-title" className="text-white text-xl sm:text-2xl mb-1 truncate">
              Global Weather System
            </h2>
            <p id="weather-page-desc" className="text-white/60 text-sm">
              Real-time weather data from around the world
            </p>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('satellite.modal.close')}
            title={`${t('satellite.modal.close')} (Esc)`}
            className="shrink-0 p-2 text-white/60 hover:text-white hover:bg-white/10 focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded-lg transition-all duration-300"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </header>

        <main>
          <DashboardWeather />
        </main>
      </div>
    </motion.div>
  );
}
