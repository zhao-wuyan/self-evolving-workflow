#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CodeGraph } from './code.js';
import { InputError, NotFoundError, requireText } from './common.js';
import { knowledgeHelp, knowledgeOptions, runKnowledgeCli } from './knowledge-cli.js';
import {
  AgentManager,
  agentIdentifier,
  type AgentMode,
  type AgentSessionStatus,
  type WorktreeSpec,
} from './orchestrator.js';
import { WorkflowStore, workflowId, type Mutation, type WorkflowStep } from './workflow-runtime.js';
import { memoryModelSettings } from './memory-config.js';
import { startMemoryHookWorker } from './memory-hook-jobs.js';
import { bindWorkflowSkill, commandNames, discoverWorkflowCommands, isProjectSkillEntry, validateWorkflowSkill, workflowBlob, workflowHeader, workflowPath, workflowStrings } from './workflow-skills.js';
import { wikiLookupScope } from './workflow-knowledge.js';
import {
  bundlePackageVersion, exportPlugins, installPlugins, installSkills, installStatus, installWorkflow,
  pluginStatus, syncProjectSkills, workflowDocument, workflowDocuments,
} from './workflow-install.js';
import { runOpenVikingCli, openVikingHelp } from './openviking/cli.js';
import { readProject } from './openviking/config.js';
import { isUnavailable, OpenVikingClient } from './openviking/client.js';
import { readProjectHead } from './openviking/assets.js';
import { prepareSession, finishSession } from './openviking/lifecycle.js';
import { experienceCommand, experienceHelp } from './openviking/experience.js';
import { completedExperience } from './openviking/experience-candidates.js';
import { delegateOmp } from './workflow-delegate.js';

const string = { type: 'string' } as const;
const strings = { type: 'string', multiple: true } as const;
const bool = { type: 'boolean' } as const;
const options = {
  root: string, db: string, id: string, session: string, run: string, actor: string, participant: string,
  'request-id': string, reason: string, evidence: strings, json: bool, help: { ...bool, short: 'h' }, advance: bool, next: bool,
  'expected-orchestration-revision': string, 'expected-run-revision': string,
  'definition-of-done': string, chain: strings, 'step-id': string, command: string, arg: strings, 'after-step': string,
  'decision-ref': string, 'goal-ref': string, stage: string, gate: strings, from: string, verdict: string, summary: string,
  'boundary-contract': string, goals: string, auto: bool, 'goal-mode': bool, status: string, query: string,
  'retry-max': string, 'decision-only': bool, 'target-step': string, confidence: string,
  to: string, tool: string, role: string, mode: string, model: string, cd: string, 'prompt-file': string, path: string,
  worktree: string, isolate: bool, 'keep-worktree': bool, 'remove-worktree': bool, 'agent-session': string,
  stream: bool, timeout: string, force: bool, 'delete-branch': bool, branch: string, 'base-ref': string,
  project: string, global: bool, apply: bool, 'knowhow-only': bool,
  scope: string, host: string, skill: strings, yes: bool, upgrade: bool, prune: bool, plugin: bool,
  commit: string, relation: string, related: string, approval: string, limit: string, all: bool,
} as const;

const usage = [
  'evolve session create <objective> --id <id> [--chain <commands>] [--actor <id>]',
  'evolve session get|update|complete --session <id>',
  'evolve session list|resume-view',
  'evolve session step add|update|delete --session <id> --step-id <id>',
  'evolve run create|get|check|read|update|cancel --session <id>',
  'evolve run complete <run> --summary <text> [--verdict done|done_with_concerns] [--gate <gate>] [--next] --session <id>',
  'evolve run skill-read <run> [<path> --from <from>] --session <id>',
  'evolve run artifact-read <run> <alias> --session <id> [--scope <Wiki scope JSON>]',
  'evolve run decide <decision-id> --verdict proceed|fix|escalate --summary <text> [--confidence <0-100>] [--target-step <step-id>] [--evidence <ref>] --session <id> [--actor <id>]',
  'evolve run task controller|add|update|delete|list --session <id> --run <id>',
  'evolve skill install|upgrade|sync [<package>...] [--plugin] [--scope project|user] [--host codex|claude|agy|omp|all] [--path <dir>] [--yes]',
  'evolve skill status [--plugin] [--scope project|user] [--host codex|claude|agy|omp|all]',
  'evolve skill validate|workflows [show <id>]',
  'evolve history collect|list|search|show [options]',
  'evolve agent exec <prompt> --to codex|agy|claude|omp --mode analysis|write [--worktree <name> | --isolate] [--agent-session <id>] [--stream] [--timeout <ms>]',
  'evolve agent providers|list|get|create|send|delete|worktree [options]',
  'evolve experience enable|disable|status|pending|review|publish|search|get',
].join('\n');

