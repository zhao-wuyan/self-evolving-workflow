import { InputError, requireText } from '../common.js';

export type AgentMode = 'analysis' | 'write';

export type AgentSessionStatus = 'idle' | 'running' | 'completed' | 'interrupted' | 'failed' | 'closed';

export interface ProviderCapabilities {
  supportsResume: boolean;
  supportsStreaming: boolean;
  supportsWriteMode: boolean;
  supportsInterrupt: boolean;
}

export interface WorktreeSpec {
  name?: string;
  branch?: string;
  baseRef?: string;
  rootDir?: string;
  setupCommand?: string;
  reuseBranch?: boolean;
}

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  repoRoot: string;
  created: boolean;
}

export type AgentStreamEvent =
  | {
    type: 'session_started';
    sessionId: string;
    provider: string;
    cwd: string;
    worktree?: WorktreeInfo;
    timestamp: string;
  }
  | {
    type: 'turn_started';
    sessionId: string;
    turnId: string;
    prompt: string;
    timestamp: string;
  }
  | {
    type: 'text_delta' | 'reasoning_delta';
    sessionId: string;
    turnId: string;
    text: string;
    timestamp: string;
  }
  | {
    type: 'tool_call';
    sessionId: string;
    turnId: string;
    callId: string;
    name: string;
    input?: unknown;
    status: 'started' | 'completed' | 'failed';
    output?: unknown;
    timestamp: string;
  }
  | {
    type: 'message';
    sessionId: string;
    turnId: string;
    role: 'assistant' | 'system';
    text: string;
    timestamp: string;
  }
  | {
    type: 'turn_completed';
    sessionId: string;
    turnId: string;
    output: string;
    status: 'completed' | 'interrupted' | 'failed';
    error?: string;
    exitCode?: number | null;
    timestamp: string;
  }
  | {
    type: 'session_closed';
    sessionId: string;
    timestamp: string;
  };

export interface AgentSessionConfig {
  provider: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  worktree?: WorktreeSpec | boolean;
  env?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  resumeExternalSessionId?: string;
  timeoutMs?: number;
  persistent?: boolean;
  inheritStderr?: boolean;
}

export interface AgentTurnOptions {
  prompt: string;
  mode?: AgentMode;
  model?: string;
  timeoutMs?: number;
  onEvent?: (event: AgentStreamEvent) => void;
}

export interface AgentTurnResult {
  sessionId: string;
  turnId: string;
  provider: string;
  output: string;
  events: AgentStreamEvent[];
  exitCode: number | null;
  status: 'completed' | 'interrupted' | 'failed';
  externalSessionId?: string;
  worktree?: WorktreeInfo;
  stderr?: string;
}

export interface AgentTurnSummary {
  turnId: string;
  promptPreview: string;
  status: 'completed' | 'interrupted' | 'failed';
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  outputPreview: string;
}

export interface AgentSessionRecord {
  id: string;
  provider: string;
  status: AgentSessionStatus;
  cwd: string;
  effectiveCwd: string;
  mode: AgentMode;
  model?: string;
  externalSessionId?: string;
  worktree?: WorktreeInfo;
  providerOptions?: Record<string, unknown>;
  turns: AgentTurnSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  readonly id: string;
  readonly provider: string;
  readonly externalSessionId?: string;
  startTurn(options: AgentTurnOptions): Promise<AgentTurnResult>;
  interrupt(reason?: string): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: AgentStreamEvent) => void): () => void;
}

export interface AgentClient {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  isAvailable(): boolean;
  createSession(config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo }): Promise<AgentSession>;
  resumeSession(record: AgentSessionRecord, overrides?: Partial<AgentSessionConfig>): Promise<AgentSession>;
}

export interface ProviderSummary {
  id: string;
  displayName: string;
  available: boolean;
  capabilities: ProviderCapabilities;
  derivedFrom?: string;
}

export interface ParallelAgentTask {
  id?: string;
  provider: string;
  prompt: string;
  cwd: string;
  mode?: AgentMode;
  model?: string;
  worktree?: WorktreeSpec | boolean;
  env?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  timeoutMs?: number;
  keepWorktree?: boolean;
}

export interface ParallelAgentResult {
  taskId: string;
  provider: string;
  ok: boolean;
  result?: AgentTurnResult;
  error?: string;
}

export function agentIdentifier(value: unknown, label = 'agent session ID'): string {
  const id = requireText(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|constructor|prototype)$/i.test(id)) {
    throw new InputError(`Invalid ${label}: ${id}`);
  }
  return id;
}

export function nowIso(): string {
  return new Date().toISOString();
}
