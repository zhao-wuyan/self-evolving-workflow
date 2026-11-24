import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseDocument } from 'yaml';
import { InputError, requireText } from './common.js';
import { isWikiCategory, type WikiCategory } from './wiki-entry.js';
import { historicalWorkflowName, odysseyModes, orchestrationSteps, workflowName } from './workflow-names.js';

export interface ArtifactType {
  kind: string;
  schema: string;
  role: string;
  alias?: string;
}
export interface OutputSlot extends ArtifactType {
  path: string;
  required?: boolean;
}
export interface InputSlot extends ArtifactType {
  required?: boolean;
  accepts_negative_evidence?: boolean;
}
export interface WorkflowSkill {
  skill_id: string;
  commit: string;
  tree: string;
  package_path: string;
  entry: string;
  required_links: string[];
  consumes: InputSlot[];
  produces: OutputSlot[];
  gates: { entry: string[]; exit: string[] };
  wiki_categories?: WikiCategory[];
  search_profile?: { wiki?: string[]; memory?: string[] };
}

const internal = new Set(orchestrationSteps.map(workflowName));
const odyssey = new Map(odysseyModes.map(mode => ['ew-odyssey-' + mode, mode]));
export const commandNames = [
  ...internal, ...odyssey.keys(), 'ew-swarm', 'ew-impeccable',
];

export function workflowHash(bytes: Buffer | string) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function git(root: string, ...args: string[]) {
  try {
    return execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new InputError('Git could not read the workflow revision or path: ' + args.slice(1).join(' '), { cause: error });
  }
}

export function workflowHead(root: string) {
  return git(root, 'rev-parse', 'HEAD^{commit}').toString().trim();
}

export function workflowPath(value: string, extension?: string) {
  if (!value || /[\\:\u0000-\u001f*?[\]]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') ||
      (extension && !value.toLowerCase().endsWith(extension))) {
    throw new InputError('Invalid workflow path: ' + value);
  }
  return value;
}

function findTreeMember(root: string, commit: string, path: string) {
  workflowPath(path);
  const record = git(root, 'ls-tree', '-z', commit, '--', path).toString();
  if (!record) return;
  const match = /^(100644|100755|040000) (blob|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(record);
  if (!match || match[4] !== path) throw new InputError('Workflow path is unavailable or is not a regular entry: ' + path);
  return { type: match[2], object: match[3] };
}

function treeMember(root: string, commit: string, path: string) {
  const member = findTreeMember(root, commit, path);
  if (!member) throw new InputError('Workflow path is unavailable: ' + path);
  return member;
}

export function workflowBlob(root: string, commit: string, path: string) {
  const member = treeMember(root, commit, path);
  if (member.type !== 'blob') throw new InputError('Expected a regular workflow file: ' + path);
  return git(root, 'cat-file', 'blob', member.object);
}

export function workflowHeader(text: string): Record<string, unknown> {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''));
  if (!header) return {};
  const doc = parseDocument(header[1], { strict: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const detail = doc.errors[0].message.split('\n')[0];
    throw new InputError(`Invalid YAML frontmatter: ${detail}`, { cause: doc.errors[0] });
  }
  return workflowRecord(doc.toJS(), 'YAML frontmatter');
}

export function workflowRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid ' + label);
  return value as Record<string, unknown>;
}

export function workflowStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new InputError(label + ' must be an array');
  return value.map(item => requireText(item, label));
}

export function workflowMeta(value: unknown): ArtifactType {
  const item = workflowRecord(value, 'artifact metadata');
  return {
    kind: requireText(item.kind, 'artifact kind'), schema: requireText(item.schema, 'artifact schema'),
    role: requireText(item.role, 'artifact role'),
    ...(item.alias === undefined ? {} : { alias: requireText(item.alias, 'artifact alias') }),
  };
}

function linkPath(from: string, destination: string) {
  const path = decodeURI(destination.split('#', 1)[0]);
  if (!path || path.startsWith('/') || /[\\:]/.test(path)) throw new InputError('Use a package-relative Markdown link');
  return workflowPath(posix.join(posix.dirname(from), path), '.md');
}

export function readWorkflowMarkdown(root: string, skill: WorkflowSkill, path: string) {
  const bytes = workflowBlob(root, skill.commit, skill.package_path + '/' + workflowPath(path, '.md'));
  return { path, markdown: bytes.toString('utf8'), sha256: workflowHash(bytes) };
}

