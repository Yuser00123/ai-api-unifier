import 'dotenv/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { MemoryManager } from './memory.js';
import { ProviderRouter } from './providers.js';
import { createStore } from './storage.js';
import { RateLimiter } from './rate-limit.js';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage, MemoryKind } from './types.js';
import { ProviderError as ProviderErrorClass } from './types.js';
import { constantTimeEqual, id, messageText, parseBearer, textFromContent } from './utils.js';

const config = loadConfig();
const store = createStore(config.databaseUrl);
let redis: RedisClientType | undefined;
if (config.redisUrl) {
  redis = createClient({ url: config.redisUrl });
  redis.on('error', (error) => console.error('[redis]', error));
}
const limiter = new RateLimiter(redis);
const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: config.maxBodyBytes });
const providerRouter = new ProviderRouter(config, store);
let storageReady = false;

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.record(z.unknown())).min(1),
  stream: z.boolean().optional(),
}).passthrough();

const memoryRequestSchema = z.object({
  kind: z.enum(['semantic', 'procedural', 'episodic', 'session']),
  content: z.string().min(1).max(10000),
  session_id: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
});

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestIdentity(request: FastifyRequest): { agentId: string; sessionId?: string; requestId: string } {
  const requestId = headerValue(request, 'x-request-id') || id();
  const agentId = headerValue(request, 'x-agent-id') || 'default-agent';
  const sessionId = headerValue(request, 'x-session-id');
  return { agentId, sessionId, requestId };
}

function getMessages(body: z.infer<typeof chatRequestSchema>): ChatMessage[] {
  return body.messages as unknown as ChatMessage[];
}

function errorStatus(error: unknown): number {
  if (error instanceof ProviderErrorClass) {
    if (error.code === 'no_route' || error.code === 'all_providers_failed') return 503;
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) return error.statusCode;
    return 502;
  }
  return 500;
}

function sendError(reply: FastifyReply, error: unknown): void {
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message : 'internal server error';
  const code = error instanceof ProviderErrorClass ? error.code : 'internal_error';
  reply.code(status).send({ error: { message, type: status >= 500 ? 'gateway_error' : 'invalid_request_error', code } });
}

function assistantMessageFromResponse(response: { choices?: Array<{ message?: ChatMessage }> }): ChatMessage | undefined {
  return response.choices?.[0]?.message;
}

