export type Severity = 'Low' | 'Medium' | 'High' | 'Critical';
export type Timeframe = 'Next Day' | 'Next Week' | 'Next Month' | 'Next Year' | 'Next 10 Years';

export interface WeatherSnapshot {
  temp: number;
  humidity: number;
  pressure: number;
  windSpeed: number;
  condition: string;
  description: string;
  estimated: boolean;
}

export interface SeismicContext {
  count: number;
  maxMagnitude: number;
  nearestKm: number | null;
}

export interface DisasterPrediction {
  id: string;
  location: string;
  coordinates: { lat: number; lon: number };
  disasterType: string;
  severity: Severity;
  confidence: number;
  timeframe: Timeframe;
  description: string;
  impactArea: number;
  affectedPopulation: number;
  recommendations: string[];
  riskFactors: string[];
  predictedDate: string;
  currentWeatherData?: WeatherSnapshot;
  seismicContext?: SeismicContext;
  source?: 'gemini' | 'heuristic';
}

export interface PredictionResponse {
  predictions: DisasterPrediction[];
  globalRiskLevel: string;
  totalPredictions: number;
  lastUpdated: Date;
  dataSource: string;
  warnings?: string[];
  isFallback?: boolean;
}

export interface PredictionOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

interface TrackedLocation {
  name: string;
  lat: number;
  lon: number;
  region: string;
  hazards: string[];
}

const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
const GEMINI_PROXY_URL = (import.meta.env.VITE_GEMINI_PROXY_URL as string | undefined) ?? '';
const GEMINI_MODEL = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';

const REQUEST_TIMEOUT_MS = 12000;
const AI_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
const CHUNK_SIZE = 5;
const RESULT_TTL_MS = 10 * 60 * 1000;
const WEATHER_TTL_MS = 15 * 60 * 1000;
const SEISMIC_TTL_MS = 5 * 60 * 1000;
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const SEISMIC_RADIUS_KM = 500;

const ALL_TIMEFRAMES: Timeframe[] = ['Next Day', 'Next Week', 'Next Month', 'Next Year', 'Next 10 Years'];
const SEVERITIES: Severity[] = ['Low', 'Medium', 'High', 'Critical'];
const SEVERITY_RANK: Record<Severity, number> = { Low: 1, Medium: 2, High: 3, Critical: 4 };
const DISASTER_TYPES = ['Wildfire', 'Flood', 'Earthquake', 'Hurricane', 'Drought', 'Tsunami', 'Volcano'];

const TIMEFRAME_DAYS: Record<Timeframe, number> = {
  'Next Day': 1,
  'Next Week': 4,
  'Next Month': 20,
  'Next Year': 180,
  'Next 10 Years': 1825,
};

const CONFIDENCE_CAP: Record<Timeframe, number> = {
  'Next Day': 90,
  'Next Week': 80,
  'Next Month': 70,
  'Next Year': 55,
  'Next 10 Years': 40,
};

const BASE_CONFIDENCE: Record<Timeframe, number> = {
  'Next Day': 70,
  'Next Week': 62,
  'Next Month': 52,
  'Next Year': 42,
  'Next 10 Years': 30,
};

