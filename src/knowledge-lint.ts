import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeLayer, KnowledgeScope } from './kb.js';
import { findCorpusConflicts } from './knowledge-conflict.js';
import {
  computeDecayFactor,
  computeUsageConcentration,
  isStaleDecayFactor,
  type KnowledgeDecayKind,
  type UsageConcentration,
} from './knowledge-decay.js';
import type { MemoryRecord } from './memory.js';
import { slugify } from './upstream/slug.js';
import { readWikiPages } from './wiki.js';

export type LintSeverity = 'P0' | 'P1' | 'P2';

export interface KnowledgeLintFinding {
  id: string;
  severity: LintSeverity;
  category:
    | 'potential_conflict'
    | 'exact_duplicate'
    | 'needs_review'
    | 'stale_knowledge'
    | 'broken_wikilink'
    | 'orphan_page'
    | 'stale_code_anchor'
    | 'exposure_concentration';
  storageKind: 'wiki' | 'memory' | 'usage';
  scope: 'project' | 'global';
  targets: string[];
  evidence: string;
  suggested_action: string;
}

export interface KnowledgeLintReport {
  schema_version: 'evolve-kb-lint/1.0';
  scope: KnowledgeScope;
  generated_at: string;
  summary: {
    wiki_total: number;
    wiki_active: number;
    wiki_deprecated: number;
    wiki_needs_review: number;
    wiki_contested: number;
    wiki_stale: number;
    episodic_total: number;
    episodic_stale: number;
    findings_total: number;
    p0: number;
    p1: number;
    p2: number;
  };
  freshness: {
    wiki_avg: number;
    episodic_avg: number;
  };
  usage: {
    search_hits_total: number;
    read_count_total: number;
    exposure_concentration: UsageConcentration;
  };
  findings: KnowledgeLintFinding[];
}

function stableFindingId(category: string, ...parts: string[]): string {
  return `lint-${createHash('sha256').update(JSON.stringify([category, ...parts])).digest('hex').slice(0, 12)}`;
}

const CODE_PATH_RE = /(?:^|[\s`"'(])((?:src|test|skills|docs|scripts|agents|rules)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;

function extractRepoPathAnchors(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(CODE_PATH_RE)) {
    const candidate = match[1].replace(/[.,;:!?)'"`]+$/, '');
    if (candidate && !candidate.includes('..') && !candidate.includes('*')) {
      paths.add(candidate);
    }
  }
  return [...paths];
}

function listAllMemories(layer: KnowledgeLayer): MemoryRecord[] {
  if (!layer.memory) return [];
  const all: MemoryRecord[] = [];
  for (let page = 1; ; page++) {
    const batch = layer.memory.list({ limit: 100, page });
    all.push(...batch.results);
    if (!batch.pagination || batch.pagination.nextPage === null) break;
  }
  return all;
}

