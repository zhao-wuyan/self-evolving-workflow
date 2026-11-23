import { InputError, requireText } from './common.js';
import { memoryModelSettings } from './memory-config.js';
import type { LlmClient } from './upstream/llm.js';
import { delegateOmpModel } from './workflow-delegate.js';

interface ChatCompletionChoice {
  finish_reason?: unknown;
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
  };
}

function extractMessageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? part.text
      : '')
    .join('\n')
    .trim();
  return text || undefined;
}

export function createModelClient(root: string): LlmClient {
  const settings = memoryModelSettings(root);
  if (settings.provider === 'omp') {
    return { chat: ({ system, prompt }) => delegateOmpModel(root, system, prompt, settings.timeoutMs ?? 240_000) };
  }
  const url = new URL(requireText(settings.baseUrl, 'LLM base URL (memory config or AGENT_MEMORY_LLM_BASE_URL)'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new InputError('LLM endpoint must use HTTP or HTTPS');
  if (!url.pathname.endsWith('/chat/completions')) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  }
  const model = requireText(settings.model, 'LLM model (memory config or AGENT_MEMORY_LLM_MODEL)');
  const key = process.env.AGENT_MEMORY_LLM_API_KEY;
  const timeoutMs = settings.timeoutMs ?? 240_000;
  return {
    async chat({ system, prompt }) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rawBody = await response.text();
      if (!response.ok) {
        const detail = rawBody.trim().slice(0, 200);
        throw new Error(`LLM request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
      }
      let data: { choices?: ChatCompletionChoice[]; error?: unknown };
      try {
        data = JSON.parse(rawBody) as { choices?: ChatCompletionChoice[]; error?: unknown };
      } catch {
        throw new Error(`LLM endpoint returned non-JSON response (HTTP ${response.status}): ${rawBody.trim().slice(0, 160)}`);
      }
      if (!data.choices?.length && data.error !== undefined) {
        const message = data.error && typeof data.error === 'object' && 'message' in data.error && typeof data.error.message === 'string'
          ? data.error.message
          : typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        throw new Error(`LLM request failed: ${message.trim().slice(0, 200)}`);
      }
      const choice = data.choices?.[0];
      const content = extractMessageText(choice?.message?.content);
      if (choice?.finish_reason === 'length') {
        throw new InputError(
          content
            ? 'LLM response truncated (finish_reason=length)'
            : 'LLM response truncated (finish_reason=length) before emitting content',
        );
      }
      if (content) return content;
      if (extractMessageText(choice?.message?.reasoning_content) || extractMessageText(choice?.message?.reasoning)) {
        throw new InputError('LLM response content was empty (only reasoning output was returned)');
      }
      return requireText(choice?.message?.content, 'LLM response content');
    },
  };
}
