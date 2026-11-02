export type UnitSystem = 'metric' | 'imperial' | 'standard';

export type AQILevel =
  | 'Good'
  | 'Moderate'
  | 'Unhealthy for Sensitive Groups'
  | 'Unhealthy'
  | 'Very Unhealthy'
  | 'Hazardous';

export type WeatherErrorCode =
  | 'CONFIG'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'SERVER'
  | 'INVALID_INPUT'
  | 'UNKNOWN';

export class WeatherError extends Error {
  code: WeatherErrorCode;
  status?: number;

  constructor(message: string, code: WeatherErrorCode, status?: number) {
    super(message);
    this.name = 'WeatherError';
    this.code = code;
    this.status = status;
  }
}

export interface Pollutants {
  pm25: number;
  pm10: number;
  o3: number;
  no2: number;
  so2: number;
  co: number;
}

export interface AirQuality {
  aqi: number | null;
  level: AQILevel | null;
  color: string;
  advice: string;
  dominantPollutant: string | null;
  station: string | null;
  source: 'waqi' | 'openweather' | 'none';
  pollutants: Pollutants;
}

export interface UnitLabels {
  temperature: string;
  speed: string;
  distance: string;
  pressure: string;
  precipitation: string;
}

export interface WeatherData {
  location: string;
  country: string;
  state?: string;
  temperature: number;
  feelsLike: number;
  tempMin: number;
  tempMax: number;
  humidity: number;
  pressure: number;
  windSpeed: number;
  windGust: number;
  windDirection: number;
  windCompass: string;
  beaufort: { scale: number; label: string };
  visibility: number;
  uvIndex: number;
  uvLevel: string;
  precipitation: number;
  description: string;
  cloudCover: number;
  coordinates: { lat: number; lon: number };
  timezoneOffset: number;
  timestamp: string;
  observedAt: string;
  localTime: string;
  sunrise: string;
  sunset: string;
  sunriseLocal: string;
  sunsetLocal: string;
  dayLengthMinutes: number;
  isDaytime: boolean;
  moonPhase: { phase: string; illumination: number; age: number };
  weatherCode: number;
  aqi: number;
  aqiLevel: AQILevel;
  airQuality: AirQuality;
  pollutants: Pollutants;
  dewPoint: number;
  heatIndex: number | null;
  windChill: number | null;
  comfort: string;
  rainVolume: number;
  snowVolume: number;
  weatherMain: string;
  weatherIcon: string;
  advisories: string[];
  units: UnitSystem;
  unitLabels: UnitLabels;
  fromCache: boolean;
}

export interface HourlyForecast {
  time: string;
  localTime: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  precipitationChance: number;
  rainVolume: number;
  description: string;
  weatherMain: string;
  weatherIcon: string;
}

export interface DailyForecast {
  date: string;
  weekday: string;
  tempMin: number;
  tempMax: number;
  avgHumidity: number;
  avgWindSpeed: number;
  maxPrecipitationChance: number;
  totalRain: number;
  totalSnow: number;
  weatherMain: string;
  weatherIcon: string;
  description: string;
}

export interface ForecastData {
  location: string;
  country: string;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
  units: UnitSystem;
  unitLabels: UnitLabels;
}

export interface GeocodingResult {
  name: string;
  country: string;
  lat: number;
  lon: number;
  state?: string;
}

export interface WeatherOptions {
  units?: UnitSystem;
  forceRefresh?: boolean;
  includeAirQuality?: boolean;
  includeUV?: boolean;
  signal?: AbortSignal;
}

export interface WeatherBundle {
  current: WeatherData;
  forecast: ForecastData | null;
}

const OPENWEATHER_API_KEY: string = import.meta.env.VITE_OPENWEATHER_API_KEY ?? '';
const WAQI_API_KEY: string = import.meta.env.VITE_WAQI_API_KEY ?? '';

const OW_BASE = 'https://api.openweathermap.org';
const WAQI_BASE = 'https://api.waqi.info';

const CONFIG = {
  requestTimeoutMs: 8000,
  maxRetries: 2,
  retryBaseDelayMs: 500,
  currentTtlMs: 10 * 60 * 1000,
  forecastTtlMs: 30 * 60 * 1000,
  geocodeTtlMs: 24 * 60 * 60 * 1000,
  maxCacheEntries: 200,
  maxBatchConcurrency: 4,
};

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet<T>(key: string, value: T, ttl: number): void {
  if (cache.size >= CONFIG.maxCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + ttl });
}

