import { NaturalEvent, getLatestGeometry, getGeometryPoint } from './eonetService';
import { getEventSeverity } from './disasterBackendService';

export interface EmailResult {
  success: boolean;
  message: string;
  messageId?: string;
  demo?: boolean;
  recipients?: string[];
}

export interface SendReportOptions {
  maxEvents?: number;
  includeCsv?: boolean;
  signal?: AbortSignal;
  sources?: string[];
}

type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

interface EmailContent {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

interface ReportRow {
  title: string;
  category: string;
  severity: Severity;
  location: string;
  detected: string;
  description: string;
  link: string | null;
}

const EMAIL_API_URL = (import.meta.env.VITE_EMAIL_API_URL as string | undefined) ?? '';
const SUPPORT_EMAIL = (import.meta.env.VITE_SUPPORT_EMAIL as string | undefined) ?? 'support@satell-eye.app';
const DEFAULT_SOURCES = ['NASA EONET'];

const MAX_RECIPIENTS = 10;
const DEFAULT_MAX_EVENTS = 25;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const MAX_DESCRIPTION_CHARS = 400;
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const SEVERITY_ORDER: Record<Severity, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
const SEVERITY_COLOR: Record<Severity, string> = {
  Critical: '#d62828',
  High: '#f77f00',
  Medium: '#e6a700',
  Low: '#0a9396',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripControl(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
}

function safeUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function normalizeSeverity(value: unknown): Severity {
  const text = String(value ?? '').toLowerCase();
  if (text === 'critical') return 'Critical';
  if (text === 'high') return 'High';
  if (text === 'medium') return 'Medium';
  return 'Low';
}

function formatDate(value: string | undefined): string {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return `${parsed.toISOString().slice(0, 10)} UTC`;
}

function formatLocation(event: NaturalEvent): string {
  const geometry = getLatestGeometry(event);
  const point = geometry ? getGeometryPoint(geometry) : null;
  if (!point) return 'N/A';
  const lat = `${Math.abs(point.lat).toFixed(4)}°${point.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.lon).toFixed(4)}°${point.lon >= 0 ? 'E' : 'W'}`;
  return `${lat}, ${lon}`;
}

function toRow(event: NaturalEvent): ReportRow {
  const geometry = getLatestGeometry(event);
  return {
    title: stripControl(event.title || 'Untitled event'),
    category: event.categories.map((c) => c.title).join(', ') || 'Uncategorized',
    severity: normalizeSeverity(getEventSeverity(event)),
    location: formatLocation(event),
    detected: formatDate(geometry?.date),
    description: truncate(stripControl(event.description ?? ''), MAX_DESCRIPTION_CHARS),
    link: safeUrl(event.link) ?? safeUrl(event.sources?.[0]?.url),
  };
}

function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function buildCsv(rows: ReportRow[]): string {
  const header = ['Title', 'Category', 'Severity', 'Location', 'Detected', 'Link'];
  const lines = rows.map((r) => [r.title, r.category, r.severity, r.location, r.detected, r.link ?? ''].map(csvCell).join(','));
  return `\uFEFF${[header.map(csvCell).join(','), ...lines].join('\r\n')}`;
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length <= 254 && !/[\r\n]/.test(trimmed) && EMAIL_PATTERN.test(trimmed);
}

export function parseRecipients(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split(/[,;\s]+/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const email = item.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(email);
  }
  return result;
}

function countBySeverity(rows: ReportRow[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const row of rows) counts[row.severity]++;
  return counts;
}

function renderStatCell(label: Severity, count: number): string {
  return `<td align="center" width="25%" style="padding:6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;border-radius:8px;">
      <tr><td align="center" style="padding:14px 4px;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:28px;font-weight:bold;color:${SEVERITY_COLOR[label]};line-height:1.1;">${count}</div>
        <div style="font-size:11px;color:#5b6770;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">${label}</div>
      </td></tr>
    </table>
  </td>`;
}

function renderEventBlock(row: ReportRow): string {
  const color = SEVERITY_COLOR[row.severity];
  const title = escapeHtml(row.title);
  const heading = row.link
    ? `<a href="${escapeHtml(row.link)}" style="color:#0b3d91;text-decoration:none;">${title}</a>`
    : title;
  const description = row.description
    ? `<div style="margin-top:8px;font-size:13px;line-height:1.5;color:#4a5560;">${escapeHtml(row.description)}</div>`
    : '';
  return `<tr><td style="padding:0 0 12px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e6ea;border-left:4px solid ${color};border-radius:6px;background:#ffffff;">
      <tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:16px;font-weight:bold;color:#1b2430;">${heading}</div>
        <div style="margin-top:8px;font-size:13px;color:#4a5560;line-height:1.6;">
          <span style="color:#7b8794;">Category:</span> ${escapeHtml(row.category)} &nbsp;|&nbsp;
          <span style="color:#7b8794;">Severity:</span> <strong style="color:${color};">${row.severity}</strong><br>
          <span style="color:#7b8794;">Location:</span> ${escapeHtml(row.location)} &nbsp;|&nbsp;
          <span style="color:#7b8794;">Detected:</span> ${escapeHtml(row.detected)}
        </div>
        ${description}
      </td></tr>
    </table>
  </td></tr>`;
}

function generateEmailReport(
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options: SendReportOptions
): EmailContent {
  const maxEvents = Math.max(1, Math.min(100, options.maxEvents ?? DEFAULT_MAX_EVENTS));
  const sources = (options.sources?.length ? options.sources : DEFAULT_SOURCES).map(stripControl).filter(Boolean);
  const generated = new Date();
  const generatedLabel = `${generated.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  const rows = events
    .map(toRow)
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  const counts = countBySeverity(rows);
  const shown = rows.slice(0, maxEvents);
  const hidden = rows.length - shown.length;

  const severityLabel = severityFilter === 'all' ? 'All levels' : stripControl(severityFilter);
  const typeLabel = typeFilter === 'all' ? 'All types' : stripControl(typeFilter);
  const subject = stripControl(
    `Satell-Eye Disaster Report: ${rows.length} active event${rows.length === 1 ? '' : 's'} (${counts.Critical} critical, ${counts.High} high) - ${generated.toISOString().slice(0, 10)}`
  );

  const eventBlocks = shown.length
    ? shown.map(renderEventBlock).join('')
    : `<tr><td style="padding:20px;text-align:center;font-family:Arial,Helvetica,sans-serif;color:#5b6770;">No events match the selected filters.</td></tr>`;

  const moreBlock = hidden > 0
    ? `<tr><td align="center" style="padding:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6770;">and ${hidden} more event${hidden === 1 ? '' : 's'}${options.includeCsv === false ? '' : ' (full list attached as CSV)'}</td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;">
      <tr><td align="center" style="background:#0b1f3a;padding:26px 20px;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:2px;">SATELL-EYE</div>
        <div style="font-size:13px;color:#9fb3c8;margin-top:6px;">Global Disaster Detection Report</div>
        <div style="font-size:12px;color:#9fb3c8;margin-top:4px;">Generated ${escapeHtml(generatedLabel)}</div>
      </td></tr>
      <tr><td style="padding:20px 18px 6px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${renderStatCell('Critical', counts.Critical)}
          ${renderStatCell('High', counts.High)}
          ${renderStatCell('Medium', counts.Medium)}
          ${renderStatCell('Low', counts.Low)}
        </tr></table>
      </td></tr>
      <tr><td style="padding:10px 24px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#4a5560;line-height:1.6;">
        <strong style="color:#1b2430;">Filters</strong><br>
        Severity: ${escapeHtml(severityLabel)} &nbsp;|&nbsp; Type: ${escapeHtml(typeLabel)} &nbsp;|&nbsp; Total events: ${rows.length}
      </td></tr>
      <tr><td style="padding:10px 24px 0 24px;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:18px;font-weight:bold;color:#0b1f3a;padding-bottom:12px;">Active events</div>
      </td></tr>
      <tr><td style="padding:0 24px 20px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${eventBlocks}
          ${moreBlock}
        </table>
      </td></tr>
      <tr><td align="center" style="background:#f4f6f8;padding:18px 20px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7b8794;line-height:1.6;">
        Data sources: ${escapeHtml(sources.join(', '))}<br>
        Severity levels are automated estimates and should be verified against official agencies before acting on them.<br>
        Questions: <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:#0b3d91;">${escapeHtml(SUPPORT_EMAIL)}</a><br>
        &copy; ${generated.getUTCFullYear()} Satell-Eye
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const textEvents = shown
    .map(
      (row, i) =>
        `${i + 1}. ${row.title}\n   Category: ${row.category}\n   Severity: ${row.severity}\n   Location: ${row.location}\n   Detected: ${row.detected}${row.link ? `\n   More: ${row.link}` : ''}${row.description ? `\n   ${row.description}` : ''}`
    )
    .join('\n\n');

  const text = [
    'SATELL-EYE - Global Disaster Detection Report',
    `Generated: ${generatedLabel}`,
    '',
    'SUMMARY',
    `Critical: ${counts.Critical}`,
    `High: ${counts.High}`,
    `Medium: ${counts.Medium}`,
    `Low: ${counts.Low}`,
    '',
    'FILTERS',
    `Severity: ${severityLabel}`,
    `Type: ${typeLabel}`,
    `Total events: ${rows.length}`,
    '',
    'ACTIVE EVENTS',
    textEvents || 'No events match the selected filters.',
    hidden > 0 ? `\n... and ${hidden} more event${hidden === 1 ? '' : 's'}` : '',
    '',
    '---',
    `Data sources: ${sources.join(', ')}`,
    'Severity levels are automated estimates; verify against official agencies.',
    `Contact: ${SUPPORT_EMAIL}`,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');

  const attachments: EmailAttachment[] = [];
  if (options.includeCsv !== false && rows.length > 0) {
    attachments.push({
      filename: `satell-eye-report-${generated.toISOString().slice(0, 10)}.csv`,
      content: toBase64(buildCsv(rows)),
      contentType: 'text/csv; charset=utf-8',
    });
  }

  return { subject, html, text, attachments };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Email sending aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Email sending aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function postToBackend(
  recipients: string[],
  content: EmailContent,
  signal?: AbortSignal
): Promise<{ messageId?: string }> {
  const idempotencyKey = makeId();
  const body = JSON.stringify({
    to: recipients,
    subject: content.subject,
    html: content.html,
    text: content.text,
    attachments: content.attachments,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Email sending aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(EMAIL_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return { messageId: typeof data?.messageId === 'string' ? data.messageId : undefined };
      }

      let detail = response.statusText;
      try {
        const errorBody = await response.json();
        detail = errorBody?.error?.message ?? errorBody?.message ?? errorBody?.error ?? detail;
      } catch {
        detail = response.statusText;
      }
      const error = new Error(`Email service responded with ${response.status}${detail ? `: ${String(detail)}` : ''}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw Object.assign(error, { fatal: true });
      lastError = error;
    } catch (error) {
      if ((error as any)?.fatal) throw error;
      if (signal?.aborted) throw new Error('Email sending aborted');
      lastError = timedOut ? new Error(`Email service timed out after ${REQUEST_TIMEOUT_MS}ms`) : error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (attempt < MAX_RETRIES) await sleep(Math.min(4000, 600 * 2 ** attempt) + Math.random() * 300, signal);
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to send email');
}

async function simulateEmailSending(recipients: string[], content: EmailContent): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    const stored = JSON.parse(localStorage.getItem('sent-emails') || '[]');
    const list = Array.isArray(stored) ? stored : [];
    list.push({
      to: recipients,
      subject: content.subject,
      timestamp: new Date().toISOString(),
      preview: content.text.slice(0, 200),
    });
    localStorage.setItem('sent-emails', JSON.stringify(list.slice(-10)));
  } catch {
    return `DEMO-${makeId()}`;
  }
  return `DEMO-${makeId()}`;
}

export async function sendReportEmail(
  recipientEmail: string | string[],
  events: NaturalEvent[],
  severityFilter: string,
  typeFilter: string,
  options: SendReportOptions = {}
): Promise<EmailResult> {
  try {
    const recipients = parseRecipients(recipientEmail);
    if (recipients.length === 0) throw new Error('Enter at least one email address');
    if (recipients.length > MAX_RECIPIENTS) throw new Error(`A report can be sent to at most ${MAX_RECIPIENTS} recipients`);
    const invalid = recipients.filter((email) => !isValidEmail(email));
    if (invalid.length) throw new Error(`Invalid email address: ${invalid.join(', ')}`);
    if (!Array.isArray(events)) throw new Error('No events supplied for the report');
    if (options.signal?.aborted) throw new Error('Email sending aborted');

    const content = generateEmailReport(events, severityFilter, typeFilter, options);

    if (EMAIL_API_URL) {
      const { messageId } = await postToBackend(recipients, content, options.signal);
      return {
        success: true,
        message: `Report sent to ${recipients.join(', ')}`,
        messageId,
        demo: false,
        recipients,
      };
    }

    const messageId = await simulateEmailSending(recipients, content);
    return {
      success: true,
      message: `Demo mode: no email was actually sent. Set VITE_EMAIL_API_URL to deliver the report to ${recipients.join(', ')}`,
      messageId,
      demo: true,
      recipients,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to send email',
    };
  }
}