export function readWorkflowLink(root: string, skill: WorkflowSkill, from: string, destination: string) {
  const source = readWorkflowMarkdown(root, skill, from);
  const links = [...source.markdown.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/g)]
    .map(match => match[1].replace(/^<|>$/g, ''));
  if (!links.includes(destination)) throw new InputError('Select a declared Markdown link from ' + from);
  return readWorkflowMarkdown(root, skill, linkPath(from, destination));
}

// OMP 的原生项目目录优先于通用根目录，与各宿主 Skill 安装位置保持一致。
export const projectSkillRoots = [
  '.omp/skills',
  'skills',
  '.agents/skills',
  '.codex/skills',
  '.claude/skills',
  '.agents/plugins/self-evolving-workflow/skills',
  '.codex/plugins/self-evolving-workflow/skills',
  '.claude/plugins/self-evolving-workflow/skills',
] as const;

export function isProjectSkillPath(path: string) {
  return projectSkillRoots.some(skillRoot => path.startsWith(skillRoot + '/'));
}

export function isProjectSkillEntry(path: string) {
  return projectSkillRoots.some(skillRoot => {
    const prefix = skillRoot + '/';
    if (!path.startsWith(prefix) || !path.endsWith('/SKILL.md')) return false;
    const packagePath = path.slice(prefix.length, -'/SKILL.md'.length);
    return packagePath.length > 0 && !packagePath.startsWith('/');
  });
}

export function projectSkillPackageKey(path: string) {
  for (const skillRoot of projectSkillRoots) {
    const prefix = skillRoot + '/';
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length).split('/')[0];
    return name ? `${skillRoot}/${name}` : undefined;
  }
  return undefined;
}

export function findProjectSkillAsset(files: readonly { path: string }[], packageName: string, relativePath: string) {
  const suffix = '/' + packageName + '/' + relativePath;
  for (const skillRoot of projectSkillRoots) {
    const path = skillRoot + suffix;
    if (files.some(file => file.path === path)) return path;
  }
  return undefined;
}

export function findWorkflowPackageTree(
  root: string,
  commit: string,
  packageName: string,
  isStep: boolean,
  legacy = false,
) {
  const suffix = isStep
    ? (legacy ? 'maestro/steps/' : 'ew-orchestrate/steps/') + packageName
    : packageName;
  for (const skillRoot of projectSkillRoots) {
    const packagePath = `${skillRoot}/${suffix}`;
    const tree = findTreeMember(root, commit, packagePath);
    if (tree?.type === 'tree') return { packagePath, tree };
  }
  return undefined;
}

function parseProfileTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()))];
    return items.length ? items : undefined;
  }
  if (typeof value === 'string' && value.trim() && value.trim() !== 'optional') {
    return [value.trim()];
  }
  return undefined;
}

