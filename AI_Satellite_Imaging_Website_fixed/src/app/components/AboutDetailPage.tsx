import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Satellite, Radio, Database, Zap, Globe2, TrendingUp, Activity, Wifi, Search,
  type LucideIcon,
} from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

/* ------------------------------------------------------------------ */
/* Theme (full class names so Tailwind can detect them at build time)  */
/* ------------------------------------------------------------------ */

type Color = 'cyan' | 'purple' | 'green' | 'orange';

const THEME: Record<Color, { bg: string; border: string; text: string; chipOn: string }> = {
  cyan:   { bg: 'from-cyan-500/20 to-blue-500/20',      border: 'border-cyan-400/30',   text: 'text-cyan-400',   chipOn: 'bg-cyan-500/25 border-cyan-400/60' },
  purple: { bg: 'from-purple-500/20 to-fuchsia-500/20', border: 'border-purple-400/30', text: 'text-purple-400', chipOn: 'bg-purple-500/25 border-purple-400/60' },
  green:  { bg: 'from-green-500/20 to-emerald-500/20',  border: 'border-green-400/30',  text: 'text-green-400',  chipOn: 'bg-green-500/25 border-green-400/60' },
  orange: { bg: 'from-orange-500/20 to-red-500/20',     border: 'border-orange-400/30', text: 'text-orange-400', chipOn: 'bg-orange-500/25 border-orange-400/60' },
};

/* ------------------------------------------------------------------ */
/* Data (module scope: not rebuilt on every render)                    */
/* ------------------------------------------------------------------ */

interface Band { name: string; range: string; bandwidth: string; usage: string; dataRate: string; applications: string[] }
interface Metric { name: string; rate: string; description: string; frequency: string }
interface Layer { layer: string; components: string[]; description: string }
interface Stat { metric: string; value: string; description: string }

type Section =
  | { id: string; title: string; icon: LucideIcon; color: Color; kind: 'bands'; items: Band[] }
  | { id: string; title: string; icon: LucideIcon; color: Color; kind: 'metrics'; items: Metric[] }
  | { id: string; title: string; icon: LucideIcon; color: Color; kind: 'architecture'; items: Layer[] }
  | { id: string; title: string; icon: LucideIcon; color: Color; kind: 'stats'; items: Stat[] };