function extractStreamAssistant(chunks: Array<{ choices: Array<{ delta?: Record<string, unknown> }> }>): ChatMessage {
  let content = '';
  const toolCalls: unknown[] = [];
  for (const chunk of chunks) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string') content += delta.content;
    if (Array.isArray(delta.tool_calls)) toolCalls.push(...delta.tool_calls);
  }
  return { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

async function completeWithOptionalContinuation(
  providerRequest: ChatCompletionRequest,
  identity: { requestId: string; agentId: string; sessionId?: string },
  initial: Awaited<ReturnType<ProviderRouter['complete']>>,
): Promise<{ completed: Awaited<ReturnType<ProviderRouter['complete']>>; continuations: number }> {
  if (providerRequest.auto_continue !== true) return { completed: initial, continuations: 0 };
  const requestedLimit = typeof providerRequest.max_continuations === 'number' ? providerRequest.max_continuations : 2;
  const maxContinuations = Math.max(0, Math.min(5, Math.floor(requestedLimit)));
  let current = initial;
  let continuations = 0;
  let accumulated = textFromContent(current.result.response.choices[0]?.message?.content);
  let previousMessage = current.result.response.choices[0]?.message;
  if (!previousMessage || previousMessage.tool_calls?.length || current.result.response.choices[0]?.finish_reason !== 'length') return { completed: current, continuations };

  while (continuations < maxContinuations && previousMessage) {
    const continuationRequest: ChatCompletionRequest = {
      ...providerRequest,
      messages: [
        ...providerRequest.messages,
        previousMessage,
        { role: 'user', content: 'Continue the previous answer from exactly where it stopped. Do not repeat completed text.' },
      ],
      auto_continue: false,
    };
    const next = await providerRouter.complete(continuationRequest, identity);
    const nextMessage = next.result.response.choices[0]?.message;
    if (!nextMessage) break;
    accumulated += textFromContent(nextMessage.content);
    const nextChoice = next.result.response.choices[0];
    current = {
      ...next,
      result: {
        ...next.result,
        response: {
          ...next.result.response,
          choices: [{ ...(nextChoice ?? { index: 0, finish_reason: 'stop' }), message: { ...nextMessage, content: accumulated } }],
        } as ChatCompletionResponse,
      },
    };
    continuations += 1;
    previousMessage = nextMessage;
    if (nextChoice?.finish_reason !== 'length') break;
  }
  return { completed: current, continuations };
}

function createMemoryManager(): MemoryManager {
  return new MemoryManager(
    store,
    config.contextBudgetTokens,
    config.recentMessageLimit,
    config.summaryTriggerMessages,
    config.maxMemoryResults,
    async (messages) => {
      const summaryRequest: ChatCompletionRequest = {
        model: config.summaryRoute,
        messages: [
          { role: 'system', content: 'Summarize the conversation facts, decisions, preferences, unresolved items, and current project state. Be compact and factual. Do not add new information.' },
          ...messages,
        ],
        temperature: 0,
        max_tokens: 900,
      };
      try {
        const result = await providerRouter.complete(summaryRequest, { requestId: `memory-${id()}`, agentId: 'memory-worker' });
        return textFromContent(result.result.response.choices[0]?.message?.content).slice(0, 6000);
      } catch {
        return messages.map((message) => `${message.role}: ${messageText(message)}`).join('\n').slice(0, 6000);
      }
    },
    async (text) => {
      const vector = await providerRouter.embedText(text);
      if (!vector || vector.length !== config.embeddingDimensions) return undefined;
      return vector;
    },
  );
}

const memoryManager = createMemoryManager();

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/health') || request.url.startsWith('/ready')) return;
  const supplied = parseBearer(headerValue(request, 'authorization'));
  if (!supplied || !constantTimeEqual(supplied, config.gatewayApiKey)) {
    reply.code(401).send({ error: { message: 'invalid or missing gateway API key', type: 'authentication_error', code: 'invalid_api_key' } });
    return reply;
  }
  const identity = requestIdentity(request);
  const rate = await limiter.check(identity.agentId, 120, 60);
  reply.header('x-ratelimit-remaining', String(rate.remaining));
  if (!rate.allowed) {
    reply.code(429).send({ error: { message: 'gateway rate limit exceeded', type: 'rate_limit_error', code: 'gateway_rate_limit' } });
    return reply;
  }
});

app.get('/health', async () => ({ status: 'ok', service: 'unified-ai-memory-gateway' }));

app.get('/ready', async (_request, reply) => {
  try {
    if (!storageReady) throw new Error('storage is still starting');
    return { status: 'ready', storage: config.databaseUrl ? 'postgres' : 'memory', redis: Boolean(redis) };
  } catch (error) {
    reply.code(503);
    return { status: 'not_ready', error: error instanceof Error ? error.message : 'storage initialization failed' };
  }
});

app.get('/v1/models', async () => {
  const aliases = Object.keys(config.routes).filter((name) => Boolean(config.routes[name]));
  return { object: 'list', data: aliases.map((idValue) => ({ id: idValue, object: 'model', owned_by: 'gateway' })) };
});

