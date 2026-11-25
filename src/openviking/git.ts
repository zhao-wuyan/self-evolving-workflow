import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputError } from '../common.js';
import { isProjectSkillPath, projectSkillRoots, workflowHead, workflowPath } from '../workflow-skills.js';
import { assetPath, sha256 } from './assets.js';
import type { AssetFile } from './types.js';

const ZERO_OID = '0'.repeat(40);

export function gitBytes(root: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv) {
  return execFileSync('git', args, { cwd: root, input, env: env ?? process.env, windowsHide: true,
    maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function gitText(root: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv) {
  return gitBytes(root, args, input, env).toString('utf8').trimEnd();
}
function readBlobsBatch(root: string, oids: string[]): Buffer[] {
  if (!oids.length) return [];
  const raw = gitBytes(root, ['cat-file', '--batch'], oids.join('\n') + '\n');
  const results: Buffer[] = [];
  let offset = 0;
  for (const oid of oids) {
    const nl = raw.indexOf(0x0a, offset);
    if (nl < 0) throw new InputError('OPENVIKING_GIT_BATCH_EOF: ' + oid);
    const header = raw.subarray(offset, nl).toString('utf8');
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header);
    if (!match) throw new InputError('OPENVIKING_GIT_BLOB_MISSING: ' + header);
    const size = Number(match[1]);
    const start = nl + 1;
    const end = start + size;
    if (end > raw.length) throw new InputError('OPENVIKING_GIT_BATCH_TRUNCATED: ' + oid);
    results.push(Buffer.from(raw.subarray(start, end)));
    offset = end + 1;
  }
  return results;
}
export function skillAssets(root: string, commit: string) {
  const files: AssetFile[] = [];
  const bytes = new Map<string, Buffer>();
  const roots = projectSkillRoots.map(skillRoot => skillRoot + '/');
  const entries: Array<{ path: string; mode: AssetFile['mode']; oid: string }> = [];
  for (const record of gitBytes(root, ['ls-tree', '-r', '-z', commit, '--', ...roots]).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(record);
    if (!match) throw new InputError('OPENVIKING_UNSUPPORTED_GIT_MODE');
    const path = assetPath(match[3]);
    if (!isProjectSkillPath(path)) throw new InputError('OPENVIKING_INVALID_ASSET_PATH');
    entries.push({ path, mode: match[1] as AssetFile['mode'], oid: match[2] });
  }
  const bodies = readBlobsBatch(root, entries.map(entry => entry.oid));
  for (let i = 0; i < entries.length; i++) {
    const { path, mode } = entries[i];
    const body = bodies[i];
    files.push({ path, mode, size: body.length, sha256: sha256(body) });
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
export function assertManagedClean(root: string, paths: string[] = projectSkillRoots.map(skillRoot => skillRoot + '/')) {
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
    const indexInfo: string[] = [];
    for (const path of removed) {
      indexInfo.push(`0 ${ZERO_OID}\t${workflowPath(path)}\0`);
    }
    if (files.length) {
      const stagedPaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        workflowPath(file.path);
        const body = bytes.get(file.path);
        if (!body || body.length !== file.size || sha256(body) !== file.sha256) throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
        const tempFile = join(temporary, `b-${i}`);
        writeFileSync(tempFile, body);
        stagedPaths.push(tempFile.replace(/\\/g, '/'));
      }
      const hashes = gitText(root, ['hash-object', '-w', '--no-filters', '--stdin-paths'], stagedPaths.join('\n') + '\n')
        .split(/\r?\n/).filter(Boolean);
      if (hashes.length !== files.length) throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
      for (let i = 0; i < files.length; i++) {
        indexInfo.push(`${files[i].mode} ${hashes[i]}\t${files[i].path}\0`);
      }
    }
    if (indexInfo.length) {
      gitBytes(root, ['update-index', '-z', '--index-info'], indexInfo.join(''), env);
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