const SECTIONS: Section[] = [
  {
    id: 'bandwidth', title: 'Satellite Bandwidth', icon: Radio, color: 'cyan', kind: 'bands',
    items: [
      { name: 'L-Band', range: '1–2 GHz', bandwidth: '1 GHz', usage: 'GPS, mobile satellite communications, and aircraft surveillance', dataRate: '50–200 Kbps', applications: ['Navigation systems', 'Emergency beacons', 'Maritime communications'] },
      { name: 'S-Band', range: '2–4 GHz', bandwidth: '2 GHz', usage: 'Weather radar, surface ship radar, and communications satellites', dataRate: '1–10 Mbps', applications: ['Weather monitoring', 'Satellite tracking', 'ISS communications'] },
      { name: 'C-Band', range: '4–8 GHz', bandwidth: '4 GHz', usage: 'Satellite communications and long-distance radio telecommunications', dataRate: '10–50 Mbps', applications: ['TV broadcasting', 'Satellite internet', 'Military communications'] },
      { name: 'X-Band', range: '8–12 GHz', bandwidth: '4 GHz', usage: 'Military satellite communications, radar, and space communications', dataRate: '50–300 Mbps', applications: ['Military radar', 'Deep space communications', 'Satellite imagery'] },
      { name: 'Ku-Band', range: '12–18 GHz', bandwidth: '6 GHz', usage: 'Satellite TV broadcasting and high-speed satellite internet', dataRate: '100–500 Mbps', applications: ['Direct broadcast satellite TV', 'VSAT networks', 'Satellite internet'] },
      { name: 'Ka-Band', range: '26–40 GHz', bandwidth: '14 GHz', usage: 'High-bandwidth satellite communications and next-gen internet', dataRate: '500+ Mbps to several Gbps', applications: ['5G satellite networks', 'High-speed internet', 'Earth observation'] },
    ],
  },
  {
    id: 'transmission', title: 'Data Transmission & Usage', icon: Database, color: 'purple', kind: 'metrics',
    items: [
      { name: 'Real-Time Telemetry', rate: '1–10 Mbps', description: 'Continuous streaming of satellite health data, position, velocity, and operational parameters', frequency: 'Every 1–5 seconds' },
      { name: 'Earth Observation Imagery', rate: '100–1000 Mbps', description: 'High-resolution satellite imagery for environmental monitoring, disaster response, and mapping', frequency: 'Multiple passes per day' },
      { name: 'Scientific Data Collection', rate: '50–500 Mbps', description: 'Climate data, atmospheric measurements, ocean temperatures, and space weather monitoring', frequency: 'Continuous or scheduled' },
      { name: 'Command & Control', rate: '10–100 Kbps', description: 'Ground station commands for satellite maneuvers, instrument activation, and configuration', frequency: 'On-demand' },
    ],
  },
  {
    id: 'architecture', title: 'Network Architecture', icon: Globe2, color: 'green', kind: 'architecture',
    items: [
      { layer: 'Space Segment', components: ['Satellites in orbit (LEO, MEO, GEO)', 'Inter-satellite links', 'Onboard processors'], description: 'The constellation of satellites providing global coverage with mesh networking capabilities' },
      { layer: 'Ground Segment', components: ['Ground stations', 'Mission control centers', 'Data processing facilities'], description: 'Worldwide network of ground stations for satellite tracking, telemetry, and command operations' },
      { layer: 'User Segment', components: ['Satellite terminals', 'Receiving antennas', 'End-user devices'], description: 'Equipment used by customers to access satellite services and receive data' },
    ],
  },
  {
    id: 'performance', title: 'Performance Metrics', icon: TrendingUp, color: 'orange', kind: 'stats',
    items: [
      { metric: 'Orbital Velocity', value: '7.8 km/s', description: 'Average speed of satellites in Low Earth Orbit' },
      { metric: 'Coverage Area', value: '≈ 2M km²', description: 'Ground coverage per satellite at any given time' },
      { metric: 'Latency (LEO)', value: '20–40 ms', description: 'Typical round-trip delay for Low Earth Orbit services' },
      { metric: 'Latency (GEO)', value: '≈ 600 ms', description: 'Typical round-trip delay for Geostationary services' },
      { metric: 'Signal Strength', value: '-80 to -120 dBm', description: 'Typical received signal power at ground stations' },
      { metric: 'Uptime', value: '99.9%+', description: 'Average satellite system availability' },
    ],
  },
];

// NOTE: placeholder figures: verify against a current source before shipping.
const OVERVIEW: { label: string; value: string; icon: LucideIcon; color: Color }[] = [
  { label: 'Active Satellites', value: '5,000+', icon: Satellite, color: 'cyan' },
  { label: 'Total Bandwidth', value: '1+ Tbps', icon: Zap, color: 'purple' },
  { label: 'Data Rate', value: '10 Gbps', icon: Activity, color: 'green' },
  { label: 'Global Coverage', value: '99%', icon: Wifi, color: 'orange' },
];

const ORBITS = [
  { name: 'Low Earth Orbit (LEO)', altitude: '160–2,000 km', note: 'Low latency • Global coverage', src: 'https://images.unsplash.com/photo-1446776653964-20c1d3a81b06', alt: 'Satellite in orbit' },
  { name: 'Geostationary Orbit (GEO)', altitude: '35,786 km', note: 'Fixed position • Weather & TV', src: 'https://images.unsplash.com/photo-1454789548928-9efd52dc4031', alt: 'Satellite communications' },
];

const C_KM_S = 299_792.458;

/* ------------------------------------------------------------------ */
/* Small components                                                    */
/* ------------------------------------------------------------------ */

