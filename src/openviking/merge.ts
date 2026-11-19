import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from '../common.js';
import { fileRecord } from './knowledge.js';
import { isProjectSkillPath } from '../workflow-skills.js';
import { sha256, stableJson } from './assets.js';
import type { AssetFile, ProjectManifest } from './types.js';

function choose<T>(base: T | undefined, ours: T | undefined, theirs: T | undefined): { resolved: boolean; value: T | undefined } {
  if (stableJson(ours) === stableJson(base)) return { resolved: true, value: theirs };
  if (stableJson(theirs) === stableJson(base) || stableJson(ours) === stableJson(theirs)) return { resolved: true, value: ours };
  return { resolved: false, value: undefined };
}
export function mergeProjectAssets(base: ProjectManifest, ours: ProjectManifest, theirs: ProjectManifest,
  baseBytes: ReadonlyMap<string, Buffer>, ourBytes: ReadonlyMap<string, Buffer>, theirBytes: ReadonlyMap<string, Buffer>, directory: string) {
  mkdirSync(directory, { recursive: true });
  const maps = [base, ours, theirs].map(manifest => new Map(manifest.files.map(file => [file.path, file])));
  const files: AssetFile[] = [];
  const bytes = new Map<string, Buffer>();
  const conflicts: string[] = [];
  for (const path of [...new Set([...maps[0].keys(), ...maps[1].keys(), ...maps[2].keys()])].sort()) {
    const [b, o, t] = maps.map(map => map.get(path));
    const picked = choose(b, o, t);
    if (picked.resolved) {
      if (picked.value) {
        files.push(picked.value);
        bytes.set(path, (picked.value === t ? theirBytes : ourBytes).get(path)!);
      }
      continue;
    }
    if (!isProjectSkillPath(path) || !b || !o || !t) { conflicts.push(path); continue; }
    const mode = choose(b.mode, o.mode, t.mode);
    if (!mode.resolved) { conflicts.push(path); continue; }
    const bodies = [baseBytes.get(path)!, ourBytes.get(path)!, theirBytes.get(path)!];
    let text = true;
    try { for (const body of bodies) { new TextDecoder('utf-8', { fatal: true }).decode(body); if (body.includes(0)) text = false; } }
    catch { text = false; }
    if (!text) { conflicts.push(path); continue; }
    const token = sha256(path);
    const paths = ['base', 'ours', 'theirs'].map((label, index) => {
      const file = join(directory, token + '-' + label); writeFileSync(file, bodies[index]); return file;
    });
    const result = spawnSync('git', ['merge-file', '--stdout', paths[1], paths[0], paths[2]], { windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
    if (result.error) throw result.error;
    writeFileSync(join(directory, token + '-result'), result.stdout);
    if (result.status !== 0) { conflicts.push(path); continue; }
    files.push(fileRecord(path, result.stdout, mode.value)); bytes.set(path, result.stdout);
  }
  const mergeRecords = <T>(base: T[], ours: T[], theirs: T[], key: (item: T) => string) => {
    const maps = [base, ours, theirs].map(items => new Map(items.map(item => [key(item), item])));
    const result: T[] = [];
    for (const id of new Set([...maps[0].keys(), ...maps[1].keys(), ...maps[2].keys()])) {
      const picked = choose(maps[0].get(id), maps[1].get(id), maps[2].get(id));
      if (!picked.resolved) conflicts.push(id);
      else if (picked.value) result.push(picked.value);
    }
    return result;
  };
  const wiki = mergeRecords(base.wiki, ours.wiki, theirs.wiki, item => item.entry);
  const memory = mergeRecords(base.memory, ours.memory, theirs.memory, item => item.origin_id);
  if (conflicts.length) {
    writeFileSync(join(directory, 'conflicts.json'), JSON.stringify({ conflicts, base, ours, theirs }, null, 2));
    throw new InputError('OPENVIKING_MERGE_CONFLICT: ' + conflicts.join(', '));
  }
  return { manifest: { ...ours, files, wiki, memory }, bytes };
}
