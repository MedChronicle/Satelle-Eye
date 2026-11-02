import { sendChatMessage, ChatMessage } from './openaiService';
import { getNaturalEvents } from './eonetService';

export type SafetyLevel = 'Safe' | 'Moderate' | 'Risky' | 'Dangerous';

export interface HazardEvent {
  type: string;
  title: string;
  source: 'NASA EONET' | 'USGS';
  distanceKm: number;
  distance: string;
  severity: string;
  magnitude?: number;
  date?: string;
  weight: number;
}

export interface LocationAnalysis {
  location: {
    latitude: number;
    longitude: number;
    placeName?: string;
    country?: string;
  };
  safetyAssessment: {
    overallSafety: SafetyLevel;
    safetyScore: number;
    reasoning: string;
    dataScore: number;
    aiScore: number | null;
    confidence: 'Low' | 'Medium' | 'High';
  };
  urbanExpansion: {
    currentUrbanization: string;
    expansionTrend: string;
    lastMajorExpansion: string;
    populationGrowth: string;
  };
  naturalDisasterRisk: {
    nearbyEvents: Array<{
      type: string;
      distance: string;
      severity: string;
    }>;
    hazards: HazardEvent[];
    historicalRisk: string;
    futureRisk: string;
    primaryThreats: string[];
  };
  environmentalFactors: {
    climate: string;
    terrain: string;
    waterSources: string;
    vegetation: string;
  };
  recommendations: string[];
  aiAnalysis: string;
  dataSources: string[];
  warnings: string[];
  timestamp: Date;
}

export interface AnalyzeOptions {
  radiusKm?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  model?: string;
  skipAI?: boolean;
}

interface AIStructured {
  safetyRating: SafetyLevel;
  safetyScore: number;
  safetyReasoning: string;
  urbanization: string;
  expansionTrend: string;
  lastMajorExpansion: string;
  populationGrowth: string;
  historicalRisk: string;
  futureRisk: string;
  primaryThreats: string[];
  climate: string;
  terrain: string;
  waterSources: string;
  vegetation: string;
  recommendations: string[];
}

const DEFAULT_RADIUS_KM = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const STEP_TIMEOUT_MS = 12000;
const AI_TIMEOUT_MS = 45000;
const EARTH_RADIUS_KM = 6371;
const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

const CATEGORY_WEIGHTS: Record<string, number> = {
  volcanoes: 30,
  severeStorms: 26,
  wildfires: 22,
  floods: 20,
  earthquakes: 28,
  landslides: 16,
  drought: 10,
  dustHaze: 8,
  seaLakeIce: 5,
  snow: 6,
  tempExtremes: 10,
  waterColor: 2,
  manmade: 12,
};

const SAFETY_ORDER: SafetyLevel[] = ['Safe', 'Moderate', 'Risky', 'Dangerous'];

const FALLBACK_RECOMMENDATIONS = [
  'Commission a geological and hydrological survey before any development',
  'Maintain an up-to-date disaster preparedness and evacuation plan',
  'Subscribe to local meteorological and seismic alert services',
  'Confirm emergency services and critical infrastructure are within reach',
];

const analysisCache = new Map<string, { value: LocationAnalysis; expires: number }>();
const inflight = new Map<string, Promise<LocationAnalysis>>();
const geocodeCache = new Map<string, { value: { name: string; country?: string }; expires: number }>();
let usgsCache: { value: any[]; expires: number } | null = null;

