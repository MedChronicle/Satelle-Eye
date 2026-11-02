import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Key, Database, Satellite, AlertCircle, Activity, CheckCircle, XCircle,
  Search, RefreshCw, ChevronDown, ShieldCheck, ShieldAlert,
} from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

/* ------------------------------------------------------------------ */
/* Types & data                                                        */
/* ------------------------------------------------------------------ */

type Status = 'active' | 'inactive' | 'limited';

interface APIInfo {
  name: string;
  /** Env var that holds the key. Keys are NEVER stored in source. Omit for public APIs. */
  keyEnvVar?: string;
  purpose: string;
  dataCollected: string[];
  bandwidth: string;
  rateLimit: string;
  status: Status;
  sampleImageUrl?: string;
  /** Optional CORS-friendly endpoint used for a live health check. */
  healthUrl?: string;
}

const APIS: APIInfo[] = [
  {
    name: 'NASA API',
    keyEnvVar: 'VITE_NASA_API_KEY',
    purpose: 'Primary data source for satellite tracking, asteroid detection, and environmental monitoring',
    dataCollected: [
      'Near-Earth Objects (NeoWs): asteroid data, trajectories, and close approach information',
      'EONET (Earth Observatory Natural Event Tracker): real-time natural disasters',
      'Satellite imagery and positioning data',
      'Space weather and solar activity',
    ],
    bandwidth: '1,000 requests/hour',
    rateLimit: 'Hourly: 1000 requests',
    status: 'active',
    sampleImageUrl: 'https://images.unsplash.com/photo-1446776653964-20c1d3a81b06?w=800&q=80',
  },
  {
    name: 'NASA EONET API',
    purpose: 'Earth Observatory Natural Event Tracker for real-time global natural disasters and phenomena',
    dataCollected: [
      'Real-time wildfires, volcanic eruptions, and severe storms',
      'Earthquakes, floods, landslides, and drought events',
      'Sea/lake ice changes and snow coverage',
      'Precise geographic coordinates (latitude/longitude) for all events',
      'Event magnitude, duration, and status (open/closed)',
      'Multi-source verification from NASA, USGS, NOAA, and other agencies',
      'Historical event tracking and temporal analysis',
    ],
    bandwidth: 'Unlimited: designed for public + research use',
    rateLimit: 'No rate limit',
    status: 'active',
    sampleImageUrl: 'https://images.unsplash.com/photo-1614730321146-b6fa6a46bcb4?w=800&q=80',
    healthUrl: 'https://eonet.gsfc.nasa.gov/api/v3/events?limit=1',
  },
  {
    name: 'OpenWeather API',
    keyEnvVar: 'VITE_OPENWEATHER_API_KEY',
    purpose: 'Comprehensive weather data including current conditions, forecasts, and historical weather',
    dataCollected: [
      'Real-time temperature, humidity, pressure, wind speed and direction',
      'Weather conditions, visibility, and cloud cover',
      'Sunrise and sunset times',
      'UV index and precipitation data',
      'Hourly and daily weather forecasts',
    ],
    bandwidth: '1,000 requests/day (Free tier)',
    rateLimit: '60 calls/minute',
    status: 'active',
    sampleImageUrl: 'https://images.unsplash.com/photo-1534088568595-a066f410bcda?w=800&q=80',
  },
  {
    name: 'WAQI (World Air Quality Index) API',
    keyEnvVar: 'VITE_WAQI_API_KEY',
    purpose: 'Real-time air quality monitoring with accurate US AQI measurements worldwide',
    dataCollected: [
      'US EPA standard Air Quality Index (AQI), 0-500 scale',
      'PM2.5 and PM10 particulate matter concentrations',
      'Ozone (O₃), Nitrogen Dioxide (NO₂), Sulfur Dioxide (SO₂)',
      'Carbon Monoxide (CO) levels',
      'Health recommendations based on US AQI standards',
      'Data from 30,000+ air quality monitoring stations globally',
    ],
    bandwidth: 'Unlimited for free tier',
    rateLimit: 'No hard limit for standard usage',
    status: 'active',
    sampleImageUrl: 'https://images.unsplash.com/photo-1611273426858-450d8e3c9fce?w=800&q=80',
  },
  {
    name: 'N2YO Satellite Tracking API',
    keyEnvVar: 'VITE_N2YO_API_KEY',
    purpose: 'Real-time satellite position tracking, orbital predictions, and radio pass calculations',
    dataCollected: [
      'Live satellite positions (latitude, longitude, altitude)',
      'Satellite velocity vectors and orbital parameters',
      'Acquisition of Signal (AOS) and Loss of Signal (LOS) times',
      'Visual and radio pass predictions',
      'Two-Line Element (TLE) data for orbital mechanics',
      'Azimuth, elevation, and range data for ground station tracking',
      'Real-time tracking for VO-96, HO-68, VO-52 amateur radio satellites',
    ],
    bandwidth: '1,000 requests/hour',
    rateLimit: 'Hourly: 1000 requests',
    status: 'active',
    sampleImageUrl: 'https://images.unsplash.com/photo-1446776877081-d282a0f896e2?w=800&q=80',
  },
  {
    name: 'IUCN Red List API',
    keyEnvVar: 'VITE_IUCN_API_KEY',
    purpose: 'Global biodiversity database providing comprehensive data on species conservation status worldwide',
    dataCollected: [
      'Species conservation status (Critically Endangered, Endangered, Vulnerable, etc.)',
      'Population trends and estimates for all assessed species',
      'Geographic distribution and habitat information by region/country',
      'Threat assessments (habitat loss, climate change, poaching, pollution)',
      'Conservation actions and protection measures',
      'Taxonomic classification and scientific names',
      'Country-specific biodiversity data and regional assessments',
      '157,000+ species assessments from global experts',
    ],
    bandwidth: '10,000 requests/day',
    rateLimit: 'No strict rate limit for research use',
    status: 'active',
    sampleImageUrl: 'https://images.unsplash.com/photo-1564760055775-d63b17a55c44?w=800&q=80',
  },
  {
    name: 'OpenStreetMap Nominatim',
    purpose: 'Geocoding service for location search and coordinate conversion',
    dataCollected: [
      'Location coordinates (latitude/longitude) from city names',
      'Reverse geocoding for coordinate-to-address conversion',
      'Country and administrative region data',
      'Place names and geographical boundaries',
    ],
    bandwidth: '1 request/second',
    rateLimit: 'Maximum 1 request per second',
    status: 'limited',
    sampleImageUrl: 'https://images.unsplash.com/photo-1524661135-423995f22d0b?w=800&q=80',
  },
];