const KEY_LOCATIONS: TrackedLocation[] = [
  { name: 'Pacific Ring of Fire (Japan)', lat: 35.6762, lon: 139.6503, region: 'Japan', hazards: ['Earthquake', 'Tsunami', 'Volcano'] },
  { name: 'California, USA', lat: 36.7783, lon: -119.4179, region: 'North America', hazards: ['Wildfire', 'Earthquake', 'Drought'] },
  { name: 'Amazon Rainforest, Brazil', lat: -3.4653, lon: -62.2159, region: 'South America', hazards: ['Wildfire', 'Flood', 'Drought'] },
  { name: 'Sahel Region, Africa', lat: 15.0, lon: 10.0, region: 'Africa', hazards: ['Drought', 'Flood'] },
  { name: 'Ganges Delta, Bangladesh', lat: 23.685, lon: 90.3563, region: 'South Asia', hazards: ['Flood', 'Hurricane'] },
  { name: 'Mediterranean Coast', lat: 37.9838, lon: 23.7275, region: 'Europe', hazards: ['Wildfire', 'Earthquake', 'Drought'] },
  { name: 'Indonesia Archipelago', lat: -6.2088, lon: 106.8456, region: 'Southeast Asia', hazards: ['Volcano', 'Earthquake', 'Tsunami', 'Flood'] },
  { name: 'Caribbean Islands', lat: 18.2208, lon: -66.5901, region: 'Caribbean', hazards: ['Hurricane', 'Flood', 'Earthquake'] },
  { name: 'Australian Outback', lat: -25.2744, lon: 133.7751, region: 'Australia', hazards: ['Wildfire', 'Drought'] },
  { name: 'Himalayan Range', lat: 28.3949, lon: 84.124, region: 'Central Asia', hazards: ['Earthquake', 'Flood'] },
];

const GENERIC_HAZARDS = ['Earthquake', 'Flood', 'Wildfire', 'Hurricane', 'Drought'];

const resultCache = new Map<string, { value: PredictionResponse; expires: number }>();
const inflight = new Map<string, Promise<PredictionResponse>>();
const weatherCache = new Map<string, { value: WeatherSnapshot; expires: number }>();
const geocodeCache = new Map<string, { value: TrackedLocation | null; expires: number }>();
let seismicCache: { value: Array<{ lat: number; lon: number; mag: number }>; expires: number } | null = null;

export function clearPredictionCache() {
  resultCache.clear();
  inflight.clear();
  weatherCache.clear();
  geocodeCache.clear();
  seismicCache = null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Prediction aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Prediction aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

async function timedFetch(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new Error('Prediction aborted');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`Request timed out after ${timeoutMs}ms`);
    if (signal?.aborted) throw new Error('Prediction aborted');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function describeWeatherCode(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 99) return 'Thunderstorm';
  return 'Unknown';
}

function estimateWeather(lat: number): WeatherSnapshot {
  return {
    temp: Math.round(27 - (Math.abs(lat) / 90) * 35),
    humidity: 60,
    pressure: 1013,
    windSpeed: 4,
    condition: 'Unknown',
    description: 'Live data unavailable, climatological estimate',
    estimated: true,
  };
}

async function getWeatherData(lat: number, lon: number, signal?: AbortSignal): Promise<WeatherSnapshot> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = weatherCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  try {
    const url = `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,weather_code&wind_speed_unit=ms`;
    const response = await timedFetch(url, { headers: { Accept: 'application/json' } }, REQUEST_TIMEOUT_MS, signal);
    if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
    const json = await response.json();
    const current = json?.current;
    if (!current) throw new Error('Weather payload missing');
    const condition = describeWeatherCode(Number(current.weather_code));
    const value: WeatherSnapshot = {
      temp: Math.round(Number(current.temperature_2m)),
      humidity: Math.round(Number(current.relative_humidity_2m)),
      pressure: Math.round(Number(current.pressure_msl)),
      windSpeed: Math.round(Number(current.wind_speed_10m) * 10) / 10,
      condition,
      description: condition.toLowerCase(),
      estimated: false,
    };
    weatherCache.set(key, { value, expires: Date.now() + WEATHER_TTL_MS });
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'Prediction aborted') throw error;
    return estimateWeather(lat);
  }
}

