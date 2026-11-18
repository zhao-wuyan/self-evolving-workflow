import { InputError } from '../common.js';
import { AgyAgentClient } from './providers/agy.js';
import { ClaudeAgentClient } from './providers/claude.js';
import { CodexAgentClient } from './providers/codex.js';
import { CustomCliAgentClient, type CustomCliProviderDefinition } from './providers/custom-cli.js';
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentSessionRecord,
  ProviderCapabilities,
  ProviderSummary,
  WorktreeInfo,
} from './types.js';

export interface ProviderAliasOptions {
  displayName?: string;
  model?: string;
  mode?: AgentSessionConfig['mode'];
  env?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
}

interface RegisteredEntry {
  client: AgentClient;
  derivedFrom?: string;
}

class DerivedAgentClient implements AgentClient {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  constructor(
    aliasId: string,
    private readonly base: AgentClient,
    private readonly defaults: ProviderAliasOptions,
  ) {
    this.id = aliasId;
    this.displayName = defaults.displayName ?? `${base.displayName} (${aliasId})`;
    this.capabilities = base.capabilities;
  }

  isAvailable(): boolean {
    return this.base.isAvailable();
  }

  createSession(
    config: AgentSessionConfig & { sessionId: string; effectiveCwd: string; worktree?: WorktreeInfo },
  ): Promise<AgentSession> {
    return this.base.createSession({
      ...config,
      provider: this.base.id,
      model: config.model ?? this.defaults.model,
      mode: config.mode ?? this.defaults.mode ?? 'analysis',
      env: this.defaults.env || config.env ? { ...(this.defaults.env ?? {}), ...(config.env ?? {}) } : undefined,
      providerOptions: this.defaults.providerOptions || config.providerOptions
        ? { ...(this.defaults.providerOptions ?? {}), ...(config.providerOptions ?? {}) }
        : undefined,
    });
  }

  resumeSession(record: AgentSessionRecord, overrides: Partial<AgentSessionConfig> = {}): Promise<AgentSession> {
    return this.base.resumeSession(record, {
      ...overrides,
      model: overrides.model ?? this.defaults.model,
      env: this.defaults.env || overrides.env ? { ...(this.defaults.env ?? {}), ...(overrides.env ?? {}) } : undefined,
      providerOptions: this.defaults.providerOptions || overrides.providerOptions
        ? { ...(this.defaults.providerOptions ?? {}), ...(overrides.providerOptions ?? {}) }
        : undefined,
    });
  }
}

export class ProviderRegistry {
  private readonly entries = new Map<string, RegisteredEntry>();

  constructor(options: { registerBuiltins?: boolean } = {}) {
    if (options.registerBuiltins !== false) {
      this.register(new CodexAgentClient());
      this.register(new AgyAgentClient());
      this.register(new ClaudeAgentClient());
    }
  }

  register(client: AgentClient): this {
    this.entries.set(client.id, { client });
    return this;
  }

  registerCustomCli(definition: CustomCliProviderDefinition): this {
    return this.register(new CustomCliAgentClient(definition));
  }

  registerAlias(aliasId: string, targetId: string, defaults: ProviderAliasOptions = {}): this {
    const base = this.get(targetId);
    this.entries.set(aliasId, {
      client: new DerivedAgentClient(aliasId, base, defaults),
      derivedFrom: targetId,
    });
    return this;
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): AgentClient {
    const entry = this.entries.get(id);
    if (!entry) {
      const supported = [...this.entries.keys()].join(', ');
      throw new InputError(`executor must be one of: ${supported}`);
    }
    return entry.client;
  }

  list(): ProviderSummary[] {
    return [...this.entries.values()].map(({ client, derivedFrom }) => ({
      id: client.id,
      displayName: client.displayName,
      available: client.isAvailable(),
      capabilities: client.capabilities,
      ...(derivedFrom ? { derivedFrom } : {}),
    }));
  }
}
