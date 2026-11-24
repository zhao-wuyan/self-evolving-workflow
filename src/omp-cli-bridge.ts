import { spawn, execFile } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from './common.js';

const commands: Record<string, true> = { session: true, run: true, skill: true, experience: true, openviking: true, kb: true, code: true, history: true };
const skillActions: Record<string, true> = { list: true, install: true, sync: true, status: true, validate: true, inspect: true, workflows: true };
const codeActions: Record<string, true> = { build: true, sync: true, search: true, graph: true, callers: true, callees: true, trace: true };
const historyActions: Record<string, true> = { collect: true, list: true, search: true, show: true };

function hasOnlyEpisodicKind(argv: string[]): boolean {
  const kinds: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--kind') {
      const next = argv[++i];
      if (next === undefined) return false;
      kinds.push(next);
    } else if (arg.startsWith('--kind=')) {
      kinds.push(arg.slice('--kind='.length));
    }
  }
  return kinds.length > 0 && kinds.every(kind => kind === 'episodic');
}

export async function runBundledWorkflow(root: string, argv: unknown, signal?: AbortSignal, agentKind?: 'main' | 'sub') {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      !(Object.hasOwn(commands, argv[0]) || argv.length === 1 && argv[0] === '--help')) {
    throw new InputError('Supply a workflow control argv array (session/run/skill/code/history/kb/experience/openviking/--help)');
  }
  if (argv[0] === 'skill' && !Object.hasOwn(skillActions, argv[1] ?? 'list')) {
    throw new InputError('OMP supports Skill list/install/sync/status/validate/inspect/workflows');
  }
  if (argv[0] === 'code' && !Object.hasOwn(codeActions, argv[1] ?? '')) {
    throw new InputError('OMP supports Code Graph build/sync/search/graph/callers/callees/trace');
  }
  if (argv[0] === 'history' && !Object.hasOwn(historyActions, argv[1] ?? '')) {
    throw new InputError('OMP supports history collect/list/search/show');
  }
  if (argv[0] === 'experience' && !['status', 'search', 'get'].includes(argv[1])) {
    throw new InputError('OMP may only read personal experience (status/search/get)');
  }
  if (argv[0] === 'kb') {
    const isHarvest = argv[1] === 'harvest' && ['session', 'receipt', 'conversation', 'skill'].includes(argv[2]);
    const isCandidatesShow = argv[1] === 'candidates' && argv[2] === 'show';
    const isReadOnlyKb = argv[1] === 'sources' || argv[1] === 'lint';
    const isReminders = argv[1] === 'reminders' && (argv[2] === undefined || argv[2] === 'ack' || argv[2].startsWith('-'));
    const isEpisodicWrite = (argv[1] === 'add' || argv[1] === 'update') && hasOnlyEpisodicKind(argv);
    if (argv[1] === 'add' || argv[1] === 'update') {
      if (!isEpisodicWrite) {
        throw new InputError('OMP kb add/update requires --kind episodic; Wiki publication requires explicit approval');
      }
    } else if (!isHarvest && !isCandidatesShow && !isReadOnlyKb && !isReminders) {
      throw new InputError('OMP knowledge closeout supports harvest, candidates show, sources, lint, reminders, and episodic add/update only; publication requires explicit approval');
    }
  }
  if (argv[0] === 'openviking' && argv[1] !== 'policy') throw new InputError('OMP Agent may only manage OpenViking policy');
  if (argv[0] === 'openviking' && argv.slice(2).some(arg => !/^(?:--(?:entry|runner|scenarios|apply)(?:=|$))/.test(arg) && arg.startsWith('-'))) {
    throw new InputError('Invalid OpenViking policy option');
  }
  if (argv.some(arg => arg === '--root' || arg.startsWith('--root='))) throw new InputError('The project root is fixed by the OMP context');
  signal?.throwIfAborted();
  // OMP 的 process.execPath 是 omp.exe；只依赖 Node，不依赖全局 evolve。
  const node = /^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'node';
  const cli = fileURLToPath(new URL('./workflow-cli.js', import.meta.url));
  const child = spawn(node, [cli, '--root', root, ...argv], {
    env: { ...process.env, EVOLVE_OMP_AGENT_KIND: agentKind ?? 'main',
      ...(/^omp(?:\.exe)?$/i.test(basename(process.execPath)) && !process.env.OMP_EXECUTABLE ? { OMP_EXECUTABLE: process.execPath } : {}) },
    cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let stopped: Promise<void> | undefined;
  const stop = () => {
    if (!child.pid || stopped) return;
    const pid = child.pid;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    stopped = promise;
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && child.exitCode === null) reject(error); else resolve();
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); resolve(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') resolve(); else reject(error); }
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    const exited = Promise.withResolvers<number | null>();
    child.once('error', exited.reject);
    child.once('close', exited.resolve);
    const exit_code = await exited.promise;
    if (stopped) await stopped;
    signal?.throwIfAborted();
    return { exit_code, stdout, stderr };
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