const agentHelp = [
  'Usage: evolve agent <action> [options]',
  '',
  '  exec <prompt>                  Delegate a turn (--to codex|agy|claude, --mode analysis|write)',
  '  providers                      List supported CLI providers and local availability',
  '  list                           List agent sessions (--to <provider>, --status <status>)',
  '  create <prompt>                Start a persistent session (alias: start; --id <id>)',
  '  get <id>                       Inspect an agent session record (alias: status)',
  '  send <id> <prompt>             Run a follow-up turn in a persistent session',
  '  delete <id>                    Close an agent session (alias: close; --remove-worktree)',
  '  worktree list|remove [<path>]  Inspect or remove Git agent worktrees',
  '',
  'Options:',
  '  --to, --tool <name>            codex (default), agy, claude, omp (exec only)',
  '  --mode <mode>                  analysis (default, read-only) | write',
  '  --model <model>                Model override',
  '  --cd <dir>                     Working directory relative to --root',
  '  --prompt-file <path>           Read prompt from file relative to --cd',
  '  --session <id> --run <id>      Inject bound Evolve Run context (exec/create)',
  '  --agent-session, --id <id>     Persistent session ID in .evolve/orchestrator.db',
  '  --worktree <name>              Create/run in isolated Git worktree (--isolate auto-names)',
  '  --branch <name>                Branch name for created worktree',
  '  --base-ref <ref>               Base ref for created worktree (default HEAD)',
  '  --keep-worktree                Preserve auto-created worktree after ephemeral exec',
  '  --remove-worktree              Remove worktree on agent delete/close (--force, --delete-branch)',
  '  --stream                       Emit JSONL AgentStreamEvent lines to stdout',
  '  --timeout <ms>                 Turn timeout in milliseconds',
  '',
  'Read the full delegation spec, prompt template, and retry rules:',
  '  evolve skill workflows show agent-usage',
].join('\n');

const knowledgeCommands = new Set(['code', 'kb', 'search', 'history']);
const skillEvolutionActions = new Set(['review', 'draft', 'replay', 'apply', 'rollback', 'retire', 'learnings', 'design']);

function needsWasmCodeGraph(group: string | undefined, action: string | undefined, values: Record<string, unknown>): boolean {
  if (values.help) return false;
  if (group === 'code') return action === 'build' || action === 'sync';
  const root = resolve(typeof values.root === 'string' ? values.root : '.');
  const ready = () => {
    try {
      return CodeGraph.hasReadyIndex(root);
    } catch {
      return true;
    }
  };
  if (group === 'search') {
    const scope = typeof values.scope === 'string' ? values.scope : (values.global ? 'global' : 'local');
    if (scope === 'global') return false;
    const from = typeof values.from === 'string' ? values.from.split(',').map(item => item.trim()) : ['all'];
    if (!from.some(item => item === 'code' || item === 'all')) return false;
    // 已有活跃锁占用时 search 会快速降级只读或跳过代码，避免无谓的 --liftoff-only 子进程重启。
    return !ready() && !CodeGraph.hasActiveLock(root);
  }
  if (group === 'session' && (action === 'open' || action === 'create')) {
    return existsSync(join(root, '.git')) && !ready();
  }
  return false;
}

