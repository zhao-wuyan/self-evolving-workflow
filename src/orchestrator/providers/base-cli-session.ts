import { randomUUID } from 'node:crypto';
import { InputError, requireText } from '../../common.js';
import { resolveCliCommand, spawnStreamingCommand } from '../command-resolver.js';
import {
  nowIso,
  type AgentMode,
  type AgentSession,
  type AgentSessionConfig,
  type AgentStreamEvent,
  type AgentTurnOptions,
  type AgentTurnResult,
  type WorktreeInfo,
} from '../types.js';

export interface TurnExecutionContext {
  sessionId: string;
  turnId: string;
  emit: (event: AgentStreamEvent) => void;
  setExternalSessionId: (id: string) => void;
  setLastAssistantText: (text: string) => void;
  getLastAssistantText: () => string | undefined;
}

export interface PreparedTurnExecution {
  executable: string;
  envVar?: string;
  args: string[];
  stdin?: string;
  onStdoutLine?: (line: string, ctx: TurnExecutionContext) => void;
  resolveOutput?: (stdout: string, ctx: TurnExecutionContext) => string;
  cleanup?: () => void;
}

export abstract class BaseCliSession implements AgentSession {
  readonly id: string;
  readonly provider: string;
  protected _externalSessionId?: string;
  protected readonly config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo };
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private activeAbort?: AbortController;
  private closed = false;

  constructor(
    config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo },
    provider: string,
  ) {
    this.id = config.sessionId;
    this.provider = provider;
    this.config = config;
    this._externalSessionId = config.resumeExternalSessionId;
  }

  get externalSessionId(): string | undefined {
    return this._externalSessionId;
  }

  onEvent(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected emit(event: AgentStreamEvent, perTurn?: (event: AgentStreamEvent) => void, collector?: AgentStreamEvent[]): void {
    if (collector) collector.push(event);
    if (perTurn) perTurn(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  protected effectiveMode(options: AgentTurnOptions): AgentMode {
    return options.mode ?? this.config.mode;
  }

  protected effectiveModel(options: AgentTurnOptions): string | undefined {
    return options.model ?? this.config.model;
  }

  protected abstract prepareTurn(options: AgentTurnOptions): PreparedTurnExecution;

  async startTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
    if (this.closed) throw new InputError(`Agent session is closed: ${this.id}`);
    if (this.activeAbort) throw new InputError(`Agent session already has an active turn: ${this.id}`);
    const prompt = requireText(options.prompt, 'prompt');
    const turnId = randomUUID();
    const events: AgentStreamEvent[] = [];
    const controller = new AbortController();
    this.activeAbort = controller;

    let lastAssistantText: string | undefined;
    const ctx: TurnExecutionContext = {
      sessionId: this.id,
      turnId,
      emit: event => this.emit(event, options.onEvent, events),
      setExternalSessionId: id => {
        if (id) this._externalSessionId = id;
      },
      setLastAssistantText: text => {
        lastAssistantText = text;
      },
      getLastAssistantText: () => lastAssistantText,
    };

    this.emit({
      type: 'turn_started',
      sessionId: this.id,
      turnId,
      prompt,
      timestamp: nowIso(),
    }, options.onEvent, events);

    const prepared = this.prepareTurn({ ...options, prompt });
    try {
      const resolved = resolveCliCommand(prepared.executable, prepared.args, {
        envVar: prepared.envVar,
        env: this.config.env ? { ...process.env, ...this.config.env } : process.env,
      });

      const execResult = await spawnStreamingCommand(resolved, {
        cwd: this.config.effectiveCwd,
        stdin: prepared.stdin,
        env: this.config.env,
        signal: controller.signal,
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
        inheritStderr: this.config.inheritStderr,
        onStdoutLine: prepared.onStdoutLine
          ? line => prepared.onStdoutLine!(line, ctx)
          : line => {
            if (line) {
              this.emit({
                type: 'text_delta',
                sessionId: this.id,
                turnId,
                text: line + '\n',
                timestamp: nowIso(),
              }, options.onEvent, events);
            }
          },
      });

      const output = prepared.resolveOutput
        ? prepared.resolveOutput(execResult.stdout, ctx)
        : (lastAssistantText ?? execResult.stdout);

      const status: AgentTurnResult['status'] = execResult.interrupted
        ? 'interrupted'
        : execResult.timedOut || execResult.exitCode !== 0
          ? 'failed'
          : 'completed';

      const error = execResult.interrupted
        ? 'Turn interrupted'
        : execResult.timedOut
          ? 'Turn timed out'
          : execResult.exitCode !== 0
            ? `${this.provider} exited with status ${execResult.exitCode}`
            : undefined;

      if (output && !events.some(event => event.type === 'message')) {
        this.emit({
          type: 'message',
          sessionId: this.id,
          turnId,
          role: 'assistant',
          text: output,
          timestamp: nowIso(),
        }, options.onEvent, events);
      }

      this.emit({
        type: 'turn_completed',
        sessionId: this.id,
        turnId,
        output,
        status,
        ...(error ? { error } : {}),
        exitCode: execResult.exitCode,
        timestamp: nowIso(),
      }, options.onEvent, events);

      return {
        sessionId: this.id,
        turnId,
        provider: this.provider,
        output,
        events,
        exitCode: execResult.exitCode,
        status,
        externalSessionId: this._externalSessionId,
        worktree: this.config.worktree,
        ...(execResult.stderr ? { stderr: execResult.stderr } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'turn_completed',
        sessionId: this.id,
        turnId,
        output: '',
        status: controller.signal.aborted ? 'interrupted' : 'failed',
        error: message,
        exitCode: null,
        timestamp: nowIso(),
      }, options.onEvent, events);
      throw error;
    } finally {
      this.activeAbort = undefined;
      if (prepared.cleanup) prepared.cleanup();
    }
  }

  async interrupt(_reason?: string): Promise<void> {
    if (this.activeAbort && !this.activeAbort.signal.aborted) {
      this.activeAbort.abort();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.interrupt('session_closed');
    this.closed = true;
    this.emit({
      type: 'session_closed',
      sessionId: this.id,
      timestamp: nowIso(),
    });
  }
}
