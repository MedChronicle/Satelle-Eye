import { NaturalEvent } from './eonetService';
import { getEventSeverity } from './disasterBackendService';

export type ExportFormat = 'csv' | 'json' | 'geojson' | 'html';
export type SeverityLevel = 'Critical' | 'High' | 'Medium' | 'Low';
export type SortKey = 'severity' | 'date' | 'title' | 'none';

export interface ExportResult {
  success: boolean;
  data: string;
  filename: string;
  format: ExportFormat;
  mimeType: string;
  sizeBytes: number;
  eventCount: number;
  error?: string;
}

export interface ShareResult {
  success: boolean;
  shareUrl?: string;
  portableUrl?: string;
  reportId?: string;
  expiresAt?: Date;
  storedIn?: 'backend' | 'local';
  error?: string;
}

export interface ExportOptions {
  sortBy?: SortKey;
  includeMetadata?: boolean;
  includeBom?: boolean;
  delimiter?: ',' | ';' | '\t';
  emptyValue?: string;
  maxDescriptionLength?: number;
  prettyJson?: boolean;
}

export interface ShareOptions {
  expiryDays?: number;
  topN?: number;
  title?: string;
}

export interface EventPoint {
  lat: number;
  lon: number;
}

export interface ReportSummary {
  totalEvents: number;
  severityCounts: Record<SeverityLevel, number>;
  categoryCounts: Record<string, number>;
  eventsWithLocation: number;
  magnitude: { count: number; min: number | null; max: number | null; average: number | null };
  dateRange: { earliest: string | null; latest: string | null };
}

export interface SharedReport {
  id: string;
  title: string;
  generatedAt: string;
  expiresAt: string;
  totalEvents: number;
  severityCounts: Record<SeverityLevel, number>;
  categoryCounts: Record<string, number>;
  filters: { severity: string; type: string };
  topEvents: {
    id: string;
    title: string;
    severity: SeverityLevel;
    category: string;
    latitude: number | null;
    longitude: number | null;
    lastUpdated: string | null;
  }[];
}

const PLATFORM = 'Satell-Eye';
const VERSION = '2.0.0';
const SHARE_BASE_URL: string = import.meta.env.VITE_SHARE_BASE_URL ?? 'https://satell-eye.app';
const SHARE_API_URL: string = import.meta.env.VITE_SHARE_API_URL ?? '';
const STORAGE_PREFIX = 'report-';
const MAX_PORTABLE_PAYLOAD = 6000;

const SEVERITY_ORDER: SeverityLevel[] = ['Critical', 'High', 'Medium', 'Low'];

const MIME_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
  geojson: 'application/geo+json;charset=utf-8',
  html: 'text/html;charset=utf-8',
};

const DEFAULT_OPTIONS: Required<ExportOptions> = {
  sortBy: 'none',
  includeMetadata: true,
  includeBom: true,
  delimiter: ',',
  emptyValue: 'N/A',
  maxDescriptionLength: 1000,
  prettyJson: true,
};

function resolveOptions(options?: ExportOptions): Required<ExportOptions> {
  return { ...DEFAULT_OPTIONS, ...options };
}

function severityOf(event: NaturalEvent): SeverityLevel {
  const value = String(getEventSeverity(event)) as SeverityLevel;
  return SEVERITY_ORDER.includes(value) ? value : 'Low';
}

function latestGeometry(event: NaturalEvent) {
  return event.geometry?.[event.geometry.length - 1];
}

function firstGeometry(event: NaturalEvent) {
  return event.geometry?.[0];
}

function collectCoordinatePairs(value: unknown, out: number[][]): void {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    out.push([value[0], value[1]]);
    return;
  }
  value.forEach((item) => collectCoordinatePairs(item, out));
}

