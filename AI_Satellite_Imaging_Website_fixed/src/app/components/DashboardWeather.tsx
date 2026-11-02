import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search,
  Cloud,
  Sunrise,
  Sunset,
  Wind,
  Droplets,
  Eye,
  Gauge,
  CloudRain,
  Thermometer,
  Activity,
  AlertTriangle,
  Compass,
  Navigation,
  MapPin,
  Clock,
  RefreshCw,
  Sun,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fetchWeatherByLocation } from '../services/weatherService';
import {
  POPULAR_CITIES,
  aqiScalePercent,
  convertDistance,
  convertPressure,
  convertPrecip,
  convertTemp,
  convertWind,
  degreesToCompass,
  distanceUnit,
  formatClock,
  formatDayLength,
  formatUpdated,
  getAqiStyle,
  getUvInfo,
  getWeatherInfo,
  precipUnit,
  pressureUnit,
  readStorage,
  safeFixed,
  tempSymbol,
  windUnit,
  writeStorage,
} from './weatherUtils';
import type { Unit, WeatherData } from './weatherUtils';

const DEFAULT_CITY = 'London';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_RECENT = 5;
const MAX_SUGGESTIONS = 8;
const UNIT_KEY = 'weather:unit';
const RECENT_KEY = 'weather:recent';

interface Suggestion {
  label: string;
  kind: 'recent' | 'popular';
}

const POLLUTANTS = [
  { key: 'pm25', label: 'PM2.5', digits: 1 },
  { key: 'pm10', label: 'PM10', digits: 1 },
  { key: 'o3', label: 'O₃', digits: 1 },
  { key: 'no2', label: 'NO₂', digits: 1 },
  { key: 'so2', label: 'SO₂', digits: 1 },
  { key: 'co', label: 'CO', digits: 0 },
] as const;

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

interface StatTileProps {
  icon: LucideIcon;
  label: string;
  value: string;
  unit?: string;
  iconClass?: string;
  compact?: boolean;
  extra?: ReactNode;
}

function StatTile({
  icon: Icon,
  label,
  value,
  unit,
  iconClass = 'text-cyan-400',
  compact = false,
  extra,
}: StatTileProps) {
  return (
    <div className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`${compact ? 'w-4 h-4' : 'w-5 h-5'} ${iconClass}`} aria-hidden="true" />
        <span className={`text-white/60 ${compact ? 'text-xs' : 'text-sm'}`}>{label}</span>
      </div>
      <div className={`text-white ${compact ? 'text-xl' : 'text-2xl'}`}>{value}</div>
      {unit && <div className="text-white/60 text-xs">{unit}</div>}
      {extra}
    </div>
  );
}

function WeatherSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-hidden="true">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 h-64 rounded-2xl bg-white/5 border border-white/10" />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-28 rounded-xl bg-white/5 border border-white/10" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-28 rounded-xl bg-white/5 border border-white/10" />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function DashboardWeather() {
  const listboxId = useId();
  const searchRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  const [query, setQuery] = useState('');
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [unit, setUnit] = useState<Unit>(() => {
    const stored = readStorage<string>(UNIT_KEY, 'metric');
    return stored === 'imperial' ? 'imperial' : 'metric';
  });
  const [recent, setRecent] = useState<string[]>(() => {
    const stored = readStorage<unknown>(RECENT_KEY, []);
    return Array.isArray(stored)
      ? stored.filter((c): c is string => typeof c === 'string').slice(0, MAX_RECENT)
      : [];
  });

  const currentCityRef = useRef<string>(recent[0] ?? DEFAULT_CITY);

  /* Persist preferences */
  useEffect(() => writeStorage(UNIT_KEY, unit), [unit]);
  useEffect(() => writeStorage(RECENT_KEY, recent), [recent]);

  /* Fetch weather. Only the most recent request is allowed to update state. */
  const loadWeather = useCallback(async (city: string) => {
    const trimmed = city.trim();
    if (!trimmed) return;

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setOpen(false);
    setActiveIndex(-1);

    try {
      const data = await fetchWeatherByLocation(trimmed);
      if (requestId !== requestIdRef.current) return;

      const label = data.location?.trim() || trimmed;
      currentCityRef.current = label;
      setWeather(data);
      setRecent((prev) =>
        [label, ...prev.filter((c) => c.toLowerCase() !== label.toLowerCase())].slice(0, MAX_RECENT),
      );
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Failed to fetch weather data. Please try another city.',
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  /* Initial load (invalidates in-flight requests on unmount) */
  useEffect(() => {
    void loadWeather(currentCityRef.current);
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadWeather]);

  /* Auto-refresh while the tab is visible */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadWeather(currentCityRef.current);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadWeather]);

  /* Close suggestions when clicking outside */
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  /* Suggestions: recent searches when empty, otherwise ranked matches */
  const suggestions = useMemo<Suggestion[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recent.map((label) => ({ label, kind: 'recent' as const }));

    const seen = new Set<string>();
    const result: Suggestion[] = [];
    const push = (label: string, kind: Suggestion['kind']) => {
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ label, kind });
    };

    recent.filter((c) => c.toLowerCase().includes(q)).forEach((c) => push(c, 'recent'));
    POPULAR_CITIES.filter((c) => c.toLowerCase().startsWith(q)).forEach((c) => push(c, 'popular'));
    POPULAR_CITIES.filter((c) => c.toLowerCase().includes(q)).forEach((c) => push(c, 'popular'));

    return result.slice(0, MAX_SUGGESTIONS);
  }, [query, recent]);

  const showDropdown = open && suggestions.length > 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const picked = showDropdown && activeIndex >= 0 ? suggestions[activeIndex]?.label : undefined;
    const target = picked ?? query;
    if (!target.trim()) return;
    setQuery('');
    void loadWeather(target);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (suggestions.length === 0) return;
      setOpen(true);
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (suggestions.length === 0) return;
      setOpen(true);
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  const handleSuggestionClick = (city: string) => {
    setQuery('');
    void loadWeather(city);
  };

  /* Derived display values */
  const aqiStyle = weather ? getAqiStyle(weather.aqiLevel) : null;
  const weatherInfo = weather ? getWeatherInfo(weather.weatherCode) : null;
  const uvInfo = weather ? getUvInfo(weather.uvIndex) : null;
  const compass = weather ? degreesToCompass(weather.windDirection) : '—';
  const showAqi = weather !== null && weather.aqi > 0 && aqiStyle !== null;

  return (
    <div className="col-span-3 backdrop-blur-md bg-gradient-to-br from-indigo-900/20 to-purple-900/20 border border-white/10 rounded-2xl p-6 shadow-2xl">
      {/* Screen-reader announcements */}
      <div className="sr-only" aria-live="polite">
        {loading ? 'Loading weather data' : weather ? `Weather updated for ${weather.location}` : ''}
      </div>

      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-white text-xl flex items-center gap-2">
            <Cloud className="w-6 h-6 text-cyan-400" aria-hidden="true" />
            Global Weather Forecast
          </h3>

          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Measurement units"
              className="flex rounded-lg border border-white/20 overflow-hidden text-sm"
            >
              {(['metric', 'imperial'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setUnit(value)}
                  aria-pressed={unit === value}
                  className={`px-3 py-1.5 transition-colors duration-200 ${
                    unit === value
                      ? 'bg-cyan-500/30 text-white'
                      : 'text-white/60 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {value === 'metric' ? '°C' : '°F'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void loadWeather(currentCityRef.current)}
              disabled={loading}
              aria-label="Refresh weather data"
              className="p-2 rounded-lg border border-white/20 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-50 transition-colors duration-200"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div ref={searchRef} className="relative">
          <form onSubmit={handleSubmit} role="search" className="relative">
            <Search
              className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/40"
              aria-hidden="true"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setActiveIndex(-1);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder="Search for any city..."
              aria-label="Search for a city"
              role="combobox"
              aria-expanded={showDropdown}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                showDropdown && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
              }
              autoComplete="off"
              spellCheck={false}
              className="w-full pl-12 pr-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-white/40 focus:outline-none focus:border-cyan-400/50 focus:bg-white/15 transition-all duration-300"
            />
          </form>

          <AnimatePresence>
            {showDropdown && (
              <motion.ul
                id={listboxId}
                role="listbox"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute top-full left-0 right-0 mt-2 backdrop-blur-md bg-slate-900/90 border border-white/20 rounded-xl overflow-hidden shadow-2xl z-50 max-h-60 overflow-y-auto"
              >
                {suggestions.map((item, index) => (
                  <li
                    key={`${item.kind}-${item.label}`}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => handleSuggestionClick(item.label)}
                      className={`w-full px-4 py-3 text-left flex items-center gap-2 transition-colors duration-150 ${
                        index === activeIndex ? 'bg-white/15 text-white' : 'text-white/80 hover:bg-white/10'
                      }`}
                    >
                      {item.kind === 'recent' ? (
                        <Clock className="w-4 h-4 text-white/40" aria-hidden="true" />
                      ) : (
                        <MapPin className="w-4 h-4 text-cyan-400" aria-hidden="true" />
                      )}
                      <span>{item.label}</span>
                      {item.kind === 'recent' && (
                        <span className="ml-auto text-xs text-white/40">Recent</span>
                      )}
                    </button>
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>

        {/* Inline error */}
        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-4"
          >
            <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="flex-1 text-sm text-white/80">{error}</div>
            <button
              type="button"
              onClick={() => void loadWeather(currentCityRef.current)}
              className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Weather display */}
      {!weather && loading ? (
        <WeatherSkeleton />
      ) : weather && weatherInfo && uvInfo ? (
        <div
          className={`space-y-6 transition-opacity duration-300 ${loading ? 'opacity-60' : 'opacity-100'}`}
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main card */}
            <div className="lg:col-span-2 backdrop-blur-md bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-cyan-500/30 rounded-2xl p-6">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h4 className="text-white text-3xl mb-1">{weather.location}</h4>
                  <p className="text-white/60">{weather.country}</p>
                  <p className="text-white/40 text-sm mt-1">
                    {safeFixed(weather.coordinates?.lat, 2)}°, {safeFixed(weather.coordinates?.lon, 2)}°
                  </p>
                </div>
                <div className="text-6xl" role="img" aria-label={weatherInfo.label}>
                  {weatherInfo.emoji}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <div className="text-white/60 text-sm mb-2">Temperature</div>
                  <div className="text-white text-5xl mb-2">
                    {safeFixed(convertTemp(weather.temperature, unit), 1)}
                    {tempSymbol(unit)}
                  </div>
                  <div className="text-white/80">
                    Feels like {safeFixed(convertTemp(weather.feelsLike, unit), 1)}
                    {tempSymbol(unit)}
                  </div>
                  <div className="text-cyan-400 mt-1 capitalize">
                    {weather.description || weatherInfo.label}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <StatTile
                    icon={Sunrise}
                    label="Sunrise"
                    value={formatClock(weather.sunrise)}
                    iconClass="text-orange-400"
                  />
                  <StatTile
                    icon={Sunset}
                    label="Sunset"
                    value={formatClock(weather.sunset)}
                    iconClass="text-pink-400"
                  />
                  <div className="col-span-2 flex items-center gap-2 text-sm text-white/60">
                    <Sun className="w-4 h-4 text-yellow-400" aria-hidden="true" />
                    Daylight: {formatDayLength(weather.sunrise, weather.sunset)}
                  </div>
                </div>
              </div>
            </div>

            {/* Quick stats */}
            <div className="grid grid-cols-2 gap-3">
              <StatTile
                compact
                icon={Wind}
                label="Wind"
                value={safeFixed(convertWind(weather.windSpeed, unit), 1)}
                unit={windUnit(unit)}
              />
              <StatTile
                compact
                icon={Droplets}
                label="Humidity"
                value={safeFixed(weather.humidity, 0)}
                unit="%"
                iconClass="text-blue-400"
              />
              <StatTile
                compact
                icon={Gauge}
                label="Pressure"
                value={safeFixed(convertPressure(weather.pressure, unit), unit === 'metric' ? 0 : 2)}
                unit={pressureUnit(unit)}
                iconClass="text-purple-400"
              />
              <StatTile
                compact
                icon={Eye}
                label="Visibility"
                value={safeFixed(convertDistance(weather.visibility, unit), 1)}
                unit={distanceUnit(unit)}
                iconClass="text-green-400"
              />
            </div>
          </div>

          {/* Secondary stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatTile
              icon={Cloud}
              label="Cloud Cover"
              value={`${safeFixed(weather.cloudCover, 0)}%`}
              unit="Coverage"
              iconClass="text-gray-400"
            />
            <StatTile
              icon={Compass}
              label="Wind Direction"
              value={`${safeFixed(weather.windDirection, 0)}°`}
              iconClass="text-cyan-400"
              extra={
                <div className="mt-1 flex items-center gap-2 text-white/60 text-xs">
                  <Navigation
                    className="w-3.5 h-3.5 text-cyan-400 transition-transform duration-500"
                    style={{ transform: `rotate(${(weather.windDirection || 0) + 180}deg)` }}
                    aria-hidden="true"
                  />
                  From {compass}
                </div>
              }
            />
            <StatTile
              icon={Thermometer}
              label="UV Index"
              value={safeFixed(weather.uvIndex, 1)}
              iconClass="text-orange-400"
              extra={<div className={`text-xs ${uvInfo.className}`}>{uvInfo.label}</div>}
            />
            <StatTile
              icon={CloudRain}
              label="Precipitation"
              value={safeFixed(convertPrecip(weather.precipitation, unit), unit === 'metric' ? 1 : 2)}
              unit={precipUnit(unit)}
              iconClass="text-blue-400"
            />
          </div>
        </div>
      ) : !error ? (
        <div className="text-center py-12 text-white/60">Search for a city to view weather data</div>
      ) : null}

      {/* Air quality */}
      {showAqi && weather && aqiStyle && (
        <div className="mt-6">
          <div
            className={`backdrop-blur-md bg-gradient-to-br ${aqiStyle.bg} border ${aqiStyle.border} rounded-2xl p-6`}
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Activity className={`w-6 h-6 ${aqiStyle.text}`} aria-hidden="true" />
                  <h4 className="text-white text-xl">Air Quality Index (AQI)</h4>
                </div>
                <p className="text-white/60 text-sm">Latest available air quality data</p>
              </div>
              <div className="text-center">
                <div className={`text-5xl ${aqiStyle.text} mb-2`}>{safeFixed(weather.aqi, 0)}</div>
                <div
                  className={`px-4 py-1 bg-gradient-to-br ${aqiStyle.bg} border ${aqiStyle.border} rounded-full ${aqiStyle.text} text-sm`}
                >
                  {weather.aqiLevel}
                </div>
              </div>
            </div>

            {/* AQI scale */}
            <div className="mb-6">
              <div className="relative h-2 rounded-full bg-gradient-to-r from-green-400 via-yellow-400 via-orange-400 via-red-500 to-purple-600">
                <div
                  className="absolute top-1/2 w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-900 shadow-lg transition-all duration-500"
                  style={{ left: `${aqiScalePercent(weather.aqi)}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 text-xs text-white/40">
                <span>0</span>
                <span>100</span>
                <span>200</span>
                <span>300+</span>
              </div>
            </div>

            <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
              {POLLUTANTS.map(({ key, label, digits }) => (
                <div
                  key={key}
                  className="backdrop-blur-md bg-white/5 border border-white/10 rounded-xl p-3"
                >
                  <div className="text-white/60 text-xs mb-1">{label}</div>
                  <div className="text-white text-lg">{safeFixed(weather.pollutants?.[key], digits)}</div>
                  <div className="text-white/40 text-xs">µg/m³</div>
                </div>
              ))}
            </div>

            <div className="mt-4 p-4 backdrop-blur-md bg-white/5 border border-white/10 rounded-xl">
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className={`w-5 h-5 ${aqiStyle.text} mt-0.5 shrink-0`}
                  aria-hidden="true"
                />
                <div>
                  <div className="text-white text-sm mb-1">Health Advisory</div>
                  <div className="text-white/80 text-sm">{aqiStyle.advisory}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {weather && (
        <div className="mt-4 text-center text-white/40 text-xs">
          Last updated: {formatUpdated(weather.timestamp)}
        </div>
      )}
    </div>
  );
}
