import type { KnowledgeReads } from './knowledge-reads.js';
import type { MemoryRecord, MemorySearchOptions } from './memory.js';
import type { OpenVikingReadEvidence } from './openviking/types.js';

export interface MemorySearchResult {
  strategy: 'exact' | 'fts' | 'embedding' | 'hybrid' | 'openviking';
  results: Array<MemoryRecord & { score: number }>;
  pagination?: { page: number; limit: number; previousPage: number | null; nextPage: number | null };
}
export interface MemoryReader {
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult>;
  get(id: string, options?: { knowledgeReads?: KnowledgeReads; fromSearchId?: string }):
    MemoryRecord | undefined | Promise<MemoryRecord | undefined>;
  close?(): void;
  drainRemoteReads?(): OpenVikingReadEvidence[];
}