export function bindWorkflowSkill(root: string, command: string, commit = workflowHead(root)): WorkflowSkill {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new InputError('Invalid Skill command or Git commit');
  }
  const name = workflowName(command);
  const mode = odyssey.get(name);
  const expectedId = mode ? 'ew-odyssey' : name;
  const isStep = internal.has(name);
  let matched = findWorkflowPackageTree(root, commit, isStep ? name : expectedId, isStep);
  const oldName = historicalWorkflowName(expectedId);
  if (!matched && oldName) {
    matched = findWorkflowPackageTree(root, commit, oldName, isStep, true);
  }
  if (!matched) {
    const fallbackPath = isStep ? 'skills/ew-orchestrate/steps/' + name : 'skills/' + expectedId;
    throw new InputError('Workflow package is unavailable: ' + fallbackPath);
  }
  const { packagePath, tree } = matched;
  const entry = 'SKILL.md';
  const header = workflowHeader(workflowBlob(root, commit, packagePath + '/' + entry).toString('utf8'));
  const skillId = requireText(header.name, 'Skill name');
  if (workflowName(skillId) !== expectedId) throw new InputError('Skill name does not match ' + name);
  const preparation = mode ? 'references/prepare/odyssey-' + mode + '.md' : undefined;
  const modeHeader = preparation ? workflowHeader(workflowBlob(root, commit, packagePath + '/' + preparation).toString('utf8')) : undefined;
  const contract = workflowRecord(modeHeader?.contract ?? header.contract ?? {}, 'Skill contract');
  const links = preparation ? [preparation, ...workflowStrings(modeHeader?.required_links ?? [], 'required_links')]
    : workflowStrings(header.required_links ?? [], 'required_links');
  const gates = workflowRecord(contract.gates ?? {}, 'Skill gates');
  const consumes = Array.isArray(contract.consumes) ? contract.consumes.map(value => ({
    ...workflowMeta(value), required: value.required === true, accepts_negative_evidence: value.accepts_negative_evidence === true,
  })) : [];
  const produces = Array.isArray(contract.produces) ? contract.produces.map(value => ({
    ...workflowMeta(value), path: workflowPath(requireText(value.path, 'output path')), required: value.required === true,
  })) : [];
  if (produces.some(item => !item.path.startsWith('outputs/'))) throw new InputError('Skill output slots belong under outputs/');
  const rawCategories = parseProfileTags(modeHeader?.wiki_categories ?? header.wiki_categories)?.filter(isWikiCategory);
  const rawProfile = modeHeader?.search_profile ?? header.search_profile;
  const profileObj = rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)
    ? rawProfile as Record<string, unknown>
    : undefined;
  const wikiProfile = parseProfileTags(profileObj?.wiki);
  const memoryProfile = parseProfileTags(profileObj?.memory);
  const searchProfile = wikiProfile?.length || memoryProfile?.length
    ? { ...(wikiProfile?.length ? { wiki: wikiProfile } : {}), ...(memoryProfile?.length ? { memory: memoryProfile } : {}) }
    : undefined;
  const skill: WorkflowSkill = {
    skill_id: skillId, commit, tree: tree.object, package_path: packagePath, entry,
    required_links: [entry, ...links.map(link => linkPath(entry, link))],
    consumes, produces, gates: { entry: workflowStrings(gates.entry ?? [], 'entry gates'), exit: workflowStrings(gates.exit ?? [], 'exit gates') },
    ...(rawCategories?.length ? { wiki_categories: rawCategories } : {}),
    ...(searchProfile ? { search_profile: searchProfile } : {}),
  };
  for (const link of links) readWorkflowLink(root, skill, entry, link);
  return skill;
}

function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function hasHeadingFragment(markdown: string, fragment: string): boolean {
  const decoded = decodeURIComponent(fragment).trim().toLowerCase();
  const targetSlug = headingSlug(decoded);
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const rawHeading = match[1].trim().toLowerCase();
    if (rawHeading === decoded || headingSlug(rawHeading) === targetSlug) return true;
  }
  return false;
}

function resolvePackageMarkdownLink(
  root: string,
  skill: WorkflowSkill,
  from: string,
  destination: string,
): { path: string; fragment?: string } {
  const hashIdx = destination.indexOf('#');
  const rawPath = hashIdx >= 0 ? destination.slice(0, hashIdx) : destination;
  const fragment = hashIdx >= 0 ? destination.slice(hashIdx + 1) : undefined;
  const path = linkPath(from, rawPath);
  readWorkflowMarkdown(root, skill, path);
  return { path, ...(fragment ? { fragment } : {}) };
}

export function discoverWorkflowCommands(root: string, commit = workflowHead(root)): string[] {
  const discovered = new Set<string>();
  for (const skillRoot of projectSkillRoots) {
    const raw = git(root, 'ls-tree', '-r', '--name-only', '-z', commit, '--', skillRoot).toString('utf8');
    if (!raw) continue;
    for (const file of raw.split('\0')) {
      if (!file.endsWith('/SKILL.md')) continue;
      const rel = file.slice(skillRoot.length + 1, -'/SKILL.md'.length);
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(rel)) {
        discovered.add(rel);
        if (rel === 'ew-odyssey') {
          for (const mode of odysseyModes) discovered.add(`ew-odyssey-${mode}`);
        }
      } else if (/^ew-orchestrate\/steps\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i.test(rel)) {
        const step = rel.split('/').at(-1)!;
        discovered.add(step);
      }
    }
  }
  return [...discovered].sort();
}