async function loadSeismicFeed(signal?: AbortSignal) {
  if (seismicCache && seismicCache.expires > Date.now()) return seismicCache.value;
  const response = await timedFetch(USGS_FEED, {}, REQUEST_TIMEOUT_MS, signal);
  if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
  const json = await response.json();
  const events: Array<{ lat: number; lon: number; mag: number }> = [];
  for (const feature of Array.isArray(json?.features) ? json.features : []) {
    const coords = feature?.geometry?.coordinates;
    const mag = Number(feature?.properties?.mag);
    if (!Array.isArray(coords) || !Number.isFinite(mag)) continue;
    events.push({ lon: coords[0], lat: coords[1], mag });
  }
  seismicCache = { value: events, expires: Date.now() + SEISMIC_TTL_MS };
  return events;
}

function seismicNear(events: Array<{ lat: number; lon: number; mag: number }>, lat: number, lon: number): SeismicContext {
  let count = 0;
  let maxMagnitude = 0;
  let nearestKm: number | null = null;
  for (const event of events) {
    const distance = haversineKm(lat, lon, event.lat, event.lon);
    if (distance > SEISMIC_RADIUS_KM) continue;
    count++;
    maxMagnitude = Math.max(maxMagnitude, event.mag);
    nearestKm = nearestKm === null ? distance : Math.min(nearestKm, distance);
  }
  return { count, maxMagnitude, nearestKm: nearestKm === null ? null : Math.round(nearestKm) };
}

