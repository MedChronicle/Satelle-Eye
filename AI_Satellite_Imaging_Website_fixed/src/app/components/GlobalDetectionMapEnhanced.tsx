import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, Loader2, AlertTriangle, ZoomIn, ZoomOut, Play, MapPin, Sparkles, Download,
  Share2, Settings, Send, Pause, RotateCcw, Maximize2, Filter, TrendingUp, AlertCircle,
  Shield, Brain, Zap, X, History, Calendar, Search, Clock, Crosshair, type LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { NaturalEvent } from '../services/eonetService';
import {
  refreshDisasterData, getEventSeverity, getSeverityColor,
} from '../services/disasterBackendService';
import {
  generateGlobalPredictions, DisasterPrediction, PredictionResponse,
} from '../services/geminiPredictionService';
import { PredictionHistoryService, HistoryEntry } from '../services/predictionHistoryService';
import { DetectionMapCanvas, MapMarker } from './DetectionMapCanvas';
import { useInterval } from '../hooks/useInterval';
import { downloadBlob, todayStamp } from '../utils/downloadBlob';

interface GlobalDetectionMapProps {
  onNavigateToAIAnalysis?: () => void;
}

// ---------------------------------------------------------------- constants
const POLL_MS = 30_000;
const SCAN_MS = 10_000; // faster polling while "scanning" is on
const AUTO_PREDICT_S = 20;

const TYPE_OPTIONS = [
  ['all', 'All Types'], ['wildfires', '🔥 Wildfires'], ['volcanoes', '🌋 Volcanoes'],
  ['severeStorms', '⛈️ Severe Storms'], ['floods', '🌊 Floods'], ['drought', '☀️ Drought'],
] as const;
const SEVERITY_OPTIONS = [
  ['all', 'All Severities'], ['Critical', '🔴 Critical'], ['High', '🟠 High'],
  ['Medium', '🟡 Medium'], ['Low', '🔵 Low'],
] as const;
const TIMEFRAMES = ['Next Day', 'Next Week', 'Next Month', 'Next Year', 'Next 10 Years'];

const SEVERITY_BADGE: Record<string, string> = {
  Critical: 'bg-red-500/20 text-red-400 border-red-400/30',
  High: 'bg-orange-500/20 text-orange-400 border-orange-400/30',
  Medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-400/30',
  Low: 'bg-cyan-500/20 text-cyan-400 border-cyan-400/30',
};
const badgeClass = (s: string) => SEVERITY_BADGE[s] ?? SEVERITY_BADGE.Low;

const SEVERITY_CARDS = [
  ['Critical', 'red'], ['High', 'orange'], ['Medium', 'yellow'], ['Low', 'cyan'],
] as const;
const CARD_STYLE: Record<string, string> = {
  red: 'bg-red-500/10 border-red-400/30 text-red-400',
  orange: 'bg-orange-500/10 border-orange-400/30 text-orange-400',
  yellow: 'bg-yellow-500/10 border-yellow-400/30 text-yellow-400',
  cyan: 'bg-cyan-500/10 border-cyan-400/30 text-cyan-400',
};

// ---------------------------------------------------------------- small UI pieces
interface Toast { id: number; text: string; kind: 'ok' | 'warn' | 'error' }

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 30 }}
            className={`max-w-sm whitespace-pre-line rounded-xl border px-4 py-3 text-sm backdrop-blur-xl shadow-xl ${
              t.kind === 'ok' ? 'bg-green-500/15 border-green-400/40 text-green-200'
              : t.kind === 'warn' ? 'bg-orange-500/15 border-orange-400/40 text-orange-200'
              : 'bg-red-500/15 border-red-400/40 text-red-200'
            }`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Modal({
  onClose, children, className = 'max-w-md', border = 'border-cyan-400/30', label,
}: { onClose: () => void; children: ReactNode; className?: string; border?: string; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        role="dialog" aria-modal="true" aria-label={label}
        initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
        className={`w-full ${className} rounded-3xl border ${border} bg-gradient-to-br from-black/90 to-black/80 p-8 shadow-2xl backdrop-blur-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

// Full class strings so Tailwind's compiler can see them (it can't resolve `bg-${color}-500`).
const BUTTON_COLORS = {
  purple: { on: 'bg-purple-500/20 border-purple-400/50 shadow-lg shadow-purple-500/20', off: 'bg-white/5 border-purple-400/30 hover:bg-purple-500/10 hover:border-purple-400/50', icon: 'text-purple-400' },
  yellow: { on: 'bg-yellow-500/20 border-yellow-400/50 shadow-lg shadow-yellow-500/20', off: 'bg-white/5 border-yellow-400/30 hover:bg-yellow-500/10 hover:border-yellow-400/50', icon: 'text-yellow-400' },
  cyan: { on: 'bg-cyan-500/20 border-cyan-400/50 shadow-lg shadow-cyan-500/20', off: 'bg-white/5 border-cyan-400/30 hover:bg-cyan-500/10 hover:border-cyan-400/50', icon: 'text-cyan-400' },
  green: { on: 'bg-green-500/20 border-green-400/50 shadow-lg shadow-green-500/20', off: 'bg-white/5 border-green-400/30 hover:bg-green-500/10 hover:border-green-400/50', icon: 'text-green-400' },
  blue: { on: 'bg-blue-500/20 border-blue-400/50 shadow-lg shadow-blue-500/20', off: 'bg-white/5 border-blue-400/30 hover:bg-blue-500/10 hover:border-blue-400/50', icon: 'text-blue-400' },
  orange: { on: 'bg-orange-500/20 border-orange-400/50 shadow-lg shadow-orange-500/20', off: 'bg-white/5 border-orange-400/30 hover:bg-orange-500/10 hover:border-orange-400/50', icon: 'text-orange-400' },
} as const;

function MissionButton({
  icon: Icon, label, color, active, busy, onClick, disabled, children,
}: {
  icon: LucideIcon; label: string; color: keyof typeof BUTTON_COLORS; active?: boolean; busy?: boolean;
  onClick: () => void; disabled?: boolean; children?: ReactNode;
}) {
  const c = BUTTON_COLORS[color];
  return (
    <motion.button
      whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
      onClick={onClick} disabled={disabled}
      aria-pressed={active}
      className={`group relative flex flex-col items-center gap-3 rounded-2xl border p-5 backdrop-blur-md transition-all duration-300 disabled:opacity-60 ${
        active ? c.on : c.off
      }`}
    >
      {busy ? <Loader2 className={`h-6 w-6 animate-spin ${c.icon}`} />
            : <Icon className={`h-6 w-6 ${c.icon} transition-transform group-hover:scale-110`} />}
      <span className="text-sm text-white">{label}</span>
      {children}
    </motion.button>
  );
}

/** Ambient particle network. Only animates while on screen; resizes with its parent. */
function ParticleBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const fit = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    const ps = Array.from({ length: 50 }, () => ({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      v: 0.5 + Math.random(), r: 1 + Math.random() * 2,
      c: Math.random() > 0.5 ? '#00ffff' : '#a855f7',
    }));
    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!visible) return;
      ctx.fillStyle = 'rgba(0,0,0,0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.y += p.v;
        if (p.y > canvas.height) { p.y = 0; p.x = Math.random() * canvas.width; }
        // each pair once (the original compared every pair twice, and itself)
        for (let j = i + 1; j < ps.length; j++) {
          const q = ps[j];
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d < 100) {
            ctx.strokeStyle = `rgba(0,255,255,${0.1 * (1 - d / 100)})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
      }
    };
    tick();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, []);
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full opacity-30" />;
}

