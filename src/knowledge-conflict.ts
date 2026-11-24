import { exactMemoryValues } from './memory-evidence.js';

export type ConflictRelation = 'same_content' | 'conflict' | 'overlap';
export type ConflictReason = 'exact_duplicate' | 'opposite_stance' | 'value_divergence' | 'high_overlap';
export type KnowledgeStance = 'positive' | 'negative' | 'unknown';

export interface ConflictTarget {
  id: string;
  title?: string;
  content: string;
  scope?: readonly string[];
  sources?: readonly string[];
}

export interface ConflictMatch {
  id: string;
  relation: ConflictRelation;
  reason: ConflictReason;
  score: number;
  sources?: string[];
}

const NEGATIVE_RE = /\b(?:must\s+not|mustn't|should\s+not|shouldn't|do\s+not|don't|never|forbid(?:den)?|prohibit(?:ed)?|avoid|disable(?:d)?)\b|不得|禁止|严禁|不可|不能|切勿|不要|禁用/gu;
const STRONG_POSITIVE_RE = /\b(?:must|required?|require|shall|should|always)\b|必须|应当|应该|需要|务必|始终|总是/u;
const WEAK_POSITIVE_RE = /\b(?:allow(?:ed)?|enable(?:d)?)\b|允许|启用/u;
const STANCE_STRIP_RE = /\b(?:must\s+not|mustn't|should\s+not|shouldn't|do\s+not|don't|never|forbid(?:den)?|prohibit(?:ed)?|avoid|disable(?:d)?|must|required?|require|shall|should|always|allow(?:ed)?|enable(?:d)?)\b|不得|禁止|严禁|不可|不能|切勿|不要|禁用|必须|应当|应该|需要|允许|务必|始终|总是|启用/gu;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalizeText(value).match(/\p{Script=Han}|[\p{L}\p{N}_-]+/gu) ?? []);
}

function ngrams(value: string, size = 3): Set<string> {
  const compact = normalizeText(value).replace(/\s+/g, '');
  if (!compact) return new Set();
  if (compact.length <= size) return new Set([compact]);
  const out = new Set<string>();
  for (let index = 0; index <= compact.length - size; index++) {
    out.add(compact.slice(index, index + size));
  }
  return out;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  return overlap / (left.size + right.size - overlap);
}

function dice(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  return (2 * overlap) / (left.size + right.size);
}

export function textSimilarity(left: string, right: string): number {
  return Math.min(1, 0.55 * jaccard(tokens(left), tokens(right)) + 0.45 * dice(ngrams(left), ngrams(right)));
}

export function detectStance(value: string): KnowledgeStance {
  const text = normalizeText(value);
  const hasNegative = new RegExp(NEGATIVE_RE.source, NEGATIVE_RE.flags).test(text);
  const withoutNegative = text.replace(NEGATIVE_RE, ' ');
  const hasStrongPositive = STRONG_POSITIVE_RE.test(withoutNegative);
  const hasWeakPositive = WEAK_POSITIVE_RE.test(withoutNegative);
  if (hasNegative && !hasStrongPositive) return 'negative';
  if ((hasStrongPositive || hasWeakPositive) && !hasNegative) return 'positive';
  return 'unknown';
}

function stripStance(value: string): string {
  return normalizeText(value).replace(STANCE_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
}

function nonOrdinalValues(text: string): string[] {
  return exactMemoryValues(text).filter(token => {
    if (/[.:/%-]/.test(token)) return true;
    const numeric = Number(token);
    if (Number.isFinite(numeric)) return Math.abs(numeric) >= 100;
    return token.length >= 4;
  });
}

function stripExactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    out = out.split(value).join(' ');
  }
  return normalizeText(out);
}

export function scopesOverlap(left?: readonly string[], right?: readonly string[]): boolean {
  if (!left?.length || !right?.length) return true;
  if (left.includes('project') || right.includes('project')) return true;
  const rightSet = new Set(right);
  return left.some(item => rightSet.has(item));
}