async function cached<T>(
  key: string,
  ttl: number,
  force: boolean,
  loader: () => Promise<T>
): Promise<{ value: T; fromCache: boolean }> {
  if (!force) {
    const hit = cacheGet<T>(key);
    if (hit !== undefined) return { value: hit, fromCache: true };
    const pending = inflight.get(key) as Promise<T> | undefined;
    if (pending) return { value: await pending, fromCache: false };
  }
  const promise = loader()
    .then((value) => {
      cacheSet(key, value, ttl);
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return { value: await promise, fromCache: false };
}

export function clearWeatherCache(): void {
  cache.clear();
  inflight.clear();
}

export function getCacheStats(): { entries: number; pending: number } {
  return { entries: cache.size, pending: inflight.size };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(base: string, path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(path, base);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function statusToError(status: number, statusText: string): WeatherError {
  if (status === 401 || status === 403) {
    return new WeatherError('API key was rejected. Check your configuration.', 'AUTH', status);
  }
  if (status === 404) {
    return new WeatherError('Requested resource was not found.', 'NOT_FOUND', status);
  }
  if (status === 429) {
    return new WeatherError('Rate limit reached. Please try again shortly.', 'RATE_LIMIT', status);
  }
  if (status >= 500) {
    return new WeatherError(`Weather provider error (${status}).`, 'SERVER', status);
  }
  return new WeatherError(`Request failed: ${status} ${statusText}`, 'UNKNOWN', status);
}

function isRetryable(error: WeatherError): boolean {
  return error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'RATE_LIMIT' || error.code === 'SERVER';
}

async function fetchJson<T>(url: string, externalSignal?: AbortSignal): Promise<T> {
  let lastError: WeatherError = new WeatherError('Unknown error', 'UNKNOWN');

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw statusToError(response.status, response.statusText);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new WeatherError('Request was cancelled.', 'UNKNOWN');
      }
      if (error instanceof WeatherError) {
        lastError = error;
      } else if (error instanceof DOMException && error.name === 'AbortError') {
        lastError = new WeatherError('Request timed out.', 'TIMEOUT');
      } else {
        lastError = new WeatherError('Network error. Check your internet connection.', 'NETWORK');
      }
      if (!isRetryable(lastError) || attempt === CONFIG.maxRetries) {
        throw lastError;
      }
      const delay = CONFIG.retryBaseDelayMs * 2 ** attempt + Math.random() * 250;
      await sleep(delay);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw lastError;
}

function requireOpenWeatherKey(): void {
  if (!OPENWEATHER_API_KEY) {
    throw new WeatherError(
      'Missing VITE_OPENWEATHER_API_KEY. Add it to your .env file.',
      'CONFIG'
    );
  }
}

function validateCoordinates(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new WeatherError('Invalid coordinates.', 'INVALID_INPUT');
  }
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const toFahrenheit = (c: number): number => (c * 9) / 5 + 32;
const toCelsius = (f: number): number => ((f - 32) * 5) / 9;

function convertTemperature(celsius: number, units: UnitSystem): number {
  if (units === 'imperial') return round(toFahrenheit(celsius));
  if (units === 'standard') return round(celsius + 273.15, 2);
  return round(celsius);
}

function convertSpeed(metersPerSecond: number, units: UnitSystem): number {
  if (units === 'imperial') return round(metersPerSecond * 2.236936);
  return round(metersPerSecond);
}

function convertDistance(km: number, units: UnitSystem): number {
  if (units === 'imperial') return round(km * 0.621371);
  return round(km);
}

function convertPressure(hPa: number, units: UnitSystem): number {
  if (units === 'imperial') return round(hPa * 0.02953, 2);
  return round(hPa, 0);
}

function convertPrecipitation(mm: number, units: UnitSystem): number {
  if (units === 'imperial') return round(mm / 25.4, 2);
  return round(mm, 2);
}

export function getUnitLabels(units: UnitSystem): UnitLabels {
  if (units === 'imperial') {
    return { temperature: '°F', speed: 'mph', distance: 'mi', pressure: 'inHg', precipitation: 'in' };
  }
  if (units === 'standard') {
    return { temperature: 'K', speed: 'm/s', distance: 'km', pressure: 'hPa', precipitation: 'mm' };
  }
  return { temperature: '°C', speed: 'm/s', distance: 'km', pressure: 'hPa', precipitation: 'mm' };
}

const COMPASS_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

export function getCompassDirection(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16];
}

const BEAUFORT_LIMITS = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
const BEAUFORT_LABELS = [
  'Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze',
  'Strong breeze', 'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane force',
];

export function getBeaufort(metersPerSecond: number): { scale: number; label: string } {
  let scale = BEAUFORT_LIMITS.findIndex((limit) => metersPerSecond < limit);
  if (scale === -1) scale = 12;
  return { scale, label: BEAUFORT_LABELS[scale] };
}

export function calculateDewPoint(tempC: number, humidity: number): number {
  const a = 17.62;
  const b = 243.12;
  const rh = clamp(humidity, 1, 100);
  const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return round((b * gamma) / (a - gamma));
}

export function calculateHeatIndex(tempC: number, humidity: number): number | null {
  if (tempC < 27 || humidity < 40) return null;
  const t = toFahrenheit(tempC);
  const rh = humidity;
  const hi =
    -42.379 +
    2.04901523 * t +
    10.14333127 * rh -
    0.22475541 * t * rh -
    0.00683783 * t * t -
    0.05481717 * rh * rh +
    0.00122874 * t * t * rh +
    0.00085282 * t * rh * rh -
    0.00000199 * t * t * rh * rh;
  return round(toCelsius(hi));
}

export function calculateWindChill(tempC: number, windMs: number): number | null {
  const windKmh = windMs * 3.6;
  if (tempC > 10 || windKmh < 4.8) return null;
  const v = windKmh ** 0.16;
  return round(13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v);
}

export function getUVLevel(uv: number): string {
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very High';
  return 'Extreme';
}

function getComfortLabel(apparentC: number, humidity: number): string {
  if (apparentC >= 41) return 'Dangerously hot';
  if (apparentC >= 32) return humidity > 60 ? 'Hot and muggy' : 'Hot';
  if (apparentC >= 26) return humidity > 65 ? 'Warm and humid' : 'Warm';
  if (apparentC >= 18) return 'Comfortable';
  if (apparentC >= 10) return 'Cool';
  if (apparentC >= 0) return 'Cold';
  if (apparentC >= -15) return 'Very cold';
  return 'Dangerously cold';
}

export function getMoonPhase(date: Date = new Date()): { phase: string; illumination: number; age: number } {
  const synodicMonth = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const daysSince = (date.getTime() - knownNewMoon) / 86400000;
  const age = ((daysSince % synodicMonth) + synodicMonth) % synodicMonth;
  const illumination = round(((1 - Math.cos((2 * Math.PI * age) / synodicMonth)) / 2) * 100, 0);

  let phase = 'New Moon';
  if (age >= 1.85 && age < 5.54) phase = 'Waxing Crescent';
  else if (age >= 5.54 && age < 9.23) phase = 'First Quarter';
  else if (age >= 9.23 && age < 12.92) phase = 'Waxing Gibbous';
  else if (age >= 12.92 && age < 16.61) phase = 'Full Moon';
  else if (age >= 16.61 && age < 20.3) phase = 'Waning Gibbous';
  else if (age >= 20.3 && age < 23.99) phase = 'Last Quarter';
  else if (age >= 23.99 && age < 27.68) phase = 'Waning Crescent';

  return { phase, illumination, age: round(age) };
}

const AQI_CATEGORIES: { max: number; level: AQILevel; color: string; advice: string }[] = [
  { max: 50, level: 'Good', color: '#00e400', advice: 'Air quality is satisfactory. Enjoy outdoor activities.' },
  { max: 100, level: 'Moderate', color: '#ffff00', advice: 'Unusually sensitive people should consider reducing prolonged outdoor exertion.' },
  { max: 150, level: 'Unhealthy for Sensitive Groups', color: '#ff7e00', advice: 'Children, older adults and people with respiratory conditions should limit outdoor exertion.' },
  { max: 200, level: 'Unhealthy', color: '#ff0000', advice: 'Everyone should reduce prolonged outdoor exertion. Consider a mask outdoors.' },
  { max: 300, level: 'Very Unhealthy', color: '#8f3f97', advice: 'Avoid outdoor activity. Keep windows closed and use an air purifier if possible.' },
  { max: Infinity, level: 'Hazardous', color: '#7e0023', advice: 'Stay indoors. Health emergency conditions for the entire population.' },
];

export function getAQILevel(aqi: number): AQILevel {
  return (AQI_CATEGORIES.find((category) => aqi <= category.max) ?? AQI_CATEGORIES[AQI_CATEGORIES.length - 1]).level;
}

function getAQICategory(aqi: number) {
  return AQI_CATEGORIES.find((category) => aqi <= category.max) ?? AQI_CATEGORIES[AQI_CATEGORIES.length - 1];
}

const PM25_BREAKPOINTS: [number, number, number, number][] = [
  [0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

export function pm25ToAQI(concentration: number): number {
  const c = Math.floor(concentration * 10) / 10;
  const bracket = PM25_BREAKPOINTS.find(([low, high]) => c >= low && c <= high);
  if (!bracket) return c > 325.4 ? 500 : 0;
  const [cLow, cHigh, iLow, iHigh] = bracket;
  return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
}

const EMPTY_POLLUTANTS: Pollutants = { pm25: 0, pm10: 0, o3: 0, no2: 0, so2: 0, co: 0 };

const EMPTY_AIR_QUALITY: AirQuality = {
  aqi: null,
  level: null,
  color: '#9ca3af',
  advice: 'Air quality data is not available for this location.',
  dominantPollutant: null,
  station: null,
  source: 'none',
  pollutants: EMPTY_POLLUTANTS,
};

function buildAirQuality(
  aqi: number,
  pollutants: Pollutants,
  source: 'waqi' | 'openweather',
  dominantPollutant: string | null,
  station: string | null
): AirQuality {
  const category = getAQICategory(aqi);
  return {
    aqi,
    level: category.level,
    color: category.color,
    advice: category.advice,
    dominantPollutant,
    station,
    source,
    pollutants,
  };
}

async function geocodeLocation(locationName: string, signal?: AbortSignal): Promise<GeocodingResult> {
  const query = locationName.trim();
  if (!query) {
    throw new WeatherError('Please enter a location name.', 'INVALID_INPUT');
  }
  requireOpenWeatherKey();

  const { value } = await cached(`geo:${query.toLowerCase()}`, CONFIG.geocodeTtlMs, false, async () => {
    const url = buildUrl(OW_BASE, '/geo/1.0/direct', { q: query, limit: 1, appid: OPENWEATHER_API_KEY });
    const data = await fetchJson<any[]>(url, signal);
    if (!data || data.length === 0) {
      throw new WeatherError(`Location "${query}" not found. Please try another city name.`, 'NOT_FOUND');
    }
    const item = data[0];
    const result: GeocodingResult = {
      name: item.name,
      country: item.country,
      lat: item.lat,
      lon: item.lon,
      state: item.state,
    };
    return result;
  });
  return value;
}

export async function searchLocations(query: string, limit = 5, signal?: AbortSignal): Promise<GeocodingResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  requireOpenWeatherKey();

  const url = buildUrl(OW_BASE, '/geo/1.0/direct', {
    q: trimmed,
    limit: clamp(limit, 1, 10),
    appid: OPENWEATHER_API_KEY,
  });
  const data = await fetchJson<any[]>(url, signal);
  return (data ?? []).map((item) => ({
    name: item.name,
    country: item.country,
    lat: item.lat,
    lon: item.lon,
    state: item.state,
  }));
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<GeocodingResult> {
  validateCoordinates(lat, lon);
  requireOpenWeatherKey();

  const url = buildUrl(OW_BASE, '/geo/1.0/reverse', { lat, lon, limit: 1, appid: OPENWEATHER_API_KEY });
  const data = await fetchJson<any[]>(url, signal);
  if (!data || data.length === 0) {
    return { name: `${round(lat, 2)}, ${round(lon, 2)}`, country: '', lat, lon };
  }
  const item = data[0];
  return { name: item.name, country: item.country, lat, lon, state: item.state };
}

export function getCurrentPosition(timeoutMs = 10000): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new WeatherError('Geolocation is not supported in this environment.', 'UNKNOWN'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => reject(new WeatherError('Unable to get your location. Permission may be denied.', 'UNKNOWN')),
      { timeout: timeoutMs, maximumAge: 5 * 60 * 1000 }
    );
  });
}

async function fetchOpenWeatherData(lat: number, lon: number, signal?: AbortSignal): Promise<any> {
  const url = buildUrl(OW_BASE, '/data/2.5/weather', { lat, lon, units: 'metric', appid: OPENWEATHER_API_KEY });
  return fetchJson<any>(url, signal);
}

async function fetchUVIndexData(lat: number, lon: number, signal?: AbortSignal): Promise<number> {
  try {
    const url = buildUrl(OW_BASE, '/data/2.5/uvi', { lat, lon, appid: OPENWEATHER_API_KEY });
    const data = await fetchJson<any>(url, signal);
    return typeof data.value === 'number' ? data.value : 0;
  } catch {
    return 0;
  }
}

async function fetchWaqiAirQuality(lat: number, lon: number, signal?: AbortSignal): Promise<AirQuality | null> {
  if (!WAQI_API_KEY) return null;
  try {
    const url = buildUrl(WAQI_BASE, `/feed/geo:${lat};${lon}/`, { token: WAQI_API_KEY });
    const data = await fetchJson<any>(url, signal);
    if (data.status !== 'ok' || !data.data || typeof data.data.aqi !== 'number') return null;

    const iaqi = data.data.iaqi ?? {};
    const pollutants: Pollutants = {
      pm25: iaqi.pm25?.v ?? 0,
      pm10: iaqi.pm10?.v ?? 0,
      o3: iaqi.o3?.v ?? 0,
      no2: iaqi.no2?.v ?? 0,
      so2: iaqi.so2?.v ?? 0,
      co: iaqi.co?.v ?? 0,
    };
    return buildAirQuality(
      data.data.aqi,
      pollutants,
      'waqi',
      data.data.dominentpol ?? null,
      data.data.city?.name ?? null
    );
  } catch {
    return null;
  }
}

async function fetchOpenWeatherAirQuality(lat: number, lon: number, signal?: AbortSignal): Promise<AirQuality | null> {
  try {
    const url = buildUrl(OW_BASE, '/data/2.5/air_pollution', { lat, lon, appid: OPENWEATHER_API_KEY });
    const data = await fetchJson<any>(url, signal);
    const components = data?.list?.[0]?.components;
    if (!components) return null;

    const pollutants: Pollutants = {
      pm25: round(components.pm2_5 ?? 0),
      pm10: round(components.pm10 ?? 0),
      o3: round(components.o3 ?? 0),
      no2: round(components.no2 ?? 0),
      so2: round(components.so2 ?? 0),
      co: round(components.co ?? 0),
    };
    return buildAirQuality(pm25ToAQI(pollutants.pm25), pollutants, 'openweather', 'pm25', null);
  } catch {
    return null;
  }
}

async function fetchAirQualityData(lat: number, lon: number, signal?: AbortSignal): Promise<AirQuality> {
  const primary = await fetchWaqiAirQuality(lat, lon, signal);
  if (primary) return primary;
  const fallback = await fetchOpenWeatherAirQuality(lat, lon, signal);
  return fallback ?? EMPTY_AIR_QUALITY;
}

function localIso(unixSeconds: number, timezoneOffset: number): string {
  return new Date((unixSeconds + timezoneOffset) * 1000).toISOString();
}

function formatLocalTime(unixSeconds: number, timezoneOffset: number): string {
  return localIso(unixSeconds, timezoneOffset).slice(11, 16);
}

function buildAdvisories(input: {
  tempC: number;
  heatIndexC: number | null;
  windChillC: number | null;
  windMs: number;
  gustMs: number;
  uv: number;
  aqi: number | null;
  visibilityKm: number;
  rainMm: number;
  snowMm: number;
  weatherId: number;
}): string[] {
  const list: string[] = [];
  const { tempC, heatIndexC, windChillC, windMs, gustMs, uv, aqi, visibilityKm, rainMm, snowMm, weatherId } = input;

  if (weatherId >= 200 && weatherId < 300) list.push('Thunderstorm activity nearby. Stay indoors and avoid open areas.');
  if (heatIndexC !== null && heatIndexC >= 41) list.push('Extreme heat risk. Limit outdoor activity and stay hydrated.');
  else if (heatIndexC !== null && heatIndexC >= 32) list.push('High heat index. Take breaks in shade and drink water often.');
  if (windChillC !== null && windChillC <= -27) list.push('Severe wind chill. Frostbite possible on exposed skin.');
  else if (tempC <= 0) list.push('Freezing temperatures. Watch for icy surfaces.');
  if (Math.max(windMs, gustMs) >= 17) list.push('Very strong winds. Secure loose objects and avoid travel if possible.');
  else if (Math.max(windMs, gustMs) >= 10.8) list.push('Strong winds expected. Take care when walking or cycling.');
  if (uv >= 8) list.push('Very high UV. Use SPF 30+, sunglasses and a hat.');
  else if (uv >= 6) list.push('High UV. Sun protection recommended.');
  if (aqi !== null && aqi > 150) list.push('Poor air quality. Reduce prolonged outdoor exertion.');
  else if (aqi !== null && aqi > 100) list.push('Air quality may affect sensitive groups.');
  if (visibilityKm < 1) list.push('Very low visibility. Drive carefully.');
  else if (visibilityKm < 5) list.push('Reduced visibility.');
  if (rainMm >= 7.5) list.push('Heavy rain. Possible flooding on low-lying roads.');
  else if (rainMm > 0) list.push('Rain in the area. Carry an umbrella.');
  if (snowMm > 0) list.push('Snowfall in the area. Expect slippery conditions.');

  return list;
}

function mostCommon<T>(items: T[]): T | undefined {
  const counts = new Map<T, number>();
  items.forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1));
  let best: T | undefined;
  let bestCount = 0;
  counts.forEach((count, item) => {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  });
  return best;
}

