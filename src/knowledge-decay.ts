import { createHash } from 'node:crypto';

export type KnowledgeDecayKind = 'constraint' | 'reference' | 'episodic';

export interface KnowledgeUsageRecord {
  contentHash: string;
  contentChangedAt: string;
  searchHits: number;
  readCount: number;
  lastHitAt?: string;
  lastReadAt?: string;
}

export interface KnowledgeDecayConfig {
  floor: number;
  warningThreshold: number;
  readRejuvenationAlpha: number;
  halfLives: Record<KnowledgeDecayKind, number>;
}

export const DEFAULT_DECAY_CONFIG: KnowledgeDecayConfig = {
  floor: 0.3,
  warningThreshold: 0.5,
  readRejuvenationAlpha: 0.5,
  halfLives: {
    constraint: 180,
    reference: 60,
    episodic: 30,
  },
};

const DAY_MS = 86_400_000;

export function computeUsageContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 计算带下界的渐近时间衰减系数，显式消费次数越多，有效半衰期越长（对数饱和）。
 * factor = floor + (1 - floor) * exp(-ln(2) / effectiveHalfLife * ageDays)
 */
export function computeDecayFactor(
  input: {
    kind: KnowledgeDecayKind;
    contentChangedAt: string | number;
    readCount?: number;
    nowMs?: number;
  },
  config: KnowledgeDecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const changedMs = typeof input.contentChangedAt === 'number'
    ? input.contentChangedAt
    : Date.parse(input.contentChangedAt);
  if (!Number.isFinite(changedMs)) return 1.0;
  const nowMs = input.nowMs ?? Date.now();
  // 按整天量化年龄，避免同一天内毫秒级写入时间差扰动同分排序或跨接口得分一致性。
  const ageDays = Math.floor(Math.max(0, nowMs - changedMs) / DAY_MS);
  const baseHalfLife = config.halfLives[input.kind] ?? 60;
  const reads = Math.max(0, input.readCount ?? 0);
  const effectiveHalfLife = baseHalfLife * (1 + config.readRejuvenationAlpha * Math.log1p(reads));
  const lambda = Math.LN2 / effectiveHalfLife;
  return config.floor + (1 - config.floor) * Math.exp(-lambda * ageDays);
}

export function isStaleDecayFactor(
  factor: number,
  config: KnowledgeDecayConfig = DEFAULT_DECAY_CONFIG,
): boolean {
  return factor < config.warningThreshold;
}

/**
 * 有界探索槽：仅在首页且候选充足时，用满足相关性下限的最低曝光候选与第 limit 位交换位置，
 * 既打破高曝光反馈闭环，又保持全量分页不重不漏。
 */
export function applyBoundedExploration<T>(
  items: readonly T[],
  options: {
    limit: number;
    page?: number;
    getId: (item: T) => string;
    getScore: (item: T) => number;
    searchHits: ReadonlyMap<string, number>;
    minRelevanceRatio?: number;
  },
): T[] {
  const list = [...items];
  const { limit, page = 1, getId, getScore, searchHits, minRelevanceRatio = 0.35 } = options;
  if (page !== 1 || limit < 4 || list.length <= limit || searchHits.size === 0) {
    return list;
  }
  const topScore = getScore(list[0]);
  if (!Number.isFinite(topScore) || topScore <= 0) return list;

  const head = list.slice(0, limit);
  const maxHeadHits = Math.max(...head.map(item => searchHits.get(getId(item)) ?? 0));
  let bestIndex = -1;
  let bestHits = Number.POSITIVE_INFINITY;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestId = '';

  for (let index = limit; index < list.length; index++) {
    const candidate = list[index];
    const id = getId(candidate);
    if (!searchHits.has(id)) continue;
    const score = getScore(candidate);
    if (score / topScore < minRelevanceRatio) continue;
    const hits = searchHits.get(id) ?? 0;
    if (
      hits < bestHits ||
      (hits === bestHits && (score > bestScore || (score === bestScore && id.localeCompare(bestId) < 0)))
    ) {
      bestIndex = index;
      bestHits = hits;
      bestScore = score;
      bestId = id;
    }
  }

  if (bestIndex < 0 || bestHits >= maxHeadHits) return list;
  const displaced = list[limit - 1];
  list[limit - 1] = list[bestIndex];
  list[bestIndex] = displaced;
  return list;
}

export interface UsageConcentration {
  positiveCount: number;
  totalEvents: number;
  top5Share: number;
  top10Share: number;
  gini: number;
  hhi: number;
}

export function computeUsageConcentration(values: readonly number[]): UsageConcentration {
  const positive = values.filter(value => value > 0).sort((a, b) => b - a);
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return { positiveCount: 0, totalEvents: 0, top5Share: 0, top10Share: 0, gini: 0, hhi: 0 };
  }
  const share = (count: number) => positive.slice(0, count).reduce((sum, value) => sum + value, 0) / total;
  const ascending = [...positive].sort((a, b) => a - b);
  const weighted = ascending.reduce((sum, value, index) => sum + (index + 1) * value, 0);
  const n = ascending.length;
  const gini = (2 * weighted) / (n * total) - (n + 1) / n;
  const hhi = positive.reduce((sum, value) => sum + (value / total) ** 2, 0);
  return {
    positiveCount: positive.length,
    totalEvents: total,
    top5Share: share(5),
    top10Share: share(10),
    gini,
    hhi,
  };
}
