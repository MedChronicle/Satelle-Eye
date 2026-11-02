import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Search, Loader2, AlertCircle, Brain, Zap, Activity, TrendingUp, Database,
  Leaf, Globe, TreePine, MapPin, X, Layers, Box, Cpu, Info, type LucideIcon,
} from 'lucide-react';
// Move GLOBAL_BIODIVERSITY_DATABASE and the BiodiversityData interface into this file and export them.
import { GLOBAL_BIODIVERSITY_DATABASE, type BiodiversityData } from './biodiversityData';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface AnalysisResult {
  location: string;
  coordinates: { lat: number; lon: number };
  confidence: number;
  landmarks: string[];
  environmentalData: Record<string, string>;
  recommendations: string[];
  aiModelData: {
    modelName: string; architecture: string; accuracy: number; processingTime: number;
    dataPoints: number; inputShape: string; outputShape: string; parameters: number;
  };
  modelLayers: { name: string; type: string; filters: number; size: string }[];
  deforestationAnalysis: { ndviDrop: number; deforestedArea: number; healthyVegetation: number; criticalZones: number };
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/** Set VITE_ANALYSIS_ENDPOINT to a server that accepts multipart `image` and returns AnalysisResult JSON. */
const ANALYSIS_ENDPOINT: string | undefined = (import.meta as any).env?.VITE_ANALYSIS_ENDPOINT;
const MAX_FILE_MB = 50;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff'];

const DEMO_STAGES: [string, number][] = [
  ['Loading image data…', 600],
  ['Preprocessing: cropping to 64×64 patches…', 500],
  ['Extracting spectral features…', 600],
  ['Encoder: Conv2D 32 → 64 filters…', 600],
  ['Bottleneck: 128 filters (latent space)…', 500],
  ['Decoder: upsampling with skip connections…', 600],
  ['Sigmoid output + NDVI change estimate…', 500],
  ['Generating report…', 400],
];

const CATEGORIES: Record<string, { label: string; cls: string; rank: number }> = {
  EX: { label: 'Extinct', cls: 'text-white bg-black/40 border-white/30', rank: 0 },
  EW: { label: 'Extinct in the Wild', cls: 'text-purple-400 bg-purple-500/20 border-purple-400/30', rank: 1 },
  CR: { label: 'Critically Endangered', cls: 'text-red-400 bg-red-500/20 border-red-400/30', rank: 2 },
  EN: { label: 'Endangered', cls: 'text-orange-400 bg-orange-500/20 border-orange-400/30', rank: 3 },
  VU: { label: 'Vulnerable', cls: 'text-yellow-400 bg-yellow-500/20 border-yellow-400/30', rank: 4 },
  NT: { label: 'Near Threatened', cls: 'text-lime-400 bg-lime-500/20 border-lime-400/30', rank: 5 },
  LC: { label: 'Least Concern', cls: 'text-green-400 bg-green-500/20 border-green-400/30', rank: 6 },
  DD: { label: 'Data Deficient', cls: 'text-gray-400 bg-gray-500/20 border-gray-400/30', rank: 7 },
};
const catInfo = (c: string) => CATEGORIES[c] ?? { label: c, cls: 'text-blue-400 bg-blue-500/20 border-blue-400/30', rank: 99 };

const COUNTRY_ALIASES: Record<string, string> = {
  'united states of america': 'united states', usa: 'united states', us: 'united states',
  'republic of india': 'india', 'people\'s republic of china': 'china',
};

// Snapshot figures: verify against the current IUCN Red List summary before relying on them.
const IUCN_SNAPSHOT = [
  { label: 'Critically Endangered', value: '9,251', cls: 'text-red-400' },
  { label: 'Endangered', value: '16,945', cls: 'text-orange-400' },
  { label: 'Vulnerable', value: '15,632', cls: 'text-yellow-400' },
  { label: 'Total Assessed', value: '157K+', cls: 'text-green-400' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

function buildDemoResult(): AnalysisResult {
  return {
    location: 'Amazon Rainforest, Brazil (sample)',
    coordinates: { lat: -3.4653, lon: -62.2159 },
    confidence: 0.947,
    landmarks: ['Rio Negro', 'Manaus', 'Amazon River Basin'],
    environmentalData: {
      landUse: 'Dense tropical rainforest with scattered clearings',
      vegetation: '85% dense canopy, 10% secondary growth, 5% cleared areas',
      waterBodies: 'Multiple tributaries and river systems detected',
      urbanDensity: 'Low: sparse settlements, <5% built-up area',
      deforestation: '18.3% deforestation detected over 8 years',
      naturalDisasters: 'Wildfire risk: medium. Flood risk: high',
    },
    recommendations: [
      'Reforestation programs in cleared areas (64.2 km² affected)',
      'Fire monitoring during the dry season (June–September)',
      'Protected conservation zones around biodiversity hotspots',
      'Continuous remote sensing with Sentinel-2 and Landsat-8',
    ],
    aiModelData: {
      modelName: 'ReLU U-Net', architecture: 'Encoder-Decoder with Skip Connections', accuracy: 94.8,
      processingTime: 3.1, dataPoints: 122847, inputShape: '(64, 64, 10)', outputShape: '(64, 64, 1)', parameters: 1947233,
    },
    modelLayers: [
      { name: 'Input', type: 'Input', filters: 10, size: '64×64' },
      { name: 'Conv2D-1', type: 'Convolution', filters: 32, size: '64×64' },
      { name: 'MaxPool-1', type: 'Pooling', filters: 32, size: '32×32' },
      { name: 'Conv2D-2', type: 'Convolution', filters: 64, size: '32×32' },
      { name: 'MaxPool-2', type: 'Pooling', filters: 64, size: '16×16' },
      { name: 'Bottleneck', type: 'Convolution', filters: 128, size: '16×16' },
      { name: 'UpSample-1', type: 'Upsampling', filters: 64, size: '32×32' },
      { name: 'UpSample-2', type: 'Upsampling', filters: 32, size: '64×64' },
      { name: 'Output', type: 'Sigmoid', filters: 1, size: '64×64' },
    ],
    deforestationAnalysis: { ndviDrop: 0.183, deforestedArea: 64.2, healthyVegetation: 78.5, criticalZones: 12 },
  };
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

function useImageAnalysis() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const select = useCallback((f: File | undefined | null) => {
    if (!f) return;
    if (!ACCEPTED.includes(f.type)) return setError('Unsupported file type. Use JPG, PNG, WebP or TIFF.');
    if (f.size > MAX_FILE_MB * 1024 * 1024) return setError(`File is larger than ${MAX_FILE_MB} MB.`);
    abortRef.current?.abort();
    setError(null); setResult(null); setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }, []);

  const analyze = useCallback(async () => {
    if (!file) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAnalyzing(true); setError(null); setResult(null);

    try {
      if (ANALYSIS_ENDPOINT) {
        setIsDemo(false); setProgress(null); setStage('Uploading image and running model…');
        const body = new FormData();
        body.append('image', file);
        const res = await fetch(ANALYSIS_ENDPOINT, { method: 'POST', body, signal: ctrl.signal });
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        setResult((await res.json()) as AnalysisResult);
      } else {
        setIsDemo(true);
        for (let i = 0; i < DEMO_STAGES.length; i++) {
          setStage(DEMO_STAGES[i][0]); setProgress(i / DEMO_STAGES.length);
          await sleep(DEMO_STAGES[i][1], ctrl.signal);
        }
        setResult(buildDemoResult());
      }
    } catch (e) {
      if (!isAbort(e)) setError(e instanceof Error ? `Analysis failed: ${e.message}` : 'Analysis failed.');
    } finally {
      if (abortRef.current === ctrl) { setAnalyzing(false); setStage(''); setProgress(null); }
    }
  }, [file]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { previewUrl, analyzing, stage, progress, result, isDemo, error, select, analyze, cancel };
}

interface BioResult { location: string; country: string; species: BiodiversityData[]; fallback: boolean }

function useBiodiversity() {
  const [data, setData] = useState<BioResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, { country: string; display: string }>());
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const search = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) return setError('Enter a country, city, or place name.');
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);

    try {
      let geo = cache.current.get(q.toLowerCase());
      if (!geo) {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1&accept-language=en`,
          { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error('Geocoding failed');
        const json = await res.json();
        if (!json?.length) { setData(null); return setError(`"${q}" not found. Try a country or major city.`); }
        const country: string = json[0].address?.country ?? '';
        if (!country) { setData(null); return setError(`Could not determine the country for "${q}".`); }
        geo = { country, display: json[0].display_name ?? q };
        cache.current.set(q.toLowerCase(), geo);
      }
      const norm = geo.country.toLowerCase();
      const key = COUNTRY_ALIASES[norm] ?? norm;
      const specific = GLOBAL_BIODIVERSITY_DATABASE[key];
      setData({
        location: geo.display, country: geo.country,
        species: specific ?? GLOBAL_BIODIVERSITY_DATABASE['default'], fallback: !specific,
      });
    } catch (e) {
      if (!isAbort(e)) setError('Could not look up that location. Check your connection and try again.');
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, []);

  return { data, loading, error, search, clear: () => { setData(null); setError(null); } };
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */

const Panel = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`backdrop-blur-xl bg-white/5 border border-white/10 rounded-3xl p-6 ${className}`}>{children}</div>
);

function Metric({ icon: Icon, label, value, sub, cls }: { icon: LucideIcon; label: string; value: string; sub?: string; cls: string }) {
  return (
    <div className={`backdrop-blur-xl border rounded-2xl p-5 ${cls}`}>
      <div className="flex items-center gap-2 text-sm mb-3"><Icon className="w-5 h-5" />{label}</div>
      <div className="text-white text-2xl font-light">{value}</div>
      {sub && <div className="text-white/60 text-xs mt-1">{sub}</div>}
    </div>
  );
}

const trendOf = (t: string) => {
  const s = t.toLowerCase();
  return s.includes('decreas') ? { icon: '↓', cls: 'text-red-400' }
    : s.includes('increas') ? { icon: '↑', cls: 'text-green-400' }
    : s.includes('stable') ? { icon: '→', cls: 'text-yellow-400' }
    : { icon: '?', cls: 'text-gray-400' };
};

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function AIAnalysisEnhanced() {
  const ai = useImageAnalysis();
  const bio = useBiodiversity();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sortBy, setSortBy] = useState<'severity' | 'name'>('severity');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Filtering/sorting is derived, so changing filters updates results immediately.
  const species = useMemo(() => {
    if (!bio.data) return [];
    const list = bio.data.species.filter((s) => category === 'all' || s.category === category);
    return [...list].sort((a, b) =>
      sortBy === 'name' ? a.species.localeCompare(b.species) : catInfo(a.category).rank - catInfo(b.category).rank);
  }, [bio.data, category, sortBy]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    bio.data?.species.forEach((s) => { m[s.category] = (m[s.category] ?? 0) + 1; });
    return m;
  }, [bio.data]);

  const r = ai.result;

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}
        className="backdrop-blur-xl bg-gradient-to-br from-purple-500/10 via-pink-500/10 to-blue-500/10 border border-purple-400/20 rounded-3xl p-8">
        <div className="flex flex-wrap items-center gap-4">
          <div className="p-4 bg-purple-500/20 rounded-2xl border border-purple-400/30"><Brain className="w-10 h-10 text-purple-400" /></div>
          <div className="flex-1 min-w-[16rem]">
            <h3 className="text-white text-3xl font-light">Satellite Image Analysis</h3>
            <p className="text-white/60 mt-1">U-Net deforestation segmentation • 64×64×10 input • NDVI change detection</p>
          </div>
          <div className={`px-5 py-3 rounded-2xl border flex items-center gap-3 ${ANALYSIS_ENDPOINT ? 'bg-green-500/15 border-green-400/30' : 'bg-yellow-500/15 border-yellow-400/30'}`}>
            <Cpu className={`w-6 h-6 ${ANALYSIS_ENDPOINT ? 'text-green-400' : 'text-yellow-400'}`} />
            <div className="text-sm font-mono text-white/90">{ANALYSIS_ENDPOINT ? 'MODEL ENDPOINT' : 'DEMO MODE'}</div>
          </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upload */}
        <Panel>
          <div className="flex items-center gap-3 mb-4"><Upload className="w-6 h-6 text-cyan-400" /><h4 className="text-white text-lg">Upload Satellite Image</h4></div>

          {!ANALYSIS_ENDPOINT && (
            <div className="mb-4 flex gap-3 rounded-xl border border-yellow-400/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Demo mode: no model is connected, so results are sample output and do not depend on your image. Set <code className="font-mono">VITE_ANALYSIS_ENDPOINT</code> to run a real model.</span>
            </div>
          )}

          <div
            role="button" tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); ai.select(e.dataTransfer.files[0]); }}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${
              dragging ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/20 hover:border-cyan-400/50 hover:bg-white/5'}`}
          >
            {ai.previewUrl ? (
              <div className="space-y-3">
                <img src={ai.previewUrl} alt="Selected satellite scene" className="w-full h-64 object-cover rounded-xl border border-white/20" />
                <span className="text-cyan-400 text-sm">Click or drop to change image</span>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="w-16 h-16 mx-auto rounded-2xl border border-cyan-400/30 bg-cyan-500/10 flex items-center justify-center"><Upload className="w-8 h-8 text-cyan-400" /></div>
                <p className="text-white">Drop an image here or click to browse</p>
                <p className="text-white/60 text-sm">JPG, PNG, WebP, TIFF • Max {MAX_FILE_MB} MB</p>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept={ACCEPTED.join(',')} className="hidden"
            onChange={(e) => { ai.select(e.target.files?.[0]); e.target.value = ''; }} />

          {ai.previewUrl && (
            <div className="mt-6 flex gap-3">
              <button onClick={ai.analyze} disabled={ai.analyzing}
                className="flex-1 px-6 py-4 bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-2xl hover:from-cyan-400 hover:to-blue-400 disabled:opacity-50 flex items-center justify-center gap-3 shadow-lg shadow-cyan-500/20">
                {ai.analyzing ? <><Loader2 className="w-5 h-5 animate-spin" />Analyzing…</> : <><Search className="w-5 h-5" />Analyze image</>}
              </button>
              {ai.analyzing && (
                <button onClick={ai.cancel} className="px-5 rounded-2xl border border-white/20 text-white/70 hover:text-white hover:bg-white/10">Cancel</button>
              )}
            </div>
          )}

          {ai.analyzing && (
            <div className="mt-4 rounded-2xl border border-purple-400/30 bg-purple-500/10 p-4" aria-live="polite">
              <p className="text-purple-300 text-sm font-mono mb-3">{ai.stage}</p>
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                {ai.progress === null
                  ? <div className="h-full w-1/3 bg-purple-400 rounded-full animate-pulse" />
                  : <div className="h-full bg-purple-400 rounded-full transition-all duration-500" style={{ width: `${ai.progress * 100}%` }} />}
              </div>
            </div>
          )}
          {ai.error && <p className="mt-4 text-red-300 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" />{ai.error}</p>}
        </Panel>

        {/* Biodiversity search */}
        <Panel>
          <div className="flex items-center gap-3 mb-6"><Globe className="w-6 h-6 text-green-400" /><h4 className="text-white text-lg">Biodiversity Explorer</h4></div>
          <div className="space-y-5">
            <div>
              <label htmlFor="bio-q" className="text-white/80 text-sm mb-2 flex items-center gap-2"><MapPin className="w-4 h-4 text-green-400" />Country, city, or place</label>
              <input id="bio-q" value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && bio.search(query)}
                placeholder="e.g., Brazil, Mumbai, Madagascar…"
                className="w-full px-5 py-4 bg-black/40 border border-white/20 rounded-2xl text-white placeholder-white/40 focus:outline-none focus:border-green-400/50" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select aria-label="Conservation status" value={category} onChange={(e) => setCategory(e.target.value)}
                className="px-4 py-3 bg-black/40 border border-white/20 rounded-2xl text-white focus:outline-none focus:border-green-400/50">
                <option value="all">All statuses</option>
                {['CR', 'EN', 'VU', 'NT', 'LC'].map((c) => <option key={c} value={c}>{catInfo(c).label} ({c})</option>)}
              </select>
              <select aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as 'severity' | 'name')}
                className="px-4 py-3 bg-black/40 border border-white/20 rounded-2xl text-white focus:outline-none focus:border-green-400/50">
                <option value="severity">Most threatened first</option>
                <option value="name">Name A–Z</option>
              </select>
            </div>
            <button onClick={() => bio.search(query)} disabled={bio.loading}
              className="w-full px-6 py-4 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-2xl hover:from-green-400 hover:to-emerald-400 disabled:opacity-50 flex items-center justify-center gap-3 shadow-lg shadow-green-500/20">
              {bio.loading ? <><Loader2 className="w-5 h-5 animate-spin" />Searching…</> : <><Leaf className="w-5 h-5" />Search biodiversity</>}
            </button>

            <div className="rounded-2xl border border-green-400/30 bg-green-500/10 p-5">
              <div className="text-green-400 text-sm mb-4">IUCN Red List snapshot</div>
              <div className="grid grid-cols-2 gap-3">
                {IUCN_SNAPSHOT.map((s) => (
                  <div key={s.label} className="rounded-xl bg-white/10 border border-white/10 p-3">
                    <div className="text-white/60 text-xs uppercase tracking-wider mb-1">{s.label}</div>
                    <div className={`${s.cls} text-xl font-light`}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>
            {bio.error && <p className="text-red-300 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" />{bio.error}</p>}
          </div>
        </Panel>
      </div>

      {/* Biodiversity results */}
      <AnimatePresence>
        {bio.data && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="backdrop-blur-xl bg-gradient-to-br from-green-500/10 to-teal-500/10 border border-green-400/20 rounded-3xl p-8">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-green-500/20 rounded-2xl border border-green-400/30"><TreePine className="w-7 h-7 text-green-400" /></div>
                <div>
                  <h4 className="text-white text-2xl font-light">Biodiversity report: {bio.data.country}</h4>
                  <p className="text-white/60 text-sm line-clamp-1">{bio.data.location}</p>
                </div>
              </div>
              <button onClick={bio.clear} aria-label="Clear results" className="p-2 hover:bg-white/10 rounded-lg"><X className="w-5 h-5 text-white/60" /></button>
            </div>

            <div className="mb-6 flex flex-wrap items-center gap-2">
              {Object.entries(counts).sort((a, b) => catInfo(a[0]).rank - catInfo(b[0]).rank).map(([c, n]) => (
                <button key={c} onClick={() => setCategory(category === c ? 'all' : c)}
                  className={`px-3 py-1.5 rounded-full text-xs border ${catInfo(c).cls} ${category === c ? 'ring-2 ring-white/50' : ''}`}>
                  {c} · {n}
                </button>
              ))}
              <span className="ml-auto text-white/40 text-xs">Curated sample dataset, not the full IUCN Red List</span>
            </div>

            {bio.data.fallback && (
              <div className="mb-6 rounded-xl border border-yellow-400/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">
                No country-specific entries for {bio.data.country}; showing globally significant species instead.
              </div>
            )}

            {species.length === 0 ? (
              <p className="text-center text-white/50 py-8">No {category === 'all' ? '' : catInfo(category).label.toLowerCase() + ' '}species in the dataset for this region.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {species.map((s, i) => {
                  const trend = trendOf(s.trendStatus);
                  return (
                    <motion.div key={`${s.scientificName}-${i}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
                      className="rounded-2xl border border-white/20 bg-white/10 p-6 hover:bg-white/15 transition-colors">
                      <div className="flex items-start justify-between gap-2 mb-4">
                        <div>
                          <h5 className="text-white">{s.species}</h5>
                          <p className="text-white/60 text-sm italic">{s.scientificName}</p>
                        </div>
                        <span className={`px-3 py-1 rounded-xl text-xs border shrink-0 ${catInfo(s.category).cls}`}>{s.category}</span>
                      </div>
                      <dl className="space-y-3 text-sm">
                        {[['Status', catInfo(s.category).label], ['Population', s.population], ['Habitat', s.habitat], ...(s.criteria ? [['IUCN criteria', s.criteria]] : [])].map(([k, v]) => (
                          <div key={k}><dt className="text-white/60 text-xs uppercase tracking-wider mb-0.5">{k}</dt><dd className="text-white">{v}</dd></div>
                        ))}
                        <div>
                          <dt className="text-white/60 text-xs uppercase tracking-wider mb-1">Main threats</dt>
                          <dd className="flex flex-wrap gap-2">
                            {s.threats.slice(0, 3).map((t) => <span key={t} className="px-2 py-1 bg-red-500/20 text-red-400 rounded-lg text-xs border border-red-400/30">{t}</span>)}
                          </dd>
                        </div>
                      </dl>
                      <div className="flex items-center justify-between pt-3 mt-3 border-t border-white/10">
                        <span className="text-white/60 text-xs uppercase tracking-wider">Trend</span>
                        <span className={`${trend.cls} text-sm`}><span className="text-lg mr-1">{trend.icon}</span>{s.trendStatus}</span>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Analysis results */}
      <AnimatePresence>
        {r && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="backdrop-blur-xl bg-gradient-to-br from-cyan-500/10 via-blue-500/10 to-purple-500/10 border border-cyan-400/20 rounded-3xl p-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-cyan-500/20 rounded-2xl border border-cyan-400/30"><TrendingUp className="w-7 h-7 text-cyan-400" /></div>
              <h4 className="text-white text-2xl font-light">Analysis results</h4>
            </div>
            {ai.isDemo && (
              <div className="mb-6 flex gap-3 rounded-xl border border-yellow-400/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">
                <Info className="w-4 h-4 shrink-0 mt-0.5" />Sample output. These numbers are placeholders and were not computed from your image.
              </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
              <Metric icon={Brain} label="Model" value={r.aiModelData.modelName} sub={r.aiModelData.architecture} cls="bg-purple-500/10 border-purple-400/30 text-purple-400" />
              <Metric icon={Activity} label="Validation acc." value={`${r.aiModelData.accuracy}%`} cls="bg-green-500/10 border-green-400/30 text-green-400" />
              <Metric icon={Zap} label="Time" value={`${r.aiModelData.processingTime.toFixed(2)}s`} cls="bg-cyan-500/10 border-cyan-400/30 text-cyan-400" />
              <Metric icon={Database} label="Data points" value={`${Math.round(r.aiModelData.dataPoints / 1000)}K`} cls="bg-orange-500/10 border-orange-400/30 text-orange-400" />
              <Metric icon={Box} label="Parameters" value={`${(r.aiModelData.parameters / 1e6).toFixed(2)}M`} cls="bg-pink-500/10 border-pink-400/30 text-pink-400" />
            </div>

            <div className="rounded-2xl border border-purple-400/30 bg-purple-500/10 p-6 mb-8">
              <div className="flex items-center gap-3 mb-5">
                <Layers className="w-6 h-6 text-purple-400" />
                <div><h5 className="text-white text-lg">Model architecture</h5>
                  <p className="text-white/60 text-sm">{r.aiModelData.inputShape} → {r.aiModelData.outputShape}</p></div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {r.modelLayers.map((l) => (
                  <div key={l.name} className="rounded-xl bg-white/10 border border-white/20 p-4">
                    <div className="flex justify-between mb-1"><span className="text-white text-sm">{l.name}</span>
                      <span className="px-2 py-0.5 bg-cyan-500/20 text-cyan-400 rounded text-xs border border-cyan-400/30">{l.size}</span></div>
                    <div className="text-white/60 text-xs">{l.type} • <span className="font-mono">{l.filters} filters</span></div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {[
                ['NDVI drop', `${(r.deforestationAnalysis.ndviDrop * 100).toFixed(1)}%`, 'bg-red-500/10 border-red-400/30 text-red-400'],
                ['Deforested area', `${r.deforestationAnalysis.deforestedArea} km²`, 'bg-orange-500/10 border-orange-400/30 text-orange-400'],
                ['Healthy vegetation', `${r.deforestationAnalysis.healthyVegetation}%`, 'bg-green-500/10 border-green-400/30 text-green-400'],
                ['Critical zones', String(r.deforestationAnalysis.criticalZones), 'bg-yellow-500/10 border-yellow-400/30 text-yellow-400'],
              ].map(([k, v, cls]) => (
                <div key={k} className={`rounded-2xl border p-5 ${cls}`}>
                  <div className="text-sm mb-2 uppercase tracking-wider">{k}</div>
                  <div className="text-white text-3xl font-light">{v}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="rounded-2xl border border-white/20 bg-white/10 p-6">
                <div className="text-white/60 text-sm mb-3 uppercase tracking-wider">Detected location</div>
                <div className="text-white text-2xl mb-2 font-light">{r.location}</div>
                <div className="text-cyan-400 text-sm mb-4 font-mono">
                  {Math.abs(r.coordinates.lat).toFixed(4)}°{r.coordinates.lat >= 0 ? 'N' : 'S'}, {Math.abs(r.coordinates.lon).toFixed(4)}°{r.coordinates.lon >= 0 ? 'E' : 'W'}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-white/60 text-sm">Confidence</span>
                  <div className="flex-1 h-3 rounded-full bg-white/10 overflow-hidden border border-white/20">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-green-400" style={{ width: `${r.confidence * 100}%` }} /></div>
                  <span className="text-white">{(r.confidence * 100).toFixed(1)}%</span>
                </div>
              </div>
              <div className="rounded-2xl border border-white/20 bg-white/10 p-6">
                <div className="text-white/60 text-sm mb-4 uppercase tracking-wider">Landmarks</div>
                <div className="flex flex-wrap gap-2">
                  {r.landmarks.map((l) => <span key={l} className="px-4 py-2 bg-cyan-500/20 text-cyan-400 rounded-xl text-sm border border-cyan-400/30">{l}</span>)}
                </div>
              </div>
              <div className="lg:col-span-2 rounded-2xl border border-white/20 bg-white/10 p-6">
                <div className="text-white/60 text-sm mb-4 uppercase tracking-wider">Environmental analysis</div>
                <dl className="space-y-4">
                  {Object.entries(r.environmentalData).map(([k, v]) => (
                    <div key={k} className="pb-4 border-b border-white/10 last:border-0">
                      <dt className="text-white/80 text-sm mb-1 capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</dt>
                      <dd className="text-white/90 text-sm">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="lg:col-span-2 rounded-2xl border border-orange-400/30 bg-gradient-to-br from-orange-500/20 to-red-500/20 p-6">
                <div className="flex items-center gap-3 mb-4"><AlertCircle className="w-6 h-6 text-orange-400" /><span className="text-white text-lg">Recommendations</span></div>
                <ul className="space-y-3">
                  {r.recommendations.map((rec) => (
                    <li key={rec} className="text-white/90 text-sm flex gap-3 p-3 bg-white/5 rounded-xl border border-white/10">
                      <span className="w-1.5 h-1.5 bg-orange-400 rounded-full mt-1.5 shrink-0" />{rec}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
