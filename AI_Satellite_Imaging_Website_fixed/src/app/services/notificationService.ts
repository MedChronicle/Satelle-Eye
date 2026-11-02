import { sendChatMessageDetailed, ChatMessage } from './openaiService';
import { getNaturalEvents, NaturalEvent } from './eonetService';
import { getEventSeverity } from './disasterBackendService';

export type Severity = 'Low' | 'Medium' | 'High' | 'Critical';

export interface DisasterPrediction {
  id: string;
  type: string;
  location: string;
  severity: Severity;
  probability: number;
  timeframe: string;
  source: 'NASA' | 'ISRO' | 'AI-Prediction';
  description: string;
  affectedRegions: string[];
  recommendations: string[];
  timestamp: Date;
  generatedBy?: 'ai' | 'heuristic' | 'fallback';
}

export interface NotificationPayload {
  predictions: DisasterPrediction[];
  summary: string;
  urgentCount: number;
  timestamp: Date;
  mode?: 'ai' | 'heuristic' | 'error';
  fromCache?: boolean;
  activeEventCount?: number;
  disclaimer?: string;
  error?: string;
}

export interface NotificationServiceConfig {
  intervalMs: number;
  pauseWhenHidden: boolean;
  eventLimit: number;
  notifyCooldownMs: number;
  reuseWindowMs: number;
  aiTimeoutMs: number;
}

export interface ServiceStatus {
  running: boolean;
  checks: number;
  consecutiveFailures: number;
  lastCheckAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastMode: NotificationPayload['mode'] | null;
  subscribers: number;
}

export type ServiceHandle = ReturnType<typeof setInterval>;
export type NotificationCallback = (payload: NotificationPayload) => void;

const DISCLAIMER =
  'Automated outlook generated from NASA EONET observations. It is not an official warning. Follow local authorities for emergency guidance.';

const DEFAULT_CONFIG: NotificationServiceConfig = {
  intervalMs: 5 * 60 * 1000,
  pauseWhenHidden: true,
  eventLimit: 100,
  notifyCooldownMs: 6 * 60 * 60 * 1000,
  reuseWindowMs: 30 * 60 * 1000,
  aiTimeoutMs: 30000,
};

const SEVERITY_ORDER: Severity[] = ['Critical', 'High', 'Medium', 'Low'];

const config: NotificationServiceConfig = { ...DEFAULT_CONFIG };
let notificationCallbacks: NotificationCallback[] = [];
let lastPayload: NotificationPayload | null = null;
let lastSignature = '';
let lastAnalysisAt = 0;
let inflight: Promise<NotificationPayload> | null = null;
let activeHandle: ServiceHandle | null = null;
const notifiedAt = new Map<string, number>();

const status: ServiceStatus = {
  running: false,
  checks: 0,
  consecutiveFailures: 0,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastMode: null,
  subscribers: 0,
};

const SAFETY_TIPS: Record<string, string[]> = {
  wildfire: ['Prepare an evacuation route and go-bag', 'Keep windows closed and monitor air quality', 'Follow local fire authority updates'],
  storm: ['Secure loose outdoor objects', 'Charge phones and power banks', 'Avoid travel during peak winds and flooding'],
  flood: ['Move valuables to higher ground', 'Avoid walking or driving through floodwater', 'Know your nearest evacuation shelter'],
  volcano: ['Carry a mask or cloth for ash protection', 'Stay outside restricted zones', 'Follow volcano observatory advisories'],
  earthquake: ['Identify safe spots: drop, cover and hold on', 'Secure heavy furniture', 'Keep an emergency kit accessible'],
  default: ['Monitor local authorities', 'Prepare emergency supplies', 'Keep a charged phone and a communication plan'],
};

function tipsFor(type: string): string[] {
  const lower = type.toLowerCase();
  if (/fire/.test(lower)) return SAFETY_TIPS.wildfire;
  if (/storm|cyclone|hurricane|typhoon/.test(lower)) return SAFETY_TIPS.storm;
  if (/flood/.test(lower)) return SAFETY_TIPS.flood;
  if (/volcan/.test(lower)) return SAFETY_TIPS.volcano;
  if (/quake|seism/.test(lower)) return SAFETY_TIPS.earthquake;
  return SAFETY_TIPS.default;
}

