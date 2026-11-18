import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { InputError, NotFoundError } from '../common.js';
import { ProviderRegistry } from './provider-registry.js';
import { AgentSessionStore } from './session-store.js';
import {
  agentIdentifier,
  nowIso,
  type AgentMode,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSessionRecord,
  type AgentSessionStatus,
  type AgentStreamEvent,
  type AgentTurnOptions,
  type AgentTurnResult,
  type ParallelAgentResult,
  type ParallelAgentTask,
  type ProviderSummary,
  type WorktreeInfo,
  type WorktreeSpec,
} from './types.js';
import { WorktreeManager } from './worktree.js';

export interface AgentManagerOptions {
  root?: string;
  registry?: ProviderRegistry;
  worktrees?: WorktreeManager;
  store?: AgentSessionStore | false;
}

export interface CreateAgentSessionOptions extends AgentSessionConfig {
  sessionId?: string;
}

export interface DelegateOptions {
  provider: string;
  prompt: string;
  cwd: string;
  mode?: AgentMode;
  model?: string;
  worktree?: WorktreeSpec | boolean;
  keepWorktree?: boolean;
  env?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  timeoutMs?: number;
  agentSessionId?: string;
  inheritStderr?: boolean;
  onEvent?: (event: AgentStreamEvent) => void;
}

export interface DelegateResult {
  executor: string;
  output: string;
  sessionId?: string;
  externalSessionId?: string;
  worktree?: WorktreeInfo;
  events: AgentStreamEvent[];
}

interface ManagedAgent {
  session: AgentSession;
  record: AgentSessionRecord;
  persistent: boolean;
  unsubscribe: () => void;
}

function previewText(text: string, maxLength = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 3) + '...';
}

export class AgentManager {
  readonly registry: ProviderRegistry;
  readonly worktrees: WorktreeManager;
  private readonly store?: AgentSessionStore;
  private readonly active = new Map<string, ManagedAgent>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();

  constructor(options: AgentManagerOptions = {}) {
    this.registry = options.registry ?? new ProviderRegistry();
    this.worktrees = options.worktrees ?? new WorktreeManager();
    if (options.store === false) {
      this.store = undefined;
    } else if (options.store) {
      this.store = options.store;
    } else if (options.root) {
      this.store = new AgentSessionStore(options.root);
    }
  }

  onEvent(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private enqueueOnLane<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tracked = next.finally(() => {
      if (this.lanes.get(sessionId) === tracked) {
        this.lanes.delete(sessionId);
      }
    });
    this.lanes.set(sessionId, tracked);
    return next;
  }

  listProviders(): ProviderSummary[] {
    return this.registry.list();
  }

  async createSession(options: CreateAgentSessionOptions): Promise<AgentSessionRecord> {
    const sessionId = options.sessionId
      ? agentIdentifier(options.sessionId)
      : `agent-${randomUUID().slice(0, 8)}`;

    if (this.active.has(sessionId) || this.store?.get(sessionId)) {
      throw new InputError(`Agent session already exists: ${sessionId}`);
    }

    const client = this.registry.get(options.provider);
    const cwd = resolve(options.cwd);
    const persistent = options.persistent !== false && Boolean(this.store);

    let worktree: WorktreeInfo | undefined;
    if (options.worktree) {
      const spec: WorktreeSpec = options.worktree === true ? { name: sessionId } : { name: sessionId, ...options.worktree };
      worktree = this.worktrees.create(cwd, spec);
    }

    const effectiveCwd = worktree ? worktree.path : cwd;
    let session: AgentSession;
    try {
      session = await client.createSession({
        ...options,
        sessionId,
        cwd,
        effectiveCwd,
        worktree,
        persistent,
      });
    } catch (error) {
      if (worktree?.created) {
        try {
          this.worktrees.remove(worktree.path, { force: true, deleteBranch: true, repoRoot: worktree.repoRoot });
        } catch {
          // 清理初始化失败的 worktree
        }
      }
      throw error;
    }

    const createdAt = nowIso();
    const record: AgentSessionRecord = {
      id: sessionId,
      provider: client.id,
      status: 'idle',
      cwd,
      effectiveCwd,
      mode: options.mode,
      ...(options.model ? { model: options.model } : {}),
      ...(options.resumeExternalSessionId ? { externalSessionId: options.resumeExternalSessionId } : {}),
      ...(worktree ? { worktree } : {}),
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      turns: [],
      createdAt,
      updatedAt: createdAt,
    };

    const unsubscribe = session.onEvent(event => this.emit(event));
    this.active.set(sessionId, { session, record, persistent, unsubscribe });
    if (persistent && this.store) {
      this.store.save(record);
    }

    this.emit({
      type: 'session_started',
      sessionId,
      provider: client.id,
      cwd: effectiveCwd,
      ...(worktree ? { worktree } : {}),
      timestamp: createdAt,
    });

    return structuredClone(record);
  }