async function resolveLocations(searchQuery: string | undefined, signal?: AbortSignal): Promise<TrackedLocation[]> {
  const query = searchQuery?.trim();
  if (!query) return KEY_LOCATIONS;

  const lower = query.toLowerCase();
  const known = KEY_LOCATIONS.filter(
    (loc) => loc.name.toLowerCase().includes(lower) || loc.region.toLowerCase().includes(lower)
  );
  if (known.length) return known;

  const cached = geocodeCache.get(lower);
  if (cached && cached.expires > Date.now()) {
    if (!cached.value) throw new Error(`Could not find a location matching "${query}"`);
    return [cached.value];
  }

  const response = await timedFetch(
    `${NOMINATIM_SEARCH}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
    { headers: { Accept: 'application/json' } },
    REQUEST_TIMEOUT_MS,
    signal
  );
  if (!response.ok) throw new Error(`Geocoding failed with HTTP ${response.status}`);
  const results = await response.json();
  const first = Array.isArray(results) ? results[0] : null;
  if (!first) {
    geocodeCache.set(lower, { value: null, expires: Date.now() + GEOCODE_TTL_MS });
    throw new Error(`Could not find a location matching "${query}"`);
  }
  const value: TrackedLocation = {
    name: String(first.display_name ?? query).split(',').slice(0, 3).join(',').trim(),
    lat: Number(first.lat),
    lon: Number(first.lon),
    region: 'Custom',
    hazards: GENERIC_HAZARDS,
  };
  geocodeCache.set(lower, { value, expires: Date.now() + GEOCODE_TTL_MS });
  return [value];
}

function normalizeTimeframes(filter?: string): Timeframe[] {
  if (!filter) return ALL_TIMEFRAMES;
  const wanted = filter
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const matched = ALL_TIMEFRAMES.filter((tf) => wanted.includes(tf.toLowerCase()));
  return matched.length ? matched : ALL_TIMEFRAMES;
}

function predictedDateFor(timeframe: Timeframe): string {
  return new Date(Date.now() + TIMEFRAME_DAYS[timeframe] * 86400000).toISOString();
}

function geminiSchema() {
  return {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        location: { type: 'STRING' },
        disasterType: { type: 'STRING', enum: DISASTER_TYPES },
        severity: { type: 'STRING', enum: SEVERITIES },
        confidence: { type: 'NUMBER' },
        timeframe: { type: 'STRING', enum: ALL_TIMEFRAMES },
        description: { type: 'STRING' },
        impactArea: { type: 'NUMBER' },
        affectedPopulation: { type: 'NUMBER' },
        recommendations: { type: 'ARRAY', items: { type: 'STRING' } },
        riskFactors: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: [
        'location',
        'disasterType',
        'severity',
        'confidence',
        'timeframe',
        'description',
        'impactArea',
        'affectedPopulation',
        'recommendations',
        'riskFactors',
      ],
    },
  };
}

async function callGeminiAPI(prompt: string, signal?: AbortSignal): Promise<string> {
  if (!GEMINI_PROXY_URL && !GEMINI_API_KEY) {
    throw new Error('Set VITE_GEMINI_PROXY_URL or VITE_GEMINI_API_KEY');
  }

  const url = GEMINI_PROXY_URL || `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!GEMINI_PROXY_URL) headers['x-goog-api-key'] = GEMINI_API_KEY;

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: geminiSchema(),
    },
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await timedFetch(url, { method: 'POST', headers, body }, AI_TIMEOUT_MS, signal);
      if (!response.ok) {
        let message = `Status ${response.status}`;
        try {
          const errorBody = await response.json();
          message = errorBody?.error?.message ?? JSON.stringify(errorBody);
        } catch {
          message = response.statusText || message;
        }
        const error = new Error(`Gemini API Error: ${message}`);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw Object.assign(error, { fatal: true });
        throw error;
      }
      const data = await response.json();
      const parts = data?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
      if (!text) throw new Error('Invalid Gemini API response format');
      return text;
    } catch (error) {
      lastError = error;
      if ((error as any)?.fatal || (error instanceof Error && error.message === 'Prediction aborted')) throw error;
      if (attempt < MAX_RETRIES) await sleep(Math.min(4000, 500 * 2 ** attempt) + Math.random() * 250, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Gemini request failed');
}

function parsePredictionJson(raw: string): any[] {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('No JSON array found in Gemini response');
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (!Array.isArray(parsed)) throw new Error('Gemini response was not an array');
  return parsed;
}

function buildPrompt(
  locations: TrackedLocation[],
  weather: WeatherSnapshot[],
  seismic: Array<SeismicContext | null>,
  timeframes: Timeframe[]
): string {
  const lines = locations.map((loc, i) => {
    const w = weather[i];
    const s = seismic[i];
    const seismicText = s
      ? `${s.count} quakes M4.5+ in last 7 days within ${SEISMIC_RADIUS_KM} km (max M${s.maxMagnitude.toFixed(1)}${s.nearestKm !== null ? `, nearest ${s.nearestKm} km` : ''})`
      : 'seismic data unavailable';
    const weatherText = w.estimated
      ? 'live weather unavailable'
      : `${w.temp}C, humidity ${w.humidity}%, pressure ${w.pressure} hPa, wind ${w.windSpeed} m/s, ${w.description}`;
    return `- ${loc.name} (${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}), known hazards: ${loc.hazards.join(', ')}; weather: ${weatherText}; seismic: ${seismicText}`;
  });

  return `You are a hazard-risk analyst producing probabilistic risk outlooks, not deterministic forecasts.

Locations and live context:
${lines.join('\n')}

Allowed timeframes: ${timeframes.join(', ')}.

Rules:
- Produce 1 to 3 entries per location, using the exact location name given.
- Choose hazards that are physically plausible for the location and season; prefer the known hazards listed.
- Use live weather and seismic context where relevant, and do not invent events that are not supported by it.
- Confidence must reflect real predictability: short-range weather hazards can be higher, earthquakes and volcanoes cannot be predicted for a specific day, so keep their confidence low.
- Long timeframes must have lower confidence than short ones.
- description: 2 to 3 sentences of grounded analysis.
- recommendations: 3 concrete actions. riskFactors: 3 specific factors.
- impactArea in square kilometres and affectedPopulation as realistic estimates.`;
}

function sanitizePrediction(
  raw: any,
  location: TrackedLocation,
  weather: WeatherSnapshot,
  seismic: SeismicContext | null,
  allowed: Timeframe[],
  index: number
): DisasterPrediction | null {
  const timeframe = ALL_TIMEFRAMES.find((tf) => tf.toLowerCase() === String(raw?.timeframe ?? '').trim().toLowerCase());
  if (!timeframe || !allowed.includes(timeframe)) return null;

  const severity = SEVERITIES.find((s) => s.toLowerCase() === String(raw?.severity ?? '').trim().toLowerCase());
  if (!severity) return null;

  const disasterType =
    DISASTER_TYPES.find((d) => d.toLowerCase() === String(raw?.disasterType ?? '').trim().toLowerCase()) ??
    String(raw?.disasterType ?? '').trim();
  if (!disasterType) return null;

  const confidenceRaw = Number(raw?.confidence);
  const confidence = Math.round(clamp(Number.isFinite(confidenceRaw) ? confidenceRaw : BASE_CONFIDENCE[timeframe], 5, CONFIDENCE_CAP[timeframe]));

  const list = (value: unknown, max: number) =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()).slice(0, max)
      : [];

  return {
    id: `PRED-AI-${Date.now()}-${index}`,
    location: location.name,
    coordinates: { lat: location.lat, lon: location.lon },
    disasterType,
    severity,
    confidence,
    timeframe,
    description: typeof raw?.description === 'string' && raw.description.trim() ? raw.description.trim() : `${disasterType} risk assessed for ${location.name}.`,
    impactArea: Math.round(Math.max(0, Number(raw?.impactArea) || 0)),
    affectedPopulation: Math.round(Math.max(0, Number(raw?.affectedPopulation) || 0)),
    recommendations: list(raw?.recommendations, 5),
    riskFactors: list(raw?.riskFactors, 5),
    predictedDate: predictedDateFor(timeframe),
    currentWeatherData: weather,
    seismicContext: seismic ?? undefined,
    source: 'gemini',
  };
}