function parseForecast(raw: any, geo: GeocodingResult, units: UnitSystem): ForecastData {
  const offset: number = raw.city?.timezone ?? 0;
  const list: any[] = raw.list ?? [];

  const hourly: HourlyForecast[] = list.slice(0, 16).map((item) => ({
    time: new Date(item.dt * 1000).toISOString(),
    localTime: localIso(item.dt, offset).slice(0, 16).replace('T', ' '),
    temperature: convertTemperature(item.main?.temp ?? 0, units),
    feelsLike: convertTemperature(item.main?.feels_like ?? item.main?.temp ?? 0, units),
    humidity: item.main?.humidity ?? 0,
    windSpeed: convertSpeed(item.wind?.speed ?? 0, units),
    precipitationChance: Math.round((item.pop ?? 0) * 100),
    rainVolume: convertPrecipitation(item.rain?.['3h'] ?? 0, units),
    description: item.weather?.[0]?.description ?? 'Unknown',
    weatherMain: item.weather?.[0]?.main ?? 'Clear',
    weatherIcon: item.weather?.[0]?.icon ?? '01d',
  }));

  const grouped = new Map<string, any[]>();
  list.forEach((item) => {
    const key = localIso(item.dt, offset).slice(0, 10);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  });

  const daily: DailyForecast[] = Array.from(grouped.entries()).map(([date, items]) => {
    const temps = items.map((i) => i.main?.temp ?? 0);
    const mains = items.map((i) => i.weather?.[0]?.main ?? 'Clear');
    const dominant = mostCommon(mains) ?? 'Clear';
    const representative = items.find((i) => i.weather?.[0]?.main === dominant) ?? items[0];
    const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

    return {
      date,
      weekday,
      tempMin: convertTemperature(Math.min(...temps), units),
      tempMax: convertTemperature(Math.max(...temps), units),
      avgHumidity: Math.round(items.reduce((sum, i) => sum + (i.main?.humidity ?? 0), 0) / items.length),
      avgWindSpeed: convertSpeed(items.reduce((sum, i) => sum + (i.wind?.speed ?? 0), 0) / items.length, units),
      maxPrecipitationChance: Math.round(Math.max(...items.map((i) => i.pop ?? 0)) * 100),
      totalRain: convertPrecipitation(items.reduce((sum, i) => sum + (i.rain?.['3h'] ?? 0), 0), units),
      totalSnow: convertPrecipitation(items.reduce((sum, i) => sum + (i.snow?.['3h'] ?? 0), 0), units),
      weatherMain: dominant,
      weatherIcon: representative.weather?.[0]?.icon ?? '01d',
      description: representative.weather?.[0]?.description ?? 'Unknown',
    };
  });

  return {
    location: geo.name,
    country: geo.country,
    hourly,
    daily,
    units,
    unitLabels: getUnitLabels(units),
  };
}

