import { z } from 'zod';
import type { GatewayConfig, ProviderName } from './types.js';

const providerNames: ProviderName[] = ['openrouter', 'gemini', 'groq', 'nvidia', 'mistral', 'cohere'];

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  GATEWAY_API_KEY: z.string().min(16).default('dev-only-change-me-please-123456'),
  INTERNAL_JOB_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(8).default(2),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(300),
  CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(12000),
  RECENT_MESSAGE_LIMIT: z.coerce.number().int().positive().default(36),
  SUMMARY_TRIGGER_MESSAGES: z.coerce.number().int().positive().default(40),
  MAX_MEMORY_RESULTS: z.coerce.number().int().positive().default(12),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(2097152),
  EMBEDDING_PROVIDER: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  DEFAULT_ROUTE: z.string().default('balanced'),
  SUMMARY_ROUTE: z.string().default('cheap-summary'),
  ROUTE_FAST: z.string().default(''),
  ROUTE_BALANCED: z.string().default(''),
  ROUTE_REASONING: z.string().default(''),
  ROUTE_LONG_CONTEXT: z.string().default(''),
  ROUTE_CHEAP_SUMMARY: z.string().default(''),
  OPENROUTER_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().optional(),
  GEMINI_BASE_URL: z.string().optional(),
  GROQ_BASE_URL: z.string().optional(),
  NVIDIA_BASE_URL: z.string().optional(),
  MISTRAL_BASE_URL: z.string().optional(),
  COHERE_BASE_URL: z.string().optional(),
  OPENROUTER_SITE_URL: z.string().optional(),
  OPENROUTER_APP_NAME: z.string().default('Unified AI Memory Gateway'),
});

function parseRoute(value: string): string {
  return value.split(',').map((item) => item.trim()).filter(Boolean).join(',');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.parse(env);
  if (parsed.NODE_ENV === 'production' && parsed.GATEWAY_API_KEY === 'dev-only-change-me-please-123456') {
    throw new Error('GATEWAY_API_KEY must be explicitly set in production');
  }
  const routes: Record<string, string> = {
    fast: parseRoute(parsed.ROUTE_FAST),
    balanced: parseRoute(parsed.ROUTE_BALANCED),
    reasoning: parseRoute(parsed.ROUTE_REASONING),
    'long-context': parseRoute(parsed.ROUTE_LONG_CONTEXT),
    'cheap-summary': parseRoute(parsed.ROUTE_CHEAP_SUMMARY),
  };

  const providerKeys: Partial<Record<ProviderName, string>> = {
    openrouter: parsed.OPENROUTER_API_KEY,
    gemini: parsed.GEMINI_API_KEY,
    groq: parsed.GROQ_API_KEY,
    nvidia: parsed.NVIDIA_API_KEY,
    mistral: parsed.MISTRAL_API_KEY,
    cohere: parsed.COHERE_API_KEY,
  };

  const embeddingProvider = parsed.EMBEDDING_PROVIDER && providerNames.includes(parsed.EMBEDDING_PROVIDER as ProviderName)
    ? parsed.EMBEDDING_PROVIDER as ProviderName
    : undefined;

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    gatewayApiKey: parsed.GATEWAY_API_KEY,
    internalJobToken: parsed.INTERNAL_JOB_TOKEN,
    databaseUrl: parsed.DATABASE_URL || undefined,
    redisUrl: parsed.REDIS_URL || undefined,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    retryAttempts: parsed.RETRY_ATTEMPTS,
    retryBaseDelayMs: parsed.RETRY_BASE_DELAY_MS,
    contextBudgetTokens: parsed.CONTEXT_BUDGET_TOKENS,
    recentMessageLimit: parsed.RECENT_MESSAGE_LIMIT,
    summaryTriggerMessages: parsed.SUMMARY_TRIGGER_MESSAGES,
    maxMemoryResults: parsed.MAX_MEMORY_RESULTS,
    maxBodyBytes: parsed.MAX_BODY_BYTES,
    embeddingProvider,
    embeddingModel: parsed.EMBEDDING_MODEL || undefined,
    embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
    defaultRoute: parsed.DEFAULT_ROUTE,
    summaryRoute: parsed.SUMMARY_ROUTE,
    routes,
    providerKeys,
    providerBases: {
      openrouter: parsed.OPENROUTER_BASE_URL || undefined,
      gemini: parsed.GEMINI_BASE_URL || undefined,
      groq: parsed.GROQ_BASE_URL || undefined,
      nvidia: parsed.NVIDIA_BASE_URL || undefined,
      mistral: parsed.MISTRAL_BASE_URL || undefined,
      cohere: parsed.COHERE_BASE_URL || undefined,
    },
    openRouterSiteUrl: parsed.OPENROUTER_SITE_URL || undefined,
    openRouterAppName: parsed.OPENROUTER_APP_NAME,
  };
}