function newId(index: number): string {
  const random = Math.random().toString(36).slice(2, 7);
  return `PRED-${Date.now()}-${index}-${random}`;
}

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function normalizeSeverity(value: unknown): Severity {
  const text = String(value ?? '').trim().toLowerCase();
  if (['critical', 'extreme', 'catastrophic'].includes(text)) return 'Critical';
  if (['high', 'severe', 'major'].includes(text)) return 'High';
  if (['low', 'minor', 'minimal'].includes(text)) return 'Low';
  return 'Medium';
}

function normalizeProbability(value: unknown): number {
  const raw = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace('%', ''));
  if (!Number.isFinite(raw)) return 50;
  const scaled = raw > 0 && raw <= 1 ? raw * 100 : raw;
  return Math.round(Math.min(100, Math.max(0, scaled)));
}

function toStringList(value: unknown, splitter: RegExp): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(splitter).map((v) => v.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean);
  return [];
}

function stem(text: string): string {
  return text.toLowerCase().replace(/(es|s)$/, '');
}

function eventMatchesType(event: NaturalEvent, type: string): boolean {
  const t = type.toLowerCase();
  return (event.categories ?? []).some((category) => {
    const c = category.title.toLowerCase();
    return c.includes(stem(t)) || t.includes(stem(c));
  });
}

function latestCoordinates(event: NaturalEvent): string {
  const geometry = event.geometry?.[event.geometry.length - 1] as { coordinates?: unknown } | undefined;
  const coords = geometry?.coordinates;
  if (Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    return `${coords[1].toFixed(2)}°, ${coords[0].toFixed(2)}°`;
  }
  return 'Unknown';
}

function eventSeverity(event: NaturalEvent): Severity {
  return normalizeSeverity(getEventSeverity(event));
}

function eventSignature(events: NaturalEvent[]): string {
  return events
    .slice(0, 30)
    .map((event) => `${event.id}:${event.geometry?.length ?? 0}`)
    .join('|');
}

function getBaseSource(activeEvents: NaturalEvent[], type: string): 'NASA' | 'AI-Prediction' {
  return activeEvents.some((event) => eventMatchesType(event, type)) ? 'NASA' : 'AI-Prediction';
}

function summarizeActiveEvents(events: NaturalEvent[]): string {
  const counts = new Map<string, number>();
  events.forEach((event) => {
    const title = event.categories?.[0]?.title ?? 'Unknown';
    counts.set(title, (counts.get(title) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([title, count]) => `${title}: ${count}`)
    .join(', ');
}

function buildPrompt(events: NaturalEvent[]): string {
  const list = events
    .slice(0, 15)
    .map((event, index) => `${index + 1}. ${event.categories?.[0]?.title ?? 'Unknown'}: ${event.title} at ${latestCoordinates(event)} (severity ${eventSeverity(event)})`)
    .join('\n');

  return `Today is ${new Date().toISOString().split('T')[0]}. Using only the NASA EONET observations below plus general seasonal knowledge, outline natural hazards that could plausibly develop or continue in the NEXT 7 DAYS.

Active events by category: ${summarizeActiveEvents(events) || 'none'}

Most recent active events:
${list || 'None reported'}

Return 3 to 5 items as a JSON array and nothing else. Each item must have exactly these keys:
"type" (Wildfire, Earthquake, Flood, Storm, Volcano, Drought, etc.),
"location" (specific region or country),
"severity" ("Low" | "Medium" | "High" | "Critical"),
"probability" (integer 0-100, a rough likelihood, not a certainty),
"timeframe" (when within the next 7 days),
"affectedRegions" (array of strings),
"recommendations" (array of short safety actions),
"description" (one sentence explaining the reasoning from the data).

Do not claim certainty. Do not predict specific earthquakes. Prefer events consistent with the observations above.`;
}

interface RawPrediction {
  type?: unknown;
  location?: unknown;
  severity?: unknown;
  probability?: unknown;
  timeframe?: unknown;
  affectedRegions?: unknown;
  regions?: unknown;
  recommendations?: unknown;
  description?: unknown;
}

function parseJsonPredictions(text: string): RawPrediction[] | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const attempts: string[] = [cleaned];
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) attempts.push(cleaned.slice(start, end + 1));
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) attempts.push(cleaned.slice(objStart, objEnd + 1));

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.predictions)) return parsed.predictions;
    } catch {
      continue;
    }
  }
  return null;
}

