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

function parseAgyStreamLine(line: string, ctx: TurnExecutionContext): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.session_id === 'string') ctx.setExternalSessionId(parsed.session_id);
    const text = typeof parsed.text === 'string'
      ? parsed.text
      : typeof parsed.delta === 'string'
        ? parsed.delta
        : typeof parsed.result === 'string'
          ? parsed.result
          : undefined;
    if (text !== undefined) {
      if (parsed.type === 'result' || parsed.type === 'message') {
        ctx.setLastAssistantText(text);
        ctx.emit({
          type: 'message',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          role: 'assistant',
          text,
          timestamp: nowIso(),
        });
      } else {
        ctx.emit({
          type: 'text_delta',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          text,
          timestamp: nowIso(),
        });
      }
      return;
    }
  } catch {
    // 回退到纯文本流事件
  }
  ctx.emit({
    type: 'text_delta',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    text: line + '\n',
    timestamp: nowIso(),
  });
}

export class AgyAgentSession extends BaseCliSession {
  constructor(config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo }) {
    super(config, 'agy');
  }

  protected prepareTurn(options: AgentTurnOptions): PreparedTurnExecution {
    const mode = this.effectiveMode(options);
    const model = this.effectiveModel(options);
    const modelArgs = model ? ['--model', model] : [];
    const jsonEvents = this.config.providerOptions?.jsonEvents === true;

    return {
      executable: 'agy',
      envVar: 'AGY_EXECUTABLE',
      args: [
        '--mode', mode === 'analysis' ? 'plan' : 'accept-edits',
        '--output-format', jsonEvents ? 'stream-json' : 'text',
        ...modelArgs,
        '--print=' + options.prompt,
      ],
      ...(jsonEvents
        ? {
          onStdoutLine: parseAgyStreamLine,
          resolveOutput: (stdout, ctx) => ctx.getLastAssistantText() ?? stdout,
        }
        : {}),
    };
  }
}

export class AgyAgentClient implements AgentClient {
  readonly id = 'agy';
  readonly displayName = 'Antigravity CLI';
  readonly capabilities: ProviderCapabilities = {
    supportsResume: false,
    supportsStreaming: true,
    supportsWriteMode: true,
    supportsInterrupt: true,
  };

  isAvailable(): boolean {
    return isCliAvailable('agy', 'AGY_EXECUTABLE');
  }

  async createSession(
    config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo },
  ): Promise<AgyAgentSession> {
    return new AgyAgentSession(config);
  }

  async resumeSession(record: AgentSessionRecord, overrides: Partial<AgentSessionConfig> = {}): Promise<AgyAgentSession> {
    return new AgyAgentSession({
      provider: this.id,
      cwd: record.cwd,
      effectiveCwd: record.effectiveCwd,
      worktree: record.worktree,
      mode: overrides.mode ?? record.mode,
      model: overrides.model ?? record.model,
      env: overrides.env,
      providerOptions: { ...(record.providerOptions ?? {}), ...(overrides.providerOptions ?? {}) },
      timeoutMs: overrides.timeoutMs,
      persistent: true,
      inheritStderr: overrides.inheritStderr,
      sessionId: record.id,
    });
  }
}
