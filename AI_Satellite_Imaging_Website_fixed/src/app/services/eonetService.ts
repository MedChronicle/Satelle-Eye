const EONET_BASE_URL = 'https://eonet.gsfc.nasa.gov/api/v3';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const EVENTS_TTL_MS = 5 * 60 * 1000;
const CATEGORIES_TTL_MS = 24 * 60 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;

export type EventStatus = 'open' | 'closed' | 'all';
export type EventSeverity = 'Low' | 'Medium' | 'High';

export interface PointGeometry {
  magnitudeValue?: number | null;
  magnitudeUnit?: string | null;
  date: string;
  type: 'Point';
  coordinates: [number, number];
}

export interface PolygonGeometry {
  magnitudeValue?: number | null;
  magnitudeUnit?: string | null;
  date: string;
  type: 'Polygon';
  coordinates: number[][][];
}

export type EventGeometry = PointGeometry | PolygonGeometry;

export interface EventCategory {
  id: string;
  title: string;
}

export interface EventSource {
  id: string;
  url: string;
}

export interface NaturalEvent {
  id: string;
  title: string;
  description?: string | null;
  link?: string;
  categories: EventCategory[];
  sources: EventSource[];
  geometry: EventGeometry[];
  closed?: string | null;
}

export interface EONETResponse {
  title: string;
  description: string;
  link: string;
  events: NaturalEvent[];
}

export interface CategoryInfo {
  id: string;
  title: string;
  link?: string;
  description?: string;
  layers?: string;
}

export interface CategoriesResponse {
  title: string;
  description: string;
  link: string;
  categories: CategoryInfo[];
}

export interface EventQueryOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
  category?: string | string[];
  source?: string | string[];
  bbox?: [number, number, number, number];
  start?: string;
  end?: string;
  magID?: string;
}

export interface LocatedEvent extends NaturalEvent {
  distanceKm: number;
  point: { lat: number; lon: number };
  severity: EventSeverity;
}

export type EONETErrorCode = 'VALIDATION' | 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'RATE_LIMIT' | 'PARSE' | 'ABORTED';

export class EONETError extends Error {
  readonly code: EONETErrorCode;
  readonly status?: number;
  constructor(code: EONETErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'EONETError';
    this.code = code;
    this.status = status;
  }
}

const cacheStore = new Map<string, { value: unknown; expires: number }>();
const inflight = new Map<string, Promise<unknown>>();

export function clearEonetCache() {
  cacheStore.clear();
  inflight.clear();
}

