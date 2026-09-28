import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatMessage } from './types.js';

export function id(): string {
  return randomUUID();
}

export function sha256(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(json).digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text ?? '');
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

export function messageText(message: ChatMessage): string {
  return textFromContent(message.content);
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(textFromContent(value).length / 4);
}

export function estimateMessageTokens(message: ChatMessage): number {
  return 4 + estimateTokens(message.content) + estimateTokens(message.tool_calls);
}

export function normalizeKeywords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])].slice(0, 32);
}

export function parseBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...existing, ...incoming]) {
    const hash = sha256(message);
    if (seen.has(hash)) continue;
    seen.add(hash);
    result.push(message);
  }
  return result;
}
