import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { InputError, requireText } from './common.js';
import { WorkflowStore, workflowId } from './workflow-runtime.js';
import type { OmpWorkerRequest } from './omp-worker.js';

type Executor = 'codex' | 'agy' | 'omp';
interface DelegateOptions {
  to?: string; tool?: string; mode?: string; model?: string; role?: string; cd?: string;
  session?: string; run?: string; 'prompt-file'?: string; timeout?: string;
}

function findWindowsCommand(name: string) {
  for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name + '.exe';
}

function commandFor(tool: Executor, childArgs: string[]) {
  const override = tool === 'codex' ? process.env.CODEX_REPLAY_EXECUTABLE
    : tool === 'agy' ? process.env.AGY_EXECUTABLE : process.env.OMP_EXECUTABLE;
  const raw = override ?? (process.platform === 'win32' ? findWindowsCommand(tool) : tool);
  if (/\.[cm]?js$/i.test(raw)) return { command: process.execPath, args: [resolve(raw), ...childArgs], shell: false };
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(raw)) {
    if (existsSync(raw)) {
      const match = /%~?dp0[\\/]([^"\r\n]+\.[cm]?js)/i.exec(readFileSync(raw, 'utf8'));
      if (match) {
        const script = resolve(dirname(raw), match[1]);
        if (existsSync(script)) return { command: process.execPath, args: [script, ...childArgs], shell: false };
      }
    }
    return { command: `"${raw}"`, args: childArgs.map(arg => `"${arg.replaceAll('"', '\\"')}"`), shell: true };
  }
  return { command: raw, args: childArgs, shell: false };
}

function stopWorker(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    const { promise, resolve: done, reject: fail } = Promise.withResolvers<void>();
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', fail);
    killer.once('close', () => done());
    return promise;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return Promise.reject(error); }
  return Promise.resolve();
}