async function cached<T>(key: string, ttl: number, force: boolean, loader: () => Promise<T>): Promise<T> {
  if (!force) {
    const hit = cacheStore.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const promise = loader()
    .then((value) => {
      cacheStore.set(key, { value, expires: Date.now() + ttl });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new EONETError('ABORTED', 'Request aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new EONETError('ABORTED', 'Request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function timedFetch(url: string, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new EONETError('ABORTED', 'Request aborted');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new EONETError('TIMEOUT', `Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    if (signal?.aborted) throw new EONETError('ABORTED', 'Request aborted');
    throw new EONETError('NETWORK', error instanceof Error ? error.message : 'Network error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await timedFetch(url, signal);
      if (response.status === 429) throw new EONETError('RATE_LIMIT', 'EONET rate limit exceeded', 429);
      if (!response.ok) throw new EONETError('HTTP', `EONET API error: ${response.status} ${response.statusText}`.trim(), response.status);
      try {
        return (await response.json()) as T;
      } catch {
        throw new EONETError('PARSE', 'EONET response was not valid JSON');
      }
    } catch (error) {
      lastError = error;
      if (error instanceof EONETError) {
        if (error.code === 'ABORTED' || error.code === 'PARSE') throw error;
        if (error.code === 'HTTP' && error.status !== undefined && error.status < 500) throw error;
      }
      if (attempt < MAX_RETRIES) await sleep(Math.min(4000, 500 * 2 ** attempt) + Math.random() * 250, signal);
    }
  }
  throw lastError;
}

function normalizeGeometry(raw: any): EventGeometry | null {
  if (!raw || typeof raw.date !== 'string') return null;
  const base = {
    date: raw.date,
    magnitudeValue: typeof raw.magnitudeValue === 'number' ? raw.magnitudeValue : null,
    magnitudeUnit: typeof raw.magnitudeUnit === 'string' ? raw.magnitudeUnit : null,
  };
  if (raw.type === 'Point' && Array.isArray(raw.coordinates) && raw.coordinates.length >= 2) {
    const lon = Number(raw.coordinates[0]);
    const lat = Number(raw.coordinates[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return { ...base, type: 'Point', coordinates: [lon, lat] };
  }
  if (raw.type === 'Polygon' && Array.isArray(raw.coordinates) && Array.isArray(raw.coordinates[0])) {
    return { ...base, type: 'Polygon', coordinates: raw.coordinates };
  }
  return null;
}

function normalizeEvent(raw: any): NaturalEvent | null {
  if (!raw || typeof raw.id !== 'string') return null;
  const geometry = (Array.isArray(raw.geometry) ? raw.geometry : [])
    .map(normalizeGeometry)
    .filter((g: EventGeometry | null): g is EventGeometry => g !== null);
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : 'Untitled event',
    description: raw.description ?? null,
    link: raw.link,
    categories: Array.isArray(raw.categories) ? raw.categories.filter((c: any) => c && typeof c.id === 'string') : [],
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s: any) => s && typeof s.id === 'string') : [],
    geometry,
    closed: raw.closed ?? null,
  };
}

function normalizeResponse(raw: any): EONETResponse {
  const events = (Array.isArray(raw?.events) ? raw.events : [])
    .map(normalizeEvent)
    .filter((e: NaturalEvent | null): e is NaturalEvent => e !== null);
  return {
    title: raw?.title ?? 'EONET Events',
    description: raw?.description ?? '',
    link: raw?.link ?? '',
    events,
  };
}

function assertPositiveInt(name: string, value: number | undefined, max: number) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new EONETError('VALIDATION', `${name} must be an integer between 1 and ${max}, received ${value}`);
  }
}

function assertStatus(status: string) {
  if (status !== 'open' && status !== 'closed' && status !== 'all') {
    throw new EONETError('VALIDATION', `Invalid status: ${status}`);
  }
}

function csv(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
  return list.length ? list.join(',') : undefined;
}

function buildParams(status: EventStatus, limit: number | undefined, days: number | undefined, options: EventQueryOptions) {
  const params = new URLSearchParams();
  if (status !== 'all') params.set('status', status);
  if (limit !== undefined) params.set('limit', String(limit));
  if (days !== undefined) params.set('days', String(days));
  const category = csv(options.category);
  const source = csv(options.source);
  if (category) params.set('category', category);
  if (source) params.set('source', source);
  if (options.start) params.set('start', options.start);
  if (options.end) params.set('end', options.end);
  if (options.magID) params.set('magID', options.magID);
  if (options.bbox) {
    const [minLon, maxLat, maxLon, minLat] = options.bbox;
    if (![minLon, maxLat, maxLon, minLat].every(Number.isFinite)) {
      throw new EONETError('VALIDATION', 'bbox must contain four finite numbers: [minLon, maxLat, maxLon, minLat]');
    }
    params.set('bbox', `${minLon},${maxLat},${maxLon},${minLat}`);
  }
  params.sort();
  return params;
}

export async function getNaturalEvents(
  status: EventStatus = 'all',
  limit?: number,
  days?: number,
  options: EventQueryOptions = {}
): Promise<EONETResponse> {
  assertStatus(status);
  assertPositiveInt('limit', limit, 5000);
  assertPositiveInt('days', days, 3650);
  const query = buildParams(status, limit, days, options).toString();
  const url = `${EONET_BASE_URL}/events${query ? `?${query}` : ''}`;
  return cached(url, EVENTS_TTL_MS, !!options.forceRefresh, async () =>
    normalizeResponse(await requestJson<unknown>(url, options.signal))
  );
}

export async function getEventsByCategory(
  categoryId: string,
  status: EventStatus = 'all',
  options: EventQueryOptions = {}
): Promise<EONETResponse> {
  if (!categoryId || !/^[A-Za-z0-9_-]+$/.test(categoryId)) {
    throw new EONETError('VALIDATION', `Invalid category id: ${categoryId}`);
  }
  assertStatus(status);
  const params = buildParams(status, undefined, undefined, options);
  const query = params.toString();
  const url = `${EONET_BASE_URL}/categories/${categoryId}${query ? `?${query}` : ''}`;
  return cached(url, EVENTS_TTL_MS, !!options.forceRefresh, async () =>
    normalizeResponse(await requestJson<unknown>(url, options.signal))
  );
}

export async function getEventById(eventId: string, options: EventQueryOptions = {}): Promise<NaturalEvent> {
  if (!eventId || !/^[A-Za-z0-9_.-]+$/.test(eventId)) {
    throw new EONETError('VALIDATION', `Invalid event id: ${eventId}`);
  }
  const url = `${EONET_BASE_URL}/events/${eventId}`;
  return cached(url, EVENTS_TTL_MS, !!options.forceRefresh, async () => {
    const event = normalizeEvent(await requestJson<unknown>(url, options.signal));
    if (!event) throw new EONETError('PARSE', `Event ${eventId} could not be parsed`);
    return event;
  });
}

export async function getCategories(options: { signal?: AbortSignal; forceRefresh?: boolean } = {}): Promise<CategoriesResponse> {
  const url = `${EONET_BASE_URL}/categories`;
  return cached(url, CATEGORIES_TTL_MS, !!options.forceRefresh, async () => {
    const raw: any = await requestJson<unknown>(url, options.signal);
    return {
      title: raw?.title ?? 'EONET Event Categories',
      description: raw?.description ?? '',
      link: raw?.link ?? '',
      categories: Array.isArray(raw?.categories) ? raw.categories : [],
    };
  });
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function getGeometryPoint(geometry: EventGeometry): { lat: number; lon: number } | null {
  if (geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    return { lat, lon };
  }
  const ring = geometry.coordinates[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let lonSum = 0;
  let latSum = 0;
  let count = 0;
  for (const position of ring) {
    if (Array.isArray(position) && Number.isFinite(position[0]) && Number.isFinite(position[1])) {
      lonSum += position[0];
      latSum += position[1];
      count++;
    }
  }
  return count ? { lat: latSum / count, lon: lonSum / count } : null;
}

export function getLatestGeometry(event: NaturalEvent): EventGeometry | null {
  if (!event.geometry.length) return null;
  return event.geometry.reduce((latest, current) =>
    Date.parse(current.date) >= Date.parse(latest.date) ? current : latest
  );
}

export function getLatestPosition(event: NaturalEvent): { lat: number; lon: number } | null {
  const latest = getLatestGeometry(event);
  return latest ? getGeometryPoint(latest) : null;
}

export function getEventSeverity(event: NaturalEvent): EventSeverity {
  const category = event.categories[0]?.id ?? '';
  const latest = getLatestGeometry(event);
  const magnitude = latest?.magnitudeValue ?? 0;
  const unit = (latest?.magnitudeUnit ?? '').toLowerCase();
  if (category === 'volcanoes' || category === 'severeStorms') {
    if (unit === 'kts' && magnitude >= 64) return 'High';
    return 'High';
  }
  if (category === 'wildfires') {
    if (unit.includes('acre') && magnitude >= 10000) return 'High';
    return magnitude > 0 ? 'Medium' : 'Low';
  }
  if (category === 'floods' || category === 'earthquakes' || category === 'landslides') return 'Medium';
  return 'Low';
}

function searchBox(lat: number, lon: number, radiusKm: number): [number, number, number, number] | undefined {
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.cos(toRad(lat));
  if (cosLat < 0.05) return undefined;
  const lonDelta = radiusKm / (111.32 * cosLat);
  const minLon = lon - lonDelta;
  const maxLon = lon + lonDelta;
  if (minLon < -180 || maxLon > 180) return undefined;
  return [minLon, Math.min(90, lat + latDelta), maxLon, Math.max(-90, lat - latDelta)];
}

export async function getEventsNear(
  latitude: number,
  longitude: number,
  radiusKm: number = 500,
  query: { status?: EventStatus; limit?: number; days?: number } & EventQueryOptions = {}
): Promise<LocatedEvent[]> {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new EONETError('VALIDATION', `Invalid latitude: ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new EONETError('VALIDATION', `Invalid longitude: ${longitude}`);
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 20000) {
    throw new EONETError('VALIDATION', `radiusKm must be between 1 and 20000, received ${radiusKm}`);
  }

  const { status = 'open', limit = 500, days, ...options } = query;
  const bbox = options.bbox ?? searchBox(latitude, longitude, radiusKm);
  const response = await getNaturalEvents(status, limit, days, { ...options, bbox });

  const located: LocatedEvent[] = [];
  for (const event of response.events) {
    let best: { distance: number; point: { lat: number; lon: number } } | null = null;
    for (const geometry of event.geometry) {
      const point = getGeometryPoint(geometry);
      if (!point) continue;
      const distance = haversineKm(latitude, longitude, point.lat, point.lon);
      if (!best || distance < best.distance) best = { distance, point };
    }
    if (!best || best.distance > radiusKm) continue;
    located.push({
      ...event,
      distanceKm: Math.round(best.distance),
      point: best.point,
      severity: getEventSeverity(event),
    });
  }
  return located.sort((a, b) => a.distanceKm - b.distanceKm);
}

export function groupEventsByCategory(events: NaturalEvent[]): Record<string, NaturalEvent[]> {
  const groups: Record<string, NaturalEvent[]> = {};
  for (const event of events) {
    const id = event.categories[0]?.id ?? 'unknown';
    (groups[id] ||= []).push(event);
  }
  return groups;
}

export interface WatchOptions {
  status?: EventStatus;
  limit?: number;
  days?: number;
  intervalMs?: number;
  query?: EventQueryOptions;
  onUpdate: (response: EONETResponse, changes: { added: NaturalEvent[]; closed: NaturalEvent[] }) => void;
  onError?: (error: EONETError) => void;
  signal?: AbortSignal;
}

export function watchNaturalEvents(options: WatchOptions): () => void {
  const intervalMs = Math.max(60_000, options.intervalMs ?? 5 * 60_000);
  let known = new Map<string, NaturalEvent>();
  let first = true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    if (stopped) return;
    try {
      const response = await getNaturalEvents(options.status ?? 'open', options.limit, options.days, {
        ...options.query,
        signal: options.signal,
        forceRefresh: true,
      });
      if (stopped) return;
      const next = new Map(response.events.map((e) => [e.id, e]));
      const added = first ? [] : response.events.filter((e) => !known.has(e.id));
      const closed = first ? [] : [...known.values()].filter((e) => !next.has(e.id));
      known = next;
      first = false;
      options.onUpdate(response, { added, closed });
    } catch (error) {
      if (error instanceof EONETError && error.code === 'ABORTED') return;
      options.onError?.(error instanceof EONETError ? error : new EONETError('NETWORK', String(error)));
    }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  run();
  return stop;
}

const CATEGORY_COLORS: Record<string, string> = {
  wildfires: '#ff4500',
  volcanoes: '#ff6347',
  severeStorms: '#4169e1',
  floods: '#1e90ff',
  drought: '#daa520',
  earthquakes: '#8b4513',
  landslides: '#a0522d',
  seaLakeIce: '#00ced1',
  snow: '#b0e0e6',
  tempExtremes: '#ff8c00',
  waterColor: '#20b2aa',
  dustHaze: '#d2b48c',
  manmade: '#808080',
};

const CATEGORY_ICONS: Record<string, string> = {
  wildfires: '🔥',
  volcanoes: '🌋',
  severeStorms: '⛈️',
  floods: '🌊',
  drought: '🏜️',
  earthquakes: '🌍',
  landslides: '⛰️',
  seaLakeIce: '🧊',
  snow: '❄️',
  tempExtremes: '🌡️',
  waterColor: '💧',
  dustHaze: '💨',
  manmade: '⚠️',
};

export function getCategoryColor(categoryId: string): string {
  return CATEGORY_COLORS[categoryId] ?? '#ffffff';
}

export function getCategoryIcon(categoryId: string): string {
  return CATEGORY_ICONS[categoryId] ?? '📍';
}
