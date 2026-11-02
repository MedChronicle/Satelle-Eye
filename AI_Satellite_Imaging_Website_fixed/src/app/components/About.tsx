import { useCallback, useState } from 'react';
import { motion, useMotionTemplate, useMotionValue } from 'motion/react';
import { Rocket, Target, Eye, ChevronRight, type LucideIcon } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { SatelliteModal } from './SatelliteModal';

/* ------------------------------------------------------------------ */
/* Data (module scope, typed, single source of truth)                  */
/* ------------------------------------------------------------------ */

interface SatelliteInfo {
  id: string;
  name: string;
  type: string;
  orbit: string;
  altitude: string;
  speed: string;
  launched: string;
  mission: string;
  status: 'Active' | 'Inactive' | 'Decommissioned';
  operator: string;
  country: string;
  description: string;
}

type SatelliteKey = 'missionControl' | 'precisionTracking' | 'orbitalWatch';

// NOTE: StarLink-4A and NaviStar GPS-III Explorer look like illustrative names;
// replace with real designations if this is meant to be factual.
const SATELLITES: Record<SatelliteKey, SatelliteInfo> = {
  missionControl: {
    id: 'sat-001',
    name: 'StarLink-4A Mission Satellite',
    type: 'Communication Satellite',
    orbit: 'Low Earth Orbit (LEO)',
    altitude: '550 km',
    speed: '27,400 km/h',
    launched: 'March 15, 2024',
    mission: 'Global broadband internet coverage and next-generation space communication infrastructure',
    status: 'Active',
    operator: 'SpaceX',
    country: 'United States',
    description:
      'Advanced communication satellite equipped with phased-array antennas and laser inter-satellite links for high-speed data transmission. Part of the next-generation constellation providing global internet coverage with ultra-low latency.',
  },
  precisionTracking: {
    id: 'sat-003',
    name: 'NaviStar GPS-III Explorer',
    type: 'Navigation & Positioning',
    orbit: 'Medium Earth Orbit (MEO)',
    altitude: '20,200 km',
    speed: '14,000 km/h',
    launched: 'November 22, 2023',
    mission: 'Ultra-precise global positioning and navigation services with advanced anti-jamming capabilities',
    status: 'Active',
    operator: 'U.S. Space Force',
    country: 'United States',
    description:
      'Next-generation GPS satellite featuring atomic clock precision timing, enhanced signal strength, and improved accuracy. Provides sub-meter positioning accuracy for critical infrastructure, aviation, and scientific applications worldwide.',
  },
  orbitalWatch: {
    id: 'sat-002',
    name: 'Sentinel-2A Earth Observer',
    type: 'Earth Observation Satellite',
    orbit: 'Sun-Synchronous Orbit (SSO)',
    altitude: '786 km',
    speed: '26,800 km/h',
    launched: 'June 23, 2015',
    mission: 'High-resolution multispectral imaging for land monitoring, agriculture, forestry, and disaster response',
    status: 'Active',
    operator: 'ESA (European Space Agency)',
    country: 'European Union',
    description:
      'Sentinel-2A delivers 10-meter resolution optical imagery across 13 spectral bands, covering the full Earth every 10 days. Its data powers AI-driven environmental monitoring: detecting deforestation, wildfires, flood extent, and urban growth in near real-time.',
  },
};

interface Feature {
  key: SatelliteKey;
  icon: LucideIcon;
  /** i18n keys, with English fallbacks for anything not yet translated */
  titleKey: string;
  descKey: string;
  fallbackTitle: string;
  fallbackDesc: string;
}

const FEATURES: Feature[] = [
  {
    key: 'missionControl', icon: Rocket,
    titleKey: 'about.feature1.title', descKey: 'about.feature1.desc',
    fallbackTitle: 'Mission Control', fallbackDesc: 'Global satellite communication and mission operations.',
  },
  {
    key: 'precisionTracking', icon: Target,
    titleKey: 'about.feature3.title', descKey: 'about.feature3.desc',
    fallbackTitle: 'Precision Tracking', fallbackDesc: 'High-accuracy positioning and navigation services.',
  },
  {
    key: 'orbitalWatch', icon: Eye,
    titleKey: 'about.feature4.title', descKey: 'about.feature4.desc',
    fallbackTitle: 'Orbital Watch',
    fallbackDesc:
      '24/7 planetary surveillance using high-resolution multispectral imaging satellites for real-time environmental threat detection.',
  },
];

