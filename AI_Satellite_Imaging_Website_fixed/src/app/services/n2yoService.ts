import * as satellite from 'satellite.js';

const N2YO_API_KEY = (import.meta.env.VITE_N2YO_API_KEY as string | undefined) ?? '';
const N2YO_PROXY_URL = (import.meta.env.VITE_N2YO_PROXY_URL as string | undefined) ?? '';
const ALLOW_MOCK = import.meta.env.VITE_N2YO_USE_MOCK === 'true';
const N2YO_BASE_URL = 'https://api.n2yo.com/rest/v1/satellite';

const PUBLIC_PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?',
];

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const DEFAULT_CONCURRENCY = 4;

const CACHE_TTL_MS = {
  positions: 5_000,
  tle: 6 * 60 * 60 * 1000,
  visualpasses: 30 * 60 * 1000,
  radiopasses: 30 * 60 * 1000,
} as const;

export const SATELLITE_IDS: Record<string, number> = {
  'ISS (ZARYA)': 25544,
  'TIANGONG': 48274,
  'GPS BIIR-2  (PRN 13)': 24876,
  'GPS BIIR-8  (PRN 16)': 27663,
  'GALILEO-FM3': 37846,
  'GALILEO-FM4': 37847,
  'GLONASS-M 759': 37829,
  'BEIDOU 3M9': 43001,
  'IRIDIUM 33': 24946,
  'IRIDIUM 117': 42803,
  'IRIDIUM 120': 42956,
  'STARLINK-1007': 44713,
  'STARLINK-1008': 44714,
  'INTELSAT 901': 26038,
  'SES-12': 43440,
  'LANDSAT 8': 39084,
  'LANDSAT 9': 49260,
  'SENTINEL-1A': 39634,
  'SENTINEL-2A': 40697,
  'SENTINEL-3A': 41335,
  'TERRA': 25994,
  'AQUA': 27424,
  'NOAA 19': 33591,
  'NOAA 20': 43013,
  'SUOMI NPP': 37849,
  'GOES 16': 41866,
  'GOES 17': 43226,
  'METOP-B': 38771,
  'METOP-C': 43689,
  'HIMAWARI-8': 40267,
  'HUBBLE SPACE TELESCOPE': 20580,
  'CHANDRA X-RAY OBSERVATORY': 25867,
  'JAMES WEBB SPACE TELESCOPE': 50463,
  'SMOS': 36036,
  'SWOT': 54754,
  'VO-96': 43137,
  'HO-68': 36122,
  'VO-52': 28650,
  'AO-91': 43017,
  'AO-92': 43137,
  'SO-50': 27607,
  'LEMUR 2 PETER-JOHN': 43765,
  'FLOCK 4E-1': 43798,
  'PLANET 1': 44885,
  'STARLINK-1600': 47129,
  'STARLINK-1843': 48274,
  'STARLINK-2182': 48915,
};

const NAME_BY_ID = new Map<number, string>();
for (const [name, id] of Object.entries(SATELLITE_IDS)) {
  if (!NAME_BY_ID.has(id)) NAME_BY_ID.set(id, name);
}

export interface SatellitePosition {
  satlatitude: number;
  satlongitude: number;
  sataltitude: number;
  azimuth: number;
  elevation: number;
  ra: number;
  dec: number;
  timestamp: number;
}

export interface SatelliteInfo {
  satid: number;
  satname: string;
  transactionscount: number;
}

export interface TLEData {
  info: SatelliteInfo;
  tle: string;
}

export interface VisualPass {
  startAz: number;
  startAzCompass: string;
  startEl: number;
  startUTC: number;
  maxAz: number;
  maxAzCompass: string;
  maxEl: number;
  maxUTC: number;
  endAz: number;
  endAzCompass: string;
  endEl: number;
  endUTC: number;
  mag: number;
  duration: number;
}

export interface RadioPass {
  startAz: number;
  startAzCompass: string;
  startUTC: number;
  maxAz: number;
  maxAzCompass: string;
  maxEl: number;
  maxUTC: number;
  endAz: number;
  endAzCompass: string;
  endUTC: number;
  duration?: number;
}