function relaunchWithLiftoffIfNeeded(argv: string[]): void {
  if (process.execArgv.includes('--liftoff-only')) return;
  if (process.env.EVOLVE_WASM_RELAUNCHED || process.env.CODEGRAPH_NO_RELAUNCH || process.env.EVOLVE_NO_RELAUNCH) return;
  if (Number(process.versions.node.split('.')[0] ?? 0) < 22) return;
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return;
  const preserved = process.execArgv.filter(arg => arg !== '--liftoff-only');
  const result = spawnSync(process.execPath, ['--liftoff-only', ...preserved, entry, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, EVOLVE_WASM_RELAUNCHED: '1' },
    windowsHide: true,
  });
  if (result.error) return;
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

async function main(argv: string[]) {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    process.stdout.write(bundlePackageVersion() + '\n');
    return;
  }
  if (argv[0] === 'openviking') return runOpenVikingCli(argv.slice(1));
  // 路由保留选项及参数顺序，具体命令仍使用各自的严格参数定义。
  const { positionals: [group, action], tokens, values } = parseArgs({
    args: argv, options: { ...knowledgeOptions, ...options }, allowPositionals: true, strict: false, tokens: true,
  });
  if (needsWasmCodeGraph(group, action, values as Record<string, unknown>)) {
    relaunchWithLiftoffIfNeeded(argv);
  }
  if (group === 'openviking') {
    const command = tokens.find(token => token.kind === 'positional');
    return runOpenVikingCli(argv.filter((_, index) => index !== command?.index));
  }
  if (knowledgeCommands.has(group) || (group === 'session' && action === 'review')) {
    return runKnowledgeCli(argv, 'evolve');
  }
  if (group === 'skill' && skillEvolutionActions.has(action)) {
    return runKnowledgeCli(argv, 'evolve');
  }
  return runWorkflowCli(argv);
}

function revision(value: string | undefined) {
  if (value === undefined) return;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result)) throw new InputError('Invalid revision: ' + value);
  return result;
}

function select<T extends string>(value: string | undefined, choices: readonly T[], label: string): T {
  if (choices.some(item => item === value)) return value as T;
  throw new InputError(label + ' must be one of: ' + choices.join(', '));
}

function withRunContext(root: string, prompt: string, session?: string, run?: string): string {
  if ((session === undefined) !== (run === undefined)) throw new InputError('Supply both Session and Run identifiers');
  if (!session || !run) return prompt;
  const sessionId = workflowId(session, 'Session ID');
  const runId = workflowId(run, 'Run ID');
  const store = new WorkflowStore(root);
  try {
    const packet = store.brief(sessionId, runId);
    return prompt + '\n\nEvolve Run context: ' + JSON.stringify({
      root, session_id: sessionId, run_id: runId, run_dir: packet.run_dir,
    }) + '\nUse the Evolve CLI to read this Run: evolve run get ' + runId +
      ' --session ' + sessionId + ' --root ' + JSON.stringify(root) +
      '. Resolve knowledge with evolve search "<query>" --mode context --session ' + sessionId +
      ' --reads ' + JSON.stringify(join(packet.run_dir, 'knowledge-reads.json')) +
      '. Read bound Skills and artifacts with evolve run skill-read and evolve run artifact-read.';
  } finally {
    store.close();
  }
}

function buildWorktreeSpec(values: {
  worktree?: string; isolate?: boolean; branch?: string; 'base-ref'?: string;
}): WorktreeSpec | undefined {
  if (!values.worktree && !values.isolate && !values.branch && !values['base-ref']) return undefined;
  return {
    ...(values.worktree ? { name: values.worktree } : {}),
    ...(values.branch ? { branch: values.branch } : {}),
    ...(values['base-ref'] ? { baseRef: values['base-ref'] } : {}),
  };
}

function resolvePromptText(cwd: string, promptFile: string | undefined, args: string[]): string {
  return requireText(promptFile ? readFileSync(resolve(cwd, promptFile), 'utf8') : args.join(' '), 'prompt');
}