const STATUS_STYLE: Record<Status, { text: string; Icon: typeof CheckCircle; label: string }> = {
  active: { text: 'text-green-400', Icon: CheckCircle, label: 'Active' },
  inactive: { text: 'text-red-400', Icon: XCircle, label: 'Inactive' },
  limited: { text: 'text-yellow-400', Icon: AlertCircle, label: 'Limited' },
};

/* ------------------------------------------------------------------ */
/* Helpers / hooks                                                     */
/* ------------------------------------------------------------------ */

/** True when the env var exists at build time. Never exposes the value. */
const hasKey = (envVar?: string) => {
  if (!envVar) return null; // public API, no key needed
  const env = (import.meta as any).env ?? {};
  return Boolean(env[envVar]);
};

interface Health { state: 'idle' | 'checking' | 'up' | 'down'; ms?: number }

/** Pings APIs that expose a public health URL and records latency. */
function useHealth(apis: APIInfo[]) {
  const [health, setHealth] = useState<Record<string, Health>>({});

  const check = useCallback(async () => {
    const targets = apis.filter((a) => a.healthUrl);
    setHealth((h) => Object.fromEntries([...Object.entries(h), ...targets.map((a) => [a.name, { state: 'checking' } as Health])]));
    await Promise.all(
      targets.map(async (a) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const t0 = performance.now();
        try {
          const res = await fetch(a.healthUrl!, { signal: ctrl.signal });
          const ms = Math.round(performance.now() - t0);
          setHealth((h) => ({ ...h, [a.name]: { state: res.ok ? 'up' : 'down', ms } }));
        } catch {
          setHealth((h) => ({ ...h, [a.name]: { state: 'down' } }));
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }, [apis]);

  useEffect(() => { check(); }, [check]);
  return { health, recheck: check };
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function APIDashboard() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const { health, recheck } = useHealth(APIS);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return APIS.filter(
      (a) =>
        (statusFilter === 'all' || a.status === statusFilter) &&
        (!q || [a.name, a.purpose, ...a.dataCollected].some((s) => s.toLowerCase().includes(q))),
    );
  }, [query, statusFilter]);

  const stats = useMemo(() => {
    const keyed = APIS.filter((a) => a.keyEnvVar);
    return {
      total: APIS.length,
      active: APIS.filter((a) => a.status === 'active').length,
      dataPoints: APIS.reduce((n, a) => n + a.dataCollected.length, 0),
      keysConfigured: keyed.filter((a) => hasKey(a.keyEnvVar)).length,
      keysTotal: keyed.length,
      live: Object.values(health).filter((h) => h.state === 'up').length,
      liveTotal: APIS.filter((a) => a.healthUrl).length,
    };
  }, [health]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="backdrop-blur-md bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-400/30 rounded-2xl p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <Key className="w-8 h-8 text-blue-400" />
            <div>
              <h3 className="text-white text-2xl">API Backend Dashboard</h3>
              <p className="text-white/60 text-sm">Data sources powering the Satell-Eye platform</p>
            </div>
          </div>
          <button
            onClick={recheck}
            className="flex items-center gap-2 px-3 py-2 text-sm text-white/70 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" /> Re-check
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          {[
            { label: 'Total APIs', value: stats.total, color: 'text-white' },
            { label: 'Active', value: stats.active, color: 'text-green-400' },
            { label: 'Data Points', value: stats.dataPoints, color: 'text-cyan-400' },
            { label: 'Keys Configured', value: `${stats.keysConfigured}/${stats.keysTotal}`, color: stats.keysConfigured === stats.keysTotal ? 'text-purple-400' : 'text-yellow-400' },
          ].map((s) => (
            <div key={s.label} className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4">
              <div className="text-white/60 text-sm mb-1">{s.label}</div>
              <div className={`${s.color} text-3xl tabular-nums`}>{s.value}</div>
            </div>
          ))}
        </div>
        <p className="text-white/40 text-xs mt-4">
          Live checks: {stats.live}/{stats.liveTotal} reachable (public endpoints only).
        </p>
      </div>

      {/* Filters */}
      <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="w-4 h-4 text-white/40 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search APIs or data collected…"
            className="pl-9 pr-3 py-2 w-72 rounded-lg bg-black/40 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-cyan-400/60"
          />
        </div>
        {(['all', 'active', 'limited', 'inactive'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
            className={`px-3 py-1.5 rounded-full text-xs border capitalize transition-colors ${
              statusFilter === s ? 'text-white bg-cyan-500/25 border-cyan-400/60' : 'text-white/60 border-white/15 hover:text-white'
            }`}
          >
            {s}
          </button>
        ))}
        <span className="ml-auto text-white/40 text-xs">{visible.length} / {APIS.length} shown</span>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {visible.map((api, index) => {
          const open = expanded === api.name;
          const { text, Icon, label } = STATUS_STYLE[api.status];
          const keyState = hasKey(api.keyEnvVar);
          const h = health[api.name];

          return (
            <motion.div
              key={api.name}
              layout
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.06 }}
              className="backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl hover:border-cyan-400/30 transition-colors duration-300"
            >
              <button
                type="button"
                onClick={() => setExpanded(open ? null : api.name)}
                aria-expanded={open}
                className="w-full text-left p-6 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
              >
                <div className="flex items-center gap-3 mb-2">
                  <Database className="w-6 h-6 text-cyan-400 shrink-0" />
                  <h4 className="text-white text-xl flex-1">{api.name}</h4>
                  <ChevronDown className={`w-5 h-5 text-cyan-400 transition-transform ${open ? 'rotate-180' : ''}`} />
                </div>
                <p className="text-white/60 text-sm mb-3">{api.purpose}</p>

                <div className="flex flex-wrap items-center gap-4 mb-4">
                  <span className={`flex items-center gap-2 text-sm ${text}`}>
                    <Icon className="w-5 h-5" /> {label}
                  </span>
                  {h && (
                    <span className={`flex items-center gap-1.5 text-xs ${h.state === 'up' ? 'text-green-400' : h.state === 'down' ? 'text-red-400' : 'text-white/50'}`}>
                      <Activity className={`w-4 h-4 ${h.state === 'checking' ? 'animate-pulse' : ''}`} />
                      {h.state === 'checking' ? 'Checking…' : h.state === 'up' ? `Live · ${h.ms} ms` : 'Unreachable'}
                    </span>
                  )}
                </div>

                {/* Key status (value is never shown) */}
                <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-xl p-3 mb-4 flex items-center gap-3">
                  {keyState === null ? (
                    <ShieldCheck className="w-5 h-5 text-white/60" />
                  ) : keyState ? (
                    <ShieldCheck className="w-5 h-5 text-green-400" />
                  ) : (
                    <ShieldAlert className="w-5 h-5 text-yellow-400" />
                  )}
                  <div className="min-w-0">
                    <div className="text-white/60 text-xs">API Key</div>
                    <div className="text-white/90 text-sm font-mono truncate">
                      {keyState === null ? 'Not required (public access)' : keyState ? `Configured via ${api.keyEnvVar}` : `Missing: set ${api.keyEnvVar}`}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-lg p-3">
                    <div className="text-white/60 text-xs mb-1">Bandwidth</div>
                    <div className="text-white text-sm">{api.bandwidth}</div>
                  </div>
                  <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-lg p-3">
                    <div className="text-white/60 text-xs mb-1">Rate Limit</div>
                    <div className="text-white text-sm">{api.rateLimit}</div>
                  </div>
                </div>
              </button>

              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-4 px-6 pb-6 pt-4 mx-0 border-t border-white/10">
                      <div>
                        <div className="text-white mb-2 flex items-center gap-2">
                          <Satellite className="w-4 h-4 text-purple-400" />
                          <span className="text-sm">Data Collected</span>
                        </div>
                        <ul className="space-y-2">
                          {api.dataCollected.map((d) => (
                            <li key={d} className="text-white/80 text-sm flex items-start gap-2">
                              <span className="text-cyan-400 mt-1">•</span>
                              <span>{d}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {api.sampleImageUrl && (
                        <figure>
                          <div className="rounded-xl overflow-hidden border border-white/20">
                            <ImageWithFallback src={api.sampleImageUrl} alt={`${api.name} sample data`} className="w-full h-48 object-cover" />
                          </div>
                          <figcaption className="text-white/40 text-xs mt-2">
                            Representative imagery showing the type of data collected from {api.name}
                          </figcaption>
                        </figure>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
        {!visible.length && (
          <div className="lg:col-span-2 text-center text-white/40 text-sm py-12">No APIs match your filters.</div>
        )}
      </div>
    </div>
  );
}