async function loadForecast(geo: GeocodingResult, options: WeatherOptions): Promise<ForecastData> {
  const units = options.units ?? 'metric';
  const key = `forecast:${round(geo.lat, 2)}:${round(geo.lon, 2)}`;
  const { value } = await cached(key, CONFIG.forecastTtlMs, options.forceRefresh ?? false, async () => {
    const url = buildUrl(OW_BASE, '/data/2.5/forecast', {
      lat: geo.lat,
      lon: geo.lon,
      units: 'metric',
      cnt: 40,
      appid: OPENWEATHER_API_KEY,
    });
    return fetchJson<any>(url, options.signal);
  });
  return parseForecast(value, geo, units);
}

async function loadCurrent(geo: GeocodingResult, options: WeatherOptions): Promise<WeatherData> {
  const units = options.units ?? 'metric';
  const includeAir = options.includeAirQuality ?? true;
  const includeUV = options.includeUV ?? true;
  const key = `current:${round(geo.lat, 3)}:${round(geo.lon, 3)}:${includeAir}:${includeUV}`;

  const { value: raw, fromCache } = await cached(
    key,
    CONFIG.currentTtlMs,
    options.forceRefresh ?? false,
    async () => {
      const [weatherData, uvIndex, airQuality] = await Promise.all([
        fetchOpenWeatherData(geo.lat, geo.lon, options.signal),
        includeUV ? fetchUVIndexData(geo.lat, geo.lon, options.signal) : Promise.resolve(0),
        includeAir ? fetchAirQualityData(geo.lat, geo.lon, options.signal) : Promise.resolve(EMPTY_AIR_QUALITY),
      ]);
      return { weatherData, uvIndex, airQuality };
    }
  );

  const { weatherData, uvIndex, airQuality } = raw;
  const main = weatherData.main ?? {};
  const wind = weatherData.wind ?? {};
  const clouds = weatherData.clouds ?? {};
  const sys = weatherData.sys ?? {};
  const weather = weatherData.weather?.[0] ?? {};
  const rain = weatherData.rain ?? {};
  const snow = weatherData.snow ?? {};

  const tempC: number = main.temp ?? 0;
  const humidity: number = main.humidity ?? 0;
  const feelsC: number = main.feels_like ?? tempC;
  const windMs: number = wind.speed ?? 0;
  const gustMs: number = wind.gust ?? windMs;
  const offset: number = weatherData.timezone ?? 0;
  const observed: number = weatherData.dt ?? Math.floor(Date.now() / 1000);
  const sunrise: number = sys.sunrise ?? observed;
  const sunset: number = sys.sunset ?? observed;
  const visibilityKm = (weatherData.visibility ?? 10000) / 1000;
  const rainMm: number = rain['1h'] ?? rain['3h'] ?? 0;
  const snowMm: number = snow['1h'] ?? snow['3h'] ?? 0;

  const heatIndexC = calculateHeatIndex(tempC, humidity);
  const windChillC = calculateWindChill(tempC, windMs);
  const apparentC = heatIndexC ?? windChillC ?? feelsC;
  const aqiValue = airQuality.aqi;

  return {
    location: geo.name,
    country: geo.country,
    state: geo.state,
    temperature: convertTemperature(tempC, units),
    feelsLike: convertTemperature(feelsC, units),
    tempMin: convertTemperature(main.temp_min ?? tempC, units),
    tempMax: convertTemperature(main.temp_max ?? tempC, units),
    humidity,
    pressure: convertPressure(main.pressure ?? 1013, units),
    windSpeed: convertSpeed(windMs, units),
    windGust: convertSpeed(gustMs, units),
    windDirection: wind.deg ?? 0,
    windCompass: getCompassDirection(wind.deg ?? 0),
    beaufort: getBeaufort(windMs),
    visibility: convertDistance(visibilityKm, units),
    uvIndex,
    uvLevel: getUVLevel(uvIndex),
    precipitation: convertPrecipitation(rainMm, units),
    description: weather.description ?? 'Unknown',
    weatherMain: weather.main ?? 'Clear',
    weatherIcon: weather.icon ?? '01d',
    cloudCover: clouds.all ?? 0,
    coordinates: { lat: geo.lat, lon: geo.lon },
    timezoneOffset: offset,
    timestamp: new Date().toISOString(),
    observedAt: new Date(observed * 1000).toISOString(),
    localTime: formatLocalTime(observed, offset),
    sunrise: new Date(sunrise * 1000).toISOString(),
    sunset: new Date(sunset * 1000).toISOString(),
    sunriseLocal: formatLocalTime(sunrise, offset),
    sunsetLocal: formatLocalTime(sunset, offset),
    dayLengthMinutes: Math.max(0, Math.round((sunset - sunrise) / 60)),
    isDaytime: observed >= sunrise && observed < sunset,
    moonPhase: getMoonPhase(new Date(observed * 1000)),
    weatherCode: weather.id ?? 800,
    aqi: aqiValue ?? 0,
    aqiLevel: airQuality.level ?? 'Good',
    airQuality,
    pollutants: airQuality.pollutants,
    dewPoint: convertTemperature(calculateDewPoint(tempC, humidity), units),
    heatIndex: heatIndexC === null ? null : convertTemperature(heatIndexC, units),
    windChill: windChillC === null ? null : convertTemperature(windChillC, units),
    comfort: getComfortLabel(apparentC, humidity),
    rainVolume: convertPrecipitation(rainMm, units),
    snowVolume: convertPrecipitation(snowMm, units),
    advisories: buildAdvisories({
      tempC,
      heatIndexC,
      windChillC,
      windMs,
      gustMs,
      uv: uvIndex,
      aqi: aqiValue,
      visibilityKm,
      rainMm,
      snowMm,
      weatherId: weather.id ?? 800,
    }),
    units,
    unitLabels: getUnitLabels(units),
    fromCache,
  };
}