export function clearLocationAnalysisCache() {
  analysisCache.clear();
  geocodeCache.clear();
  inflight.clear();
  usgsCache = null;
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateCoordinates(latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`Invalid latitude: ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`Invalid longitude: ${longitude}`);
  }
}

function formatCoordinates(lat: number, lon: number) {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Analysis aborted');
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Analysis aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      return reject(new Error('Analysis aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function geometryPoint(geometry: any): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
    return null;
  }
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates?.[0])) {
    const ring: number[][] = geometry.coordinates[0];
    if (!ring.length) return null;
    const lon = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
    const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    return [lat, lon];
  }
  return null;
}

function proximityFactor(distanceKm: number, radiusKm: number) {
  const ratio = Math.min(1, distanceKm / radiusKm);
  return Math.max(0.05, 1 - ratio ** 0.7);
}

function eonetSeverity(categoryId: string, magnitudeValue?: number): string {
  if (categoryId === 'volcanoes' || categoryId === 'severeStorms') return 'High';
  if (categoryId === 'wildfires' || categoryId === 'floods' || categoryId === 'earthquakes') {
    return magnitudeValue && magnitudeValue > 0 ? 'High' : 'Moderate';
  }
  return 'Low';
}

async function fetchEonetHazards(lat: number, lon: number, radiusKm: number, signal?: AbortSignal): Promise<HazardEvent[]> {
  const response: any = await withTimeout(getNaturalEvents('open', 200), STEP_TIMEOUT_MS, 'EONET request', signal);
  const events: any[] = response?.events ?? [];
  const hazards: HazardEvent[] = [];

  for (const event of events) {
    const geometries: any[] = Array.isArray(event.geometry) ? event.geometry : [];
    let best: { distance: number; date?: string; magnitude?: number } | null = null;

    for (const geometry of geometries) {
      const point = geometryPoint(geometry);
      if (!point) continue;
      const distance = haversineKm(lat, lon, point[0], point[1]);
      if (!best || distance < best.distance) {
        best = {
          distance,
          date: geometry.date,
          magnitude: typeof geometry.magnitudeValue === 'number' ? geometry.magnitudeValue : undefined,
        };
      }
    }

    if (!best || best.distance > radiusKm) continue;

    const category = event.categories?.[0];
    const categoryId: string = category?.id ?? 'unknown';
    const baseWeight = CATEGORY_WEIGHTS[categoryId] ?? 8;

    hazards.push({
      type: category?.title ?? 'Unknown',
      title: event.title ?? 'Untitled event',
      source: 'NASA EONET',
      distanceKm: Math.round(best.distance),
      distance: `${Math.round(best.distance)} km`,
      severity: eonetSeverity(categoryId, best.magnitude),
      magnitude: best.magnitude,
      date: best.date,
      weight: baseWeight * proximityFactor(best.distance, radiusKm),
    });
  }

  return hazards;
}

async function fetchUsgsHazards(lat: number, lon: number, radiusKm: number, signal?: AbortSignal): Promise<HazardEvent[]> {
  const now = Date.now();
  let features: any[];

  if (usgsCache && usgsCache.expires > now) {
    features = usgsCache.value;
  } else {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
    try {
      const response = await fetch(USGS_FEED, { signal: controller.signal });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const json = await response.json();
      features = Array.isArray(json?.features) ? json.features : [];
      usgsCache = { value: features, expires: now + 5 * 60 * 1000 };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  const hazards: HazardEvent[] = [];
  for (const feature of features) {
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords)) continue;
    const [eventLon, eventLat] = coords;
    if (!Number.isFinite(eventLat) || !Number.isFinite(eventLon)) continue;
    const distance = haversineKm(lat, lon, eventLat, eventLon);
    if (distance > radiusKm) continue;

    const magnitude = Number(feature.properties?.mag ?? 0);
    const severity = magnitude >= 6 ? 'High' : magnitude >= 4.5 ? 'Moderate' : 'Low';
    const magnitudeWeight = Math.max(0, (magnitude - 2) * 5);

    hazards.push({
      type: 'Earthquake',
      title: feature.properties?.title ?? `M ${magnitude.toFixed(1)} earthquake`,
      source: 'USGS',
      distanceKm: Math.round(distance),
      distance: `${Math.round(distance)} km`,
      severity,
      magnitude,
      date: feature.properties?.time ? new Date(feature.properties.time).toISOString() : undefined,
      weight: magnitudeWeight * proximityFactor(distance, radiusKm),
    });
  }
  return hazards;
}

function dedupeHazards(hazards: HazardEvent[]): HazardEvent[] {
  const seen = new Set<string>();
  const result: HazardEvent[] = [];
  for (const hazard of hazards.sort((a, b) => a.distanceKm - b.distanceKm)) {
    const key = `${hazard.source}|${hazard.title}|${hazard.distanceKm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hazard);
  }
  return result;
}

