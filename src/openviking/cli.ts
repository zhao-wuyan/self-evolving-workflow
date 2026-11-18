import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InputError, requireText } from '../common.js';
import { WorkflowStore, workflowId, type Mutation } from '../workflow-runtime.js';
import { initializeProject, prepareSession, finishSession } from './lifecycle.js';
import { isUnavailable, OpenVikingClient } from './client.js';
import { projectFile, readProject, replaceJson } from './config.js';
import { loadRelease, readProjectHead } from './assets.js';
import { selectMemory } from './knowledge.js';
import { manageEvolutionPolicy } from './policy.js';

export const openVikingHelp = [
  'evolve openviking init [--policy <file>] [--project-id <UUID>] [--root <project>]',
  'evolve openviking policy [--entry <skill> --runner <script> --scenarios <file> [--apply <preview-id>]]',
  'evolve openviking config [--enabled true|false] [--failure-policy local|fail] [--root <project>]',
  'evolve openviking status [--root <project>]',
  'evolve openviking sync --session <id> --actor <actor> --expected-orchestration-revision <n> [--request-id <id>]',
  'evolve openviking finish --session <id> --actor <actor> --expected-orchestration-revision <n> [--candidate-commit <sha>] [--request-id <id>]',
  'evolve openviking memory share|unshare <local-memory-id> [--root <project>]',
  'No project profile: local backend. init enables OpenViking; failure-policy defaults to local.',
  'init defaults to .evolve/evolution.json and creates an empty policy when absent. Empty targets sync assets without evolving Skills.',
  'policy previews by default; --apply creates a local Git commit and never publishes.',
  'Fallback never publishes, bypasses integrity checks, or substitutes local data for an ov: ID.',
].join('\n');

export async function runOpenVikingCli(argv: string[]): Promise<void> {
  const string = { type: 'string' } as const;
  const { values, positionals: [action, ...args] } = parseArgs({ args: argv, allowPositionals: true, options: {
    root: string, policy: string, 'project-id': string, session: string, actor: string,
    entry: string, runner: string, scenarios: string, apply: string,
    'expected-orchestration-revision': string, 'request-id': string, 'candidate-commit': string,
    enabled: string, 'failure-policy': string, help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
  } });
  if (!action || values.help) { process.stdout.write(openVikingHelp + '\n'); return; }
  const root = resolve(values.root ?? '.');
  const print = (value: unknown) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); };
  if (action === 'init') {
    if (args.length) throw new InputError(openVikingHelp);
    return print(await initializeProject(root, values.policy, values['project-id']));
  }
  if (action === 'policy') {
    if (args.length) throw new InputError(openVikingHelp);
    const target = [values.entry, values.runner, values.scenarios, values.apply].some(value => value !== undefined)
      ? { entry: requireText(values.entry, 'Skill entry'), runner: requireText(values.runner, 'replay runner'), scenarios: requireText(values.scenarios, 'replay scenarios') }
      : undefined;
    return print(manageEvolutionPolicy(root, target, values.apply));
  }
  const project = readProject(root);
  if (action === 'status' && !project) return print({ backend: 'local', enabled: false, configured: false });
  if (!project) throw new InputError('OPENVIKING_PROJECT_REQUIRED: run openviking init --policy <file>');
  if (action === 'config') {
    if (args.length || values.enabled !== undefined && !['true', 'false'].includes(values.enabled) ||
        values['failure-policy'] !== undefined && !['local', 'fail'].includes(values['failure-policy'])) throw new InputError(openVikingHelp);
    const next = { ...project, ...(values.enabled === undefined ? {} : { enabled: values.enabled === 'true' }),
      ...(values['failure-policy'] === undefined ? {} : { failure_policy: values['failure-policy'] }) };
    if (values.enabled !== undefined || values['failure-policy'] !== undefined) replaceJson(projectFile(root), readFileSync(projectFile(root)), next);
    return print({ project: next, backend: next.enabled === false ? 'local' : 'openviking' });
  }
  if (action === 'status') {
    if (args.length) throw new InputError(openVikingHelp);
    if (project.enabled === false) return print({ project, backend: 'local', enabled: false });
    try {
      const client = new OpenVikingClient();
      const { head } = await readProjectHead(client, project);
      const manifest = await loadRelease(client, project, head.release_id);
      return print({ project, backend: 'openviking', head, files: manifest.files.length, memory: manifest.memory.length, wiki: manifest.wiki.length });
    } catch (error) {
      if (project.failure_policy === 'fail' || !isUnavailable(error)) throw error;
      return print({ project, backend: 'local', fallback_reason: error instanceof Error ? error.message : 'OPENVIKING_UNAVAILABLE' });
    }
  }
  if (action === 'memory') {
    if (!['share', 'unshare'].includes(args[0]) || args.length !== 2) throw new InputError(openVikingHelp);
    return print(selectMemory(root, requireText(args[1], 'local Memory ID'), args[0] as 'share' | 'unshare'));
  }
  if (action !== 'sync' && action !== 'finish' || args.length) throw new InputError(openVikingHelp);
  const revision = Number(values['expected-orchestration-revision']);
  if (!/^\d+$/.test(values['expected-orchestration-revision'] ?? '') || !Number.isSafeInteger(revision)) throw new InputError('Supply a valid expected orchestration revision');
  const mutation: Mutation = { actor: workflowId(values.actor, 'actor'), revision, requestId: values['request-id'] };
  const id = workflowId(values.session, 'Session ID');
  const store = new WorkflowStore(root);
  try {
    const result = action === 'sync' ? await prepareSession(root, store, id, mutation)
      : await finishSession(root, store, id, mutation, values['candidate-commit']);
    print(result);
  } catch (error) {
    const status = store.status(id);
    print({ session_id: id, status: status.status, orchestration_revision: status.revision, openviking: status.openviking,
      recovery: ['evolve', 'openviking', action, '--root', root, '--session', id, '--actor', mutation.actor,
        '--expected-orchestration-revision', String(status.revision)] });
    throw error;
  } finally { store.close(); }
}
