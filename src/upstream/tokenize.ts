// Derived from TencentDB Agent Memory MemoryCore/src/core/store/tokenize.ts (MIT).
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';

const jieba = Jieba.withDict(dict);
export const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
  "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
  "什么", "怎么", "怎样", "如何", "为什么", "为何", "哪个", "哪些", "哪里", "哪儿", "在哪",
  "是否", "能否", "需要", "注意", "应该", "应当", "可以",
  "这个", "那个", "这些", "那些", "以及", "或者", "关于", "时候", "时", "一下", "一些",
  "把", "被", "从", "与", "对", "之", "其", "将", "并", "且", "但", "而",
  "已经", "正在", "如果", "因为", "所以", "但是",
]);

export function buildFtsQuery(text: string): string | null {
  const allWords = jieba.cutForSearch(text, true)
    .map(word => word.trim())
    .filter(word => /[\p{L}\p{N}]/u.test(word));
  if (!allWords.length) return null;
  const filtered = allWords.filter(word => !ZH_STOP_WORDS.has(word));
  const selected = filtered.length > 0 ? filtered : allWords;
  const terms = [...new Set(selected)].map(word => `"${word.replaceAll('"', '""')}"`);
  return terms.length ? terms.join(' OR ') : null;
}

export function tokenizeForFts(text: string): string {
  return jieba.cutForSearch(text, true).join(' ');
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
