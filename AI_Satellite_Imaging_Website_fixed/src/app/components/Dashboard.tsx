import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Satellite, Radio, Globe2, Clock, Loader2, AlertCircle,
  Search, RefreshCw, Pause, Play, ArrowUp, ArrowDown,
} from 'lucide-react';
import { GlobalDetectionMapEnhanced } from './GlobalDetectionMapEnhanced';
import { AIAnalysisEnhanced } from './AIAnalysisEnhanced';
import { RotatingEarth } from './RotatingEarth';
import { SatelliteDetailModal } from './SatelliteDetailModal';
import { SpaceBackground } from './SpaceBackground';
import { getAllSatelliteData } from '../services/n2yoService';
// Move your `satelliteMetadata` object into this file and `export const SATELLITE_METADATA = {...}`
import { SATELLITE_METADATA } from './satelliteMetadata';

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

interface SatelliteData {
  id: string;
  lat: number;
  lon: number;
  alt: number;
  aos: string;
  los: string;
  distance: number;
  speed: number;
  frequency: string; // azimuth string, kept for modal compatibility
  azimuth: number;
  mission: string;
  operator: string;
  purpose: string;
  band: string;
  category: Category;
}

interface Tracked {
  lat: number; lon: number;       // last known position
  vLat: number; vLon: number;     // deg / second, derived from consecutive fetches
  t: number;                      // timestamp (ms) of last fix
  trail: { lat: number; lon: number }[];
  lastTrailPush: number;
}

type Category =
  | 'Navigation' | 'Communications' | 'Earth observation' | 'Weather'
  | 'Science' | 'Amateur radio' | 'Station' | 'Other';

type SortKey = 'id' | 'alt' | 'speed' | 'azimuth' | 'aos';

const CATEGORIES: Category[] = [
  'Navigation', 'Communications', 'Earth observation', 'Weather',
  'Science', 'Amateur radio', 'Station', 'Other',
];

const CATEGORY_HUE: Record<Category, number> = {
  Navigation: 200, Communications: 280, 'Earth observation': 140, Weather: 40,
  Science: 320, 'Amateur radio': 20, Station: 170, Other: 230,
};

const EARTH_RADIUS_KM = 6371;
const MU = 398600.4418; // km^3/s^2
const REFRESH_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const TRAIL_LEN = 90;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));
const orbitalSpeed = (altKm: number) => Math.sqrt(MU / (EARTH_RADIUS_KM + altKm)); // km/s, circular orbit
const fmtUtc = (unix?: number) =>
  unix ? new Date(unix * 1000).toISOString().replace('T', ' ').split('.')[0] : 'N/A';

function categorize(purpose: string): Category {
  const p = purpose.toLowerCase();
  if (p.includes('station')) return 'Station';
  if (p.includes('navigation')) return 'Navigation';
  if (p.includes('amateur')) return 'Amateur radio';
  if (p.includes('weather')) return 'Weather';
  if (p.includes('telescope') || p.includes('soil') || p.includes('topography')) return 'Science';
  if (p.includes('earth') || p.includes('imaging') || p.includes('tracking')) return 'Earth observation';
  if (p.includes('communic') || p.includes('internet')) return 'Communications';
  return 'Other';
}

