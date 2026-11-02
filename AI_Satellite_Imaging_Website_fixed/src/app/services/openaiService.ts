export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIResponse {
  choices: {
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxContextTokens?: number;
  fallbackToMock?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  source: 'openai' | 'mock';
  model: string;
  finishReason: string;
  usage: TokenUsage;
  latencyMs: number;
}

export type AIErrorCode = 'NOT_CONFIGURED' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'NETWORK' | 'SERVER' | 'ABORTED' | 'INVALID_INPUT' | 'UNKNOWN';

export class AIServiceError extends Error {
  code: AIErrorCode;
  status?: number;

  constructor(message: string, code: AIErrorCode, status?: number) {
    super(message);
    this.name = 'AIServiceError';
    this.code = code;
    this.status = status;
  }
}

export interface JarvisPromptOptions {
  userName?: string;
  liveContext?: string;
}

const AI_PROXY_URL: string = import.meta.env.VITE_AI_PROXY_URL ?? '';
const DEFAULT_MODEL: string = import.meta.env.VITE_AI_MODEL ?? 'gpt-4';

const DEFAULTS = {
  temperature: 0.7,
  maxTokens: 500,
  timeoutMs: 20000,
  maxContextTokens: 3000,
  maxRetries: 2,
  retryBaseDelayMs: 600,
  maxUserMessageChars: 4000,
};

export function isAIConfigured(): boolean {
  return AI_PROXY_URL.length > 0;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function trimMessages(messages: ChatMessage[], maxTokens: number = DEFAULTS.maxContextTokens): ChatMessage[] {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const systemCost = system.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);

  const kept: ChatMessage[] = [];
  let budget = maxTokens - systemCost;
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content) + 4;
    if (cost > budget && kept.length > 0) break;
    kept.unshift(rest[i]);
    budget -= cost;
  }
  return [...system, ...kept];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusToError(status: number, detail: string): AIServiceError {
  if (status === 401 || status === 403) return new AIServiceError('The AI service rejected the request. Check the proxy configuration.', 'AUTH', status);
  if (status === 429) return new AIServiceError('The AI service is busy. Please try again shortly.', 'RATE_LIMIT', status);
  if (status >= 500) return new AIServiceError(`The AI service is unavailable (${status}).`, 'SERVER', status);
  return new AIServiceError(`AI request failed (${status}): ${detail}`, 'UNKNOWN', status);
}

function isRetryable(error: AIServiceError): boolean {
  return error.code === 'RATE_LIMIT' || error.code === 'SERVER' || error.code === 'NETWORK' || error.code === 'TIMEOUT';
}

function validateMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AIServiceError('At least one message is required.', 'INVALID_INPUT');
  }
  const last = messages[messages.length - 1];
  if (last.role !== 'user' || !last.content.trim()) {
    throw new AIServiceError('The last message must be a non-empty user message.', 'INVALID_INPUT');
  }
  return messages.map((m, index) =>
    index === messages.length - 1 && m.content.length > DEFAULTS.maxUserMessageChars
      ? { ...m, content: m.content.slice(0, DEFAULTS.maxUserMessageChars) }
      : m
  );
}