function computeDataScore(hazards: HazardEvent[]): number {
  const totalPenalty = hazards.reduce((sum, h) => sum + h.weight, 0);
  const saturated = 100 * (1 - Math.exp(-totalPenalty / 60));
  return Math.round(Math.max(0, Math.min(100, 100 - saturated)));
}

function scoreToLevel(score: number): SafetyLevel {
  if (score >= 75) return 'Safe';
  if (score >= 55) return 'Moderate';
  if (score >= 35) return 'Risky';
  return 'Dangerous';
}

async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<{ name: string; country?: string }> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = geocodeCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const fallback = { name: formatCoordinates(lat, lon) };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const url = `${NOMINATIM_URL}?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`;
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return fallback;
    const json = await response.json();
    const address = json?.address ?? {};
    const locality = address.city || address.town || address.village || address.county || address.state_district;
    const parts = [locality, address.state, address.country].filter(Boolean);
    const value = {
      name: parts.length ? parts.join(', ') : json?.display_name ?? fallback.name,
      country: address.country,
    };
    geocodeCache.set(key, { value, expires: Date.now() + GEOCODE_TTL_MS });
    return value;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function buildPrompt(lat: number, lon: number, placeName: string, hazards: HazardEvent[], radiusKm: number): ChatMessage[] {
  const hazardLines = hazards.length
    ? hazards
        .slice(0, 8)
        .map((h, i) => `${i + 1}. [${h.source}] ${h.type}: ${h.title} - ${h.distance} away, severity ${h.severity}${h.magnitude ? `, magnitude ${h.magnitude}` : ''}`)
        .join('\n')
    : `No active hazards recorded within ${radiusKm} km`;

  const schema = `{
  "safetyRating": "Safe | Moderate | Risky | Dangerous",
  "safetyScore": 0-100 integer where 100 is safest,
  "safetyReasoning": "2-4 sentences",
  "urbanization": "current level of urbanization",
  "expansionTrend": "historical and ongoing urban expansion trend",
  "lastMajorExpansion": "period of the last major expansion",
  "populationGrowth": "population growth pattern",
  "historicalRisk": "historical natural disaster risk",
  "futureRisk": "future risk including climate change",
  "primaryThreats": ["up to 5 specific threats"],
  "climate": "climate classification",
  "terrain": "terrain characteristics",
  "waterSources": "water availability",
  "vegetation": "vegetation patterns",
  "recommendations": ["3 to 5 specific recommendations"]
}`;

  return [
    {
      role: 'system',
      content:
        'You are an expert geographer, urban planner and disaster risk analyst. Respond with a single valid JSON object only, with no markdown fences and no text outside the JSON. Be specific to the location, avoid generic statements, and state uncertainty where the data is weak.',
    },
    {
      role: 'user',
      content: `Analyze this location.

Coordinates: ${formatCoordinates(lat, lon)}
Resolved place: ${placeName}

Live hazard data within ${radiusKm} km:
${hazardLines}

Return JSON matching exactly this schema:
${schema}`,
    },
  ];
}

function extractJson(raw: string): any {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('No JSON object found in AI response');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function asText(value: unknown, fallback = 'Information not available'): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const joined = value.filter((v) => typeof v === 'string').join('; ').trim();
    if (joined) return joined;
  }
  return fallback;
}

function asList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, max);
}

function normalizeRating(value: unknown): SafetyLevel | null {
  if (typeof value !== 'string') return null;
  const match = SAFETY_ORDER.find((level) => level.toLowerCase() === value.trim().toLowerCase());
  return match ?? null;
}

function sanitizeStructured(raw: any): AIStructured {
  const score = Number(raw?.safetyScore);
  const rating = normalizeRating(raw?.safetyRating);
  return {
    safetyRating: rating ?? (Number.isFinite(score) ? scoreToLevel(score) : 'Moderate'),
    safetyScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : NaN,
    safetyReasoning: asText(raw?.safetyReasoning, 'No specific reasoning provided'),
    urbanization: asText(raw?.urbanization),
    expansionTrend: asText(raw?.expansionTrend),
    lastMajorExpansion: asText(raw?.lastMajorExpansion),
    populationGrowth: asText(raw?.populationGrowth),
    historicalRisk: asText(raw?.historicalRisk),
    futureRisk: asText(raw?.futureRisk),
    primaryThreats: asList(raw?.primaryThreats, 5),
    climate: asText(raw?.climate),
    terrain: asText(raw?.terrain),
    waterSources: asText(raw?.waterSources),
    vegetation: asText(raw?.vegetation),
    recommendations: asList(raw?.recommendations, 5),
  };
}

