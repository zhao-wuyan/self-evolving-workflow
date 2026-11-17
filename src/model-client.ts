import { InputError, requireText } from './common.js';
import { memoryModelSettings } from './memory-config.js';
import type { LlmClient } from './upstream/llm.js';
export function createModelClient(root: string): LlmClient {
  const settings = memoryModelSettings(root);
  const url = new URL(requireText(settings.baseUrl, 'LLM base URL (memory config or AGENT_MEMORY_LLM_BASE_URL)'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new InputError('LLM endpoint must use HTTP or HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  const model = requireText(settings.model, 'LLM model (memory config or AGENT_MEMORY_LLM_MODEL)');
  const key = process.env.AGENT_MEMORY_LLM_API_KEY;
  return {
    async chat({ system, prompt }) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`LLM request failed (HTTP ${response.status})`);
      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      return requireText(data.choices?.[0]?.message?.content, 'LLM response content');
    },
  };
}