function extractField(text: string, fieldName: string): string | null {
  const regex = new RegExp(`(?:^|\\n)\\s*[-•*]?\\s*(?:\\*\\*)?${fieldName}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.+?)(?=\\n|$)`, 'i');
  const match = text.match(regex);
  return match ? match[1].replace(/\*\*/g, '').trim() : null;
}

function parseTextPredictions(text: string): RawPrediction[] {
  const sections = text.split(/PREDICTION\s*\d*\s*:?/i).filter((section) => /type\s*:/i.test(section));
  return sections.map((section) => ({
    type: extractField(section, 'Type'),
    location: extractField(section, 'Location'),
    severity: extractField(section, 'Severity'),
    probability: extractField(section, 'Probability'),
    timeframe: extractField(section, 'Timeframe'),
    affectedRegions: extractField(section, 'Regions') ?? extractField(section, 'Affected Regions'),
    recommendations: extractField(section, 'Recommendations'),
    description: extractField(section, 'Description'),
  }));
}

function toPrediction(raw: RawPrediction, index: number, activeEvents: NaturalEvent[]): DisasterPrediction {
  const type = String(raw.type ?? '').trim() || 'Unknown';
  const location = String(raw.location ?? '').trim() || 'Unknown';
  const regions = toStringList(raw.affectedRegions ?? raw.regions, /[,;]/);
  const recommendations = toStringList(raw.recommendations, /[;\n]|\.\s+/);
  const probability = normalizeProbability(raw.probability);
  const severity = normalizeSeverity(raw.severity);
  const description =
    String(raw.description ?? '').trim() ||
    `${type} risk in ${location} with an estimated ${probability}% likelihood over the coming week.`;

  return {
    id: newId(index),
    type,
    location,
    severity,
    probability,
    timeframe: String(raw.timeframe ?? '').trim() || 'Next 7 days',
    source: getBaseSource(activeEvents, type),
    description: description.length > 240 ? `${description.slice(0, 239)}…` : description,
    affectedRegions: regions.length ? regions : [location],
    recommendations: recommendations.length ? recommendations.slice(0, 5) : tipsFor(type),
    timestamp: new Date(),
    generatedBy: 'ai',
  };
}

export function parsePredictions(aiResponse: string, activeEvents: NaturalEvent[]): DisasterPrediction[] {
  const raw = parseJsonPredictions(aiResponse) ?? parseTextPredictions(aiResponse);
  return raw
    .filter((item) => item && typeof item === 'object')
    .slice(0, 8)
    .map((item, index) => toPrediction(item, index, activeEvents));
}

function buildHeuristicPredictions(events: NaturalEvent[]): DisasterPrediction[] {
  const groups = new Map<string, NaturalEvent[]>();
  events.forEach((event) => {
    const key = event.categories?.[0]?.title ?? 'Unknown';
    groups.set(key, [...(groups.get(key) ?? []), event]);
  });

  const ranked = Array.from(groups.entries())
    .map(([category, items]) => {
      const worst = items.reduce<Severity>((best, event) => {
        const current = eventSeverity(event);
        return severityRank(current) < severityRank(best) ? current : best;
      }, 'Low');
      return { category, items, worst };
    })
    .sort((a, b) => severityRank(a.worst) - severityRank(b.worst) || b.items.length - a.items.length)
    .slice(0, 5);

  return ranked.map(({ category, items, worst }, index) => ({
    id: newId(index),
    type: category,
    location: items[0].title,
    severity: worst,
    probability: Math.min(95, 40 + items.length * 6),
    timeframe: 'Ongoing, next 7 days',
    source: 'NASA' as const,
    description: `${items.length} active ${category.toLowerCase()} event${items.length > 1 ? 's' : ''} currently reported by NASA EONET; activity is likely to continue.`,
    affectedRegions: items.slice(0, 3).map((event) => event.title),
    recommendations: tipsFor(category),
    timestamp: new Date(),
    generatedBy: 'heuristic' as const,
  }));
}