async function runAI(messages: ChatMessage[], model: string, signal?: AbortSignal): Promise<{ structured: AIStructured; raw: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(signal);
    try {
      const raw = await withTimeout(sendChatMessage(messages, model as any), AI_TIMEOUT_MS, 'AI analysis', signal);
      const text = typeof raw === 'string' ? raw : String((raw as any)?.content ?? raw);
      return { structured: sanitizeStructured(extractJson(text)), raw: text };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message === 'Analysis aborted') throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('AI analysis failed');
}

function deriveConfidence(hazardSourcesOk: number, aiOk: boolean, aiScore: number | null, dataScore: number): 'Low' | 'Medium' | 'High' {
  if (!aiOk && hazardSourcesOk === 0) return 'Low';
  if (!aiOk || hazardSourcesOk === 0) return 'Low';
  const agreement = aiScore === null ? 0 : Math.abs(aiScore - dataScore);
  if (hazardSourcesOk === 2 && agreement <= 20) return 'High';
  return 'Medium';
}

function blendScores(dataScore: number, aiScore: number | null): number {
  if (aiScore === null) return dataScore;
  return Math.round(dataScore * 0.6 + aiScore * 0.4);
}

function buildReasoning(
  level: SafetyLevel,
  hazards: HazardEvent[],
  aiReasoning: string | null,
  radiusKm: number
): string {
  const closest = hazards[0];
  const dataSentence = hazards.length
    ? `${hazards.length} active hazard${hazards.length > 1 ? 's' : ''} found within ${radiusKm} km, the nearest being ${closest.type.toLowerCase()} "${closest.title}" at ${closest.distance}.`
    : `No active hazards were recorded within ${radiusKm} km.`;
  return [`Overall rating: ${level}.`, dataSentence, aiReasoning].filter(Boolean).join(' ');
}

