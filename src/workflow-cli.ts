#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CodeGraph } from './code.js';
import { InputError, requireText } from './common.js';
import { knowledgeHelp, knowledgeOptions, runKnowledgeCli } from './knowledge-cli.js';
import { WorkflowStore, workflowId, type Mutation, type WorkflowStep } from './workflow-runtime.js';
import { bindWorkflowSkill, commandNames, workflowHash, workflowBlob, workflowHeader, workflowPath, workflowStrings } from './workflow-skills.js';
import { serveWorkflowRun } from './workflow-mcp.js';
import { Wiki } from './wiki.js';
import { migrateLegacyWiki } from './wiki-migration.js';
import { wikiLookupScope } from './workflow-knowledge.js';
import { installSkills, installWorkflow, workflowDocument, workflowDocuments } from './workflow-install.js';
import { runOpenVikingCli, openVikingHelp } from './openviking/cli.js';
import { readProject } from './openviking/config.js';
import { isUnavailable, OpenVikingClient } from './openviking/client.js';
import { readProjectHead } from './openviking/assets.js';
import { prepareSession, finishSession } from './openviking/lifecycle.js';
import { experienceCommand, experienceHelp } from './openviking/experience.js';
import { completedExperience } from './openviking/experience-candidates.js';
import { delegate } from './workflow-delegate.js';

const string = { type: 'string' } as const;
const strings = { type: 'string', multiple: true } as const;
const bool = { type: 'boolean' } as const;
const options = {
  root: string, db: string, id: string, session: string, run: string, actor: string, participant: string,
  'request-id': string, reason: string, evidence: strings, json: bool, help: { ...bool, short: 'h' }, advance: bool,
  'expected-orchestration-revision': string, 'expected-run-revision': string,
  'definition-of-done': string, chain: strings, 'step-id': string, command: string, arg: strings, 'after-step': string,
  'decision-ref': string, 'goal-ref': string, stage: string, gate: strings, from: string, verdict: string, summary: string,
  'boundary-contract': string, goals: string, auto: bool, 'goal-mode': bool, status: string, query: string,
  'retry-max': string, 'decision-only': bool, 'target-step': string, confidence: string,
  to: string, tool: string, role: string, mode: string, model: string, cd: string, 'prompt-file': string, path: string,
  project: string, global: bool, apply: bool, 'knowhow-only': bool,
  scope: string, host: string, skill: strings, yes: bool,
  commit: string, timeout: string,
  relation: string, related: string, approval: string, limit: string,
} as const;

const usage = [
  'evolve capabilities',
  'evolve session open <objective> --id <id> [--chain <commands>] --actor <id>',
  'evolve session status|amend|complete --session <id>',
  'evolve session list|resume-view',
  'evolve session chain insert|replace|skip --session <id> --step-id <id>',
  'evolve run next|brief|check|skill-read|artifact-read|complete|transition|cancel|decide --session <id>',
  'evolve run skill-read <run> [<path> --from <from>] --session <id>',
  'evolve run artifact-read <run> <alias> --session <id> [--scope <Wiki scope JSON>]',
  'evolve team controller|assign|report|cancel|list --session <id> --run <id>',
  'evolve skills [install <package>... | validate <command> | inspect <entry> --commit <sha>]',
  'evolve install [--scope project|user | --global] [--host codex|claude|agy|omp] [--skill <package>] [--root <project>] [--yes]',
  'evolve workflows [show <id>]',
  'evolve knowledge import [<source>] [--root <destination>] [--project <legacy-id>] [--global] [--knowhow-only] [--apply]',
  'evolve experience enable|disable|status|pending|review|publish|search|get',
  'evolve mcp --session <id> --run <id>',
  'evolve delegate <prompt> --to codex|agy|omp --mode analysis|write [--role <OMP role>] [--model <selector>] [--timeout <seconds>]',
].join('\n');

const knowledgeCommands = new Set(['code', 'wiki', 'memory', 'search', 'context', 'serve', 'closeout', 'skill-design']);
const skillEvolutionActions = new Set(['review', 'draft', 'replay', 'apply', 'rollback']);