export function lintKnowledge(options: {
  root: string;
  scope?: KnowledgeScope;
  layers: readonly KnowledgeLayer[];
  nowMs?: number;
}): KnowledgeLintReport {
  const scope = options.scope ?? 'local';
  const nowMs = options.nowMs ?? Date.now();
  const findings: KnowledgeLintFinding[] = [];

  let wikiTotal = 0;
  let wikiActive = 0;
  let wikiDeprecated = 0;
  let wikiNeedsReview = 0;
  let wikiContested = 0;
  let wikiStale = 0;
  let wikiFreshnessSum = 0;

  let episodicTotal = 0;
  let episodicStale = 0;
  let episodicFreshnessSum = 0;

  const hitCounts: number[] = [];
  let totalSearchHits = 0;
  let totalReadCount = 0;

  for (const layer of options.layers) {
    if (layer.wiki?.hasWiki()) {
      const pages = readWikiPages(layer.wiki.root);
      const usageMap = layer.wiki.getUsageMap();

      const pageIds = new Set(pages.map(page => page.id.toLowerCase()));
      const aliasToId = new Map<string, string>();
      for (const page of pages) {
        aliasToId.set(page.id.toLowerCase(), page.id);
        aliasToId.set(slugify(page.title), page.id);
        aliasToId.set(slugify(page.id.split('/').at(-1)!), page.id);
        for (const alias of page.entry?.aliases ?? []) {
          aliasToId.set(alias.toLowerCase(), page.id);
        }
      }
      const inDegree = new Map<string, number>();
      const outDegree = new Map<string, number>();

      for (const page of pages) {
        wikiTotal++;
        const status = page.entry?.status ?? 'active';
        const mode: KnowledgeDecayKind = page.entry?.mode ?? 'reference';
        const usage = usageMap.get(page.id);
        if (usage) {
          hitCounts.push(usage.searchHits);
          totalSearchHits += usage.searchHits;
          totalReadCount += usage.readCount;
        }

        if (status === 'deprecated') {
          wikiDeprecated++;
          continue;
        }
        if (status === 'needs_review') {
          wikiNeedsReview++;
          findings.push({
            id: stableFindingId('needs_review', layer.scope, page.id),
            severity: 'P1',
            category: 'needs_review',
            storageKind: 'wiki',
            scope: layer.scope,
            targets: [page.id],
            evidence: `${page.id} has status=needs_review`,
            suggested_action: `Review and resolve via evolve kb propose / evolve kb apply (or retire if obsolete).`,
          });
        } else {
          wikiActive++;
        }

        if (page.entry?.confidence === 'contested' || page.entry?.conflictsWith?.length) {
          wikiContested++;
          if (status !== 'needs_review') {
            findings.push({
              id: stableFindingId('contested', layer.scope, page.id),
              severity: 'P1',
              category: 'needs_review',
              storageKind: 'wiki',
              scope: layer.scope,
              targets: [page.id, ...(page.entry?.conflictsWith ?? [])],
              evidence: `${page.id} is marked contested${page.entry?.conflictsWith?.length ? ` against ${page.entry.conflictsWith.join(', ')}` : ''}`,
              suggested_action: `Resolve contradiction and stage update/retire via evolve kb propose.`,
            });
          }
        }

        const changedAt = usage?.contentChangedAt ?? page.updatedAt;
        const readCount = usage?.readCount ?? 0;
        const factor = computeDecayFactor({ kind: mode, contentChangedAt: changedAt, readCount, nowMs });
        wikiFreshnessSum += factor;
        if (isStaleDecayFactor(factor)) {
          wikiStale++;
          findings.push({
            id: stableFindingId('stale_knowledge', layer.scope, page.id),
            severity: 'P2',
            category: 'stale_knowledge',
            storageKind: 'wiki',
            scope: layer.scope,
            targets: [page.id],
            evidence: `${page.id} (${mode}) freshness=${factor.toFixed(2)} (< 0.50), read_count=${readCount}`,
            suggested_action: `Verify whether ${page.id} still holds; update or retire via evolve kb propose.`,
          });
        }

        for (const rawLink of page.links) {
          const normalized = rawLink.replaceAll('\\', '/').replace(/^wiki\//i, '').replace(/\.md$/i, '');
          const targetId = aliasToId.get(normalized.toLowerCase()) ?? aliasToId.get(slugify(normalized));
          if (!targetId && !pageIds.has(normalized.toLowerCase())) {
            findings.push({
              id: stableFindingId('broken_wikilink', layer.scope, page.id, rawLink),
              severity: 'P1',
              category: 'broken_wikilink',
              storageKind: 'wiki',
              scope: layer.scope,
              targets: [page.id],
              evidence: `${page.id} links to missing page [[${rawLink}]]`,
              suggested_action: `Fix or remove [[${rawLink}]] in ${page.id}.`,
            });
          } else if (targetId && targetId !== page.id) {
            outDegree.set(page.id, (outDegree.get(page.id) ?? 0) + 1);
            inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
          }
        }

        if (layer.scope === 'project') {
          for (const relPath of extractRepoPathAnchors(`${page.body}\n${page.sources.join('\n')}`)) {
            if (!existsSync(join(options.root, relPath))) {
              findings.push({
                id: stableFindingId('stale_code_anchor', layer.scope, page.id, relPath),
                severity: 'P1',
                category: 'stale_code_anchor',
                storageKind: 'wiki',
                scope: layer.scope,
                targets: [page.id],
                evidence: `${page.id} references missing repository path "${relPath}"`,
                suggested_action: `Verify refactored path and update or retire ${page.id} via evolve kb propose.`,
              });
            }
          }
        }
      }

      const activePages = pages.filter(page => (page.entry?.status ?? 'active') === 'active');
      if (activePages.length >= 2) {
        for (const page of activePages) {
          if (!page.entry) continue;
          if ((inDegree.get(page.id) ?? 0) === 0 && (outDegree.get(page.id) ?? 0) === 0) {
            findings.push({
              id: stableFindingId('orphan_page', layer.scope, page.id),
              severity: 'P2',
              category: 'orphan_page',
              storageKind: 'wiki',
              scope: layer.scope,
              targets: [page.id],
              evidence: `${page.id} has no incoming or outgoing [[wikilink]] connections`,
              suggested_action: `Add cross-reference [[wikilink]]s if ${page.id} relates to other entries.`,
            });
          }
        }
      }

      const activeManaged = activePages.filter(page => page.entry);
      const modeById = new Map(activeManaged.map(page => [page.id, page.entry!.mode]));
      const wikiConflicts = findCorpusConflicts(
        activeManaged.map(page => ({
          id: page.id,
          title: page.title,
          content: page.body,
          scope: page.entry?.scope,
        })),
      );
      for (const conflict of wikiConflicts) {
        const involvesConstraint =
          modeById.get(conflict.leftId) === 'constraint' || modeById.get(conflict.rightId) === 'constraint';
        findings.push({
          id: stableFindingId(conflict.relation, layer.scope, conflict.leftId, conflict.rightId),
          severity: conflict.relation === 'conflict' && involvesConstraint ? 'P0' : 'P1',
          category: conflict.relation === 'same_content' ? 'exact_duplicate' : 'potential_conflict',
          storageKind: 'wiki',
          scope: layer.scope,
          targets: [conflict.leftId, conflict.rightId],
          evidence: `${conflict.leftId} vs ${conflict.rightId}: ${conflict.reason} (score=${conflict.score.toFixed(2)})`,
          suggested_action: conflict.relation === 'same_content'
            ? `Retire duplicate entry via evolve kb propose (operation: retire).`
            : `Review contradiction and supersede or mark contested via evolve kb propose.`,
        });
      }
    }

    if (layer.memory) {
      const memories = listAllMemories(layer);
      const usageMap = layer.memory.getUsageMap();
      for (const mem of memories) {
        episodicTotal++;
        const usage = usageMap.get(mem.id);
        if (usage) {
          hitCounts.push(usage.searchHits);
          totalSearchHits += usage.searchHits;
          totalReadCount += usage.readCount;
        }
        const changedAt = usage?.contentChangedAt ?? mem.updatedAt;
        const readCount = usage?.readCount ?? 0;
        const factor = computeDecayFactor({ kind: 'episodic', contentChangedAt: changedAt, readCount, nowMs });
        episodicFreshnessSum += factor;
        if (isStaleDecayFactor(factor)) {
          episodicStale++;
          findings.push({
            id: stableFindingId('stale_episodic', layer.scope, mem.id),
            severity: 'P2',
            category: 'stale_knowledge',
            storageKind: 'memory',
            scope: layer.scope,
            targets: [mem.id],
            evidence: `Episodic ${mem.id.slice(0, 12)} freshness=${factor.toFixed(2)} (< 0.50), read_count=${readCount}`,
            suggested_action: `Inspect with evolve kb get ${mem.id.slice(0, 12)}; delete or update if obsolete.`,
          });
        }
      }
      const memConflicts = findCorpusConflicts(
        memories.slice(0, 300).map(mem => ({ id: mem.id, content: mem.content })),
      );
      for (const conflict of memConflicts) {
        findings.push({
          id: stableFindingId(`mem-${conflict.relation}`, layer.scope, conflict.leftId, conflict.rightId),
          severity: conflict.relation === 'conflict' ? 'P1' : 'P2',
          category: conflict.relation === 'same_content' ? 'exact_duplicate' : 'potential_conflict',
          storageKind: 'memory',
          scope: layer.scope,
          targets: [conflict.leftId, conflict.rightId],
          evidence: `Episodic ${conflict.leftId.slice(0, 12)} vs ${conflict.rightId.slice(0, 12)}: ${conflict.reason} (score=${conflict.score.toFixed(2)})`,
          suggested_action: `Inspect both records via evolve kb get and update or delete the outdated episodic memory.`,
        });
      }
    }
  }

  const concentration = computeUsageConcentration(hitCounts);
  if (
    concentration.totalEvents >= 10 &&
    ((concentration.positiveCount > 10 && concentration.top10Share > 0.75) || concentration.gini > 0.65)
  ) {
    findings.push({
      id: stableFindingId('exposure_concentration', scope, String(concentration.totalEvents)),
      severity: 'P2',
      category: 'exposure_concentration',
      storageKind: 'usage',
      scope: scope === 'global' ? 'global' : 'project',
      targets: ['knowledge-search'],
      evidence: `Top-10 share ${(concentration.top10Share * 100).toFixed(1)}%, Gini=${concentration.gini.toFixed(3)}`,
      suggested_action: `Consider reviewing over-exposed entries or relying on exploration slots in search.`,
    });
  }

  const severityOrder: Record<LintSeverity, number> = { P0: 0, P1: 1, P2: 2 };
  findings.sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] || left.id.localeCompare(right.id));

  const wikiLive = wikiActive + wikiNeedsReview;
  return {
    schema_version: 'evolve-kb-lint/1.0',
    scope,
    generated_at: new Date(nowMs).toISOString(),
    summary: {
      wiki_total: wikiTotal,
      wiki_active: wikiActive,
      wiki_deprecated: wikiDeprecated,
      wiki_needs_review: wikiNeedsReview,
      wiki_contested: wikiContested,
      wiki_stale: wikiStale,
      episodic_total: episodicTotal,
      episodic_stale: episodicStale,
      findings_total: findings.length,
      p0: findings.filter(item => item.severity === 'P0').length,
      p1: findings.filter(item => item.severity === 'P1').length,
      p2: findings.filter(item => item.severity === 'P2').length,
    },
    freshness: {
      wiki_avg: wikiLive > 0 ? Number((wikiFreshnessSum / wikiLive).toFixed(4)) : 1,
      episodic_avg: episodicTotal > 0 ? Number((episodicFreshnessSum / episodicTotal).toFixed(4)) : 1,
    },
    usage: {
      search_hits_total: totalSearchHits,
      read_count_total: totalReadCount,
      exposure_concentration: concentration,
    },
    findings,
  };
}

export function renderKbLintCompact(report: KnowledgeLintReport): string {
  const { summary, freshness, usage, findings } = report;
  const lines = [
    `kb lint | scope: ${report.scope} | wiki: ${summary.wiki_active} active, ${summary.wiki_stale} stale, ${summary.wiki_needs_review} review | episodic: ${summary.episodic_total} total, ${summary.episodic_stale} stale`,
    `freshness: wiki=${freshness.wiki_avg.toFixed(2)}, episodic=${freshness.episodic_avg.toFixed(2)} | hits=${usage.search_hits_total}, reads=${usage.read_count_total} | findings: ${summary.findings_total} (P0=${summary.p0}, P1=${summary.p1}, P2=${summary.p2})`,
  ];
  if (!findings.length) {
    lines.push('(no findings)');
  } else {
    for (const item of findings) {
      lines.push(`[${item.severity}] ${item.category} (${item.storageKind}/${item.scope}): ${item.evidence}`);
      lines.push(`    action: ${item.suggested_action}`);
    }
  }
  return lines.join('\n') + '\n';
}
