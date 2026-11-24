export { CodeGraph } from './code.js';
export {
  AGENT_MEMORY_ENVELOPE_VERSION,
  AGENT_MEMORY_CONTEXT_LEVEL,
  AGENT_MEMORY_TRUST_BOUNDARY,
  createAgentMemoryEnvelope,
  type AgentMemoryConstraint,
  type AgentMemoryContextScope,
  type AgentMemoryEnvelope,
  type AgentMemoryEnvelopeInput,
  type AgentMemoryReference,
  type AgentMemoryWorkingMemory,
  type MemoryAuthority,
} from './context-envelope.js';
export {
  AGENT_MEMORY_PROMPT_VERSION,
  buildCloseoutHarvestPrompt,
  buildSessionSignalPrompt,
  buildWikiMergePrompt,
  buildWikiRelationPrompt,
  createAgentMemoryPrompt,
  type AgentMemoryPrompt,
  type AgentMemoryPromptKind,
} from './agent-memory-prompts.js';
export { initWiki, Wiki, type WikiHit, type WikiReadOptions, type WikiSearchOptions } from './wiki.js';
export type { WikiContext, WikiEntryMetadata } from './wiki-entry.js';
export { reviewSession, reviewSkillExecution, type ReviewedRun, type SkillSignal } from './retrospective.js';
export {
  draftSkillAddition, draftSkillRetirement, listSkillLearnings, type SkillFileChange, type SkillLearning, type SkillPriority,
} from './skill-addition.js';
export { decideSkillRoute, type SkillRetentionRoute, type SkillRouteContext, type SkillRouteDecision } from './skill-route.js';
export {
  applySkillDesign,
  createSkillDesignTask,
  readSkillDesignTask,
  replaySkillDesign,
  reviewSkillDesign,
  runSkillDesign,
  type SkillDesignReceipt,
  type SkillDesignTask,
} from './skill-design.js';
export type { WikiIngestOptions } from './wiki-ingest.js';
export { MemoryStore, type MemoryInput, type MemoryRecord, type MemorySearchOptions, type MemoryStoreOptions, type ConversationMessage, type MemorySource } from './memory.js';
export type { MemoryReader, MemorySearchResult } from './memory-reader.js';
export { openKnowledgeSources, type KnowledgeSources, type KnowledgeBackend } from './knowledge-sources.js';
export {
  context,
  prioritizeMemoryHits,
  search,
  type ContextOptions,
  type SearchSources,
  type SearchScope,
  type SearchOptions,
  type SearchResults,
} from './search.js';
export { createSearchServer } from './http.js';
export {
  KNOWLEDGE_READS_VERSION,
  KnowledgeReads,
  contentSha256,
  validateKnowledgeReads,
  type KnowledgeConstraintInput,
  type KnowledgeConstraintRecord,
  type KnowledgeReadInput,
  type KnowledgeReadKind,
  type KnowledgeReadRecord,
  type KnowledgeReadsReceipt,
  type KnowledgeSearchInput,
  type KnowledgeSearchRecord,
  type KnowledgeSearchSource,
} from './knowledge-reads.js';
export {
  DEFAULT_DECAY_CONFIG,
  applyBoundedExploration,
  computeDecayFactor,
  computeUsageConcentration,
  computeUsageContentHash,
  isStaleDecayFactor,
  type KnowledgeDecayConfig,
  type KnowledgeDecayKind,
  type KnowledgeUsageRecord,
  type UsageConcentration,
} from './knowledge-decay.js';
export {
  classifyKnowledgeRelation,
  detectStance,
  findCorpusConflicts,
  findHeuristicConflicts,
  scopesOverlap,
  textSimilarity,
  type ConflictMatch,
  type ConflictReason,
  type ConflictRelation,
  type ConflictTarget,
  type KnowledgeStance,
} from './knowledge-conflict.js';
export {
  lintKnowledge,
  renderKbLintCompact,
  type KnowledgeLintFinding,
  type KnowledgeLintReport,
  type LintSeverity,
} from './knowledge-lint.js';
export { InputError, NotFoundError } from './common.js';
export type { LlmClient, ChatParams } from './upstream/llm.js';