function heuristicSeverity(hazard: string, weather: WeatherSnapshot, seismic: SeismicContext | null): Severity {
  let score = 1;
  if (['Earthquake', 'Tsunami', 'Volcano'].includes(hazard) && seismic) {
    if (seismic.maxMagnitude >= 6.5) score = 4;
    else if (seismic.maxMagnitude >= 5.5) score = 3;
    else if (seismic.count >= 3) score = 2;
  }
  if (!weather.estimated) {
    if (hazard === 'Wildfire' && weather.temp >= 32 && weather.humidity <= 30) score = Math.max(score, 3);
    if (hazard === 'Wildfire' && weather.temp >= 38 && weather.humidity <= 20) score = 4;
    if (hazard === 'Drought' && weather.temp >= 33 && weather.humidity <= 35) score = Math.max(score, 3);
    if (hazard === 'Hurricane' && weather.windSpeed >= 15) score = Math.max(score, 3);
    if (hazard === 'Flood' && /rain|shower|thunder/i.test(weather.condition)) score = Math.max(score, 3);
  }
  return SEVERITIES[clamp(score, 1, 4) - 1];
}

const HAZARD_DEFAULTS: Record<string, { area: number; population: number; recs: string[]; factors: string[] }> = {
  Earthquake: {
    area: 20000,
    population: 500000,
    recs: ['Retrofit vulnerable buildings and critical infrastructure', 'Rehearse drop, cover and hold on drills', 'Keep emergency kits and communication plans ready'],
    factors: ['Active fault systems', 'Recent regional seismicity', 'Dense urban construction'],
  },
  Tsunami: {
    area: 8000,
    population: 300000,
    recs: ['Maintain coastal evacuation routes and signage', 'Subscribe to tsunami warning services', 'Educate coastal residents on natural warning signs'],
    factors: ['Subduction zone proximity', 'Low-lying coastline', 'Short warning times'],
  },
  Volcano: {
    area: 5000,
    population: 200000,
    recs: ['Follow volcano observatory alert levels', 'Prepare ash protection and evacuation plans', 'Define exclusion zones around active vents'],
    factors: ['Active volcanic arc', 'Nearby settlements', 'Ashfall exposure'],
  },
  Wildfire: {
    area: 15000,
    population: 100000,
    recs: ['Create defensible space around structures', 'Restrict open burning during high fire danger', 'Pre-position firefighting resources'],
    factors: ['High temperature and low humidity', 'Dry vegetation load', 'Wind-driven fire spread'],
  },
  Flood: {
    area: 12000,
    population: 800000,
    recs: ['Maintain drainage and embankment infrastructure', 'Issue early flood warnings to low-lying areas', 'Pre-stage relief supplies and shelters'],
    factors: ['Heavy rainfall exposure', 'Low-lying terrain', 'River and delta dynamics'],
  },
  Hurricane: {
    area: 30000,
    population: 1000000,
    recs: ['Track storm advisories and activate evacuation plans', 'Reinforce coastal infrastructure', 'Stockpile water, food and medical supplies'],
    factors: ['Warm sea surface temperatures', 'Coastal exposure', 'Seasonal cyclone activity'],
  },
  Drought: {
    area: 50000,
    population: 600000,
    recs: ['Implement water conservation measures', 'Diversify agricultural and water sources', 'Monitor soil moisture and reservoir levels'],
    factors: ['Rainfall deficit', 'High evaporation', 'Agricultural water demand'],
  },
};