app.post('/v1/chat/completions', async (request, reply) => {
  const parsed = chatRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({ error: { message: parsed.error.message, type: 'invalid_request_error', code: 'invalid_chat_request' } });
    return;
  }
  const body = parsed.data;
  const identity = requestIdentity(request);
  const messages = getMessages(body);
  const sessionId = identity.sessionId;
  try {
    if (sessionId) {
      await store.ensureSession(sessionId, identity.agentId);
      await store.appendMessages(sessionId, identity.agentId, messages);
    }
    const contextMessages = sessionId ? await memoryManager.buildContext(identity.agentId, sessionId, messages) : messages;
    const providerRequest: ChatCompletionRequest = { ...(body as unknown as ChatCompletionRequest), messages: contextMessages, stream: Boolean(body.stream) };

    if (body.stream) {
      const opened = await providerRouter.openStream(providerRequest, identity);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Gateway-Provider': opened.candidate.provider,
        'X-Gateway-Model': opened.candidate.model,
        'X-Gateway-Fallback-Index': String(opened.fallbackIndex),
        ...(sessionId ? { 'X-Session-ID': sessionId } : {}),
      });
      const chunks: Array<{ choices: Array<{ delta?: Record<string, unknown> }> }> = [];
      try {
        for await (const chunk of opened.stream) {
          chunks.push(chunk);
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
        if (sessionId) {
          const assistant = extractStreamAssistant(chunks);
          await store.appendMessages(sessionId, identity.agentId, [assistant]);
          void memoryManager.updateAfterTurn(identity.agentId, sessionId).catch((error) => request.log.warn({ error }, 'memory update failed'));
        }
      } catch (error) {
        reply.raw.write(`event: gateway_error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : 'stream interrupted', code: 'stream_interrupted' })}\n\n`);
      } finally {
        reply.raw.end();
      }
      return;
    }

    const first = await providerRouter.complete(providerRequest, identity);
    const continuation = await completeWithOptionalContinuation(providerRequest, identity, first);
    const completed = continuation.completed;
    reply.header('x-gateway-provider', completed.candidate.provider);
    reply.header('x-gateway-model', completed.candidate.model);
    reply.header('x-gateway-fallback-index', String(completed.fallbackIndex));
    reply.header('x-gateway-continuations', String(continuation.continuations));
    if (sessionId) reply.header('x-session-id', sessionId);
    const assistant = assistantMessageFromResponse(completed.result.response);
    if (sessionId && assistant) {
      await store.appendMessages(sessionId, identity.agentId, [assistant]);
      void memoryManager.updateAfterTurn(identity.agentId, sessionId).catch((error) => request.log.warn({ error }, 'memory update failed'));
    }
    return completed.result.response;
  } catch (error) {
    sendError(reply, error);
  }
});

app.post('/v1/sessions', async (request, reply) => {
  const body = z.object({ id: z.string().min(1).max(200).optional() }).safeParse(request.body ?? {});
  if (!body.success) {
    reply.code(400).send({ error: { message: body.error.message, type: 'invalid_request_error', code: 'invalid_session_request' } });
    return;
  }
  const identity = requestIdentity(request);
  const sessionId = body.data.id || id();
  try {
    await store.ensureSession(sessionId, identity.agentId);
    reply.code(201).send({ id: sessionId, agent_id: identity.agentId });
  } catch (error) {
    sendError(reply, error);
  }
});

app.get('/v1/sessions/:sessionId', async (request, reply) => {
  const params = request.params as { sessionId: string };
  const identity = requestIdentity(request);
  try {
    await store.ensureSession(params.sessionId, identity.agentId);
    return { id: params.sessionId, agent_id: identity.agentId, summary: await store.getSummary(params.sessionId), messages: await store.getMessages(params.sessionId, 2000) };
  } catch (error) {
    sendError(reply, error);
  }
});

app.get('/v1/memories', async (request, reply) => {
  const query = request.query as { session_id?: string };
  const identity = requestIdentity(request);
  try {
    return { data: await store.listMemories(identity.agentId, query.session_id) };
  } catch (error) {
    sendError(reply, error);
  }
});

app.post('/v1/memories', async (request, reply) => {
  const parsed = memoryRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({ error: { message: parsed.error.message, type: 'invalid_request_error', code: 'invalid_memory_request' } });
    return;
  }
  const identity = requestIdentity(request);
  try {
    const memory = await memoryManager.createManualMemory(identity.agentId, parsed.data.session_id, parsed.data.kind as MemoryKind, parsed.data.content, parsed.data.importance);
    reply.code(201).send(memory);
  } catch (error) {
    sendError(reply, error);
  }
});

app.delete('/v1/memories/:memoryId', async (request, reply) => {
  const params = request.params as { memoryId: string };
  try {
    await store.deleteMemory(params.memoryId);
    reply.code(204).send();
  } catch (error) {
    sendError(reply, error);
  }
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof Error && error.message.toLowerCase().includes('body')) {
    reply.code(413).send({ error: { message: 'request body too large', type: 'invalid_request_error', code: 'body_too_large' } });
    return;
  }
  sendError(reply, error);
});

async function start(): Promise<void> {
  await store.init();
  storageReady = true;
  if (redis) await redis.connect();
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ host: config.host, port: config.port, storage: config.databaseUrl ? 'postgres' : 'memory' }, 'unified AI gateway started');
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  if (redis) await redis.quit();
  await store.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start().catch((error) => {
  app.log.error(error, 'failed to start gateway');
  process.exit(1);
});
