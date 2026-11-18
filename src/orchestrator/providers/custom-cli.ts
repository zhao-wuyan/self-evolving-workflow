import { InputError } from '../../common.js';
import { isCliAvailable } from '../command-resolver.js';
import {
  type AgentClient,
  type AgentMode,
  type AgentSessionConfig,
  type AgentSessionRecord,
  type AgentTurnOptions,
  type ProviderCapabilities,
  type WorktreeInfo,
} from '../types.js';
import { BaseCliSession, type PreparedTurnExecution, type TurnExecutionContext } from './base-cli-session.js';

export interface CustomCliTurnContext {
  prompt: string;
  mode: AgentMode;
  model?: string;
  cwd: string;
  externalSessionId?: string;
  providerOptions?: Record<string, unknown>;
}

export interface CustomCliProviderDefinition {
  id: string;
  displayName: string;
  executable: string;
  envVar?: string;
  capabilities?: Partial<ProviderCapabilities>;
  buildTurn: (ctx: CustomCliTurnContext) => {
    args: string[];
    stdin?: string;
    onStdoutLine?: (line: string, turnCtx: TurnExecutionContext) => void;
    resolveOutput?: (stdout: string, turnCtx: TurnExecutionContext) => string;
    cleanup?: () => void;
  };
}

class CustomCliSession extends BaseCliSession {
  constructor(
    config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo },
    private readonly def: CustomCliProviderDefinition,
  ) {
    super(config, def.id);
  }

  protected prepareTurn(options: AgentTurnOptions): PreparedTurnExecution {
    const built = this.def.buildTurn({
      prompt: options.prompt,
      mode: this.effectiveMode(options),
      model: this.effectiveModel(options),
      cwd: this.config.effectiveCwd,
      externalSessionId: this._externalSessionId,
      providerOptions: this.config.providerOptions,
    });
    return {
      executable: this.def.executable,
      envVar: this.def.envVar,
      ...built,
    };
  }
}

export class CustomCliAgentClient implements AgentClient {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly def: CustomCliProviderDefinition) {
    this.id = def.id;
    this.displayName = def.displayName;
    this.capabilities = {
      supportsResume: def.capabilities?.supportsResume ?? false,
      supportsStreaming: def.capabilities?.supportsStreaming ?? true,
      supportsWriteMode: def.capabilities?.supportsWriteMode ?? true,
      supportsInterrupt: def.capabilities?.supportsInterrupt ?? true,
    };
  }

  isAvailable(): boolean {
    return isCliAvailable(this.def.executable, this.def.envVar);
  }

  async createSession(
    config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo },
  ): Promise<CustomCliSession> {
    return new CustomCliSession(config, this.def);
  }

  async resumeSession(record: AgentSessionRecord, overrides: Partial<AgentSessionConfig> = {}): Promise<CustomCliSession> {
    if (!this.capabilities.supportsResume) {
      throw new InputError(`Provider ${this.id} does not support session resume`);
    }
    return new CustomCliSession({
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
    }, this.def);
  }
}
