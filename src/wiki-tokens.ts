// From TencentDB Agent Memory Wiki manager (MIT).
export const WIKI_TOKEN_SPLIT_REGEX = /[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/;

export const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "怎么", "怎样", "如何", "为什么", "为何", "哪些", "哪个", "哪里", "哪儿", "在哪",
  "是否", "能否", "可以", "需要", "应该", "应当", "注意", "时候", "一下", "一些",
  "这个", "那个", "这些", "那些", "关于", "以及", "或者", "如果", "因为", "所以", "但是",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
]);

const CJK_PARTICLE_CHARS = new Set(['的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '么', '怎', '哪', '什']);

function pushCjkTokens(segment: string, out: string[], rawFallback: string[]): void {
  const chars = [...segment];
  if (chars.length === 0) return;
  if (chars.length === 1) {
    rawFallback.push(segment);
    if (!STOP_WORDS.has(segment)) out.push(segment);
    return;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const bigram = chars[i] + chars[i + 1];
    rawFallback.push(bigram);
    if (!STOP_WORDS.has(bigram) && !CJK_PARTICLE_CHARS.has(chars[i]) && !CJK_PARTICLE_CHARS.has(chars[i + 1])) {
      out.push(bigram);
    }
  }
  if (chars.length <= 8) {
    rawFallback.push(segment);
    if (!STOP_WORDS.has(segment)) out.push(segment);
  }
}

export function tokenizeWiki(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(WIKI_TOKEN_SPLIT_REGEX)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  const rawFallback: string[] = [];
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
    const hasLatin = /[a-z]/.test(token);

    if (hasCJK && hasLatin) {
      // 混合 token（如 "l0录入"）：拆分中英文部分分别处理
      const parts = token.split(/(?<=[a-z0-9])(?=[\u4e00-\u9fff\u3400-\u4dbf])|(?<=[\u4e00-\u9fff\u3400-\u4dbf])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(part)) {
          pushCjkTokens(part, result, rawFallback);
        } else if (part.length > 0) {
          rawFallback.push(part);
          if (!STOP_WORDS.has(part)) result.push(part);
        }
      }
    } else if (hasCJK) {
      pushCjkTokens(token, result, rawFallback);
    } else if (token.length > 0) {
      // 纯英文/数字：保留完整 token
      rawFallback.push(token);
      if (!STOP_WORDS.has(token)) result.push(token);
    }
  }
  return result.length > 0 ? result : rawFallback;
}