function fallbackPrediction(): DisasterPrediction {
  return {
    id: newId(0),
    type: 'Monitoring',
    location: 'Global',
    severity: 'Low',
    probability: 30,
    timeframe: 'Next 7 days',
    source: 'AI-Prediction',
    description: 'Continuous monitoring of global conditions. No immediate threats detected.',
    affectedRegions: ['Global'],
    recommendations: ['Continue regular monitoring', 'Stay informed through official channels'],
    timestamp: new Date(),
    generatedBy: 'fallback',
  };
}

function buildPayload(predictions: DisasterPrediction[], mode: NotificationPayload['mode'], activeEventCount: number): NotificationPayload {
  const urgentCount = predictions.filter((p) => p.severity === 'Critical' || p.severity === 'High').length;
  const summary =
    urgentCount > 0
      ? `⚠️ ${urgentCount} high-risk disaster${urgentCount > 1 ? 's' : ''} flagged for the next 7 days`
      : `✓ ${predictions.length} potential event${predictions.length === 1 ? '' : 's'} monitored - No immediate threats`;

  return {
    predictions,
    summary,
    urgentCount,
    timestamp: new Date(),
    mode,
    fromCache: false,
    activeEventCount,
    disclaimer: DISCLAIMER,
  };
}

async function runAnalysis(force: boolean): Promise<NotificationPayload> {
  const eventsResponse = await getNaturalEvents('open', config.eventLimit);
  const activeEvents: NaturalEvent[] = eventsResponse.events ?? [];
  const signature = eventSignature(activeEvents);

  const reusable =
    !force &&
    lastPayload &&
    lastPayload.mode !== 'error' &&
    signature === lastSignature &&
    Date.now() - lastAnalysisAt < config.reuseWindowMs;

  if (reusable && lastPayload) {
    return { ...lastPayload, fromCache: true };
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are an expert meteorologist and seismologist who summarises natural hazard outlooks from NASA, ISRO and global monitoring data. Be realistic, avoid overstating certainty, and respond in the exact format requested.',
    },
    { role: 'user', content: buildPrompt(activeEvents) },
  ];

  let predictions: DisasterPrediction[] = [];
  let mode: NotificationPayload['mode'] = 'ai';

  try {
    const result = await sendChatMessageDetailed(messages, {
      model: 'gpt-4',
      temperature: 0.4,
      maxTokens: 900,
      timeoutMs: config.aiTimeoutMs,
    });
    if (result.source === 'openai') {
      predictions = parsePredictions(result.content, activeEvents);
    }
  } catch (error) {
    console.error('[Notifications] AI analysis failed:', error);
  }

  if (predictions.length === 0) {
    predictions = buildHeuristicPredictions(activeEvents);
    mode = 'heuristic';
  }
  if (predictions.length === 0) {
    predictions = [fallbackPrediction()];
  }

  predictions.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.probability - a.probability);

  const payload = buildPayload(predictions, mode, activeEvents.length);
  lastSignature = signature;
  lastAnalysisAt = Date.now();
  return payload;
}

