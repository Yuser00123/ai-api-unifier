import type { GatewayConfig } from './types.js';
import type { Store } from './types.js';
import type {
  Candidate,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderName,
  ProviderResult,
  ProviderAttempt,
  ProviderError,
  StreamChunk,
  UsageEvent,
} from './types.js';
import { id, sleep } from './utils.js';
import { ProviderError as ProviderErrorClass } from './types.js';

const providerBases: Record<ProviderName, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.com',
};

const knownProviders: ProviderName[] = ['openrouter', 'gemini', 'groq', 'nvidia', 'mistral', 'cohere'];
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function normalizedRequest(request: ChatCompletionRequest, model: string, stream: boolean): Record<string, unknown> {
  const allowed = [
    'messages', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice',
    'response_format', 'reasoning_effort', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'n',
    'parallel_tool_calls', 'response_mime_type', 'thinking',
  ];
  const body: Record<string, unknown> = { model, stream };
  for (const key of allowed) {
    if (request[key] !== undefined) body[key] = request[key];
  }
  return body;
}

function extractErrorMessage(payload: unknown): string {
  if (typeof payload === 'string') return payload.slice(0, 1000);
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) return String((error as Record<string, unknown>).message);
    if ('message' in record) return String(record.message);
  }
  return 'provider request failed';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function normalizeResponse(payload: unknown, candidate: Candidate): ChatCompletionResponse {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  return {
    ...record,
    id: typeof record.id === 'string' ? record.id : `chatcmpl-${id()}`,
    object: 'chat.completion',
    created: typeof record.created === 'number' ? record.created : Math.floor(Date.now() / 1000),
    model: typeof record.model === 'string' ? record.model : candidate.model,
    choices: choices as ChatCompletionResponse['choices'],
  } as ChatCompletionResponse;
}

