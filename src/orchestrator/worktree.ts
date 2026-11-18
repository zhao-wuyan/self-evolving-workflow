import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evolvePath, InputError } from '../common.js';
import { agentIdentifier, type WorktreeInfo, type WorktreeSpec } from './types.js';

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

export interface WorktreeStatus {
  path: string;
  dirty: boolean;
  files: string[];
  diffStat: string;
}

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim()
      : '';
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new InputError(`Git worktree command failed (${args.join(' ')}): ${message}`);
  }
}

function normalizePath(target: string): string {
  const resolved = resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function samePath(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function validateBranchName(branch: string): string {
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith('-') || trimmed.includes('..') || /[\s~^:?*[\\]/.test(trimmed)) {
    throw new InputError(`Invalid Git branch name: ${branch}`);
  }
  return trimmed;
}

export class WorktreeManager {
  resolveRepoRoot(cwd: string): string {
    return normalizePath(runGit(['rev-parse', '--show-toplevel'], cwd));
  }

  create(cwd: string, spec: WorktreeSpec = {}): WorktreeInfo {
    const repoRoot = this.resolveRepoRoot(cwd);
    const id = spec.name ? agentIdentifier(spec.name, 'worktree name') : `wt-${randomUUID().slice(0, 8)}`;
    const branch = validateBranchName(spec.branch ?? `evolve-agent/${id}`);
    const rootDir = resolve(repoRoot, spec.rootDir ?? evolvePath(repoRoot, 'worktrees'));
    mkdirSync(rootDir, { recursive: true });
    const targetPath = resolve(rootDir, id);

    if (existsSync(targetPath)) {
      throw new InputError(`Worktree directory already exists: ${targetPath}`);
    }

    const baseRef = spec.baseRef?.trim() || 'HEAD';
    const branchExists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: 'ignore',
    }).status === 0;

    if (branchExists) {
      if (!spec.reuseBranch) {
        throw new InputError(`Worktree branch already exists: ${branch}`);
      }
      runGit(['worktree', 'add', targetPath, branch], repoRoot);
    } else {
      runGit(['worktree', 'add', '-b', branch, targetPath, baseRef], repoRoot);
    }

    if (spec.setupCommand?.trim()) {
      const setup = spawnSync(spec.setupCommand, {
        cwd: targetPath,
        shell: true,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (setup.status !== 0) {
        try {
          this.remove(targetPath, { force: true, deleteBranch: !branchExists });
        } catch {
          // 尽量清理失败的 worktree
        }
        const detail = (setup.stderr || setup.stdout || '').trim();
        throw new InputError(`Worktree setup command failed: ${detail || `exit ${setup.status}`}`);
      }
    }

    return {
      id,
      path: normalizePath(targetPath),
      branch,
      repoRoot,
      created: true,
    };
  }

  list(cwd: string): GitWorktreeEntry[] {
    const repoRoot = this.resolveRepoRoot(cwd);
    const raw = runGit(['worktree', 'list', '--porcelain'], repoRoot);
    if (!raw) return [];
    const entries: GitWorktreeEntry[] = [];
    let current: Partial<GitWorktreeEntry> | undefined;

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        if (current?.path) {
          entries.push({ path: normalizePath(current.path), head: current.head ?? '', ...current });
        }
        current = undefined;
        continue;
      }
      if (line.startsWith('worktree ')) {
        current = { path: normalizePath(line.slice('worktree '.length).trim()) };
      } else if (current && line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      } else if (current && line === 'bare') {
        current.bare = true;
      } else if (current && line === 'detached') {
        current.detached = true;
      }
    }
    if (current?.path) {
      entries.push({ path: normalizePath(current.path), head: current.head ?? '', ...current });
    }
    return entries;
  }

  status(worktreePath: string): WorktreeStatus {
    const normalized = normalizePath(worktreePath);
    const porcelain = runGit(['status', '--porcelain'], normalized);
    const files = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
    const diffStat = runGit(['diff', '--stat'], normalized);
    return {
      path: normalized,
      dirty: files.length > 0,
      files,
      diffStat,
    };
  }

  remove(worktreePath: string, options: { force?: boolean; deleteBranch?: boolean; repoRoot?: string } = {}): { removed: boolean; branchDeleted?: string } {
    const normalized = normalizePath(worktreePath);
    const repoRoot = options.repoRoot
      ? normalizePath(options.repoRoot)
      : this.resolveRepoRoot(existsSync(normalized) ? normalized : process.cwd());
    const entries = this.list(repoRoot);
    const entry = entries.find(item => samePath(item.path, normalized));
    if (!entry) {
      return { removed: false };
    }
    if (samePath(entry.path, repoRoot)) {
      throw new InputError('Refusing to remove the main repository worktree');
    }
    const args = ['worktree', 'remove'];
    if (options.force) args.push('--force');
    args.push(entry.path);
    runGit(args, repoRoot);

    let branchDeleted: string | undefined;
    if (options.deleteBranch && entry.branch) {
      runGit(['branch', options.force ? '-D' : '-d', entry.branch], repoRoot);
      branchDeleted = entry.branch;
    }
    return { removed: true, branchDeleted };
  }
}