async function delegate(root: string, values: {
  to?: string; tool?: string; mode?: string; model?: string; role?: string; cd?: string; session?: string; run?: string; 'prompt-file'?: string;
  worktree?: string; isolate?: boolean; 'keep-worktree'?: boolean; 'agent-session'?: string;
  stream?: boolean; timeout?: string; branch?: string; 'base-ref'?: string;
}, args: string[]) {
  const provider = values.to ?? values.tool ?? 'codex';
  const mode = select(values.mode ?? 'analysis', ['analysis', 'write'] as const, 'mode') as AgentMode;
  const cwd = resolve(root, values.cd ?? '.');
  if (provider === 'omp') {
    if (buildWorktreeSpec(values) || values['keep-worktree'] || values['agent-session'] || values.stream) {
      throw new InputError('The restricted OMP worker supports one-shot execution without worktree management, agent sessions or streaming');
    }
    return delegateOmp(root, cwd, resolvePromptText(cwd, values['prompt-file'], args), mode, values);
  }
  const prompt = withRunContext(root, resolvePromptText(cwd, values['prompt-file'], args), values.session, values.run);
  const worktree = buildWorktreeSpec(values);
  const timeoutMs = revision(values.timeout);
  const stream = Boolean(values.stream);

  const manager = new AgentManager({ root });
  try {
    const result = await manager.delegate({
      provider,
      prompt,
      cwd,
      mode,
      model: values.model,
      worktree,
      keepWorktree: values['keep-worktree'],
      timeoutMs,
      agentSessionId: values['agent-session'],
      inheritStderr: !stream,
      providerOptions: stream ? { jsonEvents: true } : undefined,
      onEvent: stream ? event => process.stdout.write(JSON.stringify(event) + '\n') : undefined,
    });
    if (stream) return undefined;
    return {
      executor: result.executor,
      output: result.output,
      ...(result.sessionId ? { session_id: result.sessionId } : {}),
      ...(result.externalSessionId ? { external_session_id: result.externalSessionId } : {}),
      ...(result.worktree ? { worktree: result.worktree } : {}),
    };
  } finally {
    await manager.close();
  }
}

