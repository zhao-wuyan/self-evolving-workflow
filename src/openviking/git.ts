import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputError } from '../common.js';
import { workflowHead, workflowPath } from '../workflow-skills.js';
import { assetPath, sha256 } from './assets.js';
import type { AssetFile } from './types.js';

export function gitBytes(root: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv) {
  return execFileSync('git', args, { cwd: root, input, env: env ?? process.env, windowsHide: true,
    maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function gitText(root: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv) {
  return gitBytes(root, args, input, env).toString('utf8').trimEnd();
}
export function skillAssets(root: string, commit: string) {
  const files: AssetFile[] = [];
  const bytes = new Map<string, Buffer>();
  for (const record of gitBytes(root, ['ls-tree', '-r', '-z', commit, '--', 'skills/']).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(record);
    if (!match) throw new InputError('OPENVIKING_UNSUPPORTED_GIT_MODE');
    const path = assetPath(match[3]);
    const body = gitBytes(root, ['cat-file', 'blob', match[2]]);
    files.push({ path, mode: match[1] as AssetFile['mode'], size: body.length, sha256: sha256(body) });
    bytes.set(path, body);
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, bytes };
}
export function assertCleanIndex(root: string) {
  if (gitText(root, ['diff', '--cached', '--name-only'])) throw new InputError('OPENVIKING_STAGED_CHANGES');
  gitText(root, ['var', 'GIT_AUTHOR_IDENT']);
  gitText(root, ['var', 'GIT_COMMITTER_IDENT']);
}
export function assertManagedClean(root: string, paths: string[] = ['skills/']) {
  assertCleanIndex(root);
  if (paths.length && gitText(root, ['status', '--porcelain', '--untracked-files=all', '--', ...paths])) {
    throw new InputError('OPENVIKING_MANAGED_DIRTY');
  }
}
export function createAssetCommit(root: string, base: string, files: AssetFile[], bytes: ReadonlyMap<string, Buffer>, removed: string[], message: string) {
  const temporary = mkdtempSync(join(tmpdir(), 'evolve-assets-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
  try {
    gitBytes(root, ['read-tree', base], undefined, env);
    for (const path of removed) gitBytes(root, ['update-index', '--force-remove', '--', workflowPath(path)], undefined, env);
    for (const file of files) {
      workflowPath(file.path);
      const body = bytes.get(file.path);
      if (!body || body.length !== file.size || sha256(body) !== file.sha256) throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
      const hash = gitText(root, ['hash-object', '-w', '--stdin'], body);
      gitBytes(root, ['update-index', '--add', '--cacheinfo', `${file.mode},${hash},${file.path}`], undefined, env);
    }
    const tree = gitText(root, ['write-tree'], undefined, env);
    if (tree === gitText(root, ['rev-parse', base + '^{tree}'])) return base;
    return gitText(root, ['commit-tree', tree, '-p', base, '-m', message]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function applyAssetCommit(root: string, base: string, candidate: string) {
  assertManagedClean(root);
  if (workflowHead(root) === candidate) return candidate;
  if (workflowHead(root) !== base) throw new InputError('OPENVIKING_LOCAL_ADVANCED');
  gitBytes(root, ['merge', '--ff-only', candidate]);
  return candidate;
}
