export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: MessageRole | string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message?: ChatMessage;
  delta?: Record<string, unknown>;
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ProviderName = 'openrouter' | 'gemini' | 'groq' | 'nvidia' | 'mistral' | 'cohere';

export interface Candidate {
  provider: ProviderName;
  model: string;
}

export interface ProviderAttempt {
  id: string;
  requestId: string;
  agentId: string;
  sessionId?: string;
  provider: ProviderName;
  model: string;
  attemptNumber: number;
  status: 'started' | 'success' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
}

export type MemoryKind = 'semantic' | 'procedural' | 'episodic' | 'session';

export interface MemoryRecord {
  id: string;
  agentId: string;
  sessionId?: string;
  kind: MemoryKind;
  content: string;
  keywords: string[];
  importance: number;
  sourceMessageIds: string[];
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface UsageEvent {
  id: string;
  requestId: string;
  agentId: string;
  sessionId?: string;
  provider: ProviderName;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  ensureSession(id: string, agentId: string): Promise<void>;
  appendMessages(sessionId: string, agentId: string, messages: ChatMessage[]): Promise<void>;
  getMessages(sessionId: string, limit?: number): Promise<ChatMessage[]>;
  getSummary(sessionId: string): Promise<string | undefined>;
  setSummary(sessionId: string, summary: string): Promise<void>;
  upsertMemory(memory: MemoryRecord): Promise<void>;
  searchMemories(agentId: string, sessionId: string | undefined, query: string, embedding?: number[], limit?: number): Promise<MemoryRecord[]>;
  listMemories(agentId: string, sessionId?: string): Promise<MemoryRecord[]>;
  deleteMemory(id: string): Promise<void>;
  logAttempt(attempt: ProviderAttempt): Promise<void>;
  logUsage(event: UsageEvent): Promise<void>;
}

export interface GatewayConfig {
  nodeEnv: string;
  port: number;
  host: string;
  logLevel: string;
  gatewayApiKey: string;
  internalJobToken?: string;
  databaseUrl?: string;
  redisUrl?: string;
  requestTimeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  contextBudgetTokens: number;
  recentMessageLimit: number;
  summaryTriggerMessages: number;
  maxMemoryResults: number;
  maxBodyBytes: number;
  embeddingProvider?: ProviderName;
  embeddingModel?: string;
  embeddingDimensions: number;
  defaultRoute: string;
  summaryRoute: string;
  routes: Record<string, string>;
  providerKeys: Partial<Record<ProviderName, string>>;
  providerBases: Partial<Record<ProviderName, string>>;
  openRouterSiteUrl?: string;
  openRouterAppName: string;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderResult {
  response: ChatCompletionResponse;
  usage?: ProviderUsage;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false,
    public readonly code: string = 'provider_error',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
