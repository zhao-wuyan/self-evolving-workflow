import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

export interface ResolvedCliCommand {
  command: string;
  args: string[];
  shell: boolean;
  rawExecutable: string;
}

export interface StreamingExecOptions {
  cwd: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBufferBytes?: number;
  inheritStderr?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface StreamingExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  interrupted: boolean;
  timedOut: boolean;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export function findCommandInPath(name: string, envPath = process.env.PATH ?? ''): string | undefined {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return existsSync(name) ? name : undefined;
  }
  const dirs = envPath.split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name.endsWith(ext) ? name : name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveExecutablePath(name: string, envVar?: string, env: Record<string, string | undefined> = process.env): string {
  const override = envVar ? env[envVar] : undefined;
  if (override && override.trim()) return override.trim();
  const found = findCommandInPath(name, env.PATH ?? '');
  if (found) return found;
  return process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(name) ? `${name}.exe` : name;
}

export function isCliAvailable(name: string, envVar?: string, env: Record<string, string | undefined> = process.env): boolean {
  const override = envVar ? env[envVar] : undefined;
  if (override && override.trim()) {
    return Boolean(findCommandInPath(override.trim(), env.PATH ?? ''));
  }
  return Boolean(findCommandInPath(name, env.PATH ?? ''));
}

export function resolveCliCommand(
  executable: string,
  childArgs: string[],
  options?: { envVar?: string; env?: Record<string, string | undefined> },
): ResolvedCliCommand {
  const raw = resolveExecutablePath(executable, options?.envVar, options?.env);
  if (/\.[cm]?js$/i.test(raw)) {
    return { command: process.execPath, args: [resolve(raw), ...childArgs], shell: false, rawExecutable: raw };
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(raw)) {
    if (existsSync(raw)) {
      const shim = readFileSync(raw, 'utf8');
      const match = /%~?dp0[\\/]([^"\r\n]+\.[cm]?js)/i.exec(shim);
      if (match) {
        const script = resolve(dirname(raw), match[1]);
        if (existsSync(script)) {
          return { command: process.execPath, args: [script, ...childArgs], shell: false, rawExecutable: raw };
        }
      }
    }
    return {
      command: `"${raw}"`,
      args: childArgs.map(arg => `"${arg.replaceAll('"', '\\"')}"`),
      shell: true,
      rawExecutable: raw,
    };
  }
  return { command: raw, args: childArgs, shell: false, rawExecutable: raw };
}

function terminateChildProcess(pid: number | undefined, child: ReturnType<typeof spawn>): void {
  if (!pid) {
    child.kill('SIGTERM');
    return;
  }
  if (process.platform === 'win32') {
    // Windows 下若子进程通过 cmd/shim 启动，使用 taskkill /T 确保整棵子进程树退出。
    const killer = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (killer.status !== 0) {
      try {
        child.kill();
      } catch {
        // 进程可能已先一步退出
      }
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // 忽略已退出进程
  }
}

export function spawnStreamingCommand(
  resolved: ResolvedCliCommand,
  options: StreamingExecOptions,
): Promise<StreamingExecResult> {
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: resolved.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutPartial = '';
    let stderrPartial = '';
    let interrupted = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };

    const stopProcess = () => {
      terminateChildProcess(child.pid, child);
      if (process.platform !== 'win32') {
        forceKillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // 忽略已退出进程
          }
        }, 1500);
        forceKillTimer.unref();
      }
    };

    const onAbort = () => {
      interrupted = true;
      stopProcess();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        interrupted = true;
        stopProcess();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stopProcess();
      }, options.timeoutMs);
      timeoutTimer.unref();
    }

    const flushLines = (chunkText: string, partial: string, emit?: (line: string) => void): string => {
      const combined = partial + chunkText;
      const lines = combined.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      if (emit) {
        for (const line of lines) emit(line);
      }
      return remainder;
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(text) > maxBuffer) {
        cleanup();
        stopProcess();
        if (!settled) {
          settled = true;
          rejectPromise(new Error(`Process stdout exceeded ${maxBuffer} bytes`));
        }
        return;
      }
      stdout += text;
      stdoutPartial = flushLines(text, stdoutPartial, options.onStdoutLine);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (options.inheritStderr) process.stderr.write(text);
      if (Buffer.byteLength(stderr) + Buffer.byteLength(text) <= maxBuffer) {
        stderr += text;
      }
      stderrPartial = flushLines(text, stderrPartial, options.onStderrLine);
    });

    child.on('error', error => {
      cleanup();
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });

    child.on('close', (exitCode, signal) => {
      cleanup();
      if (stdoutPartial && options.onStdoutLine) options.onStdoutLine(stdoutPartial);
      if (stderrPartial && options.onStderrLine) options.onStderrLine(stderrPartial);
      if (!settled) {
        settled = true;
        resolvePromise({ stdout, stderr, exitCode, signal, interrupted, timedOut });
      }
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