export function checkNow(options: { force?: boolean } = {}): Promise<NotificationPayload> {
  if (inflight) return inflight;

  status.checks += 1;
  status.lastCheckAt = new Date();

  inflight = runAnalysis(options.force ?? false)
    .then((payload) => {
      status.consecutiveFailures = 0;
      status.lastSuccessAt = new Date();
      status.lastError = null;
      status.lastMode = payload.mode ?? null;
      lastPayload = payload;
      return payload;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Notifications] Error checking predictions:', error);
      status.consecutiveFailures += 1;
      status.lastError = message;
      status.lastMode = 'error';
      return {
        predictions: [],
        summary: 'Error checking predictions',
        urgentCount: 0,
        timestamp: new Date(),
        mode: 'error' as const,
        error: message,
        disclaimer: DISCLAIMER,
      };
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

function dispatch(payload: NotificationPayload): void {
  notificationCallbacks.forEach((callback) => {
    try {
      callback(payload);
    } catch (error) {
      console.error('[Notifications] Error in callback:', error);
    }
  });
}

function predictionKey(prediction: DisasterPrediction): string {
  return `${prediction.type}|${prediction.location}`.toLowerCase();
}

function showBrowserNotification(payload: NotificationPayload): void {
  if (payload.mode === 'error' || payload.urgentCount === 0) return;
  if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') return;

  const now = Date.now();
  const fresh = payload.predictions.filter((prediction) => {
    if (prediction.severity !== 'Critical' && prediction.severity !== 'High') return false;
    const last = notifiedAt.get(predictionKey(prediction)) ?? 0;
    return now - last > config.notifyCooldownMs;
  });
  if (fresh.length === 0) return;

  fresh.forEach((prediction) => notifiedAt.set(predictionKey(prediction), now));

  const body =
    fresh.length === 1
      ? `${fresh[0].severity}: ${fresh[0].type} - ${fresh[0].location} (${fresh[0].probability}%)`
      : `${fresh.length} high-risk events flagged. ${fresh.map((p) => p.type).slice(0, 3).join(', ')}`;

  try {
    const notification = new Notification('⚠️ Satell-Eye Alert', {
      body,
      icon: '/satellite-icon.png',
      badge: '/satellite-icon.png',
      tag: 'satell-eye-alert',
      requireInteraction: fresh.some((p) => p.severity === 'Critical'),
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (error) {
    console.error('[Notifications] Unable to show browser notification:', error);
  }
}

async function tick(): Promise<void> {
  if (config.pauseWhenHidden && typeof document !== 'undefined' && document.hidden) return;
  const payload = await checkNow();
  dispatch(payload);
  showBrowserNotification(payload);
}

export function subscribeToNotifications(
  callback: NotificationCallback,
  options: { replayLast?: boolean } = {}
): () => void {
  if (!notificationCallbacks.includes(callback)) notificationCallbacks.push(callback);
  status.subscribers = notificationCallbacks.length;
  if (options.replayLast && lastPayload) {
    try {
      callback(lastPayload);
    } catch (error) {
      console.error('[Notifications] Error in callback:', error);
    }
  }
  return () => unsubscribeFromNotifications(callback);
}

export function unsubscribeFromNotifications(callback: NotificationCallback): void {
  notificationCallbacks = notificationCallbacks.filter((cb) => cb !== callback);
  status.subscribers = notificationCallbacks.length;
}

export function configureNotificationService(changes: Partial<NotificationServiceConfig>): NotificationServiceConfig {
  Object.assign(config, changes);
  if (changes.intervalMs !== undefined && activeHandle !== null) {
    clearInterval(activeHandle);
    activeHandle = setInterval(() => void tick(), config.intervalMs);
  }
  return { ...config };
}

export function startNotificationService(overrides: Partial<NotificationServiceConfig> = {}): ServiceHandle {
  Object.assign(config, overrides);

  if (activeHandle !== null) {
    clearInterval(activeHandle);
  }

  activeHandle = setInterval(() => void tick(), config.intervalMs);
  status.running = true;
  void tick();
  return activeHandle;
}

export function stopNotificationService(interval?: ServiceHandle): void {
  const handle = interval ?? activeHandle;
  if (handle !== null && handle !== undefined) clearInterval(handle);
  if (handle === activeHandle) {
    activeHandle = null;
    status.running = false;
  }
}

export function getLastPayload(): NotificationPayload | null {
  return lastPayload;
}

export function getServiceStatus(): ServiceStatus {
  return { ...status, subscribers: notificationCallbacks.length };
}

export function clearNotificationCooldowns(): void {
  notifiedAt.clear();
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
