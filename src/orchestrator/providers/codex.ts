import { isCliAvailable } from '../command-resolver.js';
import {
  nowIso,
  type AgentClient,
  type AgentSessionConfig,
  type AgentSessionRecord,
  type AgentTurnOptions,
  type ProviderCapabilities,
  type WorktreeInfo,
} from '../types.js';
import { BaseCliSession, type PreparedTurnExecution, type TurnExecutionContext } from './base-cli-session.js';

function parseCodexJsonLine(line: string, ctx: TurnExecutionContext): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    ctx.emit({ type: 'text_delta', sessionId: ctx.sessionId, turnId: ctx.turnId, text: line + '\n', timestamp: nowIso() });
    return;
  }

  const type = typeof parsed.type === 'string' ? parsed.type : '';
  if (type === 'thread.started' && typeof parsed.thread_id === 'string') {
    ctx.setExternalSessionId(parsed.thread_id);
    return;
  }

  const item = parsed.item && typeof parsed.item === 'object' ? parsed.item as Record<string, unknown> : undefined;
  const itemType = item && typeof item.type === 'string' ? item.type : '';

  if (type === 'item.completed' && itemType === 'agent_message' && typeof item?.text === 'string') {
    ctx.setLastAssistantText(item.text);
    ctx.emit({
      type: 'message',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      role: 'assistant',
      text: item.text,
      timestamp: nowIso(),
    });
    return;
  }

  if (type === 'item.completed' && itemType === 'reasoning' && typeof item?.text === 'string') {
    ctx.emit({
      type: 'reasoning_delta',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      text: item.text,
      timestamp: nowIso(),
    });
    return;
  }

  if ((type === 'item.started' || type === 'item.completed') && item && itemType) {
    const status = type === 'item.started'
      ? 'started'
      : item.status === 'failed'
        ? 'failed'
        : 'completed';
    ctx.emit({
      type: 'tool_call',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      callId: typeof item.id === 'string' ? item.id : ctx.turnId,
      name: itemType,
      input: item.command ?? item.arguments ?? item,
      status,
      ...(type === 'item.completed' ? { output: item.aggregated_output ?? item.result ?? item.changes } : {}),
      timestamp: nowIso(),
    });
  }
}

export class CodexAgentSession extends BaseCliSession {
  constructor(config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo }) {
    super(config, 'codex');
  }

  protected prepareTurn(options: AgentTurnOptions): PreparedTurnExecution {
    const mode = this.effectiveMode(options);
    const model = this.effectiveModel(options);
    const modelArgs = model ? ['--model', model] : [];
    const providerOptions = this.config.providerOptions ?? {};
    const jsonEvents = providerOptions.jsonEvents === true || (this.config.persistent === true && providerOptions.jsonEvents !== false);
    const ephemeral = providerOptions.ephemeral !== undefined
      ? Boolean(providerOptions.ephemeral)
      : !this.config.persistent;

    const args = this._externalSessionId
      ? [
        '-a', 'never', 'exec', 'resume',
        '--ignore-user-config',
        ...(jsonEvents ? ['--json'] : []),
        '--skip-git-repo-check',
        ...modelArgs,
        this._externalSessionId,
        '-',
      ]
      : [
        '-a', 'never', 'exec',
        ...(ephemeral ? ['--ephemeral'] : []),
        '--ignore-user-config',
        '--skip-git-repo-check',
        ...(jsonEvents ? ['--json'] : []),
        '--sandbox', mode === 'analysis' ? 'read-only' : 'workspace-write',
        ...modelArgs,
        '-',
      ];

    return {
      executable: 'codex',
      envVar: 'CODEX_REPLAY_EXECUTABLE',
      args,
      stdin: options.prompt,
      ...(jsonEvents
        ? {
          onStdoutLine: parseCodexJsonLine,
          resolveOutput: (stdout, ctx) => ctx.getLastAssistantText() ?? stdout,
        }
        : {}),
    };
  }
}

export class CodexAgentClient implements AgentClient {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';
  readonly capabilities: ProviderCapabilities = {
    supportsResume: true,
    supportsStreaming: true,
    supportsWriteMode: true,
    supportsInterrupt: true,
  };

  isAvailable(): boolean {
    return isCliAvailable('codex', 'CODEX_REPLAY_EXECUTABLE');
  }

  async createSession(
    config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo },
  ): Promise<CodexAgentSession> {
    return new CodexAgentSession(config);
  }

  async resumeSession(record: AgentSessionRecord, overrides: Partial<AgentSessionConfig> = {}): Promise<CodexAgentSession> {
    return new CodexAgentSession({
      provider: this.id,
      cwd: record.cwd,
      effectiveCwd: record.effectiveCwd,
      worktree: record.worktree,
      mode: overrides.mode ?? record.mode,
      model: overrides.model ?? record.model,
      env: overrides.env,
      providerOptions: { ...(record.providerOptions ?? {}), ...(overrides.providerOptions ?? {}) },
      resumeExternalSessionId: overrides.resumeExternalSessionId ?? record.externalSessionId,
      timeoutMs: overrides.timeoutMs,
      persistent: true,
      inheritStderr: overrides.inheritStderr,
      sessionId: record.id,
    });
  }
}