function extractUsage(response: ChatCompletionResponse): ProviderResult['usage'] {
  const usage = response.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function cohereMessages(request: ChatCompletionRequest): unknown[] {
  return request.messages.map((message) => ({
    role: message.role === 'developer' ? 'system' : message.role,
    content: typeof message.content === 'string' ? message.content : message.content ?? '',
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));
}

function normalizeCohereResponse(payload: unknown, candidate: Candidate): ChatCompletionResponse {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const message = record.message ?? {};
  const contentParts = Array.isArray(message.content) ? message.content : [];
  const text = contentParts.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
  const tokens = record.usage?.tokens ?? {};
  return {
    id: typeof record.id === 'string' ? record.id : `chatcmpl-${id()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: candidate.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: record.finish_reason ?? 'stop',
    }],
    usage: {
      prompt_tokens: tokens.input_tokens,
      completion_tokens: tokens.output_tokens,
      total_tokens: typeof tokens.input_tokens === 'number' && typeof tokens.output_tokens === 'number' ? tokens.input_tokens + tokens.output_tokens : undefined,
    },
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function* parseSse(response: Response, candidate: Candidate, cohere = false): AsyncGenerator<StreamChunk> {
  if (!response.body) throw new ProviderErrorClass('provider returned an empty stream', candidate.provider, undefined, true, 'empty_stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const streamId = `chatcmpl-${id()}`;
  let finished = false;

  const parseEvent = (event: string): StreamChunk | undefined => {
    const dataLine = event.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (!dataLine) return undefined;
    const data = dataLine.slice(5).trim();
    if (!data || data === '[DONE]') return undefined;
    let payload: any;
    try { payload = JSON.parse(data); } catch { return undefined; }
    if (!cohere && Array.isArray(payload.choices)) {
      return { ...payload, id: payload.id ?? streamId, object: 'chat.completion.chunk', model: payload.model ?? candidate.model } as StreamChunk;
    }
    const type = payload.type ?? payload.event_type;
    const text = payload.delta?.message?.content?.text ?? payload.delta?.text ?? payload.text ?? payload.content?.text;
    if (typeof text === 'string' && text.length > 0) {
      return { id: payload.id ?? streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: candidate.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
    }
    if (type === 'message-end' || type === 'content-end' || payload.finish_reason) {
      finished = true;
      return { id: payload.id ?? streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: candidate.model, choices: [{ index: 0, delta: {}, finish_reason: payload.finish_reason ?? 'stop' }] };
    }
    return undefined;
  };

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const chunk = parseEvent(event);
      if (chunk) yield chunk;
    }
  }
  if (buffer.trim()) {
    const chunk = parseEvent(buffer);
    if (chunk) yield chunk;
  }
}

class ProviderClient {
  constructor(private readonly config: GatewayConfig, private readonly provider: ProviderName) {}

  private key(): string {
    const key = this.config.providerKeys[this.provider];
    if (!key) throw new ProviderErrorClass(`no API key configured for ${this.provider}`, this.provider, 401, false, 'missing_provider_key');
    return key;
  }

  private base(): string {
    return this.config.providerBases[this.provider] ?? providerBases[this.provider];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key()}`, 'Content-Type': 'application/json' };
    if (this.provider === 'openrouter') {
      if (this.config.openRouterSiteUrl) headers['HTTP-Referer'] = this.config.openRouterSiteUrl;
      headers['X-OpenRouter-Title'] = this.config.openRouterAppName;
    }
    return headers;
  }

  async complete(request: ChatCompletionRequest, candidate: Candidate): Promise<ProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const isCohere = this.provider === 'cohere';
      const url = isCohere ? endpoint(this.base(), '/v2/chat') : endpoint(this.base(), '/chat/completions');
      const body = isCohere
        ? { model: candidate.model, messages: cohereMessages(request), stream: false, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}), ...(request.tools ? { tools: request.tools } : {}), ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}) }
        : normalizedRequest(request, candidate.model, false);
      const response = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
      const payload = await parseJsonResponse(response);
      if (!response.ok) {
        throw new ProviderErrorClass(extractErrorMessage(payload), this.provider, response.status, retryableStatuses.has(response.status), `http_${response.status}`);
      }
      const normalized = isCohere ? normalizeCohereResponse(payload, candidate) : normalizeResponse(payload, candidate);
      return { response: normalized, usage: extractUsage(normalized) };
    } catch (error) {
      if (error instanceof ProviderErrorClass) throw error;
      if (isAbortError(error)) throw new ProviderErrorClass('provider request timed out', this.provider, 408, true, 'timeout');
      throw new ProviderErrorClass(error instanceof Error ? error.message : 'provider request failed', this.provider, undefined, true, 'network_error');
    } finally {
      clearTimeout(timeout);
    }
  }

  async openStream(request: ChatCompletionRequest, candidate: Candidate): Promise<AsyncGenerator<StreamChunk>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const isCohere = this.provider === 'cohere';
      const url = isCohere ? endpoint(this.base(), '/v2/chat') : endpoint(this.base(), '/chat/completions');
      const body = isCohere
        ? { model: candidate.model, messages: cohereMessages(request), stream: true, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}), ...(request.tools ? { tools: request.tools } : {}), ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}) }
        : normalizedRequest(request, candidate.model, true);
      const response = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        const payload = await parseJsonResponse(response);
        throw new ProviderErrorClass(extractErrorMessage(payload), this.provider, response.status, retryableStatuses.has(response.status), `http_${response.status}`);
      }
      const generator = parseSse(response, candidate, isCohere);
      return generator;
    } catch (error) {
      if (error instanceof ProviderErrorClass) throw error;
      if (isAbortError(error)) throw new ProviderErrorClass('provider stream timed out before starting', this.provider, 408, true, 'timeout');
      throw new ProviderErrorClass(error instanceof Error ? error.message : 'provider stream failed', this.provider, undefined, true, 'network_error');
    } finally {
      clearTimeout(timeout);
    }
  }

  async embed(text: string, model: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const isCohere = this.provider === 'cohere';
      const url = isCohere ? endpoint(this.base(), '/v2/embed') : endpoint(this.base(), '/embeddings');
      const body = isCohere ? { model, input_type: 'search_query', texts: [text] } : { model, input: text };
      const response = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
      const payload = await parseJsonResponse(response) as any;
      if (!response.ok) throw new ProviderErrorClass(extractErrorMessage(payload), this.provider, response.status, retryableStatuses.has(response.status), `http_${response.status}`);
      const vector = isCohere ? payload.embeddings?.float?.[0] : payload.data?.[0]?.embedding;
      if (!Array.isArray(vector)) throw new ProviderErrorClass('embedding response did not include a vector', this.provider, 502, false, 'invalid_embedding');
      return vector.map(Number);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseCandidate(value: string): Candidate | undefined {
  const separator = value.indexOf(':');
  if (separator > 0) {
    const provider = value.slice(0, separator) as ProviderName;
    const model = value.slice(separator + 1).trim();
    if (knownProviders.includes(provider) && model) return { provider, model };
  }
  for (const provider of knownProviders) {
    if (value.startsWith(`${provider}/`)) return { provider, model: value.slice(provider.length + 1) };
  }
  return undefined;
}

export interface RequestMeta {
  requestId: string;
  agentId: string;
  sessionId?: string;
}

export class ProviderRouter {
  private readonly clients: Record<ProviderName, ProviderClient>;
  private readonly cooldowns = new Map<ProviderName, { until: number; failures: number }>();

  constructor(private readonly config: GatewayConfig, private readonly store: Store) {
    this.clients = Object.fromEntries(knownProviders.map((provider) => [provider, new ProviderClient(config, provider)])) as Record<ProviderName, ProviderClient>;
  }

  private isCoolingDown(provider: ProviderName): boolean {
    const state = this.cooldowns.get(provider);
    return Boolean(state && state.until > Date.now());
  }

  private markSuccess(provider: ProviderName): void {
    this.cooldowns.delete(provider);
  }

  private markFailure(provider: ProviderName, retryable: boolean): void {
    if (!retryable) return;
    const state = this.cooldowns.get(provider) ?? { until: 0, failures: 0 };
    const failures = Math.min(6, state.failures + 1);
    this.cooldowns.set(provider, { failures, until: Date.now() + Math.min(60000, 5000 * 2 ** (failures - 1)) });
  }

  candidates(model: string): Candidate[] {
    const routeValue = this.config.routes[model] || (model.includes('/') ? model : this.config.routes[this.config.defaultRoute]);
    const parsed = routeValue ? routeValue.split(',').map(parseCandidate).filter((candidate): candidate is Candidate => Boolean(candidate)) : [];
    const direct = parseCandidate(model);
    if (direct) return [direct, ...parsed.filter((item) => item.provider !== direct.provider || item.model !== direct.model)];
    return parsed;
  }

  private async safeLog(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch { /* telemetry must not break inference */ }
  }

  private async tryComplete(candidate: Candidate, request: ChatCompletionRequest, meta: RequestMeta, attemptNumber: number): Promise<ProviderResult> {
    const started = Date.now();
    const attempt: ProviderAttempt = { id: id(), requestId: meta.requestId, agentId: meta.agentId, sessionId: meta.sessionId, provider: candidate.provider, model: candidate.model, attemptNumber, status: 'started' };
    await this.safeLog(() => this.store.logAttempt(attempt));
    try {
      const result = await this.clients[candidate.provider].complete(request, candidate);
      this.markSuccess(candidate.provider);
      await this.safeLog(() => this.store.logAttempt({ ...attempt, status: 'success', latencyMs: Date.now() - started }));
      if (result.usage) {
        const usage: UsageEvent = { id: id(), requestId: meta.requestId, agentId: meta.agentId, sessionId: meta.sessionId, provider: candidate.provider, model: candidate.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens };
        await this.safeLog(() => this.store.logUsage(usage));
      }
      return result;
    } catch (error) {
      const providerError = error instanceof ProviderErrorClass ? error : new ProviderErrorClass('unknown provider error', candidate.provider, undefined, true);
      this.markFailure(candidate.provider, providerError.retryable);
      await this.safeLog(() => this.store.logAttempt({ ...attempt, status: 'failed', errorCode: providerError.code, errorMessage: providerError.message.slice(0, 500), latencyMs: Date.now() - started }));
      throw providerError;
    }
  }

  async complete(request: ChatCompletionRequest, meta: RequestMeta): Promise<{ result: ProviderResult; candidate: Candidate; fallbackIndex: number }> {
    const candidates = this.candidates(request.model);
    if (!candidates.length) throw new ProviderErrorClass(`no configured provider route for model alias '${request.model}'`, 'openrouter', 503, false, 'no_route');
    let lastError: ProviderError | undefined;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!;
      if (this.isCoolingDown(candidate.provider)) continue;
      for (let retry = 0; retry <= this.config.retryAttempts; retry += 1) {
        try {
          return { result: await this.tryComplete(candidate, request, meta, candidateIndex + retry + 1), candidate, fallbackIndex: candidateIndex };
        } catch (error) {
          lastError = error instanceof ProviderErrorClass ? error : new ProviderErrorClass('provider error', candidate.provider, undefined, true);
          if (retry < this.config.retryAttempts && lastError.retryable) {
            await sleep(this.config.retryBaseDelayMs * 2 ** retry + Math.floor(Math.random() * 100));
            continue;
          }
          break;
        }
      }
    }
    throw lastError ?? new ProviderErrorClass('all providers failed', 'openrouter', 503, false, 'all_providers_failed');
  }

  async openStream(request: ChatCompletionRequest, meta: RequestMeta): Promise<{ stream: AsyncGenerator<StreamChunk>; candidate: Candidate; fallbackIndex: number }> {
    const candidates = this.candidates(request.model);
    if (!candidates.length) throw new ProviderErrorClass(`no configured provider route for model alias '${request.model}'`, 'openrouter', 503, false, 'no_route');
    let lastError: ProviderError | undefined;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!;
      if (this.isCoolingDown(candidate.provider)) continue;
      for (let retry = 0; retry <= this.config.retryAttempts; retry += 1) {
        try {
          const started = Date.now();
          const attempt: ProviderAttempt = { id: id(), requestId: meta.requestId, agentId: meta.agentId, sessionId: meta.sessionId, provider: candidate.provider, model: candidate.model, attemptNumber: candidateIndex * (this.config.retryAttempts + 1) + retry + 1, status: 'started' };
          await this.safeLog(() => this.store.logAttempt(attempt));
          const stream = await this.clients[candidate.provider].openStream(request, candidate);
          this.markSuccess(candidate.provider);
          await this.safeLog(() => this.store.logAttempt({ ...attempt, status: 'success', latencyMs: Date.now() - started }));
          return { stream, candidate, fallbackIndex: candidateIndex };
        } catch (error) {
          lastError = error instanceof ProviderErrorClass ? error : new ProviderErrorClass('provider stream error', candidate.provider, undefined, true);
          this.markFailure(candidate.provider, lastError.retryable);
          if (retry < this.config.retryAttempts && lastError.retryable) {
            await sleep(this.config.retryBaseDelayMs * 2 ** retry + Math.floor(Math.random() * 100));
            continue;
          }
          break;
        }
      }
    }
    throw lastError ?? new ProviderErrorClass('all providers failed before stream started', 'openrouter', 503, false, 'all_providers_failed');
  }

  async embedText(text: string): Promise<number[] | undefined> {
    if (!this.config.embeddingProvider || !this.config.embeddingModel) return undefined;
    return this.clients[this.config.embeddingProvider].embed(text, this.config.embeddingModel);
  }
}
