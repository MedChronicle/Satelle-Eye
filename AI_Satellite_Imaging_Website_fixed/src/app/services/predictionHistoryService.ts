import { DisasterPrediction, PredictionResponse } from './geminiPredictionService';

export interface HistoryEntry {
  id: string;
  timestamp: string;
  predictions: DisasterPrediction[];
  summary: string;
  riskLevel: string;
  totalPredictions?: number;
  signature?: string;
  pinned?: boolean;
  tags?: string[];
  note?: string;
}

export interface AddEntryOptions {
  note?: string;
  tags?: string[];
  pinned?: boolean;
  allowDuplicate?: boolean;
}

export interface HistoryQuery {
  riskLevel?: string;
  search?: string;
  tag?: string;
  from?: string | Date;
  to?: string | Date;
  pinnedOnly?: boolean;
  sortBy?: 'newest' | 'oldest' | 'risk' | 'predictions';
  limit?: number;
  offset?: number;
}

export interface HistoryQueryResult {
  entries: HistoryEntry[];
  total: number;
  hasMore: boolean;
}

export interface HistoryStats {
  totalEntries: number;
  pinnedEntries: number;
  totalPredictions: number;
  averagePredictionsPerEntry: number;
  riskDistribution: Record<string, number>;
  highestRiskLevel: string | null;
  trend: 'rising' | 'falling' | 'stable' | 'insufficient-data';
  firstEntryAt: string | null;
  lastEntryAt: string | null;
  topLabels: { label: string; count: number }[];
}

export interface HistoryComparison {
  older: HistoryEntry;
  newer: HistoryEntry;
  added: DisasterPrediction[];
  removed: DisasterPrediction[];
  unchanged: number;
  riskChange: 'increased' | 'decreased' | 'unchanged';
}

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
}

export interface HistoryConfig {
  maxEntries: number;
  maxAgeDays: number;
  dedupeWindowMs: number;
}

interface StoredEnvelope {
  version: number;
  entries: HistoryEntry[];
}

const HISTORY_KEY = 'satell_eye_prediction_history';
const SCHEMA_VERSION = 2;

const config: HistoryConfig = {
  maxEntries: 50,
  maxAgeDays: 0,
  dedupeWindowMs: 60 * 1000,
};

const RISK_RANK: Record<string, number> = {
  none: 0,
  minimal: 0,
  low: 1,
  moderate: 2,
  medium: 2,
  elevated: 3,
  high: 3,
  severe: 4,
  critical: 5,
  extreme: 5,
};

const LABEL_KEYS = ['type', 'disasterType', 'category', 'event', 'name'];

const listeners = new Set<(history: HistoryEntry[]) => void>();
let storageListenerAttached = false;