const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-5 ${className}`}>{children}</div>
);

/** Physics-based minimum latency: user → satellite → gateway, satellite directly overhead. */
function LatencyCalculator() {
  const [alt, setAlt] = useState(550);
  const oneWayMs = (alt / C_KM_S) * 1000;
  const roundTripMs = oneWayMs * 4;
  const regime = alt < 2000 ? 'LEO' : alt < 35000 ? 'MEO' : 'GEO';
  const speed = Math.sqrt(398600.4418 / (6371 + alt));
  const period = (2 * Math.PI * Math.sqrt((6371 + alt) ** 3 / 398600.4418)) / 60;

  return (
    <div className="mt-6 backdrop-blur-md bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-400/30 rounded-2xl p-6">
      <h3 className="text-white text-xl mb-1">Orbit & Latency Calculator</h3>
      <p className="text-white/60 text-sm mb-5">Drag to see the physical minimum delay and orbital mechanics at any altitude.</p>
      <label htmlFor="alt" className="text-white/70 text-sm flex justify-between mb-2">
        <span>Altitude</span>
        <span className="text-cyan-400 tabular-nums">{alt.toLocaleString()} km · {regime}</span>
      </label>
      <input
        id="alt" type="range" min={160} max={36000} step={10} value={alt}
        onChange={(e) => setAlt(Number(e.target.value))}
        className="w-full accent-cyan-400"
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
        {[
          ['One-way delay', `${oneWayMs.toFixed(1)} ms`],
          ['Min. round trip', `${roundTripMs.toFixed(1)} ms`],
          ['Orbital speed', `${speed.toFixed(2)} km/s`],
          ['Orbital period', period < 180 ? `${period.toFixed(0)} min` : `${(period / 60).toFixed(1)} h`],
        ].map(([k, v]) => (
          <Card key={k} className="text-center">
            <div className="text-white/50 text-xs mb-1">{k}</div>
            <div className="text-white text-xl tabular-nums">{v}</div>
          </Card>
        ))}
      </div>
      <p className="text-white/40 text-xs mt-4">
        Speed-of-light propagation only, assuming a satellite directly overhead. Real services add processing, routing and slant-range delay.
      </p>
    </div>
  );
}

function SectionBody({ section, query }: { section: Section; query: string }) {
  const t = THEME[section.color];
  const match = (...f: string[]) => !query || f.some((x) => x.toLowerCase().includes(query));

  switch (section.kind) {
    case 'bands': {
      const items = section.items.filter((b) => match(b.name, b.usage, b.range, ...b.applications));
      return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map((b) => (
            <Card key={b.name}>
              <h4 className="text-white text-lg">{b.name} <span className="text-white/40 text-sm">({b.range})</span></h4>
              <div className={`${t.text} text-sm mb-3`}>Bandwidth: {b.bandwidth} • Data rate: {b.dataRate}</div>
              <p className="text-white/70 text-sm mb-3">{b.usage}</p>
              <div className="pt-3 border-t border-white/10">
                <div className="text-white/60 text-xs mb-2">Applications</div>
                <div className="flex flex-wrap gap-2">
                  {b.applications.map((a) => (
                    <span key={a} className="px-3 py-1 bg-white/10 border border-white/20 rounded-full text-white/80 text-xs">{a}</span>
                  ))}
                </div>
              </div>
            </Card>
          ))}
          {!items.length && <Empty />}
        </div>
      );
    }
    case 'metrics': {
      const items = section.items.filter((m) => match(m.name, m.description));
      return (
        <div className="space-y-4">
          {items.map((m) => (
            <Card key={m.name} className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h4 className="text-white text-lg">{m.name}</h4>
                <div className={`${t.text} mb-2`}>{m.rate}</div>
                <p className="text-white/70 text-sm">{m.description}</p>
              </div>
              <div className="text-right shrink-0">
                <div className="text-white/60 text-xs">Frequency</div>
                <div className="text-white text-sm">{m.frequency}</div>
              </div>
            </Card>
          ))}
          {!items.length && <Empty />}
        </div>
      );
    }
    case 'architecture': {
      const items = section.items.filter((a) => match(a.layer, a.description, ...a.components));
      return (
        <div className="space-y-4">
          {items.map((a, i) => (
            <Card key={a.layer}>
              <h4 className="text-white text-lg mb-2">
                <span className={`${t.text} mr-2 tabular-nums`}>0{i + 1}</span>{a.layer}
              </h4>
              <p className="text-white/70 text-sm mb-4">{a.description}</p>
              <div className="flex flex-wrap gap-2">
                {a.components.map((c) => (
                  <span key={c} className={`px-4 py-2 bg-white/10 border border-white/20 rounded-lg ${t.text} text-sm`}>{c}</span>
                ))}
              </div>
            </Card>
          ))}
          {!items.length && <Empty />}
        </div>
      );
    }
    case 'stats': {
      const items = section.items.filter((s) => match(s.metric, s.description, s.value));
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((s) => (
            <Card key={s.metric} className="text-center">
              <div className="text-white/60 text-xs mb-2">{s.metric}</div>
              <div className={`${t.text} text-3xl mb-2`}>{s.value}</div>
              <div className="text-white/60 text-xs">{s.description}</div>
            </Card>
          ))}
          {!items.length && <Empty />}
        </div>
      );
    }
  }
}

const Empty = () => <div className="col-span-full text-center text-white/40 text-sm py-6">No matches.</div>;

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

interface AboutDetailPageProps {
  onClose: () => void;
}

export function AboutDetailPage({ onClose }: AboutDetailPageProps) {
  const [active, setActive] = useState<string>('all');
  const [rawQuery, setRawQuery] = useState('');
  const query = rawQuery.trim().toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(
    () => (active === 'all' ? SECTIONS : SECTIONS.filter((s) => s.id === active)),
    [active],
  );

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black overflow-auto"
      role="dialog" aria-modal="true" aria-labelledby="about-title"
    >
      <div className="min-h-screen p-6 relative z-10">
        {/* Top bar */}
        <div className="flex items-center justify-between mb-6 backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl px-6 py-4">
          <div>
            <h2 id="about-title" className="text-white text-2xl mb-1">Satellite Technology Deep Dive</h2>
            <p className="text-white/60 text-sm">Bandwidth, usage, and network architecture details</p>
          </div>
          <button
            onClick={onClose} aria-label="Close"
            className="p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-all duration-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Overview */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          {OVERVIEW.map(({ label, value, icon: Icon, color }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
              className={`backdrop-blur-md bg-gradient-to-br ${THEME[color].bg} border ${THEME[color].border} rounded-2xl p-6`}
            >
              <Icon className={`w-8 h-8 ${THEME[color].text} mb-3`} />
              <div className="text-white/60 text-sm mb-1">{label}</div>
              <div className="text-white text-3xl">{value}</div>
            </motion.div>
          ))}
        </div>

        {/* Search + section tabs */}
        <div className="mb-6 backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-white/40 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={rawQuery} onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search bands, uses, components…"
              className="pl-9 pr-3 py-2 w-72 rounded-lg bg-black/40 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-cyan-400/60"
            />
          </div>
          {[{ id: 'all', title: 'All', color: 'cyan' as Color }, ...SECTIONS].map((s) => {
            const on = active === s.id;
            return (
              <button
                key={s.id} onClick={() => setActive(s.id)} aria-pressed={on}
                className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                  on ? `text-white ${THEME[s.color].chipOn}` : 'text-white/60 border-white/15 hover:text-white'
                }`}
              >
                {s.title}
              </button>
            );
          })}
        </div>

        {/* Sections */}
        <div className="space-y-6">
          <AnimatePresence mode="popLayout">
            {visible.map((section, i) => {
              const t = THEME[section.color];
              const Icon = section.icon;
              return (
                <motion.section
                  key={section.id} layout
                  initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }} transition={{ delay: i * 0.05 }}
                  className={`backdrop-blur-md bg-gradient-to-br ${t.bg} border ${t.border} rounded-2xl p-6`}
                >
                  <div className="flex items-center gap-3 mb-6">
                    <Icon className={`w-8 h-8 ${t.text}`} />
                    <h3 className="text-white text-2xl">{section.title}</h3>
                  </div>
                  <SectionBody section={section} query={query} />
                </motion.section>
              );
            })}
          </AnimatePresence>
        </div>

        <LatencyCalculator />

        {/* Orbit imagery */}
        <div className="mt-6 backdrop-blur-md bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-400/30 rounded-2xl p-6">
          <h3 className="text-white text-xl mb-4 flex items-center gap-2">
            <Satellite className="w-6 h-6 text-blue-400" /> Global Satellite Network Visualization
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {ORBITS.map((o) => (
              <figure key={o.name} className="rounded-xl overflow-hidden border border-white/20">
                <ImageWithFallback src={o.src} alt={o.alt} className="w-full h-64 object-cover" />
                <figcaption className="p-4 bg-white/5">
                  <div className="text-white mb-1">{o.name}</div>
                  <div className="text-white/60 text-sm">{o.altitude} altitude • {o.note}</div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