async function runOmp(cwd: string, request: OmpWorkerRequest, seconds: number) {
  const stage = mkdtempSync(join(tmpdir(), 'evolve-omp-'));
  // 启动器不发现环境 MCP/扩展；真正的 worker 由 SDK 再施加严格工具限制。
  const overlay = join(stage, 'bootstrap.yml');
  writeFileSync(overlay, JSON.stringify({
    disabledProviders: ['native', 'skillshare', 'omp-plugins', 'claude', 'claude-plugins', 'codex', 'gemini',
      'opencode', 'cursor', 'windsurf', 'vscode', 'mcp-json', 'agent-plugins'],
    mcp: { enableProjectConfig: false },
  }));
  const worker = fileURLToPath(new URL('./omp-worker.js', import.meta.url));
  const resolved = commandFor('omp', ['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-lsp',
    '--no-skills', '--no-rules', '--no-context-files', '--no-title', '--model', request.model, '--config', overlay, '--trusted-extension', worker]);
  let abortReason: Error | undefined;
  let killing: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  const cancel = (reason: Error) => {
    abortReason ??= reason;
    if (child && !killing) killing = stopWorker(child);
  };
  const interrupt = () => cancel(new InputError('OMP delegate cancelled'));
  const timer = setTimeout(() => cancel(new InputError(`OMP delegate timed out after ${seconds} seconds`)), seconds * 1000);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    let result: { output?: string; error?: string } | undefined;
    let protocolError: Error | undefined;
    const exited = Promise.withResolvers<number | null>();
    child = spawn(resolved.command, resolved.args, { cwd, windowsHide: true, shell: resolved.shell,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'inherit'] });
    child.once('error', exited.reject);
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'evolve_worker_result' || event.request_id !== request.request_id) return;
        if (result) throw new InputError('OMP worker returned more than one result');
        result = event;
      } catch (error) {
        protocolError ??= error instanceof Error ? error : new Error(String(error));
        cancel(protocolError);
      }
    });
    child.stdin!.on('error', error => { protocolError ??= error; });
    child.stdin!.end('/evolve-worker ' + JSON.stringify(request));
    child.once('close', code => { lines.close(); exited.resolve(code); });
    const status = await exited.promise;
    if (killing) await killing;
    if (abortReason) throw abortReason;
    if (protocolError) throw protocolError;
    if (status !== 0) throw new InputError('omp exited with status ' + status);
    if (!result) throw new InputError('OMP worker did not return a result; requires OMP with the restricted SDK and trusted extensions');
    if (result.error) throw new InputError(result.error);
    if (typeof result.output !== 'string') throw new InputError('OMP worker returned an invalid result');
    return { executor: 'omp', output: result.output };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function delegate(root: string, values: DelegateOptions, args: string[]) {
  const selected = values.to ?? values.tool ?? 'codex';
  if (!['codex', 'agy', 'omp'].includes(selected)) throw new InputError('executor must be one of: codex, agy, omp');
  const tool = selected as Executor;
  const mode = values.mode ?? 'analysis';
  if (mode !== 'analysis' && mode !== 'write') throw new InputError('mode must be one of: analysis, write');
  const cwd = resolve(root, values.cd ?? '.');
  const prompt = requireText(values['prompt-file'] ? readFileSync(resolve(cwd, values['prompt-file']), 'utf8') : args.join(' '), 'prompt');
  if ((values.session === undefined) !== (values.run === undefined)) throw new InputError('Supply both Session and Run identifiers');
  if (tool === 'omp') {
    const seconds = values.timeout === undefined ? 600 : Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 2147483) throw new InputError('timeout must be a positive number of seconds (at most 2147483)');
    const role = values.role ?? (mode === 'analysis' ? 'plan' : 'task');
    if (!/^[a-z][a-z0-9_-]*$/i.test(role)) throw new InputError('Invalid OMP model role');
    let binding: OmpWorkerRequest['binding'];
    if (values.session && values.run) {
      const session = workflowId(values.session, 'Session ID');
      const run = workflowId(values.run, 'Run ID');
      const store = new WorkflowStore(root);
      try { store.brief(session, run); }
      finally { store.close(); }
      binding = { node: process.execPath, cli: fileURLToPath(new URL('./workflow-cli.js', import.meta.url)), root, session, run };
    }
    return runOmp(cwd, { request_id: randomUUID(), prompt, cwd, mode, model: values.model ?? '@' + role, binding }, seconds);
  }
  if (values.timeout !== undefined) throw new InputError('--timeout is supported by the OMP executor only');
  const model = values.model ? ['--model', values.model] : [];
  const bound = values.session && values.run ? [
    '-c', 'mcp_servers.evolve_run.command=' + JSON.stringify(process.execPath),
    '-c', 'mcp_servers.evolve_run.args=' + JSON.stringify([fileURLToPath(new URL('./workflow-cli.js', import.meta.url)), 'mcp', '--root', root,
      '--session', workflowId(values.session, 'Session ID'), '--run', workflowId(values.run, 'Run ID')]),
    '-c', 'mcp_servers.evolve_run.required=true',
    '-c', 'mcp_servers.evolve_run.default_tools_approval_mode="writes"',
  ] : [];
  if (bound.length && tool !== 'codex') throw new InputError('Use Codex or OMP for a bound Evolve worker');
  const childArgs = tool === 'codex'
    ? ['-a', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '--sandbox', mode === 'analysis' ? 'read-only' : 'workspace-write', ...model, ...bound, '-']
    : ['--mode', mode === 'analysis' ? 'plan' : 'accept-edits', '--output-format', 'text', ...model, '--print=' + prompt];
  const resolved = commandFor(tool, childArgs);
  const child = spawnSync(resolved.command, resolved.args, { cwd, input: tool === 'codex' ? prompt : undefined, encoding: 'utf8',
    shell: resolved.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new InputError(tool + ' exited with status ' + child.status);
  return { executor: tool, output: child.stdout };
}
