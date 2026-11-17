import { spawn, execFile } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from './common.js';

const commands: Record<string, true> = { session: true, run: true, team: true, skills: true, install: true, workflows: true, capabilities: true, '--help': true };

export async function runBundledWorkflow(root: string, argv: unknown, signal?: AbortSignal) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !Object.hasOwn(commands, argv[0])) {
    throw new InputError('Supply a workflow control argv array (session/run/team/skills/install/workflows/capabilities/--help)');
  }
  if (argv.some(arg => arg === '--root' || arg.startsWith('--root='))) throw new InputError('The project root is fixed by the OMP context');
  signal?.throwIfAborted();
  // OMP 的 process.execPath 是 omp.exe；只依赖 Node，不依赖全局 evolve。
  const node = /^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'node';
  const cli = fileURLToPath(new URL('./workflow-cli.js', import.meta.url));
  const child = spawn(node, [cli, ...argv, '--root', root], {
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
