import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { InputError } from './common.js';
import { WorkflowStore, workflowId } from './workflow-runtime.js';
import type { OmpWorkerRequest } from './omp-worker.js';

interface OmpDelegateOptions {
  model?: string; role?: string; session?: string; run?: string; timeout?: string;
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

function commandFor(childArgs: string[]) {
  const raw = process.env.OMP_EXECUTABLE ?? (process.platform === 'win32' ? findWindowsCommand('omp') : 'omp');
  if (/\.[cm]?js$/i.test(raw)) return { command: process.execPath, args: [resolve(raw), ...childArgs], shell: false };
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(raw)) {
    if (existsSync(raw)) {
      const match = /%~?dp0[\\/]([^"\r\n]+\.[cm]?js)/i.exec(readFileSync(raw, 'utf8'));
      if (match) {
        const script = resolve(dirname(raw), match[1]);
        if (existsSync(script)) return { command: process.execPath, args: [script, ...childArgs], shell: false };
      }
    }
    throw new InputError('Use omp.exe or set OMP_EXECUTABLE to the OMP JavaScript entry point');
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

async function runOmp(cwd: string, request: OmpWorkerRequest, timeoutMs: number) {
  const stage = mkdtempSync(join(tmpdir(), 'evolve-omp-'));
  // 启动器不发现环境 MCP/扩展；真正的 worker 由 SDK 再施加严格工具限制。
  const overlay = join(stage, 'bootstrap.yml');
  writeFileSync(overlay, JSON.stringify({
    disabledProviders: ['native', 'skillshare', 'omp-plugins', 'claude', 'claude-plugins', 'codex', 'gemini',
      'opencode', 'cursor', 'windsurf', 'vscode', 'mcp-json', 'agent-plugins'],
    mcp: { enableProjectConfig: false },
  }));
  const worker = fileURLToPath(new URL('./omp-worker.js', import.meta.url));
  const resolved = commandFor(['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-lsp',
    '--no-skills', '--no-rules', '--no-context-files', '--no-title', '--model', request.model, '--config', overlay, '--trusted-extension', worker]);
  let abortReason: Error | undefined;
  let killing: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  const cancel = (reason: Error) => {
    abortReason ??= reason;
    if (child && !killing) killing = stopWorker(child);
  };
  const interrupt = () => cancel(new InputError('OMP delegate cancelled'));
  const timer = setTimeout(() => cancel(new InputError(`OMP delegate timed out after ${timeoutMs} ms`)), timeoutMs);
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

export async function delegateOmp(root: string, cwd: string, prompt: string, mode: OmpWorkerRequest['mode'], values: OmpDelegateOptions) {
  if ((values.session === undefined) !== (values.run === undefined)) throw new InputError('Supply both Session and Run identifiers');
  const timeoutMs = values.timeout === undefined ? 600_000 : Number(values.timeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new InputError('OMP timeout must be a positive integer in milliseconds');
  const role = values.role ?? (mode === 'analysis' ? 'plan' : 'task');
  if (!/^[a-z][a-z0-9_-]*$/i.test(role)) throw new InputError('Invalid OMP model role');
  let binding: OmpWorkerRequest['binding'];
  if (values.session !== undefined && values.run !== undefined) {
    const session = workflowId(values.session, 'Session ID');
    const run = workflowId(values.run, 'Run ID');
    const store = new WorkflowStore(root);
    try {
      if (store.brief(session, run).status !== 'running') throw new InputError('Select a running Evolve Run');
    } finally { store.close(); }
    binding = { root, session, run };
  }
  return runOmp(cwd, { request_id: randomUUID(), prompt, cwd, mode, model: values.model ?? '@' + role, binding }, timeoutMs);
}