async function performAnalysis(
  latitude: number,
  longitude: number,
  options: AnalyzeOptions
): Promise<LocationAnalysis> {
  const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;
  const model = options.model ?? 'gpt-4';
  const warnings: string[] = [];
  const dataSources: string[] = [];

  const [eonetResult, usgsResult, geocode] = await Promise.all([
    fetchEonetHazards(latitude, longitude, radiusKm, options.signal).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    fetchUsgsHazards(latitude, longitude, radiusKm, options.signal).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ),
    reverseGeocode(latitude, longitude, options.signal),
  ]);

  throwIfAborted(options.signal);

  let hazardSourcesOk = 0;
  const collected: HazardEvent[] = [];

  if (eonetResult.ok) {
    hazardSourcesOk++;
    dataSources.push('NASA EONET');
    collected.push(...eonetResult.value);
  } else {
    warnings.push(`NASA EONET unavailable: ${(eonetResult.error as Error).message}`);
  }

  if (usgsResult.ok) {
    hazardSourcesOk++;
    dataSources.push('USGS Earthquake Feed');
    collected.push(...usgsResult.value);
  } else {
    warnings.push(`USGS feed unavailable: ${(usgsResult.error as Error).message}`);
  }

  if (geocode.country) dataSources.push('OpenStreetMap Nominatim');

  const hazards = dedupeHazards(collected);
  const dataScore = computeDataScore(hazards);

  let structured: AIStructured | null = null;
  let aiRaw = '';

  if (!options.skipAI) {
    try {
      const messages = buildPrompt(latitude, longitude, geocode.name, hazards, radiusKm);
      const result = await runAI(messages, model, options.signal);
      structured = result.structured;
      aiRaw = result.raw;
      dataSources.push(`OpenAI ${model}`);
    } catch (error) {
      if (error instanceof Error && error.message === 'Analysis aborted') throw error;
      warnings.push(`AI analysis unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  const aiScore = structured && Number.isFinite(structured.safetyScore) ? structured.safetyScore : null;
  const finalScore = blendScores(dataScore, aiScore);
  let level = scoreToLevel(finalScore);

  if (structured) {
    const aiIndex = SAFETY_ORDER.indexOf(structured.safetyRating);
    const levelIndex = SAFETY_ORDER.indexOf(level);
    if (Math.abs(aiIndex - levelIndex) >= 2) {
      warnings.push('AI safety rating strongly disagrees with live hazard data; the data-driven rating was kept.');
    }
  }

  const hasHighSeverityNearby = hazards.some((h) => h.severity === 'High' && h.distanceKm < 100);
  if (hasHighSeverityNearby && SAFETY_ORDER.indexOf(level) < SAFETY_ORDER.indexOf('Risky')) {
    level = 'Risky';
  }

  const threats = structured?.primaryThreats.length
    ? structured.primaryThreats
    : Array.from(new Set(hazards.map((h) => h.type))).slice(0, 5);

  const topHazards = hazards.slice(0, 5);

  return {
    location: {
      latitude,
      longitude,
      placeName: geocode.name,
      country: geocode.country,
    },
    safetyAssessment: {
      overallSafety: level,
      safetyScore: finalScore,
      reasoning: buildReasoning(level, hazards, structured?.safetyReasoning ?? null, radiusKm),
      dataScore,
      aiScore,
      confidence: deriveConfidence(hazardSourcesOk, structured !== null, aiScore, dataScore),
    },
    urbanExpansion: {
      currentUrbanization: structured?.urbanization ?? 'Information not available',
      expansionTrend: structured?.expansionTrend ?? 'Information not available',
      lastMajorExpansion: structured?.lastMajorExpansion ?? 'Information not available',
      populationGrowth: structured?.populationGrowth ?? 'Information not available',
    },
    naturalDisasterRisk: {
      nearbyEvents: topHazards.map((h) => ({ type: h.type, distance: h.distance, severity: h.severity })),
      hazards: topHazards,
      historicalRisk: structured?.historicalRisk ?? 'Information not available',
      futureRisk: structured?.futureRisk ?? 'Information not available',
      primaryThreats: threats,
    },
    environmentalFactors: {
      climate: structured?.climate ?? 'Information not available',
      terrain: structured?.terrain ?? 'Information not available',
      waterSources: structured?.waterSources ?? 'Information not available',
      vegetation: structured?.vegetation ?? 'Information not available',
    },
    recommendations: structured?.recommendations.length ? structured.recommendations : FALLBACK_RECOMMENDATIONS,
    aiAnalysis: aiRaw,
    dataSources,
    warnings,
    timestamp: new Date(),
  };
}

export async function analyzeLocation(
  latitude: number,
  longitude: number,
  options: AnalyzeOptions = {}
): Promise<LocationAnalysis> {
  validateCoordinates(latitude, longitude);
  throwIfAborted(options.signal);

  const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;
  if (!Number.isFinite(radiusKm) || radiusKm < 10 || radiusKm > 5000) {
    throw new Error(`radiusKm must be between 10 and 5000, received ${radiusKm}`);
  }

  const key = `${latitude.toFixed(3)}:${longitude.toFixed(3)}:${radiusKm}:${options.model ?? 'gpt-4'}:${options.skipAI ? 'noai' : 'ai'}`;

  if (!options.forceRefresh) {
    const hit = analysisCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const promise = performAnalysis(latitude, longitude, options)
    .then((result) => {
      analysisCache.set(key, { value: result, expires: Date.now() + CACHE_TTL_MS });
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

export async function analyzeLocations(
  points: Array<{ latitude: number; longitude: number }>,
  options: AnalyzeOptions & { concurrency?: number } = {}
): Promise<Array<{ latitude: number; longitude: number; result?: LocationAnalysis; error?: string }>> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const output: Array<{ latitude: number; longitude: number; result?: LocationAnalysis; error?: string }> = new Array(points.length);
  let cursor = 0;

  const lane = async () => {
    while (cursor < points.length) {
      const index = cursor++;
      const { latitude, longitude } = points[index];
      try {
        output[index] = { latitude, longitude, result: await analyzeLocation(latitude, longitude, options) };
      } catch (error) {
        output[index] = { latitude, longitude, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, points.length) }, lane));
  return output;
}