export async function fetchWeatherByLocation(
  locationName: string,
  options: WeatherOptions = {}
): Promise<WeatherData> {
  const geo = await geocodeLocation(locationName, options.signal);
  return loadCurrent(geo, options);
}

export async function fetchWeatherByCoordinates(
  lat: number,
  lon: number,
  options: WeatherOptions = {}
): Promise<WeatherData> {
  validateCoordinates(lat, lon);
  requireOpenWeatherKey();
  const geo = await reverseGeocode(lat, lon, options.signal);
  return loadCurrent(geo, options);
}

export async function fetchForecastByLocation(
  locationName: string,
  options: WeatherOptions = {}
): Promise<ForecastData> {
  const geo = await geocodeLocation(locationName, options.signal);
  return loadForecast(geo, options);
}

export async function fetchWeatherWithForecast(
  locationName: string,
  options: WeatherOptions = {}
): Promise<WeatherBundle> {
  const geo = await geocodeLocation(locationName, options.signal);
  const [current, forecast] = await Promise.all([
    loadCurrent(geo, options),
    loadForecast(geo, options).catch(() => null),
  ]);
  return { current, forecast };
}

export async function fetchWeatherForCurrentPosition(options: WeatherOptions = {}): Promise<WeatherBundle> {
  const { lat, lon } = await getCurrentPosition();
  validateCoordinates(lat, lon);
  requireOpenWeatherKey();
  const geo = await reverseGeocode(lat, lon, options.signal);
  const [current, forecast] = await Promise.all([
    loadCurrent(geo, options),
    loadForecast(geo, options).catch(() => null),
  ]);
  return { current, forecast };
}

