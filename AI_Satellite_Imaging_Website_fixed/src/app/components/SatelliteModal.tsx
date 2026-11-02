import { useEffect, useId, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { X, Satellite, Activity, Globe, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

export interface SatelliteData {
  id: string;
  name: string;
  type: string;
  orbit: string;
  altitude: string;
  speed: string;
  launched: string;
  mission: string;
  status: string;
  operator: string;
  country: string;
  description: string;
}

interface SatelliteModalProps {
  isOpen: boolean;
  onClose: () => void;
  satellite: SatelliteData | null;
}

interface StatCard {
  key: 'orbit' | 'altitude' | 'speed' | 'launched';
  icon: LucideIcon | null;
  box: string;
  tint: string;
}

const STAT_CARDS: StatCard[] = [
  { key: 'orbit', icon: Globe, box: 'bg-cyan-500/20', tint: 'text-cyan-400' },
  { key: 'altitude', icon: Activity, box: 'bg-blue-500/20', tint: 'text-blue-400' },
  { key: 'speed', icon: Zap, box: 'bg-purple-500/20', tint: 'text-purple-400' },
  { key: 'launched', icon: null, box: 'bg-orange-500/20', tint: 'text-orange-400' },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function statusClasses(status: string): string {
  const value = status.toLowerCase();
  if (/(inactive|decommission|deorbit|retired|failed|lost)/.test(value)) {
    return 'bg-red-500/20 border-red-500/30 text-red-400';
  }
  if (/(active|operational|nominal|online)/.test(value)) {
    return 'bg-green-500/20 border-green-500/30 text-green-400';
  }
  return 'bg-amber-500/20 border-amber-500/30 text-amber-400';
}

function SatelliteDialog({ satellite, onClose }: { satellite: SatelliteData; onClose: () => void }) {
  const { t } = useLanguage();
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const descId = useId();
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
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialogRef.current.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
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

  const panelMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
    : {
        initial: { opacity: 0, scale: 0.9, y: 20 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.9, y: 20 },
        transition: { type: 'spring' as const, damping: 25, stiffness: 300 },
      };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/80 backdrop-blur-sm"
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        {...panelMotion}
        className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto overscroll-contain backdrop-blur-xl bg-gradient-to-br from-slate-900/95 via-blue-900/90 to-slate-900/95 border border-white/20 rounded-3xl shadow-2xl"
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={t('satellite.modal.close')}
          title={`${t('satellite.modal.close')} (Esc)`}
          className="absolute top-4 right-4 sm:top-6 sm:right-6 w-10 h-10 flex items-center justify-center backdrop-blur-md bg-white/10 hover:bg-white/20 border border-white/20 rounded-full transition-all duration-300 group z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <X
            className="w-5 h-5 text-white group-hover:rotate-90 transition-transform duration-300"
            aria-hidden="true"
          />
        </button>

        <div className="p-6 sm:p-8 md:p-12">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-4 pr-12">
              <div className="w-14 h-14 shrink-0 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-xl flex items-center justify-center">
                <Satellite className="w-7 h-7 text-white" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 id={titleId} className="text-white mb-1 break-words">
                  {satellite.name}
                </h2>
                <div className="flex flex-wrap items-center gap-2">