async function requestWithRetry(body: Record<string, unknown>, options: ChatOptions): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  let lastError = new AIServiceError('Unknown error', 'UNKNOWN');

  for (let attempt = 0; attempt <= DEFAULTS.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort);

    try {
      const response = await fetch(AI_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = response.statusText;
        try {
          const payload = await response.json();
          detail = payload?.error?.message ?? detail;
        } catch {
          detail = response.statusText;
        }
        throw statusToError(response.status, detail);
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw new AIServiceError('Request was cancelled.', 'ABORTED');
      if (error instanceof AIServiceError) lastError = error;
      else if (error instanceof DOMException && error.name === 'AbortError') lastError = new AIServiceError('The AI service timed out.', 'TIMEOUT');
      else lastError = new AIServiceError('Network error while contacting the AI service.', 'NETWORK');

      if (!isRetryable(lastError) || attempt === DEFAULTS.maxRetries) throw lastError;
      await sleep(DEFAULTS.retryBaseDelayMs * 2 ** attempt + Math.random() * 250);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

function buildBody(messages: ChatMessage[], options: ChatOptions, stream: boolean): Record<string, unknown> {
  return {
    model: options.model ?? DEFAULT_MODEL,
    messages: trimMessages(messages, options.maxContextTokens),
    temperature: options.temperature ?? DEFAULTS.temperature,
    max_tokens: options.maxTokens ?? DEFAULTS.maxTokens,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    stream,
  };
}

interface MockIntent {
  name: string;
  keywords: (string | RegExp)[];
  responses: string[];
}

const MOCK_INTENTS: MockIntent[] = [
  {
    name: 'iss',
    keywords: [/\biss\b/, 'international space station', 'space station'],
    responses: [
      "The International Space Station orbits at roughly 408 kilometres, completing a lap of Earth about every 92 minutes at around 7.66 km/s. It is occasionally visible to the naked eye at dawn and dusk. Shall I look into passes over your location?",
    ],
  },
  {
    name: 'starlink',
    keywords: ['starlink', 'spacex'],
    responses: [
      "Starlink is a large low Earth orbit constellation operating at roughly 340 to 550 km, delivering broadband across Ku and Ka bands. I can focus on individual spacecraft such as Starlink-1007 or 1600 if you wish.",
    ],
  },
  {
    name: 'navigation',
    keywords: [/\bgps\b/, 'navigation', 'galileo', 'glonass', 'beidou'],
    responses: [
      "The principal navigation constellations are GPS, Galileo, GLONASS and BeiDou. Civilian positioning is typically accurate to a few metres, and all of them broadcast in the L-band.",
    ],
  },
  {
    name: 'earth-observation',
    keywords: ['landsat', 'sentinel', /\bterra\b/, /\baqua\b/, 'earth observation'],
    responses: [
      "Landsat, Sentinel, Terra and Aqua provide optical, radar and thermal imagery used for land use, vegetation health, water resources and climate indicators.",
    ],
  },
  {
    name: 'satellite',
    keywords: ['satellite', 'orbit', 'tle', 'constellation'],
    responses: [
      "I can track a broad catalogue of satellites, including the ISS, Hubble, Starlink, navigation and Earth observation craft. Name a spacecraft and I shall provide its orbital characteristics.",
    ],
  },
  {
    name: 'weather',
    keywords: ['weather', 'temperature', 'forecast', 'rain', 'humidity', 'air quality', /\baqi\b/],
    responses: [
      "I can retrieve current conditions, air quality and a multi-day forecast for any city. Which location would you like, sir?",
    ],
  },
  {
    name: 'disaster',
    keywords: ['disaster', 'earthquake', 'wildfire', 'flood', 'volcano', 'cyclone', 'hurricane', 'eonet'],
    responses: [
      "Natural events are monitored through NASA EONET, covering wildfires, volcanic activity, floods and severe storms. I can filter by severity or category if that would help.",
    ],
  },
  {
    name: 'analysis',
    keywords: [/\bai\b/, 'analysis', 'detection', /\bmodels?\b/, 'yolo', 'segmentation', 'classification'],
    responses: [
      "The analysis suite handles object detection, classification and segmentation of satellite imagery. Upload an image and I shall run it through the pipeline.",
    ],
  },
  {
    name: 'status',
    keywords: ['status', 'system', 'online', 'diagnostics'],
    responses: [
      "Running in demonstration mode: live AI is not configured, so I cannot report genuine system telemetry. Connect the AI proxy to enable full responses.",
    ],
  },
  {
    name: 'capabilities',
    keywords: ['what can you do', /\bhelp\b/, 'capabilities', 'features'],
    responses: [
      "I am JARVIS, your mission control assistant. I can discuss satellite tracking, weather, natural disaster monitoring, image analysis and orbital mechanics. Where shall we begin?",
    ],
  },
  {
    name: 'greeting',
    keywords: [/\bhello\b/, /\bhi\b/, /\bhey\b/, 'good morning', 'good evening', 'good afternoon'],
    responses: [
      "Greetings, sir. JARVIS at your service. How may I assist you today?",
      "Good day, sir. All interfaces are standing by. What shall we look into?",
    ],
  },
];

function scoreIntent(message: string, intent: MockIntent): number {
  return intent.keywords.reduce((score, keyword) => {
    if (typeof keyword === 'string') return message.includes(keyword) ? score + keyword.length : score;
    return keyword.test(message) ? score + 4 : score;
  }, 0);
}

function getMockResponse(userMessage: string): string {
  const message = userMessage.toLowerCase();
  let best: MockIntent | null = null;
  let bestScore = 0;

  MOCK_INTENTS.forEach((intent) => {
    const score = scoreIntent(message, intent);
    if (score > bestScore) {
      best = intent;
      bestScore = score;
    }
  });

  if (best) {
    const responses = (best as MockIntent).responses;
    return responses[Math.floor(Math.random() * responses.length)];
  }

  const preview = userMessage.length > 80 ? `${userMessage.slice(0, 80)}…` : userMessage;
  return `I understand you are asking about "${preview}". I can help with satellite positions, weather, disaster alerts and image analysis. Could you give me a little more detail, sir?`;
}

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function mockResult(messages: ChatMessage[], model: string, started: number): ChatResult {
  const content = getMockResponse(messages[messages.length - 1].content);
  const promptTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const completionTokens = estimateTokens(content);
  return {
    content,
    source: 'mock',
    model: 'mock',
    finishReason: 'stop',
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    latencyMs: Date.now() - started,
  };
}

export async function sendChatMessageDetailed(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const started = Date.now();
  const validated = validateMessages(messages);
  const model = options.model ?? DEFAULT_MODEL;

  if (!isAIConfigured()) {
    return mockResult(validated, model, started);
  }

  try {
    const response = await requestWithRetry(buildBody(validated, options, false), options);
    const data: OpenAIResponse = await response.json();
    const choice = data.choices?.[0];
    if (!choice?.message?.content) {
      throw new AIServiceError('The AI service returned an empty response.', 'UNKNOWN');
    }
    return {
      content: choice.message.content,
      source: 'openai',
      model,
      finishReason: choice.finish_reason ?? 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof AIServiceError && error.code === 'ABORTED') throw error;
    console.error('Error calling AI service:', error);
    if (options.fallbackToMock === false) {
      throw error instanceof AIServiceError ? error : new AIServiceError('Unexpected AI error.', 'UNKNOWN');
    }
    return mockResult(validated, model, started);
  }
}

export async function sendChatMessage(
  messages: ChatMessage[],
  model: string = DEFAULT_MODEL,
  options: Omit<ChatOptions, 'model'> = {}
): Promise<string> {
  const result = await sendChatMessageDetailed(messages, { ...options, model });
  return result.content;
}

async function streamMock(content: string, onToken: (token: string) => void, signal?: AbortSignal): Promise<void> {
  const words = content.split(/(\s+)/);
  for (const word of words) {
    if (signal?.aborted) throw new AIServiceError('Request was cancelled.', 'ABORTED');
    onToken(word);
    await sleep(18);
  }
}

export async function streamChatMessage(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  options: ChatOptions = {}
): Promise<ChatResult> {
  const started = Date.now();
  const validated = validateMessages(messages);
  const model = options.model ?? DEFAULT_MODEL;

  const runMock = async (): Promise<ChatResult> => {
    const result = mockResult(validated, model, started);
    await streamMock(result.content, onToken, options.signal);
    return { ...result, latencyMs: Date.now() - started };
  };

  if (!isAIConfigured()) return runMock();

  let collected = '';
  try {
    const response = await requestWithRetry(buildBody(validated, options, true), options);
    if (!response.body) throw new AIServiceError('Streaming is not supported by this response.', 'UNKNOWN');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = 'stop';

    while (true) {
      if (options.signal?.aborted) {
        await reader.cancel();
        throw new AIServiceError('Request was cancelled.', 'ABORTED');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const choice = json.choices?.[0];
          const token: string | undefined = choice?.delta?.content;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (token) {
            collected += token;
            onToken(token);
          }
        } catch {
          continue;
        }
      }
    }

    const promptTokens = validated.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const completionTokens = estimateTokens(collected);
    return {
      content: collected,
      source: 'openai',
      model,
      finishReason,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof AIServiceError && error.code === 'ABORTED') throw error;
    console.error('Error streaming from AI service:', error);
    if (options.fallbackToMock === false || collected.length > 0) {
      throw error instanceof AIServiceError ? error : new AIServiceError('Unexpected AI error.', 'UNKNOWN');
    }
    return runMock();
  }
}

export function createJarvisSystemPrompt(options: JarvisPromptOptions = {}): ChatMessage {
  const address = options.userName ? `Address the user as "${options.userName}" or "sir".` : 'Address the user as "sir" or by name if known.';
  const liveContext = options.liveContext?.trim()
    ? `\n\nLive platform context (use it as the source of truth for current values):\n${options.liveContext.trim()}`
    : '';

  return {
    role: 'system',
    content: `You are JARVIS, an advanced AI assistant for the Satell-Eye satellite imaging and mission control platform. You have a sophisticated, polite British manner and speak with confidence and precision, similar to Tony Stark's JARVIS from Iron Man.

Your capabilities include:
- Satellite tracking including ISS, Hubble, Starlink, GPS/GLONASS/Galileo navigation satellites, and Earth observation satellites
- Access to NASA EONET for global natural disaster monitoring (wildfires, earthquakes, floods, volcanoes, severe storms)
- Global weather and air quality data
- AI-powered satellite image analysis for detection, classification and segmentation

Your personality:
- Professional, sophisticated, and slightly witty
- Use British English spellings and expressions
- ${address}
- Provide precise technical data when requested
- Offer proactive suggestions and insights
- Maintain a calm demeanour even during emergencies

Rules:
- Keep responses concise, typically 2 to 4 sentences unless detailed technical information is requested.
- Never invent live data such as current positions, readings or counts. If live context is not provided, say you do not have it and explain how to obtain it.
- Acknowledge when you do not have specific information.

Current UTC time: ${new Date().toISOString()}${liveContext}`,
  };
}

export class JarvisConversation {
  private history: ChatMessage[] = [];
  private systemOptions: JarvisPromptOptions;
  private usage: TokenUsage = zeroUsage();
  private readonly maxTurns: number;

  constructor(systemOptions: JarvisPromptOptions = {}, maxTurns = 20) {
    this.systemOptions = systemOptions;
    this.maxTurns = maxTurns;
  }

  setContext(liveContext: string): void {
    this.systemOptions = { ...this.systemOptions, liveContext };
  }

  setUserName(userName: string): void {
    this.systemOptions = { ...this.systemOptions, userName };
  }

  private buildMessages(userText: string): ChatMessage[] {
    return [createJarvisSystemPrompt(this.systemOptions), ...this.history, { role: 'user', content: userText }];
  }

  private record(userText: string, result: ChatResult): void {
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: result.content });
    if (this.history.length > this.maxTurns * 2) {
      this.history = this.history.slice(-this.maxTurns * 2);
    }
    this.usage = {
      promptTokens: this.usage.promptTokens + result.usage.promptTokens,
      completionTokens: this.usage.completionTokens + result.usage.completionTokens,
      totalTokens: this.usage.totalTokens + result.usage.totalTokens,
    };
  }

  async send(userText: string, options: ChatOptions = {}): Promise<ChatResult> {
    const result = await sendChatMessageDetailed(this.buildMessages(userText), options);
    this.record(userText, result);
    return result;
  }

  async stream(userText: string, onToken: (token: string) => void, options: ChatOptions = {}): Promise<ChatResult> {
    const result = await streamChatMessage(this.buildMessages(userText), onToken, options);
    this.record(userText, result);
    return result;
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  reset(): void {
    this.history = [];
    this.usage = zeroUsage();
  }

  export(): string {
    return JSON.stringify({ exportedAt: new Date().toISOString(), usage: this.usage, messages: this.history }, null, 2);
  }
}
