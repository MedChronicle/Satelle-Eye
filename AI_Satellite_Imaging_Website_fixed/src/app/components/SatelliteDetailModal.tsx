import { useEffect, useId, useMemo, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  X,
  Satellite,
  Globe2,
  Zap,
  Clock,
  Activity,
  Gauge,
  Antenna,
  Navigation,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

export interface SatelliteDetail {
  id: string;
  name: string;
  lat: number;
  lon: number;
  alt: number;
  speed: number;
  operator: string;
  purpose: string;
  band: string;
  aos?: string;
  los?: string;
  azimuth?: number;
  elevation?: number;
  distance?: number;
  status?: string;
}

interface SatelliteDetailModalProps {
  satellite: SatelliteDetail;
  onClose: () => void;
  isLive?: boolean;
}

const EARTH_RADIUS_KM = 6371;
const MU_KM3_S2 = 398600.4418;
const GEO_ALTITUDE_KM = 35786;
const GEO_TOLERANCE_KM = 300;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function num(value: number | undefined, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function classifyOrbit(altKm: number): string {
  if (!Number.isFinite(altKm)) return 'Unknown orbit';
  if (altKm < 2000) return 'LEO (Low Earth Orbit)';
  if (Math.abs(altKm - GEO_ALTITUDE_KM) <= GEO_TOLERANCE_KM) return 'GEO (Geostationary Orbit)';
  if (altKm < GEO_ALTITUDE_KM - GEO_TOLERANCE_KM) return 'MEO (Medium Earth Orbit)';
  return 'HEO (High Earth Orbit)';
}

function computeOrbit(altKm: number) {
  if (!Number.isFinite(altKm) || altKm < 0) {
    return { periodMinutes: null as number | null, coverageMkm2: null as number | null };
  }
  const radius = EARTH_RADIUS_KM + altKm;
  const periodSeconds = 2 * Math.PI * Math.sqrt(Math.pow(radius, 3) / MU_KM3_S2);
  const capArea = 2 * Math.PI * EARTH_RADIUS_KM * EARTH_RADIUS_KM * (1 - EARTH_RADIUS_KM / radius);
  return { periodMinutes: Math.round(periodSeconds / 60), coverageMkm2: capArea / 1_000_000 };
}

function statusClasses(status: string): string {
  const value = status.toLowerCase();
  if (/(inactive|decommission|deorbit|retired|failed|lost)/.test(value)) {
    return 'bg-red-500/20 border-red-400/50 text-red-400';
  }
  if (/(active|operational|nominal|online)/.test(value)) {
    return 'bg-green-500/20 border-green-400/50 text-green-400';
  }
  return 'bg-amber-500/20 border-amber-400/50 text-amber-400';
}

export function SatelliteDetailModal({ satellite, onClose, isLive = true }: SatelliteDetailModalProps) {
  const { t } = useLanguage();
  const reduceMotion = useReducedMotion();
  const titleId = useId();
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

  const orbitType = useMemo(() => classifyOrbit(satellite.alt), [satellite.alt]);
  const { periodMinutes, coverageMkm2 } = useMemo(() => computeOrbit(satellite.alt), [satellite.alt]);

  const hasTracking =
    typeof satellite.azimuth === 'number' && typeof satellite.elevation === 'number';
  const hasRange = typeof satellite.distance === 'number' && Number.isFinite(satellite.distance);
  const hasPasses = Boolean(satellite.aos && satellite.los);

  const cardMotion = (delay: number, axis: 'x' | 'y', offset: number) =>
    reduceMotion
      ? { initial: false as const, animate: { opacity: 1 } }
      : {
          initial: { opacity: 0, [axis]: offset },
          animate: { opacity: 1, [axis]: 0 },
          transition: { delay },
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={reduceMotion ? { opacity: 0 } : { scale: 0.9, opacity: 0, y: 50 }}
        animate={reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { scale: 0.9, opacity: 0, y: 50 }}
        transition={reduceMotion ? { duration: 0.15 } : { type: 'spring', damping: 25 }}
        className="relative flex flex-col max-w-4xl w-full max-h-[90vh] backdrop-blur-md bg-gradient-to-br from-slate-900/95 to-black/95 border-2 border-cyan-400/30 rounded-3xl shadow-2xl overflow-hidden"
        style={{ boxShadow: '0 0 80px rgba(6, 182, 212, 0.4), 0 0 40px rgba(6, 182, 212, 0.2)' }}
      >
        <div className="absolute inset-0 opacity-5 pointer-events-none" aria-hidden="true">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: 'radial-gradient(circle at 2px 2px, rgba(6, 182, 212, 0.3) 1px, transparent 0)',
              backgroundSize: '40px 40px',
            }}
          />
        </div>

        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={t('satellite.modal.close')}
          title={`${t('satellite.modal.close')} (Esc)`}
          className="absolute top-4 right-4 sm:top-6 sm:right-6 p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-xl transition-all duration-300 z-10 backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <X className="w-6 h-6" aria-hidden="true" />
        </button>

        <div className="relative shrink-0 bg-gradient-to-r from-cyan-500/20 via-blue-500/20 to-purple-500/20 border-b border-cyan-400/30 p-5 sm:p-8 pr-14 sm:pr-16">
          <div className="flex items-start gap-4 sm:gap-6">
            <motion.div
              animate={reduceMotion ? undefined : { rotate: 360 }}
              transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
              className="shrink-0 p-3 sm:p-4 bg-gradient-to-br from-cyan-500/30 to-blue-600/30 rounded-2xl backdrop-blur-sm border border-cyan-400/50"
              style={{ boxShadow: '0 0 30px rgba(6, 182, 212, 0.3)' }}
              aria-hidden="true"
            >
              <Satellite className="w-9 h-9 sm:w-12 sm:h-12 text-cyan-400" />
            </motion.div>
            <div className="flex-1 min-w-0">
              <h2 id={titleId} className="text-white text-2xl sm:text-3xl mb-2 break-words">
                {satellite.name}
              </h2>
              <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
                <span className="px-3 py-1 bg-cyan-500/20 border border-cyan-400/50 text-cyan-400 rounded-full text-sm">
                  {orbitType}
                </span>
                {satellite.status && (
                  <span
                    className={`px-3 py-1 border rounded-full text-sm flex items-center gap-1 ${statusClasses(satellite.status)}`}
                  >
                    <Activity className="w-3 h-3" aria-hidden="true" />
                    {satellite.status}
                  </span>
                )}
                <span className="text-white/60 text-sm">NORAD ID: {satellite.id}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="relative flex-1 overflow-y-auto overscroll-contain p-5 sm:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <motion.div
              {...cardMotion(0.1, 'x', -20)}
              className="backdrop-blur-md bg-gradient-to-br from-cyan-500/10 to-blue-500/10 border border-cyan-400/30 rounded-2xl p-5"
            >
              <div className="flex items-center gap-3 text-cyan-400 mb-3">
                <Globe2 className="w-5 h-5" aria-hidden="true" />
                <span className="text-sm uppercase tracking-wide">{t('dashboard.operator')}</span>
              </div>
              <div className="text-white text-xl break-words">{satellite.operator}</div>
            </motion.div>

            <motion.div
              {...cardMotion(0.15, 'x', 20)}
              className="backdrop-blur-md bg-gradient-to-br from-purple-500/10 to-pink-500/10 border border-purple-400/30 rounded-2xl p-5"
            >
              <div className="flex items-center gap-3 text-purple-400 mb-3">
                <Zap className="w-5 h-5" aria-hidden="true" />
                <span className="text-sm uppercase tracking-wide">{t('dashboard.purpose')}</span>
              </div>
              <div className="text-white text-xl break-words">{satellite.purpose}</div>
            </motion.div>
          </div>

          <motion.section
            {...cardMotion(0.2, 'y', 20)}
            className="backdrop-blur-md bg-gradient-to-br from-orange-500/10 to-red-500/10 border-2 border-orange-400/40 rounded-2xl p-5 sm:p-6 mb-6"
          >
            <h3 className="text-orange-400 text-lg sm:text-xl mb-4 flex items-center gap-2">
              <Antenna className="w-6 h-6 shrink-0" aria-hidden="true" />
              Communications & Technical Specifications
            </h3>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <dt className="text-white/60 text-xs uppercase tracking-wide mb-1">{t('dashboard.band')}</dt>
                <dd className="text-orange-300 text-2xl m-0">{satellite.band}</dd>
              </div>
              <div>
                <dt className="text-white/60 text-xs uppercase tracking-wide mb-1">Orbital Period</dt>
                <dd className="text-white text-lg m-0">
                  {periodMinutes === null ? '—' : `${periodMinutes} min`}
                </dd>
              </div>
              <div>
                <dt className="text-white/60 text-xs uppercase tracking-wide mb-1">Coverage Area</dt>
                <dd className="text-white text-lg m-0">
                  {coverageMkm2 === null ? '—' : `${coverageMkm2.toFixed(1)}M km²`}
                </dd>
              </div>
              <div>
                <dt className="text-white/60 text-xs uppercase tracking-wide mb-1">{t('satellite.modal.speed')}</dt>
                <dd className="text-white text-lg m-0">{num(satellite.speed, 2)} km/s</dd>
              </div>
            </dl>
          </motion.section>

          <motion.section
            {...cardMotion(0.25, 'y', 20)}
            className="backdrop-blur-md bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-2 border-green-400/40 rounded-2xl p-5 sm:p-6 mb-6"
          >
            <h3 className="text-green-400 text-lg sm:text-xl mb-4 flex items-center gap-2">
              <Navigation className="w-6 h-6 shrink-0" aria-hidden="true" />
              {isLive ? 'Real-Time Orbital Position' : 'Last Known Orbital Position'}
            </h3>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="text-center">
                <dt className="text-white/60 text-sm mb-2">Latitude</dt>
                <dd className="m-0">
                  <div className="text-3xl sm:text-4xl text-green-400 font-mono mb-1">{num(satellite.lat, 4)}°</div>
                  <div className="text-xs text-white/40">{satellite.lat >= 0 ? 'North' : 'South'}</div>
                </dd>
              </div>
              <div className="text-center">
                <dt className="text-white/60 text-sm mb-2">Longitude</dt>
                <dd className="m-0">
                  <div className="text-3xl sm:text-4xl text-green-400 font-mono mb-1">{num(satellite.lon, 4)}°</div>
                  <div className="text-xs text-white/40">{satellite.lon >= 0 ? 'East' : 'West'}</div>
                </dd>
              </div>
              <div className="text-center">
                <dt className="text-white/60 text-sm mb-2">{t('satellite.modal.altitude')}</dt>
                <dd className="m-0">
                  <div className="text-3xl sm:text-4xl text-cyan-400 font-mono mb-1">{num(satellite.alt, 0)}</div>
                  <div className="text-xs text-white/40">kilometers</div>
                </dd>
              </div>
            </dl>
          </motion.section>

          {hasTracking && (
            <motion.section
              {...cardMotion(0.3, 'y', 20)}
              className="backdrop-blur-md bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-400/30 rounded-2xl p-5 sm:p-6 mb-6"
            >
              <h3 className="text-blue-400 text-lg sm:text-xl mb-4 flex items-center gap-2">
                <Gauge className="w-6 h-6 shrink-0" aria-hidden="true" />
                Ground Station Tracking Data
              </h3>
              <dl className={`grid gap-4 sm:gap-6 ${hasRange ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'}`}>
                <div className="backdrop-blur-sm bg-white/5 rounded-xl p-4">
                  <dt className="text-white/60 text-sm mb-2">Azimuth</dt>
                  <dd className="text-3xl text-blue-400 font-mono m-0">{num(satellite.azimuth, 2)}°</dd>
                </div>
                <div className="backdrop-blur-sm bg-white/5 rounded-xl p-4">
                  <dt className="text-white/60 text-sm mb-2">Elevation</dt>
                  <dd className="text-3xl text-blue-400 font-mono m-0">{num(satellite.elevation, 2)}°</dd>
                </div>
                {hasRange && (
                  <div className="backdrop-blur-sm bg-white/5 rounded-xl p-4">
                    <dt className="text-white/60 text-sm mb-2">{t('dashboard.table.distance')}</dt>
                    <dd className="text-2xl text-blue-400 font-mono m-0">
                      {satellite.distance!.toLocaleString()} km
                    </dd>
                  </div>
                )}
              </dl>
            </motion.section>
          )}

          {hasPasses && (
            <motion.section
              {...cardMotion(0.35, 'y', 20)}
              className="backdrop-blur-md bg-gradient-to-br from-yellow-500/10 to-orange-500/10 border border-yellow-400/30 rounded-2xl p-5 sm:p-6"
            >
              <h3 className="text-yellow-400 text-lg sm:text-xl mb-4 flex items-center gap-2">
                <Clock className="w-6 h-6 shrink-0" aria-hidden="true" />
                Next Pass Schedule
              </h3>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                <div className="backdrop-blur-sm bg-white/5 rounded-xl p-4">
                  <dt className="text-yellow-400 text-sm mb-2 uppercase tracking-wide">
                    {t('dashboard.table.aos')} (Acquisition of Signal)
                  </dt>
                  <dd className="text-white text-lg font-mono m-0">{satellite.aos}</dd>
                </div>
                <div className="backdrop-blur-sm bg-white/5 rounded-xl p-4">
                  <dt className="text-pink-400 text-sm mb-2 uppercase tracking-wide">
                    {t('dashboard.table.los')} (Loss of Signal)
                  </dt>
                  <dd className="text-white text-lg font-mono m-0">{satellite.los}</dd>
                </div>
              </dl>
            </motion.section>
          )}
        </div>

        <div className="relative shrink-0 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border-t border-cyan-400/30 px-5 sm:px-8 py-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-white/40 text-xs">
              Data provided by N2YO Satellite Tracking API
              {isLive ? ' • Updated in real-time' : ''}
            </p>
            {isLive && (
              <div className="flex items-center gap-2" role="status">
                <div
                  className={`w-2 h-2 bg-green-400 rounded-full ${reduceMotion ? '' : 'animate-pulse'}`}
                  aria-hidden="true"
                />
                <span className="text-green-400 text-xs">Live Tracking Active</span>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