export interface SatellitePositionResponse {
  info: SatelliteInfo;
  positions: SatellitePosition[];
  isMock?: boolean;
}

export interface VisualPassesResponse {
  info: SatelliteInfo;
  passes: VisualPass[];
}

export interface RadioPassesResponse {
  info: SatelliteInfo;
  passes: RadioPass[];
  isMock?: boolean;
}

export interface Observer {
  lat: number;
  lng: number;
  alt: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

export type N2YOErrorCode =
  | 'VALIDATION'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'HTTP'
  | 'RATE_LIMIT'
  | 'API'
  | 'PARSE'
  | 'ABORTED'
  | 'CONFIG';

export class N2YOError extends Error {
  readonly code: N2YOErrorCode;
  readonly status?: number;
  constructor(code: N2YOErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'N2YOError';
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new N2YOError('ABORTED', 'Request aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new N2YOError('ABORTED', 'Request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const backoffDelay = (attempt: number) =>
  Math.min(2000, 250 * 2 ** attempt) + Math.random() * 150;

function assertRange(name: string, value: number, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new N2YOError('VALIDATION', `${name} must be between ${min} and ${max}, received ${value}`);
  }
}

function validateObserver(lat: number, lng: number, alt: number) {
  assertRange('observerLat', lat, -90, 90);
  assertRange('observerLng', lng, -180, 180);
  assertRange('observerAlt', alt, -500, 9000);
}

function validateSatelliteId(id: number) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new N2YOError('VALIDATION', `Invalid NORAD ID: ${id}`);
  }
}

class TTLCache {
  private store = new Map<string, { value: unknown; expires: number }>();
  private inflight = new Map<string, Promise<unknown>>();