/* ------------------------------------------------------------------ */
/* Card with cursor-following spotlight                                */
/* ------------------------------------------------------------------ */

interface CardProps {
  feature: Feature;
  title: string;
  desc: string;
  sat: SatelliteInfo;
  index: number;
  onOpen: (key: SatelliteKey) => void;
  detailsLabel: string;
}

function FeatureCard({ feature, title, desc, sat, index, onOpen, detailsLabel }: CardProps) {
  const Icon = feature.icon;
  const mx = useMotionValue(-200);
  const my = useMotionValue(-200);
  const spotlight = useMotionTemplate`radial-gradient(260px circle at ${mx}px ${my}px, rgba(34,211,238,0.14), transparent 70%)`;

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, delay: index * 0.1 }}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.985 }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        mx.set(e.clientX - r.left);
        my.set(e.clientY - r.top);
      }}
      onClick={() => onOpen(feature.key)}
      aria-haspopup="dialog"
      className="relative overflow-hidden text-left backdrop-blur-md bg-white/5 border border-white/10 rounded-2xl p-6 hover:border-cyan-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 transition-colors duration-300 group cursor-pointer"
    >
      <motion.div aria-hidden className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: spotlight }} />

      <div className="relative">
        <div className="w-12 h-12 bg-cyan-500/10 border border-cyan-500/20 rounded-xl flex items-center justify-center mb-4 group-hover:bg-cyan-500/20 group-hover:scale-110 transition-all duration-300">
          <Icon className="w-6 h-6 text-cyan-400" />
        </div>

        <h3 className="text-white mb-2">{title}</h3>
        <p className="text-white/60 text-sm mb-4">{desc}</p>

        {/* Live preview of the linked satellite */}
        <div className="flex flex-wrap gap-2 mb-4">
          <span className="px-2.5 py-1 rounded-full text-xs bg-white/5 border border-white/10 text-white/70">
            {sat.orbit.match(/\(([^)]+)\)/)?.[1] ?? sat.orbit}
          </span>
          <span className="px-2.5 py-1 rounded-full text-xs bg-white/5 border border-white/10 text-white/70">{sat.altitude}</span>
          <span className="px-2.5 py-1 rounded-full text-xs bg-green-500/10 border border-green-400/30 text-green-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 animate-pulse" />
            {sat.status}
          </span>
        </div>

        <div className="flex items-center gap-1 text-cyan-400 text-sm opacity-60 group-hover:opacity-100 transition-opacity duration-300">
          <span>{detailsLabel}</span>
          <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
        </div>
      </div>
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function About() {
  const { t } = useLanguage();
  // Store only the key; the modal's open state is derived from it.
  const [selectedKey, setSelectedKey] = useState<SatelliteKey | null>(null);
  // Keep the last satellite so the modal's exit animation still has content.
  const [lastKey, setLastKey] = useState<SatelliteKey | null>(null);

  const open = useCallback((key: SatelliteKey) => { setSelectedKey(key); setLastKey(key); }, []);
  const close = useCallback(() => setSelectedKey(null), []);

  /** Translate with an English fallback when the key is missing (t usually echoes the key). */
  const tr = (key: string, fallback: string) => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  return (
    <>
      <section className="relative py-32 px-8" id="about" aria-labelledby="about-heading">
        <div className="max-w-[1400px] mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-500/10 border border-cyan-500/20 rounded-full mb-6">
              <Rocket className="w-4 h-4 text-cyan-400" />
              <span className="text-cyan-400 text-sm">{t('about.badge')}</span>
            </div>
            <h2 id="about-heading" className="text-white mb-6">{t('about.title')}</h2>
            <p className="text-white/70 max-w-3xl mx-auto text-lg">{t('about.description')}</p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {FEATURES.map((f, i) => (
              <FeatureCard
                key={f.key}
                feature={f}
                index={i}
                sat={SATELLITES[f.key]}
                title={tr(f.titleKey, f.fallbackTitle)}
                desc={tr(f.descKey, f.fallbackDesc)}
                detailsLabel={tr('about.viewDetails', 'View Details')}
                onOpen={open}
              />
            ))}
          </div>
        </div>
      </section>

      <SatelliteModal
        isOpen={selectedKey !== null}
        onClose={close}
        satellite={lastKey ? SATELLITES[lastKey] : null}
      />
    </>
  );
}