  async resumeSession(sessionId: string, overrides: Partial<AgentSessionConfig> = {}): Promise<AgentSessionRecord> {
    const id = agentIdentifier(sessionId);
    const existing = this.active.get(id);
    if (existing) {
      if (existing.record.status === 'closed') {
        throw new InputError(`Agent session is closed: ${id}`);
      }
      return structuredClone(existing.record);
    }

    const stored = this.store?.get(id);
    if (!stored) {
      throw new NotFoundError(`Agent session not found: ${id}`);
    }
    if (stored.status === 'closed') {
      throw new InputError(`Agent session is closed: ${id}`);
    }
    if (!existsSync(stored.effectiveCwd)) {
      throw new InputError(`Agent session workspace is missing: ${stored.effectiveCwd}`);
    }

    const client = this.registry.get(stored.provider);
    const session = await client.resumeSession(stored, overrides);
    const unsubscribe = session.onEvent(event => this.emit(event));
    const record: AgentSessionRecord = {
      ...stored,
      ...(overrides.mode ? { mode: overrides.mode } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
      updatedAt: nowIso(),
    };
    this.active.set(id, { session, record, persistent: Boolean(this.store), unsubscribe });
    this.store?.save(record);
    return structuredClone(record);
  }

  async runTurn(sessionId: string, options: AgentTurnOptions): Promise<AgentTurnResult> {
    const id = agentIdentifier(sessionId);
    return this.enqueueOnLane(id, async () => {
      if (!this.active.has(id)) {
        await this.resumeSession(id);
      }
      const managed = this.active.get(id);
      if (!managed) {
        throw new NotFoundError(`Agent session not found: ${id}`);
      }
      if (managed.record.status === 'closed') {
        throw new InputError(`Agent session is closed: ${id}`);
      }

      const startedAt = nowIso();
      managed.record.status = 'running';
      managed.record.updatedAt = startedAt;
      if (managed.persistent) this.store?.save(managed.record);

      try {
        const result = await managed.session.startTurn(options);
        const finishedAt = nowIso();
        if (result.externalSessionId) {
          managed.record.externalSessionId = result.externalSessionId;
        }
        managed.record.status = result.status;
        managed.record.updatedAt = finishedAt;
        managed.record.turns.push({
          turnId: result.turnId,
          promptPreview: previewText(options.prompt),
          status: result.status,
          startedAt,
          finishedAt,
          exitCode: result.exitCode,
          outputPreview: previewText(result.output),
        });
        if (managed.persistent) this.store?.save(managed.record);
        return result;
      } catch (error) {
        managed.record.status = 'failed';
        managed.record.updatedAt = nowIso();
        if (managed.persistent) this.store?.save(managed.record);
        throw error;
      }
    });
  }

  async interrupt(sessionId: string, reason?: string): Promise<void> {
    const id = agentIdentifier(sessionId);
    const managed = this.active.get(id);
    if (!managed) return;
    await managed.session.interrupt(reason);
  }

  async closeSession(
    sessionId: string,
    options: { removeWorktree?: boolean; forceWorktree?: boolean; deleteBranch?: boolean } = {},
  ): Promise<{ closed: boolean; worktreeRemoved?: boolean; branchDeleted?: string }> {
    const id = agentIdentifier(sessionId);
    return this.enqueueOnLane(id, async () => {
      const managed = this.active.get(id);
      const stored = managed?.record ?? this.store?.get(id);
      if (!managed && !stored) {
        throw new NotFoundError(`Agent session not found: ${id}`);
      }

      if (managed) {
        await managed.session.close();
        managed.unsubscribe();
        this.active.delete(id);
      }

      if (stored) {
        stored.status = 'closed';
        stored.updatedAt = nowIso();
        if (managed ? managed.persistent : Boolean(this.store)) {
          this.store?.save(stored);
        }
      }

      let worktreeRemoved = false;
      let branchDeleted: string | undefined;
      if (options.removeWorktree && stored?.worktree?.created && existsSync(stored.worktree.path)) {
        const removed = this.worktrees.remove(stored.worktree.path, {
          force: options.forceWorktree,
          deleteBranch: options.deleteBranch ?? true,
          repoRoot: stored.worktree.repoRoot,
        });
        worktreeRemoved = removed.removed;
        branchDeleted = removed.branchDeleted;
      }

      return { closed: true, ...(options.removeWorktree ? { worktreeRemoved, branchDeleted } : {}) };
    });
  }

  getSession(sessionId: string): AgentSessionRecord | undefined {
    const id = agentIdentifier(sessionId);
    const active = this.active.get(id);
    if (active) return structuredClone(active.record);
    return this.store?.get(id);
  }

  listSessions(filter: { provider?: string; status?: AgentSessionStatus } = {}): AgentSessionRecord[] {
    const merged = new Map<string, AgentSessionRecord>();
    for (const record of this.store?.list(filter) ?? []) {
      merged.set(record.id, record);
    }
    for (const { record } of this.active.values()) {
      if (filter.provider && record.provider !== filter.provider) continue;
      if (filter.status && record.status !== filter.status) continue;
      merged.set(record.id, structuredClone(record));
    }
    return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async delegate(options: DelegateOptions): Promise<DelegateResult> {
    const mode = options.mode ?? 'analysis';
    if (options.agentSessionId) {
      const id = agentIdentifier(options.agentSessionId);
      const existing = this.getSession(id);
      if (existing) {
        await this.resumeSession(id, {
          mode,
          model: options.model,
          env: options.env,
          providerOptions: options.providerOptions,
          timeoutMs: options.timeoutMs,
          inheritStderr: options.inheritStderr,
        });
      } else {
        await this.createSession({
          sessionId: id,
          provider: options.provider,
          cwd: options.cwd,
          mode,
          model: options.model,
          worktree: options.worktree,
          env: options.env,
          providerOptions: options.providerOptions,
          timeoutMs: options.timeoutMs,
          persistent: true,
          inheritStderr: options.inheritStderr,
        });
      }
      const turn = await this.runTurn(id, {
        prompt: options.prompt,
        mode,
        model: options.model,
        timeoutMs: options.timeoutMs,
        onEvent: options.onEvent,
      });
      if (turn.status !== 'completed') {
        throw new InputError(`${options.provider} exited with status ${turn.exitCode ?? 'unknown'}`);
      }
      return {
        executor: options.provider,
        output: turn.output,
        sessionId: id,
        ...(turn.externalSessionId ? { externalSessionId: turn.externalSessionId } : {}),
        ...(turn.worktree ? { worktree: turn.worktree } : {}),
        events: turn.events,
      };
    }

    const created = await this.createSession({
      provider: options.provider,
      cwd: options.cwd,
      mode,
      model: options.model,
      worktree: options.worktree,
      env: options.env,
      providerOptions: options.providerOptions,
      timeoutMs: options.timeoutMs,
      persistent: false,
      inheritStderr: options.inheritStderr,
    });

    try {
      const turn = await this.runTurn(created.id, {
        prompt: options.prompt,
        mode,
        model: options.model,
        timeoutMs: options.timeoutMs,
        onEvent: options.onEvent,
      });
      if (turn.status !== 'completed') {
        throw new InputError(`${options.provider} exited with status ${turn.exitCode ?? 'unknown'}`);
      }
      return {
        executor: options.provider,
        output: turn.output,
        ...(turn.worktree ? { worktree: turn.worktree } : {}),
        events: turn.events,
      };
    } finally {
      await this.closeSession(created.id, {
        removeWorktree: Boolean(created.worktree?.created) && !options.keepWorktree,
        forceWorktree: true,
        deleteBranch: true,
      });
    }
  }

  async runParallel(
    tasks: ParallelAgentTask[],
    options: { concurrency?: number; isolateWorktrees?: boolean; signal?: AbortSignal } = {},
  ): Promise<ParallelAgentResult[]> {
    if (!tasks.length) return [];
    const concurrency = Math.max(1, Math.min(options.concurrency ?? tasks.length, tasks.length));
    const results: ParallelAgentResult[] = new Array(tasks.length);
    const runningSessionIds = new Set<string>();
    let cursor = 0;

    const onAbort = () => {
      for (const sessionId of runningSessionIds) {
        void this.interrupt(sessionId, 'parallel_aborted');
      }
    };
    if (options.signal) {
      if (options.signal.aborted) {
        throw new InputError('Parallel execution aborted before start');
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const worker = async () => {
      while (true) {
        if (options.signal?.aborted) break;
        const index = cursor++;
        if (index >= tasks.length) break;
        const task = tasks[index];
        const taskId = task.id ? agentIdentifier(task.id, 'task ID') : `task-${index + 1}-${randomUUID().slice(0, 6)}`;
        let createdSessionId: string | undefined;
        let createdWorktree = false;

        try {
          const created = await this.createSession({
            provider: task.provider,
            cwd: task.cwd,
            mode: task.mode ?? 'analysis',
            model: task.model,
            worktree: task.worktree ?? (options.isolateWorktrees ? { name: taskId } : undefined),
            env: task.env,
            providerOptions: task.providerOptions,
            timeoutMs: task.timeoutMs,
            persistent: false,
          });
          createdSessionId = created.id;
          createdWorktree = Boolean(created.worktree?.created);
          runningSessionIds.add(created.id);

          const turn = await this.runTurn(created.id, {
            prompt: task.prompt,
            mode: task.mode,
            model: task.model,
            timeoutMs: task.timeoutMs,
          });
          results[index] = {
            taskId,
            provider: task.provider,
            ok: turn.status === 'completed',
            result: turn,
            ...(turn.status !== 'completed' ? { error: `${task.provider} finished with status ${turn.status}` } : {}),
          };
        } catch (error) {
          results[index] = {
            taskId,
            provider: task.provider,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          if (createdSessionId) {
            runningSessionIds.delete(createdSessionId);
            await this.closeSession(createdSessionId, {
              removeWorktree: createdWorktree && !task.keepWorktree,
              forceWorktree: true,
              deleteBranch: true,
            }).catch(() => undefined);
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      for (let i = 0; i < tasks.length; i++) {
        if (!results[i]) {
          results[i] = {
            taskId: tasks[i].id ?? `task-${i + 1}`,
            provider: tasks[i].provider,
            ok: false,
            error: 'Parallel execution aborted',
          };
        }
      }
      return results;
    } finally {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    const entries = [...this.active.entries()];
    await Promise.all(entries.map(([id, managed]) =>
      this.enqueueOnLane(id, async () => {
        await managed.session.close();
        managed.unsubscribe();
        this.active.delete(id);
        if (managed.persistent && managed.record.status === 'running') {
          managed.record.status = 'interrupted';
          managed.record.updatedAt = nowIso();
          this.store?.save(managed.record);
        }
      }).catch(() => undefined),
    ));
    this.store?.close();
  }
}
