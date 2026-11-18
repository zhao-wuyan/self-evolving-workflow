export interface ChatParams {
  system: string;
  prompt: string;
  label?: string;
}

export interface LlmClient {
  chat(params: ChatParams): Promise<string>;
}

/** 剥离推理模型输出的思维链标签块，兼容缺失开标签仅保留闭合标签的模板。 */
export function stripThinkingBlocks(raw: string): string {
  const closed = raw.replace(/<(think|thought)>[\s\S]*?<\/\1>\s*/gi, '').trim();
  if (!closed || /^[\[{`]/.test(closed)) return closed;
  const leadingClose = closed.match(/^[\s\S]*?<\/(?:think|thought)>\s*/i);
  if (leadingClose && !/<(?:think|thought)>/i.test(leadingClose[0])) {
    return closed.slice(leadingClose[0].length).trim();
  }
  return closed;
}

function findBalancedJsonEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') stack.push(']');
    else if (ch === '{') stack.push('}');
    else if (ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function unwrapObjectArray(value: unknown, wrapperKeys: readonly string[]): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)) ? value : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of wrapperKeys) {
    if (Array.isArray(record[key])) return unwrapObjectArray(record[key], wrapperKeys);
  }
  return undefined;
}

function pickPreferredArray(candidates: unknown[][]): unknown[] | undefined {
  return candidates.find(items => items.length > 0) ?? candidates[0];
}

/**
 * 从模型响应文本中稳健提取 JSON 对象数组：跳过思维链与非 JSON 括号文本，
 * 优先解析 Markdown 代码块，再通过括号平衡扫描提取，并兼容常见外层对象包装。
 */
export function extractJsonArray(raw: string, wrapperKeys: readonly string[] = ['items', 'results', 'data']): unknown[] | undefined {
  const text = stripThinkingBlocks(raw);
  if (!text) return undefined;

  const direct = unwrapObjectArray(tryParseJson(text), wrapperKeys);
  if (direct) return direct;

  const fenced: unknown[][] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = unwrapObjectArray(tryParseJson(match[1].trim()), wrapperKeys);
    if (parsed) fenced.push(parsed);
  }
  if (fenced.length) return pickPreferredArray(fenced);

  const scanned: unknown[][] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '[' && ch !== '{') continue;
    const end = findBalancedJsonEnd(text, i);
    if (end === -1) continue;
    const parsed = unwrapObjectArray(tryParseJson(text.slice(i, end + 1)), wrapperKeys);
    if (parsed) {
      scanned.push(parsed);
      i = end;
    }
  }
  return pickPreferredArray(scanned);
}

/** 在解析失败时附带格式纠偏提示重试一次，不吞掉模型通信错误。 */
export async function chatWithFormatRetry<T>(
  llm: LlmClient,
  params: ChatParams,
  parse: (raw: string) => T,
  formatHint: string,
): Promise<T> {
  const first = await llm.chat(params);
  try {
    return parse(first);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const prompt = `${params.prompt}\n\n[Format correction] Your previous response could not be parsed (${reason}). ${formatHint}`;
    return parse(await llm.chat({ ...params, prompt }));
  }
}