async function main(argv: string[]) {
  if (argv[0] === 'openviking') return runOpenVikingCli(argv.slice(1));
  // 路由保留选项及参数顺序，具体命令仍使用各自的严格参数定义。
  const { positionals: [group, action], tokens } = parseArgs({
    args: argv, options: { ...knowledgeOptions, ...options }, allowPositionals: true, strict: false, tokens: true,
  });
  if (group === 'openviking') {
    const token = tokens.find(token => token.kind === 'positional');
    return runOpenVikingCli(argv.filter((_, index) => index !== token?.index));
  }
  if (knowledgeCommands.has(group) || (group === 'session' && action === 'review')) {
    return runKnowledgeCli(argv, 'evolve');
  }
  if (group === 'skills' && skillEvolutionActions.has(action)) {
    const command = tokens.find(token => token.kind === 'positional');
    if (command) argv[command.index] = 'evolve';
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

function importLegacyKnowledge(root: string, sourceArg: string | undefined, values: {
  root?: string; global?: boolean; project?: string; apply?: boolean; 'knowhow-only'?: boolean;
}) {
  const scope = values.global ? 'global' : 'project';
  const source = realpathSync(sourceArg ?? (values.global ? join(homedir(), '.maestro') : root));
  if (!lstatSync(source).isDirectory()) throw new InputError('Legacy knowledge source must be a directory');
  const destination = values.root ? root : values.global ? join(homedir(), '.evolve') : source;
  const project = values.project ?? (values.global && !sourceArg ? 'maestro-global' : 'legacy-' + workflowHash(source).slice(7, 23));
  const entries = migrateLegacyWiki(new Wiki(destination), source, project, values.apply, {
    scope, knowhowOnly: values['knowhow-only'],
  });
  return { source, destination, project, scope, applied: values.apply ?? false,
    new_entries: entries.filter(entry => !entry.existing).length,
    existing_entries: entries.filter(entry => entry.existing).length,
    needs_review: entries.filter(entry => entry.status === 'needs_review').length, entries };
}

async function runWorkflowCli(argv: string[]) {
  const { positionals: [group, action, ...args], values } = parseArgs({ options, args: argv, allowPositionals: true });
  if (group === 'experience' && (!action || values.help)) {
    process.stdout.write(experienceHelp + '\n');
    return;
  }
  if (!group || values.help) {
    process.stdout.write(usage + '\n\n' + openVikingHelp + '\n\n' + knowledgeHelp('evolve'));
    return;
  }
  const root = resolve(values.root ?? '.');
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (group === 'experience') {
    return print(await experienceCommand(root, action, args, {
      relation: values.relation, related: values.related, approval: values.approval, limit: values.limit,
    }));
  }
  if (group === 'capabilities') return print({ schema_version: 'evolve-workflow/1.0', session: 'evolve-session/1.0',
    features: ['revision-cas', 'request-receipts', 'git-skill-binding', 'atomic-artifact-seal', 'run-knowledge', 'swarm-coordination'] });
  if (group === 'knowledge') {
    if (action !== 'import' || args.length > 1) {
      throw new InputError('Usage: evolve knowledge import [<source>] [--root <destination>] [--project <legacy-id>] [--global] [--knowhow-only] [--apply]');
    }
    return print(importLegacyKnowledge(root, args[0], values));
  }
  if (group === 'workflows') {
    if (!action) return print(workflowDocuments());
    if (action === 'show' && args.length === 1) {
      process.stdout.write(workflowDocument(args[0]));
      return;
    }
    throw new InputError('Usage: evolve workflows [show <id>]');
  }
  if (group === 'install' && !action) {
    if (values.global && values.scope === 'project') throw new InputError('--global selects the user scope');
    const scope = values.global ? 'user'
      : values.scope === undefined ? undefined : select(values.scope, ['project', 'user'] as const, 'Install scope');
    return print(await installWorkflow(root, {
      scope,
      host: values.host === undefined ? undefined : select(values.host, ['codex', 'claude', 'agy', 'omp'] as const, 'Install host'),
      skill: values.skill, yes: values.yes,
    }));
  }
  if (group === 'skills') {
    if (action === 'install') return print(installSkills(root, args));
    if (action === 'validate') return print(bindWorkflowSkill(root, requireText(args[0], 'Skill command')));
    if (action === 'inspect') {
      const entry = workflowPath(requireText(args[0], 'Skill entry'));
      const commit = requireText(values.commit, 'Skill commit');
      if (!/^skills\/.+\/SKILL\.md$/.test(entry) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new InputError('Invalid Skill entry or commit');
      const header = workflowHeader(workflowBlob(root, commit, entry).toString('utf8'));
      const required_links = workflowStrings(header.required_links ?? [], 'required_links');
      const packagePath = entry.slice(0, -'SKILL.md'.length);
      for (const link of required_links) workflowBlob(root, commit, packagePath + workflowPath(link.split('#', 1)[0], '.md'));
      return print({ entry, commit, header, required_links });
    }
    if (!action) return print(commandNames.map(command => ({ command })));
    throw new InputError('Unknown Skills command: ' + action);
  }
  if (group === 'delegate') return print(await delegate(root, values, action === undefined ? args : [action, ...args]));
  const store = new WorkflowStore(root);
  const id = () => workflowId(values.session ?? values.id, 'Session ID');
  const runId = () => workflowId(values.run ?? args[0], 'Run ID');
  const mutation = (): Mutation => {
    const actor = workflowId(values.actor ?? values.participant, 'actor');
    if (values.participant && values.participant !== actor) throw new InputError('Participant must match the actor');
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
        const completion = store.completeSession(id(), mutation());
        const experience = completedExperience(root, id());
        const result = experience ? { ...completion, personal_experience: experience } : completion;
        const completed = store.status(id());
        if (!completed.openviking) return print(result);
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
      if (action === 'complete') return print(store.completeRun(id(), runId(), requireText(values.summary, 'Run summary'),
        select(values.verdict ?? 'done', ['done', 'done_with_concerns'], 'verdict'), gates, mutation()));
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
    if (group === 'team') {
      if (action === 'list') return print(store.teamList(id(), runId()));
      if (action === 'controller') return print(store.swarmController(id(), runId()));
      const operation = select(action, ['assign', 'report', 'cancel'], 'team operation');
      return print(store.team(id(), workflowId(values.run, 'Run ID'), operation, {
        id: workflowId(values.id ?? args[0], 'assignment ID'),
        role: operation === 'assign' ? workflowId(values.role, 'worker role') : '',
        path: operation === 'assign' ? requireText(values.path, 'artifact path') : '',
        ...(operation === 'report' ? { result: { summary: requireText(values.summary, 'assignment summary'), sha256: '' } } : {}),
      }, mutation()));
    }
    if (group === 'mcp') return await serveWorkflowRun(store, id(), workflowId(values.run, 'Run ID'), values.db);
    throw new InputError('Unknown workflow command: ' + [group, action].filter(Boolean).join(' '));
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
