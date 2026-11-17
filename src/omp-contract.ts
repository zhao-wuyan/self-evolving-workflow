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
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(): OmpBranchEntry[];
  };
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
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Schema;
    approval: 'read' | 'write' | 'exec';
    execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
      onUpdate: unknown, ctx: OmpContext): Promise<OmpToolResult>;
  }): void;
  on(event: 'session_start' | 'session_switch' | 'session_branch' | 'session_tree' | 'session_clear' | 'session_shutdown',
    handler: (event: { type: string }, ctx: OmpContext) => void | Promise<void>): void;
  appendEntry(type: string, data: { eventId: string }): void;
}