function heuristicPredictions(
  location: TrackedLocation,
  weather: WeatherSnapshot,
  seismic: SeismicContext | null,
  timeframes: Timeframe[],
  seed: number
): DisasterPrediction[] {
  const results: DisasterPrediction[] = [];
  const hazards = location.hazards.slice(0, 3);
  hazards.forEach((hazard, hIndex) => {
    const timeframe = timeframes[hIndex % timeframes.length];
    const defaults = HAZARD_DEFAULTS[hazard] ?? HAZARD_DEFAULTS.Flood;
    const severity = heuristicSeverity(hazard, weather, seismic);
    const confidence = Math.round(clamp(BASE_CONFIDENCE[timeframe] - 10 + SEVERITY_RANK[severity] * 2, 5, CONFIDENCE_CAP[timeframe]));
    results.push({
      id: `PRED-HEUR-${Date.now()}-${seed}-${hIndex}`,
      location: location.name,
      coordinates: { lat: location.lat, lon: location.lon },
      disasterType: hazard,
      severity,
      confidence,
      timeframe,
      description: `Rule-based outlook: ${hazard.toLowerCase()} is a recognised hazard for ${location.name}. This estimate uses ${weather.estimated ? 'climatological averages' : 'current weather'}${seismic ? ' and recent USGS seismicity' : ''}, not a model forecast.`,
      impactArea: defaults.area,
      affectedPopulation: defaults.population,
      recommendations: defaults.recs,
      riskFactors: defaults.factors,
      predictedDate: predictedDateFor(timeframe),
      currentWeatherData: weather,
      seismicContext: seismic ?? undefined,
      source: 'heuristic',
    });
  });
  return results;
}