function transform(raw: any[]): SatelliteData[] {
  return raw
    .filter((s) => s?.position)
    .map((sat) => {
      const meta = SATELLITE_METADATA[sat.name] ?? {
        operator: 'Unknown', purpose: 'Unknown', band: 'Unknown',
      };
      const p = sat.position;
      const next = sat.passes?.[0];
      return {
        id: sat.name,
        lat: p.satlatitude,
        lon: p.satlongitude,
        alt: p.sataltitude,
        aos: fmtUtc(next?.startUTC),
        los: fmtUtc(next?.endUTC),
        distance: Math.round(p.sataltitude + EARTH_RADIUS_KM),
        speed: Number(orbitalSpeed(p.sataltitude).toFixed(2)),
        frequency: `${p.azimuth.toFixed(2)}°`,
        azimuth: p.azimuth,
        mission: sat.name,
        operator: meta.operator,
        purpose: meta.purpose,
        band: meta.band,
        category: categorize(meta.purpose),
      };
    });
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Polls satellite data with cancellation, backoff on errors, pause and manual refresh. */
function useSatelliteData(paused: boolean) {
  const [satellites, setSatellites] = useState<SatelliteData[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tick, setTick] = useState(0); // bump to force a refetch
  const failures = useRef(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const run = async () => {
      setRefreshing(true);
      try {
        const data = await getAllSatelliteData();
        if (cancelled) return;
        setSatellites(transform(data));
        setLastUpdated(new Date());
        setError(null);
        failures.current = 0;
      } catch (err) {
        if (cancelled) return;
        failures.current += 1;
        console.error('Error fetching satellite data:', err);
        setError('Failed to fetch real-time satellite data. Check your API key or network. Retrying automatically…');
      } finally {
        if (!cancelled) {
          setInitialLoading(false);
          setRefreshing(false);
          const delay = Math.min(REFRESH_MS * 2 ** failures.current, MAX_BACKOFF_MS);
          timer = setTimeout(run, failures.current ? delay : REFRESH_MS);
        }
      }
    };

    run();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [paused, tick]);

  return { satellites, initialLoading, refreshing, error, lastUpdated, refresh };
}

/* ------------------------------------------------------------------ */
/* Live map canvas                                                     */
/* ------------------------------------------------------------------ */

interface LiveMapProps {
  satellites: SatelliteData[];
  selectedId: string | null;
  onSelect: (sat: SatelliteData) => void;
}

function LiveMap({ satellites, selectedId, onSelect }: LiveMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackedRef = useRef<Map<string, Tracked>>(new Map());
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const satsRef = useRef<SatelliteData[]>([]);
  const selectedRef = useRef<string | null>(selectedId);
  const hoverRef = useRef<string | null>(null);

  selectedRef.current = selectedId;
  satsRef.current = satellites;

  // Derive velocity from consecutive fixes so markers glide between API polls.
  useEffect(() => {
    const now = Date.now();
    const seen = new Set<string>();
    for (const s of satellites) {
      seen.add(s.id);
      const prev = trackedRef.current.get(s.id);
      if (!prev) {
        trackedRef.current.set(s.id, {
          lat: s.lat, lon: s.lon, vLat: 0, vLon: 0, t: now,
          trail: [{ lat: s.lat, lon: s.lon }], lastTrailPush: now,
        });
        continue;
      }
      const dt = (now - prev.t) / 1000;
      if (dt > 1) {
        const dLon = wrapLon(s.lon - prev.lon);
        prev.vLon = dLon / dt;
        prev.vLat = (s.lat - prev.lat) / dt;
      }
      prev.lat = s.lat; prev.lon = s.lon; prev.t = now;
      prev.trail.push({ lat: s.lat, lon: s.lon });
      if (prev.trail.length > TRAIL_LEN) prev.trail.shift();
    }
    for (const id of trackedRef.current.keys()) if (!seen.has(id)) trackedRef.current.delete(id);
  }, [satellites]);

  // Single long-lived render loop (does not restart on data updates).
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let w = 0, h = 0, raf = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const project = (lat: number, lon: number) => ({
      x: ((lon + 180) / 360) * w,
      y: ((90 - lat) / 180) * h,
    });

    const draw = () => {
      const nowMs = Date.now();
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let lat = -90; lat <= 90; lat += 15) {
        const y = ((90 - lat) / 180) * h; ctx.moveTo(0, y); ctx.lineTo(w, y);
      }
      for (let lon = -180; lon <= 180; lon += 30) {
        const x = ((lon + 180) / 360) * w; ctx.moveTo(x, 0); ctx.lineTo(x, h);
      }
      ctx.stroke();
      // Equator
      ctx.strokeStyle = 'rgba(0,255,255,0.12)';
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

      const positions = positionsRef.current;
      positions.clear();

      for (const sat of satsRef.current) {
        const tr = trackedRef.current.get(sat.id);
        if (!tr) continue;
        const dt = Math.min((nowMs - tr.t) / 1000, REFRESH_MS / 1000 * 2);
        const lat = clampLat(tr.lat + tr.vLat * dt);
        const lon = wrapLon(tr.lon + tr.vLon * dt);
        const { x, y } = project(lat, lon);
        positions.set(sat.id, { x, y });

        const hue = CATEGORY_HUE[sat.category];
        const isSel = sat.id === selectedRef.current;
        const isHover = sat.id === hoverRef.current;

        // Ground-track trail (break the line across the antimeridian)
        if (tr.trail.length > 1) {
          ctx.strokeStyle = `hsla(${hue},80%,65%,${isSel ? 0.9 : 0.35})`;
          ctx.lineWidth = isSel ? 2 : 1;
          ctx.beginPath();
          let prev = project(tr.trail[0].lat, tr.trail[0].lon);
          ctx.moveTo(prev.x, prev.y);
          for (let i = 1; i < tr.trail.length; i++) {
            const p = project(tr.trail[i].lat, tr.trail[i].lon);
            if (Math.abs(p.x - prev.x) > w / 2) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
            prev = p;
          }
          ctx.lineTo(x, y);
          ctx.stroke();
        }

        // Real coverage footprint from altitude: angular radius = acos(R / (R + h))
        if (isSel || isHover) {
          const ang = (Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + sat.alt)) * 180) / Math.PI;
          const rx = (ang / 180) * w; // degrees of arc -> px
          const ry = (ang / 180) * h;
          const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
          g.addColorStop(0, `hsla(${hue},80%,60%,0.28)`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `hsla(${hue},80%,65%,0.6)`;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Marker with pulse for selected
        ctx.shadowBlur = isSel ? 22 : 12;
        ctx.shadowColor = `hsl(${hue},90%,60%)`;
        ctx.fillStyle = isSel ? '#ffffff' : `hsl(${hue},90%,65%)`;
        ctx.beginPath();
        ctx.arc(x, y, isSel || isHover ? 5.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (isSel) {
          const pulse = 8 + ((nowMs / 60) % 14);
          ctx.strokeStyle = `hsla(${hue},90%,70%,${1 - (pulse - 8) / 14})`;
          ctx.beginPath(); ctx.arc(x, y, pulse, 0, Math.PI * 2); ctx.stroke();
        }

        // Label only when relevant, avoids clutter with many satellites
        if (isSel || isHover || satsRef.current.length <= 12) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.font = '11px Inter, sans-serif';
          ctx.fillText(sat.id, x + 9, y - 9);
        }
      }

      // Hover tooltip
      const hov = satsRef.current.find((s) => s.id === hoverRef.current);
      const hp = hov && positions.get(hov.id);
      if (hov && hp) {
        const lines = [hov.id, `${hov.category} · ${hov.operator}`, `${hov.alt.toFixed(0)} km · ${hov.speed} km/s`];
        ctx.font = '11px Inter, sans-serif';
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
        const bx = Math.min(hp.x + 14, w - tw - 4);
        const by = Math.max(hp.y - 54, 4);
        ctx.fillStyle = 'rgba(10,12,20,0.92)';
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath(); ctx.roundRect(bx, by, tw, 48, 6); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#67e8f9'; ctx.fillText(lines[0], bx + 8, by + 15);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText(lines[1], bx + 8, by + 30);
        ctx.fillText(lines[2], bx + 8, by + 43);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  const nearest = (e: React.MouseEvent<HTMLCanvasElement>, radius: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    let best: SatelliteData | null = null, bestD = radius;
    for (const s of satsRef.current) {
      const p = positionsRef.current.get(s.id);
      if (!p) continue;
      const d = Math.hypot(cx - p.x, cy - p.y);
      if (d < bestD) { best = s; bestD = d; }
    }
    return best;
  };

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-[400px] rounded-lg cursor-crosshair"
      role="img"
      aria-label="Live satellite ground-track map"
      onMouseMove={(e) => {
        const s = nearest(e, 14);
        hoverRef.current = s?.id ?? null;
        e.currentTarget.style.cursor = s ? 'pointer' : 'crosshair';
      }}
      onMouseLeave={() => { hoverRef.current = null; }}
      onClick={(e) => { const s = nearest(e, 20); if (s) onSelect(s); }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

interface DashboardProps {
  onClose: () => void;
}

const MODES = ['Satellites', 'Global Detection', 'AI Analysis'] as const;
type Mode = (typeof MODES)[number];

export function Dashboard({ onClose }: DashboardProps) {
  const [selectedMode, setSelectedMode] = useState<Mode>('Satellites');
  const [paused, setPaused] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeCats, setActiveCats] = useState<Set<Category>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'id', dir: 1 });

  const now = useNow();
  const { satellites, initialLoading, refreshing, error, lastUpdated, refresh } = useSatelliteData(paused);

  // Close on Escape (unless the detail modal is open: it handles its own close)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selectedId) setSelectedId(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = satellites.filter(
      (s) =>
        (activeCats.size === 0 || activeCats.has(s.category)) &&
        (!q || [s.id, s.operator, s.purpose].some((f) => f.toLowerCase().includes(q))),
    );
    const { key, dir } = sort;
    return [...list].sort((a, b) => {
      const av = a[key], bv = b[key];
      return (typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))) * dir;
    });
  }, [satellites, query, activeCats, sort]);

  const selected = useMemo(
    () => satellites.find((s) => s.id === selectedId) ?? null,
    [satellites, selectedId], // stays in sync with every refresh
  );

  const earthSatellites = useMemo(
    () => visible.map((s) => ({
      name: s.id, lat: s.lat, lon: s.lon, alt: s.alt,
      color: `hsl(${CATEGORY_HUE[s.category]}, 90%, 60%)`,
    })),
    [visible],
  );

  const stats = useMemo(() => {
    if (!satellites.length) return null;
    const alts = satellites.map((s) => s.alt);
    return {
      count: satellites.length,
      avgAlt: Math.round(alts.reduce((a, b) => a + b, 0) / alts.length),
      highest: satellites.reduce((a, b) => (b.alt > a.alt ? b : a)),
      fastest: satellites.reduce((a, b) => (b.speed > a.speed ? b : a)),
    };
  }, [satellites]);

  const toggleCat = (c: Category) =>
    setActiveCats((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  const columns: { key: SortKey; label: string }[] = [
    { key: 'id', label: 'ID' },
    { key: 'alt', label: 'Altitude' },
    { key: 'aos', label: 'Next AOS' },
    { key: 'speed', label: 'Speed' },
    { key: 'azimuth', label: 'Azimuth' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black overflow-auto"
    >
      <SpaceBackground />

      <div className="min-h-screen p-6 relative z-10">
        {/* Top bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6 backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl px-6 py-4">
          <div className="flex items-center gap-4 text-white/60">
            <Clock className="w-4 h-4" />
            <span className="tabular-nums">
              {now.toISOString().split('T')[0]} {now.toISOString().split('T')[1].split('.')[0]} UTC
            </span>
            {initialLoading && (
              <span className="flex items-center gap-2 text-cyan-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading satellite data…
              </span>
            )}
            {!initialLoading && lastUpdated && (
              <span className="text-xs text-white/40">
                Updated {lastUpdated.toLocaleTimeString()}
                {refreshing && ' · refreshing…'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => setSelectedMode(mode)}
                className={`px-4 py-2 rounded-lg transition-all duration-300 ${
                  selectedMode === mode
                    ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-400/50'
                    : 'text-white/60 hover:text-white hover:bg-white/5'
                }`}
              >
                {mode}
              </button>
            ))}
            <button
              onClick={() => setPaused((p) => !p)}
              title={paused ? 'Resume live updates' : 'Pause live updates'}
              className="ml-2 p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-lg"
            >
              {paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
            </button>
            <button
              onClick={refresh}
              disabled={paused || refreshing}
              title="Refresh now"
              className="p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-lg disabled:opacity-40"
            >
              <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              aria-label="Close dashboard"
              className="p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-6 backdrop-blur-md bg-red-500/10 border border-red-400/30 rounded-2xl p-4">
            <div className="flex items-center gap-3 text-red-400">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <p className="flex-1">{error}</p>
              <button onClick={refresh} className="text-sm underline hover:text-red-300">Retry now</button>
            </div>
          </div>
        )}

        {selectedMode === 'Satellites' && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Stat strip */}
            {stats && (
              <div className="xl:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  ['Tracked', String(stats.count)],
                  ['Mean altitude', `${stats.avgAlt.toLocaleString()} km`],
                  ['Highest', `${stats.highest.id} · ${stats.highest.alt.toFixed(0)} km`],
                  ['Fastest', `${stats.fastest.id} · ${stats.fastest.speed} km/s`],
                ].map(([label, value]) => (
                  <div key={label} className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                    <div className="text-white/50 text-xs">{label}</div>
                    <div className="text-white truncate">{value}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Filters */}
            <div className="xl:col-span-3 backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-white/40 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, operator, purpose…"
                  className="pl-9 pr-3 py-2 w-72 rounded-lg bg-black/40 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-cyan-400/60"
                />
              </div>
              {CATEGORIES.map((c) => {
                const on = activeCats.has(c);
                return (
                  <button
                    key={c}
                    onClick={() => toggleCat(c)}
                    aria-pressed={on}
                    className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                      on ? 'text-white border-transparent' : 'text-white/60 border-white/15 hover:text-white'
                    }`}
                    style={on ? { background: `hsla(${CATEGORY_HUE[c]},70%,50%,0.35)` } : undefined}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-1.5"
                      style={{ background: `hsl(${CATEGORY_HUE[c]},90%,60%)` }}
                    />
                    {c}
                  </button>
                );
              })}
              <span className="ml-auto text-white/40 text-xs">{visible.length} / {satellites.length} shown</span>
            </div>

            {/* Map */}
            <div className="xl:col-span-2 backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white flex items-center gap-2">
                  <Globe2 className="w-5 h-5 text-cyan-400" /> Global Satellite Tracking Map
                </h3>
                {satellites.length > 0 && (
                  <span className={`text-sm ${paused ? 'text-yellow-400' : 'text-green-400 animate-pulse'}`}>
                    ● {paused ? 'Paused' : 'Live tracking'}
                  </span>
                )}
              </div>
              <LiveMap satellites={visible} selectedId={selectedId} onSelect={(s) => setSelectedId(s.id)} />
            </div>

            {/* 3D Earth */}
            <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white">Orbit Visualization</h3>
                <Radio className="w-5 h-5 text-pink-400" />
              </div>
              <div className="w-full h-[340px]">
                {satellites.length > 0 ? (
                  <RotatingEarth
                    satellites={earthSatellites}
                    width={340}
                    height={340}
                    onSatelliteClick={(c) => setSelectedId(c.name)}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                  </div>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="xl:col-span-3 backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
              <div className="px-6 py-4 border-b border-white/10">
                <h3 className="text-white flex items-center gap-2">
                  <Satellite className="w-5 h-5 text-cyan-400" /> Real-Time Satellite Data
                </h3>
              </div>
              <div className="overflow-x-auto">
                {initialLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                  </div>
                ) : visible.length === 0 ? (
                  <div className="py-12 text-center text-white/50 text-sm">No satellites match your filters.</div>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-white/10">
                        {columns.slice(0, 2).map((c) => (
                          <SortTh key={c.key} col={c} sort={sort} onSort={setSortKey} />
                        ))}
                        <th className="px-6 py-3 text-left text-white/60 text-sm">Coordinates</th>
                        {columns.slice(2).map((c) => (
                          <SortTh key={c.key} col={c} sort={sort} onSort={setSortKey} />
                        ))}
                        <th className="px-6 py-3 text-left text-white/60 text-sm">Next LOS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((sat) => (
                        <tr
                          key={sat.id}
                          tabIndex={0}
                          onClick={() => setSelectedId(sat.id)}
                          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSelectedId(sat.id)}
                          className={`border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer focus:outline-none focus:bg-white/10 ${
                            sat.id === selectedId ? 'bg-cyan-500/10' : ''
                          }`}
                        >
                          <td className="px-6 py-4 text-cyan-400">
                            <span
                              className="inline-block w-2 h-2 rounded-full mr-2"
                              style={{ background: `hsl(${CATEGORY_HUE[sat.category]},90%,60%)` }}
                            />
                            {sat.id}
                          </td>
                          <td className="px-6 py-4 text-white/80">{sat.alt.toFixed(0)} km</td>
                          <td className="px-6 py-4 text-white/80 tabular-nums">
                            {`${sat.lat.toFixed(2)}°, ${sat.lon.toFixed(2)}°`}
                          </td>
                          <td className="px-6 py-4 text-white/80 text-sm">{sat.aos}</td>
                          <td className="px-6 py-4 text-white/80">{sat.speed} km/s</td>
                          <td className="px-6 py-4 text-white/80">{sat.frequency}</td>
                          <td className="px-6 py-4 text-pink-400 text-sm">{sat.los}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {selectedMode === 'Global Detection' && (
          <div className="space-y-6">
            <GlobalDetectionMapEnhanced onNavigateToAIAnalysis={() => setSelectedMode('AI Analysis')} />
          </div>
        )}

        {selectedMode === 'AI Analysis' && <AIAnalysisEnhanced />}
      </div>

      <AnimatePresence>
        {selected && (
          <SatelliteDetailModal
            satellite={{
              id: selected.id,
              name: selected.id,
              lat: selected.lat,
              lon: selected.lon,
              alt: selected.alt,
              speed: selected.speed,
              operator: selected.operator,
              purpose: selected.purpose,
              band: selected.band,
              aos: selected.aos,
              los: selected.los,
              azimuth: selected.azimuth,
              distance: selected.distance,
            }}
            onClose={() => setSelectedId(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */

function SortTh({
  col, sort, onSort,
}: {
  col: { key: SortKey; label: string };
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
}) {
  const active = sort.key === col.key;
  return (
    <th
      className="px-6 py-3 text-left text-white/60 text-sm cursor-pointer select-none hover:text-white"
      onClick={() => onSort(col.key)}
      aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {col.label}
        {active && (sort.dir === 1 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </span>
    </th>
  );
}