export function validateWorkflowSkill(root: string, command: string, commit = workflowHead(root)) {
  let skill: WorkflowSkill;
  try {
    skill = bindWorkflowSkill(root, command, commit);
  } catch (error) {
    const normalized = workflowName(command);
    if (error instanceof InputError && /Workflow package is unavailable/.test(error.message)) {
      const diskCandidates = [
        join(root, 'skills', normalized, 'SKILL.md'),
        join(root, 'skills', 'ew-orchestrate', 'steps', normalized, 'SKILL.md'),
      ];
      if (diskCandidates.some(path => existsSync(path))) {
        throw new InputError(`${error.message} (uncommitted changes exist on disk; commit before running skill validate)`);
      }
    }
    throw error;
  }
  const entryText = workflowBlob(root, commit, `${skill.package_path}/${skill.entry}`).toString('utf8');
  const header = workflowHeader(entryText);
  const description = requireText(header.description, 'Skill description');
  if (header['session-mode'] !== undefined && header['session-mode'] !== 'none' && header['session-mode'] !== 'run') {
    throw new InputError(`Invalid session-mode in ${skill.skill_id}: ${String(header['session-mode'])}`);
  }
  const mode = odyssey.get(workflowName(command));
  const prepPath = mode ? `references/prepare/odyssey-${mode}.md` : undefined;
  const modeHeader = prepPath ? workflowHeader(workflowBlob(root, commit, `${skill.package_path}/${prepPath}`).toString('utf8')) : undefined;
  if (header['session-mode'] === 'run' && !(modeHeader?.contract ?? header.contract)) {
    throw new InputError(`Stateful Skill (session-mode: run) requires a contract: ${skill.skill_id}`);
  }
  if (header.version !== undefined) {
    const ver = String(header.version).trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ver)) {
      throw new InputError(`Invalid semver version in ${skill.skill_id}: ${ver}`);
    }
  }
  // 校验 required_links 与入口正文中相对 Markdown 链接及其 #heading 锚点。
  const rawLinks = Array.isArray(modeHeader?.required_links ?? header.required_links)
    ? (modeHeader?.required_links ?? header.required_links) as unknown[]
    : [];
  for (const item of rawLinks) {
    if (typeof item !== 'string') continue;
    const { path, fragment } = resolvePackageMarkdownLink(root, skill, skill.entry, item);
    if (fragment) {
      const target = readWorkflowMarkdown(root, skill, path);
      if (!hasHeadingFragment(target.markdown, fragment)) {
        throw new InputError(`Missing Markdown heading #${fragment} in ${path}`);
      }
    }
  }
  for (const match of entryText.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/g)) {
    const dest = match[1].replace(/^<|>$/g, '');
    if (!dest || dest.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(dest)) continue;
    const { path, fragment } = resolvePackageMarkdownLink(root, skill, skill.entry, dest);
    if (fragment) {
      const target = readWorkflowMarkdown(root, skill, path);
      if (!hasHeadingFragment(target.markdown, fragment)) {
        throw new InputError(`Missing Markdown heading #${fragment} in ${path}`);
      }
    }
  }
  // 校验宿主调用对等性（disable-model-invocation 与 agents/openai.yaml）。
  const openaiTree = findTreeMember(root, commit, `${skill.package_path}/agents/openai.yaml`);
  if (openaiTree?.type === 'blob') {
    const openaiDoc = parseDocument(workflowBlob(root, commit, `${skill.package_path}/agents/openai.yaml`).toString('utf8'), {
      strict: true, uniqueKeys: true,
    });
    if (openaiDoc.errors.length) {
      throw new InputError(`Invalid agents/openai.yaml in ${skill.skill_id}: ${openaiDoc.errors[0].message.split('\n')[0]}`);
    }
    const openaiJs = openaiDoc.toJS() as { policy?: { allow_implicit_invocation?: unknown } } | null;
    const disabledInSkill = header['disable-model-invocation'] === true;
    const disabledInOpenAi = openaiJs?.policy?.allow_implicit_invocation === false;
    if (disabledInSkill !== disabledInOpenAi) {
      throw new InputError(
        `Invocation parity mismatch in ${skill.skill_id}: disable-model-invocation (${disabledInSkill}) vs agents/openai.yaml allow_implicit_invocation=false (${disabledInOpenAi})`,
      );
    }
  }
  // 校验 <!-- evolve:learning:... --> 块配对与数量统计。
  const starts = [...entryText.matchAll(/<!-- evolve:learning:([a-f0-9]{20}) -->/g)].length;
  const ends = [...entryText.matchAll(/<!-- \/evolve:learning -->/g)].length;
  if (starts !== ends) {
    throw new InputError(`Unbalanced learning markers in ${skill.skill_id}: ${starts} start vs ${ends} end`);
  }
  return {
    ...skill,
    description,
    session_mode: (header['session-mode'] as string | undefined) ?? 'unspecified',
    disable_model_invocation: header['disable-model-invocation'] === true,
    ...(header.version !== undefined ? { version: String(header.version) } : {}),
    validated: true,
  };
}
