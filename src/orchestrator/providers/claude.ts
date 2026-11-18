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

function parseClaudeStreamLine(line: string, ctx: TurnExecutionContext): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    ctx.emit({ type: 'text_delta', sessionId: ctx.sessionId, turnId: ctx.turnId, text: line + '\n', timestamp: nowIso() });
    return;
  }

  if (typeof parsed.session_id === 'string') {
    ctx.setExternalSessionId(parsed.session_id);
  }

  if (parsed.type === 'assistant' && parsed.message && typeof parsed.message === 'object') {
    const message = parsed.message as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    const textChunks: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'text' && typeof item.text === 'string') {
        textChunks.push(item.text);
      } else if (item.type === 'tool_use') {
        ctx.emit({
          type: 'tool_call',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          callId: typeof item.id === 'string' ? item.id : ctx.turnId,
          name: typeof item.name === 'string' ? item.name : 'tool',
          input: item.input,
          status: 'started',
          timestamp: nowIso(),
        });
      }
    }
    if (textChunks.length) {
      const text = textChunks.join('');
      ctx.setLastAssistantText(text);
      ctx.emit({
        type: 'message',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        role: 'assistant',
        text,
        timestamp: nowIso(),
      });
    }
    return;
  }

  if (parsed.type === 'result' && typeof parsed.result === 'string') {
    ctx.setLastAssistantText(parsed.result);
    ctx.emit({
      type: 'message',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      role: 'assistant',
      text: parsed.result,
      timestamp: nowIso(),
    });
  }
}

export class ClaudeAgentSession extends BaseCliSession {
  constructor(config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo }) {
    super(config, 'claude');
  }

  protected prepareTurn(options: AgentTurnOptions): PreparedTurnExecution {
    const mode = this.effectiveMode(options);
    const model = this.effectiveModel(options);
    const providerOptions = this.config.providerOptions ?? {};
    const jsonEvents = providerOptions.jsonEvents === true || (this.config.persistent === true && providerOptions.jsonEvents !== false);
    const args: string[] = [
      '-p', options.prompt,
      '--output-format', jsonEvents ? 'stream-json' : 'text',
      '--permission-mode', mode === 'analysis' ? 'plan' : 'acceptEdits',
    ];
    if (jsonEvents && providerOptions.verbose !== false) {
      args.push('--verbose');
    }
    if (model) {
      args.push('--model', model);
    }
    if (this._externalSessionId) {
      args.push('--resume', this._externalSessionId);
    }

    return {
      executable: 'claude',
      envVar: 'CLAUDE_EXECUTABLE',
      args,
      ...(jsonEvents
        ? {
          onStdoutLine: parseClaudeStreamLine,
          resolveOutput: (stdout, ctx) => ctx.getLastAssistantText() ?? stdout,
        }
        : {}),
    };
  }
}

export class ClaudeAgentClient implements AgentClient {
  readonly id = 'claude';
  readonly displayName = 'Claude Code CLI';
  readonly capabilities: ProviderCapabilities = {
    supportsResume: true,
    supportsStreaming: true,
    supportsWriteMode: true,
    supportsInterrupt: true,
  };

  isAvailable(): boolean {
    return isCliAvailable('claude', 'CLAUDE_EXECUTABLE');
  }

  async createSession(
    config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo },
  ): Promise<ClaudeAgentSession> {
    return new ClaudeAgentSession(config);
  }

  async resumeSession(record: AgentSessionRecord, overrides: Partial<AgentSessionConfig> = {}): Promise<ClaudeAgentSession> {
    return new ClaudeAgentSession({
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