function riskRank(level: string | undefined): number {
  return RISK_RANK[(level ?? '').toLowerCase()] ?? -1;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `HIST-${crypto.randomUUID()}`;
  }
  return `HIST-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function signatureOf(predictions: DisasterPrediction[]): string {
  return hashString(JSON.stringify(predictions));
}

function predictionKey(prediction: DisasterPrediction): string {
  return hashString(JSON.stringify(prediction));
}

function readLabel(prediction: DisasterPrediction): string | null {
  const record = prediction as unknown as Record<string, unknown>;
  for (const key of LABEL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function toTime(value: string | Date | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function isValidEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<HistoryEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.timestamp === 'string' &&
    !Number.isNaN(new Date(entry.timestamp).getTime()) &&
    Array.isArray(entry.predictions) &&
    typeof entry.summary === 'string' &&
    typeof entry.riskLevel === 'string'
  );
}

function normalizeEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    totalPredictions: entry.totalPredictions ?? entry.predictions.length,
    signature: entry.signature ?? signatureOf(entry.predictions),
    pinned: entry.pinned ?? false,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  };
}

function sortNewestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function parseStored(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredEnvelope).entries)
      ? (parsed as StoredEnvelope).entries
      : [];
  return sortNewestFirst(list.filter(isValidEntry).map(normalizeEntry));
}

function applyRetention(entries: HistoryEntry[]): HistoryEntry[] {
  let result = sortNewestFirst(entries);

  if (config.maxAgeDays > 0) {
    const cutoff = Date.now() - config.maxAgeDays * 86400000;
    result = result.filter((entry) => entry.pinned || new Date(entry.timestamp).getTime() >= cutoff);
  }

  while (result.length > config.maxEntries) {
    let index = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      if (!result[i].pinned) {
        index = i;
        break;
      }
    }
    if (index === -1) break;
    result.splice(index, 1);
  }

  return result;
}

function writeEntries(entries: HistoryEntry[]): HistoryEntry[] | null {
  const storage = getStorage();
  if (!storage) return null;

  let working = [...entries];
  while (true) {
    try {
      const envelope: StoredEnvelope = { version: SCHEMA_VERSION, entries: working };
      storage.setItem(HISTORY_KEY, JSON.stringify(envelope));
      return working;
    } catch (error) {
      if (working.length === 0) {
        console.error('Failed to save prediction history:', error);
        return null;
      }
      const unpinnedIndex = [...working].reverse().findIndex((entry) => !entry.pinned);
      const removeAt = unpinnedIndex === -1 ? working.length - 1 : working.length - 1 - unpinnedIndex;
      working.splice(removeAt, 1);
    }
  }
}

function notify(history: HistoryEntry[]): void {
  listeners.forEach((listener) => {
    try {
      listener(history);
    } catch (error) {
      console.error('History listener failed:', error);
    }
  });
}

function persist(entries: HistoryEntry[]): HistoryEntry[] {
  const saved = writeEntries(applyRetention(entries));
  if (saved === null) return getHistory();
  notify(saved);
  return saved;
}

function getHistory(): HistoryEntry[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    return parseStored(storage.getItem(HISTORY_KEY));
  } catch (error) {
    console.error('Failed to load prediction history:', error);
    return [];
  }
}

function addEntry(response: PredictionResponse, options: AddEntryOptions = {}): HistoryEntry[] {
  try {
    const history = getHistory();
    const signature = signatureOf(response.predictions);
    const latest = history[0];

    if (
      !options.allowDuplicate &&
      latest &&
      latest.signature === signature &&
      Date.now() - new Date(latest.timestamp).getTime() < config.dedupeWindowMs
    ) {
      return history;
    }

    const newEntry: HistoryEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      predictions: response.predictions,
      summary: `Generated ${response.totalPredictions} predictions with ${response.globalRiskLevel} risk level`,
      riskLevel: response.globalRiskLevel,
      totalPredictions: response.totalPredictions,
      signature,
      pinned: options.pinned ?? false,
      tags: options.tags ?? [],
      note: options.note,
    };

    return persist([newEntry, ...history]);
  } catch (error) {
    console.error('Failed to save prediction history:', error);
    return [];
  }
}

function getEntry(id: string): HistoryEntry | undefined {
  return getHistory().find((entry) => entry.id === id);
}

function updateEntry(
  id: string,
  changes: Partial<Pick<HistoryEntry, 'note' | 'tags' | 'pinned'>>
): HistoryEntry | null {
  const history = getHistory();
  const index = history.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const updated = { ...history[index], ...changes };
  history[index] = updated;
  persist(history);
  return updated;
}

function togglePin(id: string): boolean | null {
  const entry = getEntry(id);
  if (!entry) return null;
  const next = !entry.pinned;
  updateEntry(id, { pinned: next });
  return next;
}

function removeEntry(id: string): boolean {
  const history = getHistory();
  const next = history.filter((entry) => entry.id !== id);
  if (next.length === history.length) return false;
  persist(next);
  return true;
}

function clearHistory(options: { keepPinned?: boolean } = {}): void {
  const storage = getStorage();
  if (!storage) return;
  if (options.keepPinned) {
    persist(getHistory().filter((entry) => entry.pinned));
    return;
  }
  storage.removeItem(HISTORY_KEY);
  notify([]);
}

function query(filter: HistoryQuery = {}): HistoryQueryResult {
  let results = getHistory();

  if (filter.riskLevel) {
    const target = filter.riskLevel.toLowerCase();
    results = results.filter((entry) => entry.riskLevel.toLowerCase() === target);
  }
  if (filter.pinnedOnly) {
    results = results.filter((entry) => entry.pinned);
  }
  if (filter.tag) {
    const tag = filter.tag.toLowerCase();
    results = results.filter((entry) => (entry.tags ?? []).some((t) => t.toLowerCase() === tag));
  }
  const from = toTime(filter.from);
  const to = toTime(filter.to);
  if (from !== null) results = results.filter((entry) => new Date(entry.timestamp).getTime() >= from);
  if (to !== null) results = results.filter((entry) => new Date(entry.timestamp).getTime() <= to);

  if (filter.search?.trim()) {
    const needle = filter.search.trim().toLowerCase();
    results = results.filter((entry) => {
      const haystack = [entry.summary, entry.note ?? '', (entry.tags ?? []).join(' '), JSON.stringify(entry.predictions)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  switch (filter.sortBy) {
    case 'oldest':
      results = [...results].reverse();
      break;
    case 'risk':
      results = [...results].sort((a, b) => riskRank(b.riskLevel) - riskRank(a.riskLevel));
      break;
    case 'predictions':
      results = [...results].sort((a, b) => (b.totalPredictions ?? 0) - (a.totalPredictions ?? 0));
      break;
    default:
      break;
  }

  const total = results.length;
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = filter.limit && filter.limit > 0 ? filter.limit : total;
  const page = results.slice(offset, offset + limit);

  return { entries: page, total, hasMore: offset + page.length < total };
}

function getStats(): HistoryStats {
  const history = getHistory();
  const riskDistribution: Record<string, number> = {};
  const labelCounts = new Map<string, number>();
  let totalPredictions = 0;

  history.forEach((entry) => {
    riskDistribution[entry.riskLevel] = (riskDistribution[entry.riskLevel] ?? 0) + 1;
    totalPredictions += entry.totalPredictions ?? entry.predictions.length;
    entry.predictions.forEach((prediction) => {
      const label = readLabel(prediction);
      if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    });
  });

  let highest: string | null = null;
  history.forEach((entry) => {
    if (highest === null || riskRank(entry.riskLevel) > riskRank(highest)) highest = entry.riskLevel;
  });

  let trend: HistoryStats['trend'] = 'insufficient-data';
  if (history.length >= 2) {
    const diff = riskRank(history[0].riskLevel) - riskRank(history[1].riskLevel);
    trend = diff > 0 ? 'rising' : diff < 0 ? 'falling' : 'stable';
  }

  return {
    totalEntries: history.length,
    pinnedEntries: history.filter((entry) => entry.pinned).length,
    totalPredictions,
    averagePredictionsPerEntry: history.length ? Number((totalPredictions / history.length).toFixed(2)) : 0,
    riskDistribution,
    highestRiskLevel: highest,
    trend,
    firstEntryAt: history.length ? history[history.length - 1].timestamp : null,
    lastEntryAt: history.length ? history[0].timestamp : null,
    topLabels: Array.from(labelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, count]) => ({ label, count })),
  };
}

function compareEntries(idA: string, idB: string): HistoryComparison | null {
  const a = getEntry(idA);
  const b = getEntry(idB);
  if (!a || !b) return null;

  const [older, newer] = new Date(a.timestamp) <= new Date(b.timestamp) ? [a, b] : [b, a];
  const olderKeys = new Map(older.predictions.map((p) => [predictionKey(p), p]));
  const newerKeys = new Map(newer.predictions.map((p) => [predictionKey(p), p]));

  const added = newer.predictions.filter((p) => !olderKeys.has(predictionKey(p)));
  const removed = older.predictions.filter((p) => !newerKeys.has(predictionKey(p)));
  const unchanged = newer.predictions.length - added.length;

  const diff = riskRank(newer.riskLevel) - riskRank(older.riskLevel);
  return {
    older,
    newer,
    added,
    removed,
    unchanged,
    riskChange: diff > 0 ? 'increased' : diff < 0 ? 'decreased' : 'unchanged',
  };
}

function exportHistory(): string {
  const envelope = {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    entries: getHistory(),
  };
  return JSON.stringify(envelope, null, 2);
}

function csvCell(value: string | number | boolean): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportHistoryCSV(): string {
  const header = ['ID', 'Timestamp', 'Risk Level', 'Predictions', 'Pinned', 'Tags', 'Note', 'Summary'];
  const rows = getHistory().map((entry) =>
    [
      entry.id,
      entry.timestamp,
      entry.riskLevel,
      entry.totalPredictions ?? entry.predictions.length,
      entry.pinned ?? false,
      (entry.tags ?? []).join('; '),
      entry.note ?? '',
      entry.summary,
    ]
      .map(csvCell)
      .join(',')
  );
  return `\uFEFF${[header.join(','), ...rows].join('\r\n')}`;
}

function importHistory(json: string, mode: 'merge' | 'replace' = 'merge'): ImportResult {
  const parsed: unknown = JSON.parse(json);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredEnvelope).entries)
      ? (parsed as StoredEnvelope).entries
      : [];

  const valid = list.filter(isValidEntry).map(normalizeEntry);
  const existing = mode === 'replace' ? [] : getHistory();
  const knownIds = new Set(existing.map((entry) => entry.id));

  const fresh = valid.filter((entry) => !knownIds.has(entry.id));
  persist([...existing, ...fresh]);

  return { imported: fresh.length, skipped: list.length - fresh.length, total: list.length };
}

function subscribe(listener: (history: HistoryEntry[]) => void): () => void {
  listeners.add(listener);

  if (!storageListenerAttached && typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === HISTORY_KEY) notify(getHistory());
    });
    storageListenerAttached = true;
  }

  return () => {
    listeners.delete(listener);
  };
}

function configure(changes: Partial<HistoryConfig>): HistoryConfig {
  Object.assign(config, changes);
  if (changes.maxEntries !== undefined || changes.maxAgeDays !== undefined) {
    persist(getHistory());
  }
  return { ...config };
}

export const PredictionHistoryService = {
  getHistory,
  addEntry,
  clearHistory,
  exportHistory,
  getEntry,
  updateEntry,
  togglePin,
  removeEntry,
  query,
  getStats,
  compareEntries,
  exportHistoryCSV,
  importHistory,
  subscribe,
  configure,
};