  async resolve<T>(key: string, ttl: number, force: boolean, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (!force) {
      const hit = this.store.get(key);
      if (hit && hit.expires > now) return hit.value as T;
      const pending = this.inflight.get(key);
      if (pending) return pending as Promise<T>;
    }
    const promise = loader()
      .then((value) => {
        this.store.set(key, { value, expires: Date.now() + ttl });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  clear() {
    this.store.clear();
    this.inflight.clear();
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expires <= now) this.store.delete(key);
    }
  }
}

const cache = new TTLCache();

export function clearSatelliteCache() {
  cache.clear();
}

async function runLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const lane = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new N2YOError('ABORTED', 'Request aborted');
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

const proxyFailures = new Map<string, number>();

function orderedProxies(): string[] {
  return [...PUBLIC_PROXIES].sort((a, b) => (proxyFailures.get(a) ?? 0) - (proxyFailures.get(b) ?? 0));
}

async function timedFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal?.aborted) {
    clearTimeout(timer);
    throw new N2YOError('ABORTED', 'Request aborted');
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new N2YOError('TIMEOUT', `Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    if (signal?.aborted) throw new N2YOError('ABORTED', 'Request aborted');
    throw new N2YOError('NETWORK', error instanceof Error ? error.message : 'Network error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 429) throw new N2YOError('RATE_LIMIT', 'Rate limit exceeded', 429);
  if (!response.ok) throw new N2YOError('HTTP', `HTTP ${response.status}`, response.status);
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new N2YOError('PARSE', 'Response was not valid JSON');
  }
  if (data && typeof data === 'object' && typeof data.error === 'string') {
    const code = /limit|exceed/i.test(data.error) ? 'RATE_LIMIT' : 'API';
    throw new N2YOError(code, data.error);
  }
  return data as T;
}

async function requestWithRetry<T>(url: string, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await parseResponse<T>(await timedFetch(url, signal));
    } catch (error) {
      lastError = error;
      if (error instanceof N2YOError) {
        if (['ABORTED', 'VALIDATION', 'API', 'RATE_LIMIT'].includes(error.code)) throw error;
        if (error.code === 'HTTP' && error.status && error.status < 500) throw error;
      }
      if (attempt < MAX_RETRIES) await sleep(backoffDelay(attempt), signal);
    }
  }
  throw lastError;
}

async function n2yoGet<T>(endpoint: string, params: Array<string | number>, signal?: AbortSignal): Promise<T> {
  const path = `${endpoint}/${params.join('/')}/`;

  if (N2YO_PROXY_URL) {
    return requestWithRetry<T>(`${N2YO_PROXY_URL.replace(/\/$/, '')}/${path}`, signal);
  }

  if (!N2YO_API_KEY) {
    throw new N2YOError('CONFIG', 'Set VITE_N2YO_PROXY_URL or VITE_N2YO_API_KEY');
  }

  const apiUrl = `${N2YO_BASE_URL}/${path}&apiKey=${N2YO_API_KEY}`;
  let lastError: unknown = new N2YOError('NETWORK', 'No proxy available');

  for (const proxy of orderedProxies()) {
    try {
      const data = await requestWithRetry<T>(`${proxy}${encodeURIComponent(apiUrl)}`, signal);
      proxyFailures.set(proxy, 0);
      return data;
    } catch (error) {
      lastError = error;
      if (error instanceof N2YOError && ['ABORTED', 'API', 'RATE_LIMIT'].includes(error.code)) throw error;
      proxyFailures.set(proxy, (proxyFailures.get(proxy) ?? 0) + 1);
    }
  }
  throw lastError;
}

export async function getSatellitePositions(
  satelliteId: number,
  observerLat: number = 0,
  observerLng: number = 0,
  observerAlt: number = 0,
  seconds: number = 300,
  options: RequestOptions = {}
): Promise<SatellitePositionResponse> {
  validateSatelliteId(satelliteId);
  validateObserver(observerLat, observerLng, observerAlt);
  assertRange('seconds', seconds, 1, 300);

  const key = `pos:${satelliteId}:${observerLat}:${observerLng}:${observerAlt}:${seconds}`;
  try {
    return await cache.resolve(key, CACHE_TTL_MS.positions, !!options.forceRefresh, () =>
      n2yoGet<SatellitePositionResponse>(
        'positions',
        [satelliteId, observerLat, observerLng, observerAlt, seconds],
        options.signal
      )
    );
  } catch (error) {
    if (ALLOW_MOCK && !(error instanceof N2YOError && error.code === 'ABORTED')) {
      return generateMockPositionData(satelliteId);
    }
    throw error;
  }
}

export async function getSatelliteTLE(satelliteId: number, options: RequestOptions = {}): Promise<TLEData> {
  validateSatelliteId(satelliteId);
  return cache.resolve(`tle:${satelliteId}`, CACHE_TTL_MS.tle, !!options.forceRefresh, () =>
    n2yoGet<TLEData>('tle', [satelliteId], options.signal)
  );
}

export async function getVisualPasses(
  satelliteId: number,
  observerLat: number,
  observerLng: number,
  observerAlt: number = 0,
  days: number = 10,
  minVisibility: number = 300,
  options: RequestOptions = {}
): Promise<VisualPassesResponse> {
  validateSatelliteId(satelliteId);
  validateObserver(observerLat, observerLng, observerAlt);
  assertRange('days', days, 1, 10);
  assertRange('minVisibility', minVisibility, 1, 3600);

  const key = `vis:${satelliteId}:${observerLat}:${observerLng}:${observerAlt}:${days}:${minVisibility}`;
  return cache.resolve(key, CACHE_TTL_MS.visualpasses, !!options.forceRefresh, () =>
    n2yoGet<VisualPassesResponse>(
      'visualpasses',
      [satelliteId, observerLat, observerLng, observerAlt, days, minVisibility],
      options.signal
    )
  );
}

export async function getRadioPasses(
  satelliteId: number,
  observerLat: number,
  observerLng: number,
  observerAlt: number = 0,
  days: number = 10,
  minElevation: number = 0,
  options: RequestOptions = {}
): Promise<RadioPassesResponse> {
  validateSatelliteId(satelliteId);
  validateObserver(observerLat, observerLng, observerAlt);
  assertRange('days', days, 1, 10);
  assertRange('minElevation', minElevation, 0, 90);

  const key = `radio:${satelliteId}:${observerLat}:${observerLng}:${observerAlt}:${days}:${minElevation}`;
  try {
    return await cache.resolve(key, CACHE_TTL_MS.radiopasses, !!options.forceRefresh, () =>
      n2yoGet<RadioPassesResponse>(
        'radiopasses',
        [satelliteId, observerLat, observerLng, observerAlt, days, minElevation],
        options.signal
      )
    );
  } catch (error) {
    if (ALLOW_MOCK && !(error instanceof N2YOError && error.code === 'ABORTED')) {
      return { info: mockInfo(satelliteId), passes: generateMockRadioPasses(), isMock: true };
    }
    throw error;
  }
}

export function propagateFromTLE(tle: string, observer: Observer, date: Date = new Date()): SatellitePosition {
  const [line1, line2] = tle.trim().split(/\r?\n/).map((line) => line.trim());
  if (!line1 || !line2) throw new N2YOError('PARSE', 'TLE must contain two lines');

  const satrec = satellite.twoline2satrec(line1, line2);
  const state = satellite.propagate(satrec, date);
  if (!state || !state.position || typeof state.position === 'boolean') {
    throw new N2YOError('PARSE', 'Propagation failed for the supplied TLE');
  }

  const gmst = satellite.gstime(date);
  const geodetic = satellite.eciToGeodetic(state.position, gmst);
  const observerGd = {
    longitude: satellite.degreesToRadians(observer.lng),
    latitude: satellite.degreesToRadians(observer.lat),
    height: observer.alt / 1000,
  };
  const look = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(state.position, gmst));
  const { x, y, z } = state.position;
  const radius = Math.sqrt(x * x + y * y + z * z);

  return {
    satlatitude: satellite.degreesLat(geodetic.latitude),
    satlongitude: satellite.degreesLong(geodetic.longitude),
    sataltitude: geodetic.height,
    azimuth: satellite.radiansToDegrees(look.azimuth),
    elevation: satellite.radiansToDegrees(look.elevation),
    ra: (satellite.radiansToDegrees(Math.atan2(y, x)) + 360) % 360,
    dec: satellite.radiansToDegrees(Math.asin(z / radius)),
    timestamp: Math.floor(date.getTime() / 1000),
  };
}

export function groundTrack(
  tle: string,
  observer: Observer,
  minutes: number = 90,
  stepSeconds: number = 30,
  start: Date = new Date()
): SatellitePosition[] {
  assertRange('minutes', minutes, 1, 1440);
  assertRange('stepSeconds', stepSeconds, 1, 600);
  const points: SatellitePosition[] = [];
  const total = minutes * 60;
  for (let offset = 0; offset <= total; offset += stepSeconds) {
    try {
      points.push(propagateFromTLE(tle, observer, new Date(start.getTime() + offset * 1000)));
    } catch {
      continue;
    }
  }
  return points;
}

export interface TrackOptions {
  intervalMs?: number;
  onUpdate: (position: SatellitePosition, info: SatelliteInfo) => void;
  onError?: (error: N2YOError) => void;
  signal?: AbortSignal;
}

export async function trackSatellite(
  satelliteId: number,
  observer: Observer = { lat: 0, lng: 0, alt: 0 },
  options: TrackOptions
): Promise<() => void> {
  validateSatelliteId(satelliteId);
  validateObserver(observer.lat, observer.lng, observer.alt);
  const intervalMs = Math.max(250, options.intervalMs ?? 1000);

  const tleData = await getSatelliteTLE(satelliteId, { signal: options.signal });
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    try {
      options.onUpdate(propagateFromTLE(tleData.tle, observer), tleData.info);
    } catch (error) {
      options.onError?.(
        error instanceof N2YOError ? error : new N2YOError('PARSE', (error as Error).message)
      );
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

function mockInfo(satelliteId: number): SatelliteInfo {
  return {
    satid: satelliteId,
    satname: NAME_BY_ID.get(satelliteId) ?? 'Unknown',
    transactionscount: 0,
  };
}

function generateMockPositionData(satelliteId: number): SatellitePositionResponse {
  const now = Math.floor(Date.now() / 1000);
  const phase = ((now + satelliteId * 97) % 5400) / 5400;
  const angle = phase * Math.PI * 2;
  return {
    info: mockInfo(satelliteId),
    isMock: true,
    positions: [
      {
        satlatitude: Math.sin(angle) * 51.6,
        satlongitude: ((phase * 360 + (satelliteId % 360)) % 360) - 180,
        sataltitude: 400 + (satelliteId % 1200),
        azimuth: (phase * 360) % 360,
        elevation: Math.max(0, Math.sin(angle) * 90),
        ra: (phase * 360) % 360,
        dec: Math.sin(angle) * 51.6,
        timestamp: now,
      },
    ],
  };
}

function generateMockRadioPasses(): RadioPass[] {
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: 5 }, (_, i) => {
    const startUTC = now + i * 12 * 3600 + Math.floor(Math.random() * 3600);
    const duration = 300 + Math.floor(Math.random() * 600);
    return {
      startAz: Math.random() * 360,
      startAzCompass: compass[Math.floor(Math.random() * 8)],
      startUTC,
      maxAz: Math.random() * 360,
      maxAzCompass: compass[Math.floor(Math.random() * 8)],
      maxEl: 30 + Math.random() * 60,
      maxUTC: startUTC + Math.floor(duration / 2),
      endAz: Math.random() * 360,
      endAzCompass: compass[Math.floor(Math.random() * 8)],
      endUTC: startUTC + duration,
      duration,
    };
  });
}

export interface SatelliteSnapshot {
  name: string;
  id: number;
  position: SatellitePosition;
  passes: RadioPass[];
  info: SatelliteInfo;
}

export interface SatelliteFailure {
  name: string;
  id: number;
  error: N2YOError;
}

export interface AllSatelliteOptions {
  includePasses?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

export async function getAllSatelliteDataDetailed(
  observerLat: number = 0,
  observerLng: number = 0,
  observerAlt: number = 0,
  options: AllSatelliteOptions = {}
): Promise<{ data: SatelliteSnapshot[]; failures: SatelliteFailure[] }> {
  validateObserver(observerLat, observerLng, observerAlt);
  const { includePasses = true, concurrency = DEFAULT_CONCURRENCY, signal, forceRefresh } = options;
  const entries = Object.entries(SATELLITE_IDS);
  const requestOptions: RequestOptions = { signal, forceRefresh };

  const settled = await runLimited(
    entries,
    concurrency,
    async ([name, id]): Promise<SatelliteSnapshot> => {
      const [position, passes] = await Promise.all([
        getSatellitePositions(id, observerLat, observerLng, observerAlt, 1, requestOptions),
        includePasses
          ? getRadioPasses(id, observerLat, observerLng, observerAlt, 10, 0, requestOptions)
          : Promise.resolve(null),
      ]);
      return {
        name,
        id,
        position: position.positions[0],
        passes: passes?.passes ?? [],
        info: position.info,
      };
    },
    signal
  );

  const data: SatelliteSnapshot[] = [];
  const failures: SatelliteFailure[] = [];
  settled.forEach((result, index) => {
    const [name, id] = entries[index];
    if (result.status === 'fulfilled') {
      data.push(result.value);
    } else {
      const reason = result.reason;
      failures.push({
        name,
        id,
        error: reason instanceof N2YOError ? reason : new N2YOError('NETWORK', String(reason)),
      });
    }
  });

  cache.prune();
  return { data, failures };
}

export async function getAllSatelliteData(
  observerLat: number = 0,
  observerLng: number = 0,
  observerAlt: number = 0,
  options: AllSatelliteOptions = {}
): Promise<SatelliteSnapshot[]> {
  const { data } = await getAllSatelliteDataDetailed(observerLat, observerLng, observerAlt, options);
  return data;
}