function HistoryList({
  entries, onRestore, compact,
}: { entries: HistoryEntry[]; onRestore: (e: HistoryEntry) => void; compact?: boolean }) {
  if (entries.length === 0) {
    return (
      <div className="py-12 text-center text-white/30">
        <History className="mx-auto mb-4 h-10 w-10 opacity-50" />
        No history available yet.
      </div>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <button
          key={entry.id}
          onClick={() => onRestore(entry)}
          className="group w-full rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-all hover:border-cyan-400/30 hover:bg-white/10"
        >
          <div className="mb-2 flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-medium text-white">{new Date(entry.timestamp).toLocaleDateString()}</span>
              <span className="text-xs text-white/40">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            </div>
            <span className={`rounded border px-2 py-0.5 text-xs ${badgeClass(entry.riskLevel)}`}>
              {entry.riskLevel}{compact ? '' : ' Risk'}
            </span>
          </div>
          <p className={`text-sm text-white/60 ${compact ? 'line-clamp-2' : 'mb-3'}`}>{entry.summary}</p>
          {!compact && (
            <span className="rounded bg-black/40 px-2 py-1 text-xs text-white/40 transition-colors group-hover:text-cyan-400">
              {entry.predictions.length} Predictions
            </span>
          )}
        </button>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- main component
export function GlobalDetectionMapEnhanced({ onNavigateToAIAnalysis }: GlobalDetectionMapProps) {
  void onNavigateToAIAnalysis; // kept for API compatibility

  // data
  const [events, setEvents] = useState<NaturalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [scanning, setScanning] = useState(false);

  // map
  const [zoom, setZoom] = useState(1);
  const [recenter, setRecenter] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  // modals / actions
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [showLocationInput, setShowLocationInput] = useState(false);
  const [locationInput, setLocationInput] = useState({ lat: '', lon: '' });
  const [locationAnalysis, setLocationAnalysis] = useState<any>(null);
  const [analyzingLocation, setAnalyzingLocation] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const notifTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // predictions
  const [predictions, setPredictions] = useState<DisasterPrediction[]>([]);
  const [predictionResponse, setPredictionResponse] = useState<PredictionResponse | null>(null);
  const [loadingPredictions, setLoadingPredictions] = useState(false);
  const loadingRef = useRef(false);
  const [showPredictionsPanel, setShowPredictionsPanel] = useState(false);
  const [selectedPrediction, setSelectedPrediction] = useState<DisasterPrediction | null>(null);
  const [autoPredict, setAutoPredict] = useState(false);
  const [nextPredictionIn, setNextPredictionIn] = useState(AUTO_PREDICT_S);
  const [predictionSearch, setPredictionSearch] = useState('');
  const [predictionTimeframe, setPredictionTimeframe] = useState('Next Week');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  // toasts replace alert()
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  // ------------------------------------------------ derived data (memoised)
  const enriched = useMemo(
    () =>
      (events || []).map((event) => {
        const g = event.geometry[event.geometry.length - 1];
        const point = g && g.type === 'Point' ? { lon: g.coordinates[0] as number, lat: g.coordinates[1] as number } : null;
        return { event, severity: getEventSeverity(event) as string, point };
      }),
    [events]
  );

  const filtered = useMemo(
    () =>
      enriched.filter(
        (e) =>
          (severityFilter === 'all' || e.severity === severityFilter) &&
          (typeFilter === 'all' || (e.event.categories[0]?.id || '') === typeFilter)
      ),
    [enriched, severityFilter, typeFilter]
  );

  const severityCounts = useMemo(() => {
    const c: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    filtered.forEach((e) => { c[e.severity] = (c[e.severity] ?? 0) + 1; });
    return c;
  }, [filtered]);

  const markers: MapMarker[] = useMemo(
    () =>
      filtered
        .filter((e) => e.point)
        .map((e) => ({ id: e.event.id, lat: e.point!.lat, lon: e.point!.lon, color: getSeverityColor(e.severity as any) })),
    [filtered]
  );

  const selected = useMemo(() => filtered.find((e) => e.event.id === selectedId) ?? null, [filtered, selectedId]);

  // drop the selection if a filter hides it
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selected, selectedId]);

  // ------------------------------------------------ data polling
  const fetchData = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const update = await refreshDisasterData();
      setEvents(update.allEvents);
      setLastUpdate(new Date());
    } catch (err) {
      console.error('Error fetching disaster data:', err);
      if (!initial) notify('Live refresh failed. Retrying on the next cycle.', 'warn');
    } finally {
      if (initial) setLoading(false);
    }
  }, [notify]);

  useEffect(() => { fetchData(true); }, [fetchData]);
  // One poller. "Start Scan" simply polls faster (previously it ran a second duplicate poller).
  useInterval(() => fetchData(), scanning ? SCAN_MS : POLL_MS);

  useEffect(() => { setHistory(PredictionHistoryService.getHistory()); }, []);

  // ------------------------------------------------ predictions
  const generatePredictions = useCallback(async (silent = false) => {
    if (loadingRef.current) return; // never overlap requests
    loadingRef.current = true;
    setLoadingPredictions(true);
    setShowPredictionsPanel(true);
    setShowHistory(false);
    try {
      const response = await generateGlobalPredictions(predictionSearch, predictionTimeframe);
      setPredictionResponse(response);
      setPredictions(response.predictions);
      setSelectedPrediction(null);
      setNextPredictionIn(AUTO_PREDICT_S);
      setHistory(PredictionHistoryService.addEntry(response));
      if (!silent) {
        const crit = response.predictions.filter((p) => p.severity === 'Critical').length;
        notify(`Predictions ready: ${response.totalPredictions} total, ${crit} critical. Global risk: ${response.globalRiskLevel}`);
      }
    } catch (err) {
      console.error('Prediction generation failed:', err);
      if (!silent) notify('Gemini API error. Check the console for details.', 'error');
    } finally {
      loadingRef.current = false;
      setLoadingPredictions(false);
    }
  }, [predictionSearch, predictionTimeframe, notify]);

  // Interval always calls the latest generatePredictions (fixes stale search/timeframe).
  useInterval(() => generatePredictions(true), autoPredict ? AUTO_PREDICT_S * 1000 : null);
  useInterval(() => setNextPredictionIn((n) => (n <= 1 ? AUTO_PREDICT_S : n - 1)), autoPredict ? 1000 : null);

  const toggleAutoPredict = () => {
    if (autoPredict) {
      setAutoPredict(false);
      notify('Auto-predictions disabled', 'warn');
    } else {
      setAutoPredict(true);
      setNextPredictionIn(AUTO_PREDICT_S);
      generatePredictions(true);
      notify(`Auto-predictions enabled (every ${AUTO_PREDICT_S}s)`);
    }
  };

  const restoreHistoryEntry = (entry: HistoryEntry) => {
    setPredictions(entry.predictions);
    setSelectedPrediction(null);
    setPredictionResponse({
      predictions: entry.predictions,
      globalRiskLevel: entry.riskLevel,
      totalPredictions: entry.predictions.length,
      lastUpdated: new Date(entry.timestamp),
      dataSource: 'Historical Archive',
    } as PredictionResponse);
    setShowHistory(false);
    setShowHistoryModal(false);
    setShowPredictionsPanel(true);
  };

  const clearHistory = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    PredictionHistoryService.clearHistory();
    setHistory([]);
    setConfirmClear(false);
  };

  const exportHistory = () =>
    downloadBlob(PredictionHistoryService.exportHistory(), `prediction-history-${todayStamp()}.json`, 'application/json');

  const archiveStats = useMemo(() => {
    const all = history.flatMap((h) => h.predictions);
    return { sessions: history.length, points: all.length, locations: new Set(all.map((p) => p.location)).size };
  }, [history]);

  // ------------------------------------------------ actions
  const exportData = async () => {
    setExporting(true);
    try {
      const { exportDisasterData } = await import('../services/reportBackendService');
      const result = await exportDisasterData(filtered.map((f) => f.event), severityFilter, typeFilter);
      if (result.success) downloadBlob(result.data, `disaster-report-${todayStamp()}.csv`, 'text/csv');
      else notify('Export returned no data.', 'warn');
    } catch (err) {
      console.error('Export failed:', err);
      notify('Failed to export data. Please try again.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const sendEmail = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
      notify('Please enter a valid email address.', 'warn');
      return;
    }
    setSharing(true);
    try {
      const { sendReportEmail } = await import('../services/emailService');
      const result = await sendReportEmail(emailInput, filtered.map((f) => f.event), severityFilter, typeFilter);
      if (result.success) {
        notify(`Report sent to ${emailInput}`);
        setShowEmailModal(false);
        setEmailInput('');
      } else {
        notify(`Failed to send email: ${result.message}`, 'error');
      }
    } catch (err) {
      console.error('Email failed:', err);
      notify('Failed to send email. Please try again.', 'error');
    } finally {
      setSharing(false);
    }
  };

  const analyzeLocation = async () => {
    const lat = parseFloat(locationInput.lat);
    const lon = parseFloat(locationInput.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      notify('Enter valid coordinates:\nLatitude -90 to 90, Longitude -180 to 180', 'warn');
      return;
    }
    setAnalyzingLocation(true);
    try {
      const { analyzeLocation: run } = await import('../services/locationAnalysisService');
      setLocationAnalysis(await run(lat, lon));
    } catch (err) {
      console.error('Analysis failed:', err);
      notify('Failed to analyze location. Please try again.', 'error');
    } finally {
      setAnalyzingLocation(false);
    }
  };

  const stopNotifications = useCallback(async () => {
    if (!notifTimer.current) return;
    const { stopNotificationService } = await import('../services/notificationService');
    stopNotificationService(notifTimer.current);
    notifTimer.current = null;
  }, []);

  const toggleNotifications = async () => {
    if (notificationsEnabled) {
      await stopNotifications();
      setNotificationsEnabled(false);
      notify('Disaster predictions disabled', 'warn');
      return;
    }
    const { startNotificationService, requestNotificationPermission, subscribeToNotifications } =
      await import('../services/notificationService');
    if (!(await requestNotificationPermission())) {
      notify('Browser notifications are blocked. Enable them in your browser settings for alerts.', 'warn');
    }
    notifTimer.current = startNotificationService();
    subscribeToNotifications((payload: any) => {
      if (payload.urgentCount > 0) notify(`URGENT: ${payload.summary}`, 'error');
    });
    setNotificationsEnabled(true);
    notify('Disaster predictions enabled. Checking every 15 seconds for threats in the next 7 days.');
  };

  // stop the notification timer when the component unmounts
  useEffect(() => () => { void stopNotifications(); }, [stopNotifications]);

  const zoomBy = (d: number) => setZoom((z) => Math.max(0.5, Math.min(3, +(z + d).toFixed(2))));
  const resetFilters = () => { setSeverityFilter('all'); setTypeFilter('all'); };

  const emptyLabel =
    typeFilter === 'all' ? 'environmental events'
    : ({ wildfires: 'wildfires', volcanoes: 'volcanic activity', floods: 'floods', drought: 'drought events' } as Record<string, string>)[typeFilter] ?? typeFilter;

  // ================================================================= render
  return (
    <div className="space-y-6">
      <Toasts toasts={toasts} />

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 via-blue-500/10 to-purple-500/10 p-8 backdrop-blur-xl"
      >
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="mb-2 flex items-center gap-3 text-3xl font-light text-white">
              <div className="rounded-2xl border border-cyan-400/30 bg-cyan-500/20 p-3">
                <Activity className="h-8 w-8 text-cyan-400" />
              </div>
              Global Detection Map
            </h3>
            <p className="ml-16 text-white/60">Real-time planetary monitoring with NASA EONET integration</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 rounded-2xl border border-cyan-400/30 bg-black/40 px-5 py-3 backdrop-blur-xl">
              <div className={`h-3 w-3 rounded-full bg-cyan-400 shadow-lg shadow-cyan-400/50 ${scanning ? 'animate-ping' : 'animate-pulse'}`} />
              <span className="font-mono text-sm text-cyan-400">{scanning ? 'SCANNING' : 'LIVE'}</span>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/40 px-5 py-3 backdrop-blur-xl">
              <span className="text-sm text-white/80">Zoom: </span>
              <span className="font-mono text-white">{(zoom * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>
        <div className="relative z-10 mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {SEVERITY_CARDS.map(([label, color]) => (
            <div key={label} className={`rounded-2xl border p-4 backdrop-blur-md ${CARD_STYLE[color]}`}>
              <div className="mb-1 text-xs uppercase tracking-wider">{label}</div>
              <div className="text-3xl font-light text-white">{severityCounts[label]}</div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Mission control */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <Settings className="h-5 w-5 text-purple-400" />
          <h4 className="text-lg text-white">Mission Control</h4>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <MissionButton icon={scanning ? Pause : Play} label={scanning ? 'Stop Scan' : 'Start Scan'} color="purple"
            active={scanning}
            onClick={() => { setScanning((s) => !s); notify(scanning ? 'Fast scanning stopped' : `Fast scanning started (every ${SCAN_MS / 1000}s)`); }}>
            {scanning && <div className="h-1 w-full animate-pulse rounded-full bg-purple-500/50" />}
          </MissionButton>
          <MissionButton icon={MapPin} label="Track Location" color="yellow" onClick={() => setShowLocationInput(true)} />
          <MissionButton icon={Brain} label={autoPredict ? `Auto: ${nextPredictionIn}s` : 'Prediction'} color="cyan"
            active={autoPredict} busy={loadingPredictions} onClick={toggleAutoPredict} disabled={loadingPredictions}>
            {autoPredict && <div className="h-1 w-full animate-pulse rounded-full bg-gradient-to-r from-cyan-500 to-purple-500" />}
          </MissionButton>
          <MissionButton icon={Download} label="Export Data" color="green" busy={exporting} onClick={exportData} disabled={exporting} />
          <MissionButton icon={Share2} label="Share Report" color="blue" busy={sharing} onClick={() => setShowEmailModal(true)} />
          <MissionButton icon={Shield} label="Configure" color="orange" active={notificationsEnabled} onClick={() => setShowConfigModal(true)}>
            {notificationsEnabled && <div className="h-1 w-full animate-pulse rounded-full bg-orange-500/50" />}
          </MissionButton>
          <MissionButton icon={History} label="History" color="purple" onClick={() => setShowHistoryModal(true)} />
        </div>
      </motion.div>

      {/* Filters */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
        className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <Filter className="h-5 w-5 text-cyan-400" />
          <h4 className="text-lg text-white">Detection Filters</h4>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {([
            ['Detection Type', 'bg-cyan-400', typeFilter, setTypeFilter, TYPE_OPTIONS],
            ['Severity Level', 'bg-orange-400', severityFilter, setSeverityFilter, SEVERITY_OPTIONS],
          ] as const).map(([label, dot, value, set, opts]) => (
            <label key={label} className="block">
              <span className="mb-3 flex items-center gap-2 text-sm text-white/80">
                <span className={`h-2 w-2 rounded-full ${dot}`} />
                {label}
              </span>
              <select
                value={value} onChange={(e) => set(e.target.value)}
                className="w-full rounded-2xl border border-white/20 bg-black/40 px-5 py-3 text-white backdrop-blur-xl transition-all focus:border-cyan-400/50 focus:bg-black/60 focus:outline-none"
              >
                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          ))}
          <div className="flex items-end">
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={resetFilters}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-500 px-5 py-3 text-white shadow-lg shadow-cyan-500/20 transition-all hover:from-cyan-400 hover:to-blue-400"
            >
              <RotateCcw className="h-4 w-4" /> Reset Filters
            </motion.button>
          </div>
        </div>
      </motion.div>

      {/* Map */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
        className="relative overflow-hidden rounded-3xl border border-cyan-400/20 bg-black/40 p-6 backdrop-blur-xl"
      >
        <div className="relative z-10 mb-6 flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-3 text-xl text-white">
            <Maximize2 className="h-5 w-5 text-cyan-400" /> Planetary Surveillance Grid
          </h3>
          <div className="flex items-center gap-4">
            <div className="rounded-xl border border-cyan-400/30 bg-black/60 px-4 py-2">
              <span className="font-mono text-sm text-cyan-400">{markers.length} ACTIVE DETECTIONS</span>
            </div>
            <div className="rounded-xl border border-white/20 bg-black/60 px-4 py-2">
              <span className="text-sm text-white/60">Last Update: </span>
              <span className="font-mono text-sm text-white">{lastUpdate.toLocaleTimeString()}</span>
            </div>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/80 shadow-2xl">
          {loading && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
              <Loader2 className="mb-4 h-12 w-12 animate-spin text-cyan-400" />
              <span className="font-mono text-sm text-cyan-400">Scanning planetary surface...</span>
            </div>
          )}
          {!loading && markers.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="px-8 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-green-400/30 bg-green-500/10">
                  <Shield className="h-8 w-8 text-green-400" />
                </div>
                <p className="mb-2 text-lg font-semibold text-green-400">All Clear</p>
                <p className="max-w-xs text-sm text-white/50">
                  No active {emptyLabel} detected at this time. Planetary conditions nominal.
                </p>
              </div>
            </div>
          )}

          <DetectionMapCanvas
            markers={markers} selectedId={selectedId} zoom={zoom}
            onZoomChange={setZoom} onSelect={setSelectedId} recenterSignal={recenter}
          />

          <div className="absolute right-6 top-6 flex flex-col gap-3">
            {[
              { icon: ZoomIn, label: 'Zoom in', fn: () => zoomBy(0.1) },
              { icon: ZoomOut, label: 'Zoom out', fn: () => zoomBy(-0.1) },
              { icon: Crosshair, label: 'Recenter map', fn: () => { setZoom(1); setRecenter((n) => n + 1); } },
            ].map(({ icon: Icon, label, fn }) => (
              <motion.button
                key={label} whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={fn} aria-label={label}
                className="rounded-xl border border-cyan-400/30 bg-black/80 p-3 text-white shadow-lg backdrop-blur-xl transition-all hover:border-cyan-400/50 hover:bg-black/90"
              >
                <Icon className="h-5 w-5" />
              </motion.button>
            ))}
          </div>

          <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-2xl border border-cyan-400/30 bg-black/80 px-6 py-3 shadow-xl backdrop-blur-xl">
            <div className="flex items-center gap-2 font-mono text-sm text-cyan-400">
              <div className="h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
              Scroll to zoom • Drag to pan • Click markers for details
            </div>
          </div>
        </div>

        <div className="relative z-10 mt-6 flex flex-wrap items-center gap-8 border-t border-white/10 pt-6">
          {SEVERITY_CARDS.map(([label, color]) => (
            <div key={label} className="flex items-center gap-3">
              <div className={`h-4 w-4 rounded-full ${{ red: 'bg-red-500', orange: 'bg-orange-500', yellow: 'bg-yellow-500', cyan: 'bg-cyan-400' }[color]} animate-pulse`} />
              <span className="text-sm text-white/90">{label} ({severityCounts[label]})</span>
            </div>
          ))}
        </div>

        <AnimatePresence>
          {selected && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative mt-6 overflow-hidden rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 via-blue-500/10 to-purple-500/10 p-6 backdrop-blur-xl"
            >
              <div className="mb-5 flex items-start justify-between">
                <div>
                  <div className="mb-2 flex items-center gap-3">
                    <AlertCircle className="h-6 w-6 text-cyan-400" />
                    <h4 className="text-xl text-white">{selected.event.title}</h4>
                  </div>
                  <p className="ml-9 text-sm text-white/60">{selected.event.categories.map((c) => c.title).join(', ')}</p>
                </div>
                <div className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium ${badgeClass(selected.severity)}`}>
                  <div className="h-2 w-2 animate-pulse rounded-full bg-current" />
                  {selected.severity}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-white/20 bg-white/10 p-4">
                  <div className="mb-2 text-xs uppercase tracking-wider text-white/60">Event ID</div>
                  <div className="truncate font-mono text-sm text-white" title={selected.event.id}>{selected.event.id}</div>
                </div>
                <div className="rounded-xl border border-white/20 bg-white/10 p-4">
                  <div className="mb-2 text-xs uppercase tracking-wider text-white/60">First Detected</div>
                  <div className="text-sm text-white">
                    {selected.event.geometry[0]?.date ? new Date(selected.event.geometry[0].date).toLocaleDateString() : 'Unknown'}
                  </div>
                </div>
                <div className="rounded-xl border border-white/20 bg-white/10 p-4">
                  <div className="mb-2 text-xs uppercase tracking-wider text-white/60">Coordinates</div>
                  <div className="font-mono text-sm text-cyan-400">
                    {selected.point ? `${selected.point.lat.toFixed(4)}°, ${selected.point.lon.toFixed(4)}°` : 'n/a'}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* AI predictions */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
        className={`relative overflow-hidden rounded-3xl border transition-all duration-500 ${
          showPredictionsPanel
            ? 'min-h-[600px] border-cyan-400/50 bg-black/80'
            : 'h-[100px] cursor-pointer border-cyan-400/20 bg-black/40 hover:border-cyan-400/50 hover:shadow-lg hover:shadow-cyan-500/20'
        }`}
        onClick={() => {
          if (showPredictionsPanel) return;
          predictions.length === 0 ? generatePredictions() : setShowPredictionsPanel(true);
        }}
      >
        <ParticleBackground />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-cyan-900/20 via-transparent to-purple-900/20" />

        {!showPredictionsPanel ? (
          <div className="relative z-10 flex h-full w-full items-center justify-between px-8">
            <div className="flex items-center gap-4">
              <div className="animate-pulse rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-3">
                <Brain className="h-6 w-6 text-cyan-400" />
              </div>
              <div>
                <h3 className="text-xl font-light text-white">AI Predicted Threats</h3>
                <p className="text-sm text-cyan-400/60">Click to initialize predictive neural scan</p>
              </div>
            </div>
            <div className="flex items-center gap-3 text-white/40">
              <Zap className="h-5 w-5" />
              <span className="font-mono text-sm">AWAITING ACTIVATION</span>
            </div>
          </div>
        ) : (
          <div className="relative z-10 p-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-8 flex flex-col gap-6">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-3 text-2xl text-white">
                  <Brain className="h-8 w-8 text-cyan-400" /> AI Predictions
                </h3>
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setShowHistory((s) => !s)}
                    className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm transition-all ${
                      showHistory ? 'border-purple-400/50 bg-purple-500/20 text-purple-400'
                                  : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'}`}
                  >
                    <History className="h-4 w-4" /> History
                  </button>
                  <button
                    onClick={() => generatePredictions()} disabled={loadingPredictions}
                    className="flex items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-5 py-2 text-sm text-cyan-400 transition-all hover:bg-cyan-500/20 disabled:opacity-50"
                  >
                    {loadingPredictions ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    Regenerate
                  </button>
                  <button onClick={() => setShowPredictionsPanel(false)} aria-label="Close predictions" className="p-2 text-white/40 transition-colors hover:text-white">
                    <X className="h-6 w-6" />
                  </button>
                </div>
              </div>

              {!showHistory && (
                <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
                  <div className="relative min-w-[220px] flex-1">
                    <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                    <input
                      type="text" value={predictionSearch} onChange={(e) => setPredictionSearch(e.target.value)}
                      placeholder="Search by location (e.g., California, Tokyo)..."
                      onKeyDown={(e) => e.key === 'Enter' && generatePredictions()}
                      className="w-full rounded-xl border border-white/10 bg-black/40 py-2 pl-10 pr-4 text-white placeholder-white/30 transition-all focus:border-cyan-400/50 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-white/40" />
                    <select
                      value={predictionTimeframe} onChange={(e) => setPredictionTimeframe(e.target.value)}
                      className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-white focus:border-cyan-400/50 focus:outline-none"
                    >
                      {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <button
                    onClick={() => generatePredictions()}
                    className="rounded-xl bg-cyan-500/20 px-4 py-2 text-sm font-medium text-cyan-400 transition-colors hover:bg-cyan-500/30"
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>

            {showHistory ? (
              <div className="custom-scrollbar max-h-[500px] space-y-4 overflow-y-auto pr-2">
                <div className="mb-4 flex items-center justify-between">
                  <h4 className="text-lg text-white/80">Prediction History</h4>
                  <div className="flex gap-4">
                    <button onClick={exportHistory} className="flex items-center gap-1 text-xs text-cyan-400 hover:underline">
                      <Share2 className="h-3 w-3" /> Export History
                    </button>
                    <button onClick={clearHistory} className="text-xs text-red-400 hover:underline">
                      {confirmClear ? 'Click again to confirm' : 'Clear History'}
                    </button>
                  </div>
                </div>
                <HistoryList entries={history} onRestore={restoreHistoryEntry} />
              </div>
            ) : (
              <div className="space-y-6">
                {predictionResponse && (
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    {[
                      ['Risk Level', predictionResponse.globalRiskLevel, 'text-orange-400'],
                      ['Total Threats', predictionResponse.totalPredictions, 'text-white'],
                      ['Critical', predictions.filter((p) => p.severity === 'Critical').length, 'text-red-400'],
                      ['Source', predictionResponse.dataSource ?? 'Gemini', 'text-cyan-400'],
                    ].map(([label, value, color]) => (
                      <div key={String(label)} className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
                        <div className="mb-1 text-xs uppercase tracking-wider text-white/60">{label}</div>
                        <div className={`truncate text-2xl font-light ${color}`}>{String(value)}</div>
                      </div>
                    ))}
                  </div>
                )}

                {loadingPredictions && predictions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <Loader2 className="mb-4 h-12 w-12 animate-spin text-cyan-400" />
                    <p className="animate-pulse font-mono text-cyan-400">Analyzing planetary data streams...</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    <div className={`custom-scrollbar max-h-[500px] space-y-4 overflow-y-auto pr-2 transition-opacity ${loadingPredictions ? 'opacity-50' : ''}`}>
                      {predictions.map((p, i) => (
                        <motion.button
                          key={p.id}
                          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                          onClick={() => setSelectedPrediction(selectedPrediction?.id === p.id ? null : p)}
                          className={`w-full rounded-xl border p-4 text-left transition-all duration-300 ${
                            selectedPrediction?.id === p.id
                              ? 'border-cyan-400/60 bg-cyan-500/20 shadow-lg shadow-cyan-500/20'
                              : 'border-white/10 bg-white/5 hover:border-cyan-400/40 hover:bg-white/10'}`}
                        >
                          <div className="mb-2 flex items-start justify-between">
                            <span className={`rounded border px-2 py-1 text-xs font-medium ${badgeClass(p.severity)}`}>{p.severity}</span>
                            <span className="text-xs text-white/40">{p.timeframe}</span>
                          </div>
                          <h4 className="mb-1 font-medium text-white">{p.disasterType}</h4>
                          <p className="mb-2 text-sm text-white/60">📍 {p.location}</p>
                          <div className="flex gap-3 text-xs text-white/40">
                            <span>Conf: {p.confidence}%</span>
                            <span>Pop: {p.affectedPopulation.toLocaleString()}</span>
                          </div>
                        </motion.button>
                      ))}
                    </div>

                    <div className="h-fit rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm">
                      {selectedPrediction ? (
                        <motion.div key={selectedPrediction.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                          <div className="mb-6 flex items-center gap-3">
                            <div className={`rounded-full border p-3 ${badgeClass(selectedPrediction.severity)}`}>
                              <AlertTriangle className="h-6 w-6" />
                            </div>
                            <div>
                              <h3 className="text-xl text-white">{selectedPrediction.disasterType}</h3>
                              <p className="text-sm text-white/60">Detected in {selectedPrediction.location}</p>
                            </div>
                          </div>
                          <div className="space-y-6">
                            <div className="rounded-xl border border-white/5 bg-black/20 p-4">
                              <h5 className="mb-2 text-sm font-medium text-cyan-400">AI Analysis</h5>
                              <p className="text-sm leading-relaxed text-white/80">{selectedPrediction.description}</p>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                              {[
                                ['Impact Area', `${selectedPrediction.impactArea.toLocaleString()} km²`],
                                ['Affected Population', selectedPrediction.affectedPopulation.toLocaleString()],
                                ['Start Time', selectedPrediction.timeframe],
                                ['Confidence Score', `${selectedPrediction.confidence}%`],
                              ].map(([k, v]) => (
                                <div key={k}>
                                  <div className="mb-1 text-xs text-white/40">{k}</div>
                                  <div className="text-white">{v}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </motion.div>
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center py-12 text-white/40">
                          <Brain className="mb-4 h-12 w-12 opacity-50" />
                          <p>Select a prediction to view detailed analysis</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </motion.div>

      {/* Modals */}
      <AnimatePresence>
        {showLocationInput && (
          <Modal label="Track location" className="max-w-2xl" onClose={() => setShowLocationInput(false)}>
            <h3 className="mb-6 flex items-center gap-3 text-2xl text-white">
              <MapPin className="h-7 w-7 text-yellow-400" /> Track Location Coordinates
            </h3>
            <div className="space-y-4">
              {([['lat', 'Latitude (-90 to 90)', 'e.g., -3.4653'], ['lon', 'Longitude (-180 to 180)', 'e.g., -62.2159']] as const).map(([key, label, ph]) => (
                <label key={key} className="block">
                  <span className="mb-2 block text-sm text-white/80">{label}</span>
                  <input
                    type="text" inputMode="decimal" value={locationInput[key]} placeholder={ph}
                    onChange={(e) => setLocationInput((p) => ({ ...p, [key]: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && analyzeLocation()}
                    className="w-full rounded-2xl border border-white/20 bg-black/60 px-5 py-4 text-white placeholder-white/40 transition-all focus:border-cyan-400/50 focus:bg-black/80 focus:outline-none"
                  />
                </label>
              ))}
              <div className="flex gap-3">
                <button
                  onClick={analyzeLocation} disabled={analyzingLocation}
                  className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-500 px-6 py-4 text-white shadow-lg shadow-cyan-500/20 transition-all hover:from-cyan-400 hover:to-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {analyzingLocation ? <><Loader2 className="h-5 w-5 animate-spin" /> Analyzing...</> : <><Sparkles className="h-5 w-5" /> Analyze Location</>}
                </button>
                <button onClick={() => setShowLocationInput(false)} className="rounded-2xl border border-white/20 bg-white/5 px-6 py-4 text-white transition-all hover:bg-white/10">
                  Cancel
                </button>
              </div>
              {locationAnalysis && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  className="mt-6 rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 to-purple-500/10 p-6">
                  <h4 className="mb-3 flex items-center gap-2 text-cyan-400"><TrendingUp className="h-5 w-5" /> Analysis Results</h4>
                  <div className="space-y-2 text-sm text-white/80">
                    <p><span className="text-white/60">Location:</span> {locationAnalysis.location}</p>
                    <p><span className="text-white/60">Assessment:</span> {locationAnalysis.riskAssessment}</p>
                    {locationAnalysis.threats?.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {locationAnalysis.threats.map((t: string, i: number) => (
                          <li key={i} className="flex items-center gap-2 text-orange-400"><AlertTriangle className="h-4 w-4" />{t}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </motion.div>
              )}
            </div>
          </Modal>
        )}

        {showEmailModal && (
          <Modal label="Share report" border="border-blue-400/30" onClose={() => setShowEmailModal(false)}>
            <h3 className="mb-6 flex items-center gap-3 text-2xl text-white">
              <Send className="h-7 w-7 text-blue-400" /> Share Report via Email
            </h3>
            <label className="mb-4 block">
              <span className="mb-2 block text-sm text-white/80">Recipient Email</span>
              <input
                type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendEmail()} placeholder="colleague@organization.com"
                className="w-full rounded-2xl border border-white/20 bg-black/60 px-5 py-4 text-white placeholder-white/40 transition-all focus:border-blue-400/50 focus:bg-black/80 focus:outline-none"
              />
            </label>
            <div className="flex gap-3">
              <button
                onClick={sendEmail} disabled={sharing}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-blue-500 to-purple-500 px-6 py-4 text-white shadow-lg shadow-blue-500/20 transition-all hover:from-blue-400 hover:to-purple-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sharing ? <><Loader2 className="h-5 w-5 animate-spin" /> Sending...</> : <><Send className="h-5 w-5" /> Send Report</>}
              </button>
              <button onClick={() => setShowEmailModal(false)} className="rounded-2xl border border-white/20 bg-white/5 px-6 py-4 text-white transition-all hover:bg-white/10">
                Cancel
              </button>
            </div>
          </Modal>
        )}

        {showConfigModal && (
          <Modal label="Configure notifications" border="border-orange-400/30" onClose={() => setShowConfigModal(false)}>
            <h3 className="mb-6 flex items-center gap-3 text-2xl text-white">
              <Shield className="h-7 w-7 text-orange-400" /> Configure Notifications
            </h3>
            <div className="space-y-6">
              <div className="rounded-2xl border border-orange-400/30 bg-orange-500/10 p-6">
                <p className="mb-4 text-sm text-white/80">Enable predictive disaster alerts using NASA/ISRO satellite data</p>
                <div className="flex items-center justify-between">
                  <span className="text-white" id="notif-label">Disaster Predictions</span>
                  <button
                    role="switch" aria-checked={notificationsEnabled} aria-labelledby="notif-label"
                    onClick={toggleNotifications}
                    className={`relative h-7 w-14 rounded-full transition-all duration-300 ${notificationsEnabled ? 'bg-orange-500' : 'bg-white/20'}`}
                  >
                    <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all duration-300 ${notificationsEnabled ? 'left-8' : 'left-1'}`} />
                  </button>
                </div>
              </div>
              <ul className="space-y-2 text-sm text-white/60">
                <li>• Scans every 15 seconds</li>
                <li>• 7-day prediction window</li>
                <li>• Browser notifications enabled</li>
              </ul>
              <button onClick={() => setShowConfigModal(false)}
                className="w-full rounded-2xl bg-gradient-to-r from-orange-500 to-red-500 px-6 py-4 text-white shadow-lg shadow-orange-500/20 transition-all hover:from-orange-400 hover:to-red-400">
                Close
              </button>
            </div>
          </Modal>
        )}

        {showHistoryModal && (
          <Modal label="Prediction archive" className="flex h-[90vh] max-w-6xl flex-col !p-0 overflow-hidden" border="border-purple-500/30"
            onClose={() => setShowHistoryModal(false)}>
            <div className="flex items-center justify-between border-b border-white/10 bg-gradient-to-r from-purple-900/20 to-transparent p-6">
              <div className="flex items-center gap-4">
                <div className="rounded-xl border border-purple-400/30 bg-purple-500/20 p-3"><History className="h-8 w-8 text-purple-400" /></div>
                <div>
                  <h3 className="text-2xl font-light text-white">Mission Control Archives</h3>
                  <p className="text-sm text-purple-400/60">Historical Predictive Analysis Logs</p>
                </div>
              </div>
              <button onClick={() => setShowHistoryModal(false)} aria-label="Close archive" className="rounded-xl p-3 text-white/40 transition-colors hover:bg-white/5 hover:text-white">
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1">
              <div className="flex w-1/3 flex-col border-r border-white/10 bg-black/20">
                <div className="border-b border-white/5 p-4">
                  <h4 className="mb-2 text-xs uppercase tracking-wider text-white/60">Recorded Sessions</h4>
                  <div className="text-sm text-white">Total Entries: {archiveStats.sessions}</div>
                </div>
                <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-4">
                  <HistoryList entries={history} onRestore={restoreHistoryEntry} compact />
                </div>
                <div className="border-t border-white/10 bg-black/40 p-4">
                  <button onClick={exportHistory}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 py-3 text-sm text-white/60 transition-all hover:bg-white/10 hover:text-white">
                    <Download className="h-4 w-4" /> Download Full Archive
                  </button>
                </div>
              </div>

              <div className="custom-scrollbar flex-1 overflow-y-auto bg-black/40 p-8">
                {history.length > 0 ? (
                  <div className="space-y-8">
                    {/* real numbers; the original hard-coded 94.2% accuracy and 142 locations */}
                    <div className="grid grid-cols-3 gap-6">
                      {[
                        ['Sessions', archiveStats.sessions, 'border-purple-400/20 bg-purple-500/10', 'text-purple-400'],
                        ['Data Points', archiveStats.points, 'border-cyan-400/20 bg-cyan-500/10', 'text-cyan-400'],
                        ['Unique Locations', archiveStats.locations, 'border-blue-400/20 bg-blue-500/10', 'text-blue-400'],
                      ].map(([label, value, box, text]) => (
                        <div key={String(label)} className={`rounded-2xl border p-6 ${box}`}>
                          <h5 className={`mb-2 text-sm ${text}`}>{label}</h5>
                          <div className="text-3xl font-light text-white">{Number(value).toLocaleString()}</div>
                        </div>
                      ))}
                    </div>
                    <div>
                      <h4 className="mb-4 flex items-center gap-2 text-lg text-white"><Brain className="h-5 w-5 text-purple-400" /> Latest Archived Predictions</h4>
                      <div className="grid grid-cols-2 gap-4">
                        {history[0].predictions.slice(0, 6).map((p, i) => (
                          <div key={i} className="rounded-xl border border-white/5 bg-white/5 p-4 transition-all hover:border-white/20">
                            <div className="mb-2 flex items-start justify-between">
                              <span className="font-medium text-white">{p.location}</span>
                              <span className={`rounded border px-2 py-0.5 text-xs ${badgeClass(p.severity)}`}>{p.severity}</span>
                            </div>
                            <p className="line-clamp-2 text-sm text-white/60">{p.description}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="text-sm text-white/40">Select any session in the sidebar to restore it to the main view.</p>
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-white/30">
                    <History className="mb-4 h-16 w-16 opacity-20" />
                    <p>No historical data available to visualize.</p>
                    <p className="mt-2 text-sm">Run a new prediction scan to generate archives.</p>
                  </div>
                )}
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