export function extractPoint(event: NaturalEvent): EventPoint | null {
  const geometry = latestGeometry(event) as { coordinates?: unknown } | undefined;
  if (!geometry?.coordinates) return null;

  const pairs: number[][] = [];
  collectCoordinatePairs(geometry.coordinates, pairs);
  const valid = pairs.filter(([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (valid.length === 0) return null;

  const lon = valid.reduce((sum, p) => sum + p[0], 0) / valid.length;
  const lat = valid.reduce((sum, p) => sum + p[1], 0) / valid.length;
  return { lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)) };
}

function toTime(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function sortEvents(events: NaturalEvent[], sortBy: SortKey): NaturalEvent[] {
  const copy = [...events];
  if (sortBy === 'severity') {
    return copy.sort((a, b) => SEVERITY_ORDER.indexOf(severityOf(a)) - SEVERITY_ORDER.indexOf(severityOf(b)));
  }
  if (sortBy === 'date') {
    return copy.sort((a, b) => toTime(latestGeometry(b)?.date) - toTime(latestGeometry(a)?.date));
  }
  if (sortBy === 'title') {
    return copy.sort((a, b) => a.title.localeCompare(b.title));
  }
  return copy;
}

function cleanText(value: string | null | undefined, maxLength: number): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function sanitizeSpreadsheetText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

type CsvCell = string | number | null | undefined;

function formatCsvCell(cell: CsvCell, delimiter: string, emptyValue: string): string {
  if (cell === null || cell === undefined || cell === '') return emptyValue;
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : emptyValue;
  const text = sanitizeSpreadsheetText(cell);
  const needsQuotes = text.includes('"') || text.includes('\n') || text.includes('\r') || text.includes(delimiter);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function buildFilename(format: ExportFormat, severityFilter: string, typeFilter: string): string {
  const date = new Date().toISOString().split('T')[0];
  const parts = ['disaster-report', slugify(severityFilter), slugify(typeFilter), date].filter(
    (part) => part && part !== 'all'
  );
  return `${parts.join('-')}.${format}`;
}

function buildResult(
  format: ExportFormat,
  data: string,
  eventCount: number,
  severityFilter: string,
  typeFilter: string
): ExportResult {
  return {
    success: true,
    data,
    filename: buildFilename(format, severityFilter, typeFilter),
    format,
    mimeType: MIME_TYPES[format],
    sizeBytes: new TextEncoder().encode(data).length,
    eventCount,
  };
}

function failure(format: ExportFormat, error: unknown): ExportResult {
  console.error(`[Export] Failed to export ${format}:`, error);
  return {
    success: false,
    data: '',
    filename: '',
    format,
    mimeType: MIME_TYPES[format],
    sizeBytes: 0,
    eventCount: 0,
    error: error instanceof Error ? error.message : 'Unknown export error',
  };
}

export function summarizeEvents(events: NaturalEvent[]): ReportSummary {
  const severityCounts: Record<SeverityLevel, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  const categoryCounts: Record<string, number> = {};
  const magnitudes: number[] = [];
  const times: number[] = [];
  let withLocation = 0;

  events.forEach((event) => {
    severityCounts[severityOf(event)] += 1;
    (event.categories ?? []).forEach((category) => {
      categoryCounts[category.title] = (categoryCounts[category.title] ?? 0) + 1;
    });
    if (extractPoint(event)) withLocation += 1;

    const magnitude = latestGeometry(event)?.magnitudeValue;
    if (typeof magnitude === 'number' && Number.isFinite(magnitude)) magnitudes.push(magnitude);

    (event.geometry ?? []).forEach((g) => {
      const time = toTime(g.date);
      if (time > 0) times.push(time);
    });
  });

  return {
    totalEvents: events.length,
    severityCounts,
    categoryCounts,
    eventsWithLocation: withLocation,
    magnitude: {
      count: magnitudes.length,
      min: magnitudes.length ? Math.min(...magnitudes) : null,
      max: magnitudes.length ? Math.max(...magnitudes) : null,
      average: magnitudes.length
        ? Number((magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length).toFixed(2))
        : null,
    },
    dateRange: {
      earliest: times.length ? new Date(Math.min(...times)).toISOString() : null,
      latest: times.length ? new Date(Math.max(...times)).toISOString() : null,
    },
  };
}

export async function exportDisasterData(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options?: ExportOptions
): Promise<ExportResult> {
  try {
    const opts = resolveOptions(options);
    const sorted = sortEvents(events, opts.sortBy);
    const { delimiter, emptyValue } = opts;

    const headers = [
      'Event ID',
      'Title',
      'Category',
      'Severity',
      'Latitude',
      'Longitude',
      'First Detected',
      'Last Updated',
      'Magnitude',
      'Magnitude Unit',
      'Position Count',
      'Sources',
      'Link',
      'Description',
    ];

    const rows = sorted.map((event) => {
      const latest = latestGeometry(event);
      const point = extractPoint(event);
      const cells: CsvCell[] = [
        event.id,
        event.title,
        (event.categories ?? []).map((c) => c.title).join('; '),
        severityOf(event),
        point?.lat,
        point?.lon,
        firstGeometry(event)?.date,
        latest?.date,
        latest?.magnitudeValue,
        latest?.magnitudeUnit,
        event.geometry?.length ?? 0,
        (event.sources ?? []).map((s: { id?: string }) => s.id ?? '').filter(Boolean).join('; '),
        (event as { link?: string }).link,
        cleanText(event.description, opts.maxDescriptionLength),
      ];
      return cells.map((cell) => formatCsvCell(cell, delimiter, emptyValue)).join(delimiter);
    });

    const lines: string[] = [];
    if (opts.includeMetadata) {
      const summary = summarizeEvents(sorted);
      lines.push(
        `# ${PLATFORM} Disaster Report`,
        `# Generated: ${new Date().toISOString()}`,
        `# Total Events: ${sorted.length}`,
        `# Severity Filter: ${severityFilter}`,
        `# Type Filter: ${typeFilter}`,
        `# Critical: ${summary.severityCounts.Critical} | High: ${summary.severityCounts.High} | Medium: ${summary.severityCounts.Medium} | Low: ${summary.severityCounts.Low}`,
        '#'
      );
    }
    lines.push(headers.join(delimiter), ...rows);

    const body = lines.join('\r\n');
    const data = opts.includeBom ? `\uFEFF${body}` : body;
    return buildResult('csv', data, sorted.length, severityFilter, typeFilter);
  } catch (error) {
    return failure('csv', error);
  }
}

export async function exportDisasterDataJSON(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options?: ExportOptions
): Promise<ExportResult> {
  try {
    const opts = resolveOptions(options);
    const sorted = sortEvents(events, opts.sortBy);

    const payload = {
      metadata: {
        generatedAt: new Date().toISOString(),
        totalEvents: sorted.length,
        filters: { severity: severityFilter, type: typeFilter },
        platform: PLATFORM,
        version: VERSION,
      },
      summary: summarizeEvents(sorted),
      events: sorted.map((event) => {
        const latest = latestGeometry(event);
        const point = extractPoint(event);
        return {
          id: event.id,
          title: event.title,
          description: event.description ?? null,
          categories: (event.categories ?? []).map((c) => ({ id: c.id, title: c.title })),
          severity: severityOf(event),
          location: {
            latitude: point?.lat ?? null,
            longitude: point?.lon ?? null,
            magnitude: latest?.magnitudeValue ?? null,
            magnitudeUnit: latest?.magnitudeUnit ?? null,
          },
          timeline: {
            firstDetected: firstGeometry(event)?.date ?? null,
            lastUpdated: latest?.date ?? null,
            positionCount: event.geometry?.length ?? 0,
          },
          sources: event.sources ?? [],
        };
      }),
    };

    const data = JSON.stringify(payload, null, opts.prettyJson ? 2 : 0);
    return buildResult('json', data, sorted.length, severityFilter, typeFilter);
  } catch (error) {
    return failure('json', error);
  }
}

export async function exportDisasterDataGeoJSON(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options?: ExportOptions
): Promise<ExportResult> {
  try {
    const opts = resolveOptions(options);
    const sorted = sortEvents(events, opts.sortBy);

    const features = sorted.flatMap((event) => {
      const point = extractPoint(event);
      if (!point) return [];
      const latest = latestGeometry(event);
      return [
        {
          type: 'Feature' as const,
          id: event.id,
          geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
          properties: {
            title: event.title,
            description: cleanText(event.description, opts.maxDescriptionLength) || null,
            severity: severityOf(event),
            categories: (event.categories ?? []).map((c) => c.title),
            magnitude: latest?.magnitudeValue ?? null,
            magnitudeUnit: latest?.magnitudeUnit ?? null,
            firstDetected: firstGeometry(event)?.date ?? null,
            lastUpdated: latest?.date ?? null,
          },
        },
      ];
    });

    const collection = {
      type: 'FeatureCollection' as const,
      metadata: {
        generatedAt: new Date().toISOString(),
        platform: PLATFORM,
        filters: { severity: severityFilter, type: typeFilter },
        skippedWithoutLocation: sorted.length - features.length,
      },
      features,
    };

    const data = JSON.stringify(collection, null, opts.prettyJson ? 2 : 0);
    return buildResult('geojson', data, features.length, severityFilter, typeFilter);
  } catch (error) {
    return failure('geojson', error);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SEVERITY_COLORS: Record<SeverityLevel, string> = {
  Critical: '#b91c1c',
  High: '#ea580c',
  Medium: '#ca8a04',
  Low: '#16a34a',
};

export function buildHtmlReport(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options?: ExportOptions
): string {
  const opts = resolveOptions(options);
  const sorted = sortEvents(events, opts.sortBy === 'none' ? 'severity' : opts.sortBy);
  const summary = summarizeEvents(sorted);
  const maxCount = Math.max(1, ...Object.values(summary.severityCounts));

  const severityBars = SEVERITY_ORDER.map((level) => {
    const count = summary.severityCounts[level];
    const width = Math.round((count / maxCount) * 100);
    return `<div class="bar-row"><span class="bar-label">${level}</span><div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${SEVERITY_COLORS[level]}"></div></div><span class="bar-count">${count}</span></div>`;
  }).join('');

  const categoryRows = Object.entries(summary.categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td>${count}</td></tr>`)
    .join('');

  const eventRows = sorted
    .map((event) => {
      const severity = severityOf(event);
      const point = extractPoint(event);
      const latest = latestGeometry(event);
      const magnitude =
        latest?.magnitudeValue !== undefined && latest?.magnitudeValue !== null
          ? `${latest.magnitudeValue} ${latest.magnitudeUnit ?? ''}`.trim()
          : '—';
      return `<tr>
<td>${escapeHtml(event.title)}</td>
<td>${escapeHtml((event.categories ?? []).map((c) => c.title).join(', ') || '—')}</td>
<td><span class="badge" style="background:${SEVERITY_COLORS[severity]}">${severity}</span></td>
<td>${point ? `${point.lat}, ${point.lon}` : '—'}</td>
<td>${escapeHtml(magnitude)}</td>
<td>${latest?.date ? escapeHtml(new Date(latest.date).toLocaleString()) : '—'}</td>
</tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${PLATFORM} Disaster Report</title>
<style>
body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:32px;color:#111827}
h1{margin:0 0 4px}
.sub{color:#6b7280;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.card{border:1px solid #e5e7eb;border-radius:8px;padding:12px}
.card b{display:block;font-size:22px}
.bar-row{display:flex;align-items:center;gap:8px;margin:6px 0}
.bar-label{width:70px;font-size:13px}
.bar-track{flex:1;background:#f3f4f6;border-radius:4px;height:12px}
.bar-fill{height:12px;border-radius:4px}
.bar-count{width:30px;text-align:right;font-size:13px}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:13px}
th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f9fafb}
.badge{color:#fff;padding:2px 8px;border-radius:10px;font-size:12px}
@media print{body{margin:12mm}tr{page-break-inside:avoid}}
</style>
</head>
<body>
<h1>${PLATFORM} Disaster Report</h1>
<div class="sub">Generated ${escapeHtml(new Date().toLocaleString())} · Severity: ${escapeHtml(severityFilter)} · Type: ${escapeHtml(typeFilter)}</div>
<div class="grid">
<div class="card"><b>${summary.totalEvents}</b>Total events</div>
<div class="card"><b>${summary.severityCounts.Critical}</b>Critical</div>
<div class="card"><b>${summary.eventsWithLocation}</b>With location</div>
<div class="card"><b>${summary.magnitude.max ?? '—'}</b>Max magnitude</div>
</div>
<h2>Severity breakdown</h2>
${severityBars}
<h2>Categories</h2>
<table><tr><th>Category</th><th>Events</th></tr>${categoryRows || '<tr><td colspan="2">No categories</td></tr>'}</table>
<h2>Events</h2>
<table><tr><th>Title</th><th>Category</th><th>Severity</th><th>Location</th><th>Magnitude</th><th>Last updated</th></tr>${eventRows || '<tr><td colspan="6">No events</td></tr>'}</table>
</body>
</html>`;
}

export async function exportDisasterDataHTML(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options?: ExportOptions
): Promise<ExportResult> {
  try {
    const html = buildHtmlReport(events, severityFilter, typeFilter, options);
    return buildResult('html', html, events.length, severityFilter, typeFilter);
  } catch (error) {
    return failure('html', error);
  }
}

export async function generatePDFReport(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string
): Promise<Blob> {
  const html = buildHtmlReport(events, severityFilter, typeFilter);
  return new Blob([html], { type: MIME_TYPES.html });
}

export function printReport(events: NaturalEvent[], severityFilter: string, typeFilter: string): boolean {
  const html = buildHtmlReport(events, severityFilter, typeFilter);
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
  return true;
}

export function downloadExport(result: ExportResult): boolean {
  if (!result.success || typeof document === 'undefined') return false;
  const blob = new Blob([result.data], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export async function copyExportToClipboard(result: ExportResult): Promise<boolean> {
  if (!result.success || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(result.data);
    return true;
  } catch {
    return false;
  }
}

export async function exportAll(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  formats: ExportFormat[] = ['csv', 'json', 'geojson', 'html'],
  options?: ExportOptions
): Promise<ExportResult[]> {
  const handlers: Record<ExportFormat, typeof exportDisasterData> = {
    csv: exportDisasterData,
    json: exportDisasterDataJSON,
    geojson: exportDisasterDataGeoJSON,
    html: exportDisasterDataHTML,
  };
  return Promise.all(formats.map((format) => handlers[format](events, severityFilter, typeFilter, options)));
}

function generateReportId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').toUpperCase().slice(0, 10);
  return `SATL-${Date.now().toString(36).toUpperCase()}-${token}`;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isExpired(report: { expiresAt?: string }): boolean {
  return !!report.expiresAt && new Date(report.expiresAt).getTime() < Date.now();
}

export function purgeExpiredReports(): number {
  const storage = safeStorage();
  if (!storage) return 0;
  let removed = 0;
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? '{}');
      if (isExpired(parsed)) {
        storage.removeItem(key);
        removed += 1;
      }
    } catch {
      storage.removeItem(key);
      removed += 1;
    }
  }
  return removed;
}

export function listSharedReports(): SharedReport[] {
  const storage = safeStorage();
  if (!storage) return [];
  purgeExpiredReports();
  const reports: SharedReport[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    try {
      reports.push(JSON.parse(storage.getItem(key) ?? ''));
    } catch {
      continue;
    }
  }
  return reports.sort((a, b) => toTime(b.generatedAt) - toTime(a.generatedAt));
}

export function deleteSharedReport(reportId: string): boolean {
  const storage = safeStorage();
  if (!storage || !storage.getItem(`${STORAGE_PREFIX}${reportId}`)) return false;
  storage.removeItem(`${STORAGE_PREFIX}${reportId}`);
  return true;
}

function buildSharedReport(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  reportId: string,
  expiresAt: Date,
  options: ShareOptions
): SharedReport {
  const summary = summarizeEvents(events);
  const ranked = sortEvents(events, 'severity');
  return {
    id: reportId,
    title: options.title ?? `${PLATFORM} Disaster Report`,
    generatedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    totalEvents: summary.totalEvents,
    severityCounts: summary.severityCounts,
    categoryCounts: summary.categoryCounts,
    filters: { severity: severityFilter, type: typeFilter },
    topEvents: ranked.slice(0, options.topN ?? 5).map((event) => {
      const point = extractPoint(event);
      return {
        id: event.id,
        title: event.title,
        severity: severityOf(event),
        category: event.categories?.[0]?.title ?? 'Unknown',
        latitude: point?.lat ?? null,
        longitude: point?.lon ?? null,
        lastUpdated: latestGeometry(event)?.date ?? null,
      };
    }),
  };
}

async function uploadToBackend(report: SharedReport): Promise<{ url?: string } | null> {
  if (!SHARE_API_URL) return null;
  try {
    const response = await fetch(SHARE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (!response.ok) return null;
    return (await response.json()) as { url?: string };
  } catch {
    return null;
  }
}

export async function generateShareableReport(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options: ShareOptions = {}
): Promise<ShareResult> {
  try {
    const reportId = generateReportId();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (options.expiryDays ?? 7));

    const report = buildSharedReport(events, severityFilter, typeFilter, reportId, expiresAt, options);

    const uploaded = await uploadToBackend(report);
    let storedIn: 'backend' | 'local' = 'backend';
    if (!uploaded) {
      const storage = safeStorage();
      if (!storage) {
        return { success: false, error: 'No storage available to save the report.' };
      }
      purgeExpiredReports();
      storage.setItem(`${STORAGE_PREFIX}${reportId}`, JSON.stringify(report));
      storedIn = 'local';
    }

    const shareUrl = uploaded?.url ?? `${SHARE_BASE_URL}/reports/${reportId}`;
    const encoded = toBase64Url(JSON.stringify(report));
    const portableUrl = encoded.length <= MAX_PORTABLE_PAYLOAD ? `${shareUrl}#data=${encoded}` : undefined;

    return { success: true, shareUrl, portableUrl, reportId, expiresAt, storedIn };
  } catch (error) {
    console.error('[Share] Error generating shareable report:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown share error' };
  }
}

export function decodeReportFromHash(hash: string): SharedReport | null {
  const match = hash.match(/data=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const report = JSON.parse(fromBase64Url(match[1])) as SharedReport;
    return isExpired(report) ? null : report;
  } catch {
    return null;
  }
}

export async function getSharedReport(reportId: string, hash?: string): Promise<SharedReport> {
  const storage = safeStorage();
  const raw = storage?.getItem(`${STORAGE_PREFIX}${reportId}`);

  if (raw) {
    const report = JSON.parse(raw) as SharedReport;
    if (isExpired(report)) {
      storage?.removeItem(`${STORAGE_PREFIX}${reportId}`);
      throw new Error('Report has expired');
    }
    return report;
  }

  if (SHARE_API_URL) {
    try {
      const response = await fetch(`${SHARE_API_URL.replace(/\/$/, '')}/${encodeURIComponent(reportId)}`);
      if (response.ok) {
        const report = (await response.json()) as SharedReport;
        if (!isExpired(report)) return report;
        throw new Error('Report has expired');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Report has expired') throw error;
    }
  }

  if (hash) {
    const fromHash = decodeReportFromHash(hash);
    if (fromHash && fromHash.id === reportId) return fromHash;
  }

  throw new Error('Report not found or expired');
}

export async function shareReportLink(result: ShareResult, title = `${PLATFORM} Disaster Report`): Promise<'shared' | 'copied' | 'failed'> {
  const url = result.portableUrl ?? result.shareUrl;
  if (!result.success || !url) return 'failed';

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch {
      return 'failed';
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}