export function classifyKnowledgeRelation(
  candidateText: string,
  targetText: string,
  options: { candidateTitle?: string; targetTitle?: string } = {},
): { relation: ConflictRelation; reason: ConflictReason; score: number } | null {
  const normLeft = normalizeText(candidateText);
  const normRight = normalizeText(targetText);
  if (!normLeft || !normRight) return null;
  if (normLeft === normRight) {
    return { relation: 'same_content', reason: 'exact_duplicate', score: 1 };
  }

  const leftStance = detectStance(candidateText);
  const rightStance = detectStance(targetText);
  const oppositeStance = leftStance !== 'unknown' && rightStance !== 'unknown' && leftStance !== rightStance;

  const subjectLeft = stripStance(candidateText);
  const subjectRight = stripStance(targetText);
  const subjectSimilarity = textSimilarity(subjectLeft || candidateText, subjectRight || targetText);
  const titleSimilarity = options.candidateTitle && options.targetTitle
    ? textSimilarity(options.candidateTitle, options.targetTitle)
    : 0;
  const combinedSubject = Math.max(subjectSimilarity, 0.7 * subjectSimilarity + 0.3 * titleSimilarity);

  if (oppositeStance && combinedSubject >= 0.45) {
    return { relation: 'conflict', reason: 'opposite_stance', score: combinedSubject };
  }

  const leftValues = nonOrdinalValues(candidateText);
  const rightValues = nonOrdinalValues(targetText);
  if (leftValues.length > 0 && rightValues.length > 0) {
    const leftSet = new Set(leftValues);
    const rightSet = new Set(rightValues);
    const valuesDiffer = leftValues.some(item => !rightSet.has(item)) || rightValues.some(item => !leftSet.has(item));
    if (valuesDiffer) {
      const templateSimilarity = textSimilarity(
        stripExactValues(subjectLeft, leftValues),
        stripExactValues(subjectRight, rightValues),
      );
      if (templateSimilarity >= 0.75) {
        return { relation: 'conflict', reason: 'value_divergence', score: templateSimilarity };
      }
    }
  }

  const rawSimilarity = textSimilarity(candidateText, targetText);
  if (rawSimilarity >= 0.58) {
    return { relation: 'overlap', reason: 'high_overlap', score: rawSimilarity };
  }
  return null;
}

export function findHeuristicConflicts(
  candidate: { id?: string; title?: string; content: string; scope?: readonly string[] },
  targets: readonly ConflictTarget[],
  options: { maxResults?: number } = {},
): ConflictMatch[] {
  const matches: ConflictMatch[] = [];
  for (const target of targets) {
    if (candidate.id && target.id === candidate.id) continue;
    const classified = classifyKnowledgeRelation(candidate.content, target.content, {
      candidateTitle: candidate.title,
      targetTitle: target.title,
    });
    if (!classified) continue;
    if (classified.relation === 'conflict' && !scopesOverlap(candidate.scope, target.scope)) continue;
    matches.push({
      id: target.id,
      relation: classified.relation,
      reason: classified.reason,
      score: classified.score,
      ...(target.sources ? { sources: [...target.sources] } : {}),
    });
  }
  const rank: Record<ConflictRelation, number> = { same_content: 0, conflict: 1, overlap: 2 };
  matches.sort((left, right) =>
    rank[left.relation] - rank[right.relation] || right.score - left.score || left.id.localeCompare(right.id));
  return options.maxResults !== undefined ? matches.slice(0, options.maxResults) : matches;
}

export function findCorpusConflicts(
  records: readonly ConflictTarget[],
  options: { maxPairs?: number } = {},
): Array<{ leftId: string; rightId: string; relation: 'conflict' | 'same_content'; reason: ConflictReason; score: number }> {
  const findings: Array<{ leftId: string; rightId: string; relation: 'conflict' | 'same_content'; reason: ConflictReason; score: number }> = [];
  const cap = options.maxPairs ?? 200;
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const left = records[i];
      const right = records[j];
      const classified = classifyKnowledgeRelation(left.content, right.content, {
        candidateTitle: left.title,
        targetTitle: right.title,
      });
      if (!classified || classified.relation === 'overlap') continue;
      if (classified.relation === 'conflict' && !scopesOverlap(left.scope, right.scope)) continue;
      findings.push({
        leftId: left.id,
        rightId: right.id,
        relation: classified.relation,
        reason: classified.reason,
        score: classified.score,
      });
      if (findings.length >= cap) return findings;
    }
  }
  return findings;
}
