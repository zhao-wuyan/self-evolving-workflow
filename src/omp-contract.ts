export interface RunBinding { session: string; run: string }

export interface KnowledgeSourceBinding {
  fingerprint: string;
  backend: 'local' | 'openviking' | 'cache';
  releaseId?: string;
  repositoryId?: string;
}

export interface OmpInvocationContext {
  root: string;
  ompSessionId: string;
  branchLeafId: string | null;
  toolCallId: string;
  generation: number;
  binding?: RunBinding;
}

export interface OmpBranchEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}

export interface OmpContext {
  cwd: string;
  agent?: { kind: 'main' | 'sub' };
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(): OmpBranchEntry[];
  };
}

export interface OmpCommandContext extends OmpContext {
  hasUI: boolean;
  ui: {
    notify(message: string, level: 'info' | 'warning' | 'error'): void;
    confirm(title: string, message: string): Promise<boolean>;
    select?(title: string, options: string[]): Promise<string | undefined>;
    setStatus?(key: string, text: string | undefined): void;
    setWidget?(key: string, content: string[] | undefined, options?: { placement?: 'aboveEditor' | 'belowEditor' }): void;
    setWorkingMessage?(message?: string): void;
  };
}

export interface OmpBeforeAgentStartEvent {
  type: 'before_agent_start';
  prompt?: string;
  reason?: string;
  systemPrompt?: string | unknown[];
}
export interface OmpBeforeAgentStartResult {
  systemPrompt?: string | unknown[];
}

interface Schema {
  optional(): Schema;
}
export interface OmpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
  isError?: boolean;
}
export interface OmpExtensionApi {
  zod: {
    string(): Schema;
    array(item: Schema): Schema;
    object(shape: Record<string, Schema>): Schema;
  };
  registerCommand(name: string, command: {
    description: string;
    getArgumentCompletions?(prefix: string): Array<{ value: string; label: string; description?: string }> | null;
    handler(args: string, ctx: OmpCommandContext): Promise<void>;
  }): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Schema;
    approval: 'read' | 'write' | 'exec';
    execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
      onUpdate: unknown, ctx: OmpCommandContext): Promise<OmpToolResult>;
  }): void;
  on(event: 'before_agent_start',
    handler: (event: OmpBeforeAgentStartEvent, ctx: OmpContext) => OmpBeforeAgentStartResult | void | Promise<OmpBeforeAgentStartResult | void>): void;
  on(event: 'session_start' | 'session_switch' | 'session_branch' | 'session_tree' | 'session_clear' | 'session_shutdown',
    handler: (event: { type: string }, ctx: OmpContext) => void | Promise<void>): void;
  appendEntry(type: string, data: { eventId: string }): void;
}
