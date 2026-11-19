import type { MemoryRecord } from '../memory.js';

export interface OpenVikingProject {
  schema_version: 'evolve-openviking-project/1.0';
  project_id: string;
  account_id: string;
  user_id: string;
  root_uri: string;
  evolution_policy?: string;
  enabled?: boolean;
  failure_policy?: 'local' | 'fail';
}
export interface EvolutionTarget { entry: string; scenarios: string; runner: string }
export interface EvolutionPolicy { schema_version: 'evolve-openviking-policy/1.0'; targets: EvolutionTarget[] }
export interface WriteOperation {
  uri: string;
  content_base64: string;
  mode: 'replace';
  if_absent?: true;
  expected_sha256?: string;
}
export interface AssetFile { path: string; mode: '100644' | '100755'; size: number; sha256: string }
export interface WikiApproval { id: string; payload_json: string }
export interface SharedMemory { origin_id: string; path: string; metadata: Omit<MemoryRecord, 'id' | 'content'> }
export interface ProjectManifest {
  schema_version: 'evolve-project-release/1.0';
  project_id: string;
  account_id: string;
  user_id: string;
  parent: string | null;
  created_at: string;
  source_commit: string;
  cli_version: string;
  upstream: { cli_version: string; skills_sha256: string };
  files: AssetFile[];
  wiki: Array<{ entry: string; path: string; approval: WikiApproval }>;
  memory: SharedMemory[];
  verification: {
    kind: 'bootstrap' | 'evolved' | 'knowledge'; session_id: string | null;
    replay_ids: string[]; validation_id: string | null; approval?: string;
  };
}
export interface ProjectHead {
  schema_version: 'evolve-project-head/1.0'; project_id: string; release_id: string; manifest_sha256: string;
}
export interface OpenVikingReadEvidence {
  record_id: string; origin_id: string; release_id: string; uri: string;
  content_sha256: string; fetched_at: string; via: 'network' | 'cache';
}
export interface RemoteReadReceipt {
  schema_version: 'openviking-reads/1.0'; project_id: string; release_id: string; reads: OpenVikingReadEvidence[];
}
export interface AssetBinding {
  project_id: string; release_id: string; manifest_sha256: string; phase: 'preparing' | 'ready'; skill_commit?: string;
  publication?: { state: 'pending' | 'running' | 'no_change' | 'published' | 'failed' | 'conflict'; release_id?: string; error?: string };
}