export interface BatchResult {
  location: string;
  data?: WeatherData;
  error?: WeatherError;
}

export async function fetchMultipleLocations(
  locations: string[],
  options: WeatherOptions = {}
): Promise<BatchResult[]> {
  const unique = Array.from(new Set(locations.map((l) => l.trim()).filter(Boolean)));
  const results: BatchResult[] = new Array(unique.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const index = cursor++;
      const location = unique[index];
      try {
        results[index] = { location, data: await fetchWeatherByLocation(location, options) };
      } catch (error) {
        results[index] = {
          location,
          error: error instanceof WeatherError ? error : new WeatherError('Unexpected error.', 'UNKNOWN'),
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONFIG.maxBatchConcurrency, unique.length) }, worker);
  await Promise.all(workers);
  return results;
}

export function formatWeatherSummary(data: WeatherData): string {
  const { temperature, feelsLike, unitLabels: u } = data;
  const parts = [
    `${data.location}, ${data.country}: ${temperature}${u.temperature} (feels ${feelsLike}${u.temperature}), ${data.description}`,
    `Wind ${data.windSpeed} ${u.speed} ${data.windCompass}, humidity ${data.humidity}%`,
    `Comfort: ${data.comfort}`,
  ];
  if (data.airQuality.aqi !== null) {
    parts.push(`AQI ${data.airQuality.aqi} (${data.airQuality.level})`);
  }
  return parts.join(' | ');
}

export function getWeatherIconUrl(icon: string, size: '1x' | '2x' | '4x' = '2x'): string {
  const suffix = size === '1x' ? '' : `@${size}`;
  return `https://openweathermap.org/img/wn/${icon}${suffix}.png`;
}