async function runAgentCommand(root: string, action: string | undefined, args: string[], values: {
  id?: string; 'agent-session'?: string; to?: string; tool?: string; mode?: string; model?: string; cd?: string; path?: string;
  session?: string; run?: string; 'prompt-file'?: string; worktree?: string; isolate?: boolean;
  'remove-worktree'?: boolean; stream?: boolean; timeout?: string; status?: string;
  force?: boolean; 'delete-branch'?: boolean; branch?: string; 'base-ref'?: string;
}, print: (value: unknown) => void) {
  const manager = new AgentManager({ root });
  try {
    if (action === 'providers') {
      return print(manager.listProviders());
    }
    if (action === 'list') {
      const status = values.status === undefined
        ? undefined
        : select(values.status, ['idle', 'running', 'completed', 'interrupted', 'failed', 'closed'] as const, 'agent session status') as AgentSessionStatus;
      return print(manager.listSessions({ provider: values.to ?? values.tool, status }));
    }
    if (action === 'status') {
      const id = agentIdentifier(values.id ?? values['agent-session'] ?? args[0]);
      const record = manager.getSession(id);
      if (!record) throw new NotFoundError(`Agent session not found: ${id}`);
      return print(record);
    }
    if (action === 'close') {
      const id = agentIdentifier(values.id ?? values['agent-session'] ?? args[0]);
      return print(await manager.closeSession(id, {
        removeWorktree: Boolean(values['remove-worktree']),
        forceWorktree: Boolean(values.force),
        deleteBranch: values['delete-branch'] === undefined ? true : Boolean(values['delete-branch']),
      }));
    }
    if (action === 'start') {
      const provider = values.to ?? values.tool ?? 'codex';
      const mode = select(values.mode ?? 'analysis', ['analysis', 'write'] as const, 'mode') as AgentMode;
      const cwd = resolve(root, values.cd ?? '.');
      const prompt = withRunContext(root, resolvePromptText(cwd, values['prompt-file'], args), values.session, values.run);
      const worktree = buildWorktreeSpec(values);
      const timeoutMs = revision(values.timeout);
      const stream = Boolean(values.stream);
      const session = await manager.createSession({
        sessionId: values.id ?? values['agent-session'],
        provider,
        cwd,
        mode,
        model: values.model,
        worktree,
        timeoutMs,
        persistent: true,
        inheritStderr: !stream,
        providerOptions: stream ? { jsonEvents: true } : undefined,
      });
      const turn = await manager.runTurn(session.id, {
        prompt,
        mode,
        model: values.model,
        timeoutMs,
        onEvent: stream ? event => process.stdout.write(JSON.stringify(event) + '\n') : undefined,
      });
      if (stream) return;
      return print({ session: manager.getSession(session.id) ?? session, turn });
    }
    if (action === 'send') {
      const id = agentIdentifier(values.id ?? values['agent-session'] ?? args[0]);
      const promptArgs = values.id || values['agent-session'] ? args : args.slice(1);
      const cwd = resolve(root, values.cd ?? '.');
      const prompt = resolvePromptText(cwd, values['prompt-file'], promptArgs);
      const mode = values.mode === undefined ? undefined : select(values.mode, ['analysis', 'write'] as const, 'mode') as AgentMode;
      const timeoutMs = revision(values.timeout);
      const stream = Boolean(values.stream);
      await manager.resumeSession(id, {
        ...(mode ? { mode } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        inheritStderr: !stream,
        ...(stream ? { providerOptions: { jsonEvents: true } } : {}),
      });
      const turn = await manager.runTurn(id, {
        prompt,
        mode,
        model: values.model,
        timeoutMs,
        onEvent: stream ? event => process.stdout.write(JSON.stringify(event) + '\n') : undefined,
      });
      if (stream) return;
      return print({ session: manager.getSession(id), turn });
    }
    if (action === 'worktree') {
      const sub = select(args[0] ?? 'list', ['list', 'remove'] as const, 'worktree action');
      if (sub === 'list') return print(manager.worktrees.list(root));
      const target = requireText(args[1] ?? values.path, 'worktree path');
      return print(manager.worktrees.remove(resolve(root, target), {
        force: Boolean(values.force),
        deleteBranch: Boolean(values['delete-branch']),
        repoRoot: root,
      }));
    }
    throw new InputError('Unknown agent command: ' + (action ?? ''));
  } finally {
    await manager.close();
  }
}

async function runWorkflowCli(argv: string[]) {
  const { positionals, values } = parseArgs({ options, args: argv, allowPositionals: true });
  let [group, action, ...args] = positionals;
  if (group && !['session', 'run', 'agent', 'skill', 'experience'].includes(group)) throw new InputError('Unknown command: ' + group);
  if (group === 'agent' && values.help) {
    process.stdout.write(agentHelp + '\n');
    return;
  }
  if (group === 'experience' && (!action || values.help)) {
    process.stdout.write(experienceHelp + '\n');
    return;
  }
  if (!group || values.help) {
    process.stdout.write(usage + '\n\n' + openVikingHelp + '\n\n' + knowledgeHelp('evolve'));
    return;
  }
  if (group === 'session') {
    action = ({ create: 'open', get: 'status', update: 'amend' } as Record<string, string>)[action] ?? action;
    if (action === 'step') {
      action = 'chain';
      args[0] = ({ add: 'insert', update: 'replace', delete: 'skip' } as Record<string, string>)[args[0]] ?? args[0];
    }
  }
  if (group === 'run') {
    action = ({ get: 'brief', update: 'transition' } as Record<string, string>)[action] ?? action;
    if (action === 'read') {
      const kind = select(args.shift(), ['skill', 'artifact'] as const, 'read kind');
      action = kind === 'skill' ? 'skill-read' : 'artifact-read';
    }
  }
  if (group === 'agent') action = ({ create: 'start', get: 'status', delete: 'close' } as Record<string, string>)[action] ?? action;
  const root = resolve(values.root ?? '.');
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (group === 'experience') return print(await experienceCommand(root, action, args, {
    relation: values.relation, related: values.related, approval: values.approval, limit: values.limit,
  }));
  if (group === 'skill' && action === 'workflows') {
    if (!args.length) return print(workflowDocuments(root));
    if (args[0] === 'show' && args.length === 2) {
      process.stdout.write(workflowDocument(args[1], root));
      return;
    }
    throw new InputError('Usage: evolve skill workflows [show <id>]');
  }
  const installScope = () => {
    if (values.global && values.scope === 'project') throw new InputError('--global selects the user scope');
    return values.global ? 'user' as const
      : values.scope === undefined ? undefined : select(values.scope, ['project', 'user'] as const, 'Install scope');
  };
  if (group === 'skill') {
    if (action === 'install' || action === 'upgrade') {
      const upgrade = action === 'upgrade' || Boolean(values.upgrade);
      if (values.plugin) {
        const skill = [...(values.skill ?? []), ...args];
        if (values.path) {
          return print(exportPlugins(root, values.path, {
            host: values.host, skill, upgrade, force: Boolean(values.force),
          }));
        }
        return print(await installPlugins(root, {
          scope: installScope(), host: values.host, skill, yes: values.yes,
          upgrade, force: Boolean(values.force),
        }));
      }
      if (args.length) return print(installSkills(root, args, values.host, {
        upgrade, prune: Boolean(values.prune), force: Boolean(values.force),
      }));
      return print(await installWorkflow(root, {
        scope: installScope(), host: values.host, skill: values.skill, yes: values.yes,
        upgrade, prune: Boolean(values.prune), force: Boolean(values.force),
      }));
    }
    if (action === 'sync') {
      return print(syncProjectSkills(root, {
        scope: installScope(),
        host: values.host,
        skill: [...(values.skill ?? []), ...args],
        force: Boolean(values.force),
      }));
    }
    if (action === 'status' && !args.length) {
      return print(values.plugin
        ? pluginStatus(root, { scope: installScope(), host: values.host })
        : installStatus(root, { scope: installScope(), host: values.host }));
    }
    if (action === 'validate') {
      if (values.all) {
        const commands = discoverWorkflowCommands(root);
        if (!commands.length) throw new InputError('No committed Skill packages found in this project');
        const results = commands.map(command => {
          try {
            return { command, ok: true, result: validateWorkflowSkill(root, command) };
          } catch (error) {
            return { command, ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        });
        const failed = results.filter(item => !item.ok);
        if (failed.length) process.exitCode = 1;
        return print({ total: results.length, passed: results.length - failed.length, failed: failed.length, results });
      }
      return print(validateWorkflowSkill(root, requireText(args[0], 'Skill command')));
    }
    if (action === 'inspect') {
      const entry = workflowPath(requireText(args[0], 'Skill entry'));
      const commit = requireText(values.commit, 'Skill commit');
      if (!isProjectSkillEntry(entry) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new InputError('Invalid Skill entry or commit');
      const header = workflowHeader(workflowBlob(root, commit, entry).toString('utf8'));
      const required_links = workflowStrings(header.required_links ?? [], 'required_links');
      const packagePath = entry.slice(0, -'SKILL.md'.length);
      for (const link of required_links) workflowBlob(root, commit, packagePath + workflowPath(link.split('#', 1)[0], '.md'));
      return print({ entry, commit, header, required_links });
    }
    if (!action || action === 'list') {
      const custom = discoverWorkflowCommands(root).filter(
        name => !commandNames.includes(name) && name !== 'ew-orchestrate' && name !== 'ew-odyssey',
      );
      return print([...commandNames, ...custom].map(command => ({ command })));
    }
    throw new InputError('Unknown Skill command: ' + action);
  }
  if (group === 'agent' && action === 'exec') {
    const delegated = await delegate(root, values, args);
    if (delegated !== undefined) print(delegated);
    return;
  }
  if (group === 'agent') {
    return runAgentCommand(root, action, args, values, print);
  }
  const store = new WorkflowStore(root);
  const id = () => workflowId(values.session ?? values.id, 'Session ID');
  const runId = () => workflowId(values.run ?? args[0], 'Run ID');
  const mutation = (): Mutation => {
    if (values.actor !== undefined && values.participant !== undefined && values.actor !== values.participant) {
      throw new InputError('Participant must match the actor');
    }
    const actor = workflowId(values.actor ?? values.participant ?? process.env.EVOLVE_ACTOR ?? 'agent', 'actor');
    return { actor, requestId: values['request-id'], revision: revision(values['expected-orchestration-revision']),
      runRevision: revision(values['expected-run-revision']), evidence: values.evidence, reason: values.reason };
  };
  const parseJsonOption = (raw: string | undefined, label: string) => {
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { throw new InputError('Invalid JSON for ' + label); }
  };
  const makeStep = (command: string, step: string): WorkflowStep => ({
    id: step, command, args: values.arg ?? [],
    ...(values['decision-only'] ? { kind: 'decision' as const } : {}),
    ...(values['retry-max'] === undefined ? {} : { retry_max: revision(values['retry-max']) }),
    decision_ref: values['decision-ref'],
    goal_ref: values['goal-ref'], stage: values.stage,
  });
  try {
    if (group === 'session') {
      if (action === 'list' || action === 'resume-view') {
        const status = values.status === undefined ? undefined : select(values.status, ['open', 'completed'] as const, 'Session status');
        return print(store.list({ status, query: values.query }));
      }
      if (action === 'status') return print(store.status(id()));
      if (action === 'amend') return print(store.amend(id(), requireText(args[0], 'amended objective'),
        values['definition-of-done'], mutation()));
      if (action === 'open') {
        const chain = [...values.chain ?? [], ...args.slice(1)].flatMap(value => value.split(/[\s,]+/)).filter(Boolean);
        const steps = chain.map((command, index) => ({ id: command + '-' + (index + 1), command, args: [] }));
        const boundaryContract = parseJsonOption(values['boundary-contract'], '--boundary-contract');
        const goals = parseJsonOption(values.goals, '--goals');
        const policy = values.auto || values['goal-mode'] ? { auto_mode: Boolean(values.auto), goal_mode: Boolean(values['goal-mode']) } : undefined;
        const profile = readProject(root);
        const existing = store.find(id());
        let seed = existing?.openviking ? { project_id: existing.openviking.project_id, release_id: existing.openviking.release_id,
          manifest_sha256: existing.openviking.manifest_sha256 } : undefined;
        let fallback: string | undefined;
        if (!existing && profile && profile.enabled !== false) {
          try {
            const { head } = await readProjectHead(new OpenVikingClient(), profile);
            seed = { project_id: profile.project_id, release_id: head.release_id, manifest_sha256: head.manifest_sha256 };
          } catch (error) {
            if (profile.failure_policy === 'fail' || !isUnavailable(error)) throw error;
            fallback = error instanceof Error ? error.message : 'OPENVIKING_UNAVAILABLE';
            console.warn('OpenViking unavailable; opening local Session: ' + fallback);
          }
        }
        let session: object = store.open(id(), requireText(args[0], 'objective'), values['definition-of-done'] ?? '', steps, mutation(),
          { boundaryContract, goals, policy, ...(seed ? { openviking: seed } : {}) });
        if (seed) session = existing?.openviking?.phase === 'ready'
          ? store.status(id()) : await prepareSession(root, store, id(), { ...mutation(), requestId: undefined, revision: store.status(id()).revision });
        if (fallback) session = { ...session, knowledge_backend: { configured: 'openviking', active: 'local', fallback_reason: fallback } };
        if (existsSync(join(root, '.git'))) {
          try {
            await new CodeGraph(root).refresh();
          } catch (error) {
            console.warn('Code graph refresh failed: ' + (error instanceof Error ? error.message : String(error)));
          }
        }
        return print(session);
      }
      if (action === 'chain') {
        const change = select(args[0], ['insert', 'replace', 'skip'], 'chain action');
        const cmd = change === 'skip' || values['decision-only'] ? '' : requireText(values.command, 'command');
        return print(store.chain(id(), change, makeStep(cmd, workflowId(values['step-id'], 'step ID')), values['after-step'], mutation()));
      }
      if (action === 'complete') {
        const completion = store.completeSession(id(), mutation(), values.project);
        // Completion and the immutable outbox commit before any model work.
        // Failure to dispatch cannot roll back a completed task.
        try {
          const settings = memoryModelSettings(root);
          if (settings.baseUrl && settings.model) await startMemoryHookWorker(root, true);
        } catch (error) {
          console.warn('Knowledge closeout queued; worker dispatch failed: ' + (error instanceof Error ? error.message : String(error)));
        }
        const experience = completedExperience(root, id());
        const result = experience ? { ...completion, personal_experience: experience } : completion;
        const completed = store.status(id());
        if (!completed.openviking) return print(result);
        if (process.env.EVOLVE_OMP_AGENT_KIND === 'sub') {
          return print({ ...result, asset_publication: { state: 'deferred', reason: 'main_session_required' } });
        }
        try {
          return print({ ...result, asset_publication: await finishSession(root, store, id(), {
            ...mutation(), revision: completed.revision, requestId: undefined,
          }) });
        } catch (error) {
          const latest = store.status(id());
          const fallback = readProject(root)?.failure_policy !== 'fail' && isUnavailable(error);
          print({ ...result, asset_publication: latest.openviking?.publication, orchestration_revision: latest.revision,
            ...(fallback ? { knowledge_backend: { active: 'local', fallback_reason: 'OPENVIKING_UNAVAILABLE' } } : {}),
            recovery: ['evolve', 'openviking', 'finish', '--session', id(), '--actor', mutation().actor,
              '--expected-orchestration-revision', String(latest.revision)] });
          if (!fallback) process.exitCode = 1;
          return;
        }
      }
    }
    if (group === 'run') {
      const gates = values.gate ?? [];
      if (action === 'next' || action === 'create') return print(store.next(id(), mutation(), gates, values['step-id']));
      if (action === 'brief') return print(store.brief(id(), runId()));
      if (action === 'check') return print(store.check(id(), runId(), gates));
      const target = values.run === undefined ? args[1] : args[0];
      if (action === 'skill-read') return print(store.readSkill(id(), runId(), values.from, target));
      if (action === 'artifact-read') return print(store.readArtifact(id(), runId(), requireText(target, 'artifact ID or alias'),
        wikiLookupScope(values.scope === undefined ? undefined : JSON.parse(values.scope))));
      if (action === 'complete') {
        const completed = store.completeRun(id(), runId(), requireText(values.summary, 'Run summary'),
          select(values.verdict ?? 'done', ['done', 'done_with_concerns'], 'verdict'), gates, mutation());
        if (values.next && completed.continuation.action === 'next') {
          const nextRun = store.next(id(), { actor: completed.receipt.actor }, gates);
          return print({ ...completed, next_run: nextRun });
        }
        return print(completed);
      }
      if (action === 'transition' || action === 'cancel') return print(store.transition(id(), runId(),
        action === 'cancel' ? 'cancelled' : select(args[1], ['running', 'blocked', 'failed'], 'Run status'),
        requireText(values.reason ?? values.summary, 'transition reason'), mutation()));
      if (action === 'decide') return print(store.decide(id(), workflowId(args[0], 'decision ID'),
        select(values.verdict, ['proceed', 'fix', 'escalate'], 'decision'), requireText(values.summary, 'decision summary'), mutation(),
        {
          targetStepId: values['target-step'] === undefined ? undefined : workflowId(values['target-step'], 'target step ID'),
          confidence: values.confidence === undefined ? undefined : Number(values.confidence),
        }));
    }
    if (group === 'run' && action === 'task') {
      const taskAction = requireText(args.shift(), 'task action');
      const operationName = ({ add: 'assign', update: 'report', delete: 'cancel' } as Record<string, string>)[taskAction] ?? taskAction;
      if (operationName === 'list') return print(store.teamList(id(), runId()));
      if (operationName === 'controller') return print(store.swarmController(id(), runId()));
      const operation = select(operationName, ['assign', 'report', 'cancel'], 'task operation');
      return print(store.team(id(), workflowId(values.run, 'Run ID'), operation, {
        id: workflowId(values.id ?? args[0], 'assignment ID'),
        role: operation === 'assign' ? workflowId(values.role, 'worker role') : '',
        path: operation === 'assign' ? requireText(values.path, 'artifact path') : '',
        ...(operation === 'report' ? { result: { summary: requireText(values.summary, 'assignment summary'), sha256: '' } } : {}),
      }, mutation()));
    }
    throw new InputError('Unknown workflow command: ' + [group, action].filter(Boolean).join(' '));
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