function computeGlobalRisk(predictions: DisasterPrediction[]): string {
  if (!predictions.length) return 'Low';
  const critical = predictions.filter((p) => p.severity === 'Critical').length;
  const high = predictions.filter((p) => p.severity === 'High').length;
  const weighted = predictions.reduce((sum, p) => sum + SEVERITY_RANK[p.severity] * (p.confidence / 100), 0) / predictions.length;
  if (critical > 5 || weighted >= 3) return 'Critical';
  if (critical > 3 || high > 5 || weighted >= 2.4) return 'High';
  if (critical === 0 && high < 2 && weighted < 1.6) return 'Low';
  return 'Moderate';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function buildPredictions(
  searchQuery: string | undefined,
  filterTimeframe: string | undefined,
  options: PredictionOptions
): Promise<PredictionResponse> {
  const warnings: string[] = [];
  const timeframes = normalizeTimeframes(filterTimeframe);
  const locations = await resolveLocations(searchQuery, options.signal);

  const [weatherList, seismicEvents] = await Promise.all([
    Promise.all(locations.map((loc) => getWeatherData(loc.lat, loc.lon, options.signal))),
    loadSeismicFeed(options.signal).catch((error) => {
      if (error instanceof Error && error.message === 'Prediction aborted') throw error;
      warnings.push(`USGS seismic feed unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }),
  ]);

  if (weatherList.some((w) => w.estimated)) warnings.push('Live weather unavailable for some locations; climatological estimates were used.');

  const seismicList = locations.map((loc) => (seismicEvents ? seismicNear(seismicEvents, loc.lat, loc.lon) : null));

  const indexed = locations.map((loc, i) => ({ loc, i }));
  const groups = chunk(indexed, CHUNK_SIZE);
  const predictions: DisasterPrediction[] = [];
  let aiGroups = 0;
  let counter = 0;

  const outcomes = await Promise.all(
    groups.map(async (group) => {
      const groupLocations = group.map((g) => g.loc);
      const groupWeather = group.map((g) => weatherList[g.i]);
      const groupSeismic = group.map((g) => seismicList[g.i]);
      try {
        const raw = await callGeminiAPI(buildPrompt(groupLocations, groupWeather, groupSeismic, timeframes), options.signal);
        const parsed = parsePredictionJson(raw);
        const accepted: DisasterPrediction[] = [];
        parsed.forEach((item) => {
          const name = String(item?.location ?? '').trim().toLowerCase();
          const position = group.findIndex((g) => g.loc.name.toLowerCase() === name);
          if (position === -1) return;
          const result = sanitizePrediction(item, group[position].loc, groupWeather[position], groupSeismic[position], timeframes, counter++);
          if (result) accepted.push(result);
        });
        if (!accepted.length) throw new Error('Gemini returned no valid predictions');
        return { ok: true as const, accepted };
      } catch (error) {
        if (error instanceof Error && error.message === 'Prediction aborted') throw error;
        return { ok: false as const, error, group };
      }
    })
  );

  for (const outcome of outcomes) {
    if (outcome.ok) {
      aiGroups++;
      predictions.push(...outcome.accepted);
    } else {
      warnings.push(`Gemini unavailable for a batch, rule-based estimates used: ${outcome.error instanceof Error ? outcome.error.message : 'unknown error'}`);
      outcome.group.forEach((g) => {
        predictions.push(...heuristicPredictions(g.loc, weatherList[g.i], seismicList[g.i], timeframes, g.i));
      });
    }
  }

  predictions.sort((a, b) => {
    if (a.severity !== b.severity) return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return b.confidence - a.confidence;
  });

  const isFallback = aiGroups === 0;
  const sources = ['Open-Meteo'];
  if (seismicEvents) sources.push('USGS');
  if (aiGroups > 0) sources.unshift(`Gemini (${GEMINI_MODEL})`);
  if (aiGroups < groups.length) sources.push('Rule-based estimates');

  return {
    predictions,
    globalRiskLevel: computeGlobalRisk(predictions),
    totalPredictions: predictions.length,
    lastUpdated: new Date(),
    dataSource: sources.join(' + '),
    warnings,
    isFallback,
  };
}

export async function generateGlobalPredictions(
  searchQuery?: string,
  filterTimeframe?: string,
  options: PredictionOptions = {}
): Promise<PredictionResponse> {
  if (options.signal?.aborted) throw new Error('Prediction aborted');

  const key = `${(searchQuery ?? '').trim().toLowerCase()}|${normalizeTimeframes(filterTimeframe).join(',')}`;

  if (!options.forceRefresh) {
    const hit = resultCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const promise = buildPredictions(searchQuery, filterTimeframe, options)
    .then((result) => {
      resultCache.set(key, { value: result, expires: Date.now() + RESULT_TTL_MS });
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

export const GeminiPredictionService = {
  generateGlobalPredictions,
  clearPredictionCache,
};
