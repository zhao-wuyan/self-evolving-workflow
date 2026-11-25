import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { EVOLVE_DIR, InputError, evolveDir } from './common.js';
import { workflowName } from './workflow-names.js';

const bundle = fileURLToPath(new URL('../', import.meta.url));
const source = join(bundle, 'skills');
const agentsSource = join(bundle, 'agents');
const assetsSource = join(bundle, 'assets');
const PLUGIN_NAME = 'self-evolving-workflow';
const PLUGIN_DISPLAY_NAME = 'Self-Evolving Workflow';
const PLUGIN_AUTHOR = 'catlog22';
const PLUGIN_REPOSITORY = 'https://github.com/catlog22/self-evolving-workflow';
const PLUGIN_DESCRIPTION = 'Self-Evolving Workflow: Session/Run orchestration, local code graph, Markdown wiki, episodic memory, and skill evolution.';
const PLUGIN_SHORT_DESCRIPTION = 'Self-evolving agent workflow';
const PLUGIN_LONG_DESCRIPTION = 'Orchestrate tasks with recoverable Session/Run chains, local code graph, Markdown wiki, episodic memory, and sandboxed skill evolution.';
const PLUGIN_SUGGESTED_PROMPTS = [
  'Initialize Evolve workflow for this repository',
  'Orchestrate a multi-step task with Evolve Session/Run',
  'Search project wiki, code graph, and episodic memory',
];
const FALLBACK_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none"><rect x="12" y="12" width="104" height="104" rx="24" fill="#111827"/><circle cx="64" cy="64" r="14" fill="#38BDF8"/></svg>\n';
const hosts = {
  codex: {
    project: { path: ['.codex'], instructions: ['AGENTS.md'] },
    user: { path: ['.codex'], instructions: ['.codex', 'AGENTS.md'] },
  },
  claude: {
    project: { path: ['.claude'], instructions: ['CLAUDE.md'] },
    user: { path: ['.claude'], instructions: ['.claude', 'CLAUDE.md'] },
  },
  agy: {
    project: { path: ['.agents'], instructions: ['AGENTS.md'] },
    user: { path: ['.gemini', 'config'], instructions: ['.gemini', 'AGENTS.md'] },
  },
  omp: {
    // OMP 显式项目专属 Skill 位于 .omp/skills，项目 Agents 位于 OMP 原生 .omp/agents（未装插件时的兜底目录）。
    project: {
      path: ['.omp'], skills: ['.omp', 'skills'], agents: ['.omp', 'agents'],
      instructions: ['AGENTS.md'],
    },
    user: { path: ['.omp', 'agent'], instructions: ['.omp', 'agent', 'AGENTS.md'] },
  },
} as const;
const workflowTitle = 'Self-Evolving Workflow';
const INSTALL_MANIFEST_VERSION = 'evolve-install-manifest/1.0';
const retiredShippedSkills = new Set(['team-swarm']);
// Keep in sync with skills/.npmignore (non-shipped test/example packages).
const nonShippedSkills = new Set(['release-gate']);
const instructionStartMarker = '<!-- evolve:instructions:start -->';
const instructionEndMarker = '<!-- evolve:instructions:end -->';

type InstallScope = 'project' | 'user';
export type InstallHost = keyof typeof hosts;
export const installHosts = Object.keys(hosts) as InstallHost[];

interface HostScopeConfig {
  path: readonly string[];
  skills?: readonly string[];
  agents?: readonly string[];
  instructions: readonly string[];
}

interface InstallOptions {
  scope?: InstallScope;
  host?: string;
  skill?: string[];
  yes?: boolean;
  upgrade?: boolean;
  prune?: boolean;
  force?: boolean;
  plugin?: boolean;
  path?: string;
}

export interface InstallSkillsOptions {
  upgrade?: boolean;
  prune?: boolean;
  force?: boolean;
  agentsHost?: InstallHost;
}

export interface PluginInstallOptions {
  scope?: InstallScope;
  host?: string;
  skill?: string[];
  yes?: boolean;
  upgrade?: boolean;
  force?: boolean;
  path?: string;
}

export interface SkillInstallStatus {
  name: string;
  status: 'up_to_date' | 'outdated' | 'not_installed' | 'retired';
  on_disk: boolean;
  tracked_in_manifest: boolean;
  installed_version?: string;
  bundle_version?: string;
  installed_sha256?: string;
  bundle_sha256?: string;
}

interface InstalledSkillRecord {
  version: string;
  sha256: string;
  installed_at: string;
  updated_at: string;
}

interface TargetManifestRecord {
  scope: InstallScope;
  host: InstallHost | null;
  skills_dir: string;
  agents_dir?: string;
  agents_host?: InstallHost;
  instructions: string;
  updated_at: string;
  package_version: string;
  skills: Record<string, InstalledSkillRecord>;
  agents?: Record<string, InstalledSkillRecord>;
}

interface PluginManifestRecord {
  scope: InstallScope;
  host: InstallHost;
  plugin_dir: string;
  marketplace_path?: string;
  instructions?: string;
  version: string;
  sha256: string;
  skills: string[];
  agents: string[];
  installed_at: string;
  updated_at: string;
}

interface InstallManifest {
  schema_version: typeof INSTALL_MANIFEST_VERSION;
  targets: Record<string, TargetManifestRecord>;
  plugins?: Record<string, PluginManifestRecord>;
}

interface InstallTarget {
  host: InstallHost | undefined;
  target: string;
  skillsDir: string;
  agentsDir: string;
  instructions: string;
  skillsLabel: string;
}

interface WorkflowDocument {
  id: string;
  path: string;
}

let cachedPackageVersion: string | undefined;

export function bundlePackageVersion(): string {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')) as { version?: unknown };
    cachedPackageVersion = typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
  } catch {
    cachedPackageVersion = '0.0.0';
  }
  return cachedPackageVersion;
}

function directorySha256(rootDir: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string, prefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        walk(full, rel);
      } else if (entry.isFile()) {
        hash.update(`file:${rel}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(rootDir, '');
  return hash.digest('hex');
}

function skillVersion(skillDir: string): string {
  const entry = join(skillDir, 'SKILL.md');
  if (existsSync(entry)) {
    const text = readFileSync(entry, 'utf8').replace(/^\uFEFF/, '');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (match) {
      try {
        const parsed = parseYaml(match[1]) as { version?: unknown } | null;
        if (typeof parsed?.version === 'string' && parsed.version.trim()) return parsed.version.trim();
        if (typeof parsed?.version === 'number') return String(parsed.version);
      } catch {
        // 忽略无效 frontmatter，回退到包版本。
      }
    }
  }
  return bundlePackageVersion();
}

function manifestPath(root: string, scope: InstallScope): string {
  const base = scope === 'user' ? join(homedir(), EVOLVE_DIR) : evolveDir(root);
  return join(base, 'install-manifest.json');
}

function readManifest(path: string): InstallManifest {
  if (!existsSync(path)) return { schema_version: INSTALL_MANIFEST_VERSION, targets: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstallManifest>;
    if (parsed.schema_version === INSTALL_MANIFEST_VERSION && parsed.targets && typeof parsed.targets === 'object') {
      return {
        schema_version: INSTALL_MANIFEST_VERSION,
        targets: parsed.targets,
        ...(parsed.plugins && typeof parsed.plugins === 'object' ? { plugins: parsed.plugins } : {}),
      };
    }
  } catch {
    // 损坏的旧记录不阻断重装，重建为空记录。
  }
  return { schema_version: INSTALL_MANIFEST_VERSION, targets: {} };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.evolve-json-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function writeManifest(path: string, manifest: InstallManifest): void {
  writeJsonAtomic(path, manifest);
}

export function workflowDocuments(root?: string): WorkflowDocument[] {
  const documents: WorkflowDocument[] = JSON.parse(readFileSync(join(bundle, 'workflows', 'index.json'), 'utf8'));
  const skills = shippedSkills();
  const base = documents.filter(item => skills.includes(item.path.split('/')[1]));
  if (!root || resolve(root) === resolve(bundle)) return base;
  const projectSkillsDir = join(resolve(root), 'skills');
  if (!existsSync(projectSkillsDir)) return base;
  const seen = new Set(base.map(item => item.id));
  const extra: WorkflowDocument[] = [];
  for (const entry of readdirSync(projectSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `skills/${entry.name}/SKILL.md`;
    if (existsSync(join(resolve(root), rel)) && !seen.has(entry.name)) {
      seen.add(entry.name);
      extra.push({ id: entry.name, path: rel });
    }
    if (entry.name === 'ew-orchestrate') {
      const stepsDir = join(projectSkillsDir, 'ew-orchestrate', 'steps');
      if (!existsSync(stepsDir)) continue;
      for (const step of readdirSync(stepsDir, { withFileTypes: true })) {
        if (!step.isDirectory()) continue;
        const stepRel = `skills/ew-orchestrate/steps/${step.name}/SKILL.md`;
        if (existsSync(join(resolve(root), stepRel)) && !seen.has(step.name)) {
          seen.add(step.name);
          extra.push({ id: step.name, path: stepRel });
        }
      }
    }
  }
  return [...base, ...extra];
}

export function workflowDocument(id: string, root?: string) {
  const name = id === 'odyssey' || id === 'skill-design' ? 'ew-' + id : workflowName(id);
  const docs = workflowDocuments(root);
  const document = docs.find(item => item.id === name) ?? docs.find(item => item.id === id);
  if (!document) throw new InputError('Unknown workflow: ' + id);
  if (root) {
    const projectFile = join(resolve(root), document.path);
    if (existsSync(projectFile)) return readFileSync(projectFile, 'utf8');
  }
  return readFileSync(join(bundle, document.path), 'utf8');
}

export function shippedSkillNames(): string[] {
  return shippedSkills();
}

function shippedSkills() {
  return readdirSync(source, { withFileTypes: true })
    .filter(item => item.isDirectory() && !nonShippedSkills.has(item.name))
    .map(item => item.name)
    .sort();
}

function shippedAgents() {
  if (!existsSync(agentsSource)) return [];
  return readdirSync(agentsSource, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.endsWith('.md'))
    .map(item => item.name.replace(/\.md$/, ''))
    .sort();
}

function contentSha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function agentFileExtension(host: InstallHost | undefined): '.toml' | '.md' {
  return host === 'codex' ? '.toml' : '.md';
}

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function parseAgentMarkdown(raw: string) {
  const text = raw.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  let frontmatter: Record<string, unknown> = {};
  let body = text;
  if (match) {
    body = text.slice(match[0].length);
    try {
      const parsed = parseYaml(match[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      // 忽略无效 frontmatter，保留正文。
    }
  }
  const rawTools = frontmatter['allowed-tools'] ?? frontmatter.tools;
  const tools = Array.isArray(rawTools)
    ? rawTools.map(item => String(item).trim()).filter(Boolean)
    : typeof rawTools === 'string'
      ? rawTools.split(',').map(item => item.trim()).filter(Boolean)
      : [];
  return { frontmatter, tools, body };
}

function renderAgentForHost(name: string, host: InstallHost | undefined) {
  const sourcePath = join(agentsSource, `${name}.md`);
  const raw = readFileSync(sourcePath, 'utf8');
  const { frontmatter, tools, body } = parseAgentMarkdown(raw);
  const rawVersion = frontmatter.version;
  const version = typeof rawVersion === 'string' && rawVersion.trim()
    ? rawVersion.trim()
    : typeof rawVersion === 'number'
      ? String(rawVersion)
      : bundlePackageVersion();

  if (host === 'codex') {
    const codexName = (typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : name)
      .replace(/[-\s]+/g, '_')
      .toLowerCase();
    const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
    const hasWriteTool = tools.some(tool => /^(?:write|edit|notebookedit|write_file|edit_file)$/i.test(tool));
    const sandboxMode = hasWriteTool ? 'workspace-write' : 'read-only';
    const normalizedBody = body.replace(/\r\n/g, '\n').trim().replace(/"""/g, '\\"""');
    const content = [
      `name = "${escapeTomlString(codexName)}"`,
      `description = "${escapeTomlString(description)}"`,
      `sandbox_mode = "${sandboxMode}"`,
      '',
      'developer_instructions = """',
      normalizedBody,
      '"""',
      '',
    ].join('\n');
    return { fileName: `${name}.toml`, content, version, sha256: contentSha256(content) };
  }

  return { fileName: `${name}.md`, content: raw, version, sha256: contentSha256(raw) };
}

function selectSkills(shipped: string[], requested: string[]) {
  const selected = requested.length ? [...new Set(requested.map(workflowName))] : shipped;
  if (selected.some(name => !shipped.includes(name))) throw new InputError('Choose a shipped Skill package');
  if (selected.includes('ew-odyssey') && !selected.includes('ew-orchestrate')) {
    return ['ew-orchestrate', ...selected];
  }
  return selected;
}

export function parseInstallHosts(value: string): InstallHost[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'all') return [...installHosts];
  const selected = normalized.split(',').map(item => item.trim()).filter(Boolean);
  if (!selected.length || selected.some(host => !installHosts.includes(host as InstallHost))) {
    throw new InputError(`Choose ${installHosts.join(', ')} or all`);
  }
  return installHosts.filter(host => selected.includes(host));
}

function validatePruneDirectory(base: string, targetDir: string, label = 'Skills') {
  const root = resolve(base);
  const path = relative(root, resolve(targetDir));
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) {
    throw new InputError(`${label} directory must be inside the installation root`);
  }
  let current = root;
  for (const part of path.split(sep)) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new InputError('Use regular installation directories: ' + current);
    }
  }
  if (existsSync(targetDir)) {
    const actual = relative(realpathSync(root), realpathSync(targetDir));
    if (!actual || isAbsolute(actual) || actual === '..' || actual.startsWith('..' + sep)) {
      throw new InputError(`${label} directory must be inside the installation root`);
    }
  }
}

function installAgentsToTarget(
  target: InstallTarget,
  installBase: string,
  existingAgents: Record<string, InstalledSkillRecord>,
  now: string,
  options: InstallSkillsOptions,
) {
  const agents = shippedAgents();
  const agentsDir = target.agentsDir;
  const agentRecords: Record<string, InstalledSkillRecord> = { ...existingAgents };
  const installed: string[] = [];
  const upgraded: string[] = [];
  const kept: string[] = [];
  const pruned: string[] = [];

  if (!agents.length) {
    return { agents, agents_dir: agentsDir, installed, upgraded, kept, pruned, records: agentRecords };
  }

  if (resolve(agentsDir) === resolve(agentsSource)) {
    for (const name of agents) {
      const rendered = renderAgentForHost(name, target.host);
      kept.push(name);
      const prev = agentRecords[name];
      agentRecords[name] = {
        version: rendered.version,
        sha256: rendered.sha256,
        installed_at: prev?.installed_at ?? now,
        updated_at: now,
      };
    }
    return { agents, agents_dir: agentsDir, installed, upgraded, kept, pruned, records: agentRecords };
  }

  if (options.prune) validatePruneDirectory(installBase, agentsDir, 'Agents');
  if (lstatSync(agentsDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new InputError('Use a regular agents directory');
  }
  mkdirSync(agentsDir, { recursive: true });

  for (const name of agents) {
    const rendered = renderAgentForHost(name, target.host);
    const dest = join(agentsDir, rendered.fileName);
    const destInfo = lstatSync(dest, { throwIfNoEntry: false });

    if (destInfo?.isSymbolicLink()) throw new InputError('Use a regular agent file: ' + dest);
    if (destInfo && !destInfo.isFile()) throw new InputError('Existing agent path is not a regular file: ' + dest);

    const exists = Boolean(destInfo);
    const currentDiskHash = destInfo?.isFile() ? contentSha256(readFileSync(dest)) : undefined;
    const isSameContent = Boolean(currentDiskHash && currentDiskHash === rendered.sha256);
    const shouldReplace = exists && (options.force || (options.upgrade && !isSameContent));

    if (!exists || shouldReplace) {
      const stage = mkdtempSync(join(agentsDir, '.evolve-agent-install-'));
      try {
        const staged = join(stage, rendered.fileName);
        writeFileSync(staged, rendered.content, 'utf8');
        if (exists) {
          const backup = join(stage, `${rendered.fileName}.backup`);
          renameSync(dest, backup);
          try {
            renameSync(staged, dest);
          } catch (error) {
            if (!existsSync(dest) && existsSync(backup)) renameSync(backup, dest);
            throw error;
          }
          upgraded.push(name);
        } else {
          renameSync(staged, dest);
          installed.push(name);
        }
      } finally {
        if (dirname(stage) === agentsDir) rmSync(stage, { recursive: true, force: true });
      }
      const prev = agentRecords[name];
      agentRecords[name] = {
        version: rendered.version,
        sha256: rendered.sha256,
        installed_at: prev?.installed_at ?? now,
        updated_at: now,
      };
    } else {
      kept.push(name);
      if (!agentRecords[name]) {
        agentRecords[name] = {
          version: rendered.version,
          sha256: currentDiskHash!,
          installed_at: now,
          updated_at: now,
        };
      }
    }
  }

  if (options.prune) {
    const shippedSet = new Set(agents);
    const ext = agentFileExtension(target.host);
    const retired = Object.keys(agentRecords).filter(name => !shippedSet.has(name)).sort();
    validatePruneDirectory(installBase, agentsDir, 'Agents');
    for (const name of retired) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.endsWith('.')) {
        throw new InputError('Invalid Agent name in install manifest: ' + name);
      }
      const dest = resolve(agentsDir, `${name}${ext}`);
      if (dirname(dest) !== resolve(agentsDir)) {
        throw new InputError('Prune target must be inside the agents directory: ' + name);
      }
      const info = lstatSync(dest, { throwIfNoEntry: false });
      if (info && !info.isSymbolicLink() && info.isFile()) {
        if (dirname(realpathSync(dest)) !== realpathSync(agentsDir)) {
          throw new InputError('Prune target must be inside the agents directory: ' + name);
        }
        rmSync(dest, { force: true });
        pruned.push(name);
      }
      delete agentRecords[name];
    }
  }

  return { agents, agents_dir: agentsDir, installed, upgraded, kept, pruned, records: agentRecords };
}

function installSkillsToTarget(
  target: InstallTarget,
  scope: InstallScope,
  projectRoot: string,
  requested: string[],
  options: InstallSkillsOptions = {},
) {
  const shipped = shippedSkills();
  const skills = selectSkills(shipped, requested);
  const skillsDir = target.skillsDir;
  const installBase = scope === 'user' ? homedir() : projectRoot;
  if (options.prune) validatePruneDirectory(installBase, skillsDir);
  if (lstatSync(skillsDir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new InputError('Use a regular skills directory');
  mkdirSync(skillsDir, { recursive: true });

  const filePath = manifestPath(projectRoot, scope);
  const manifest = readManifest(filePath);
  const targetKey = resolve(skillsDir);
  const existingRecord = manifest.targets[targetKey];
  const agentsHost = options.agentsHost ?? existingRecord?.agents_host;
  const agentsTarget = agentsHost ? scopeAndHost(projectRoot, scope, agentsHost) : target;
  const skillRecords: Record<string, InstalledSkillRecord> = { ...(existingRecord?.skills ?? {}) };
  const now = new Date().toISOString();

  const installed: string[] = [];
  const upgraded: string[] = [];
  const kept: string[] = [];
  const keptSources: Array<{ name: string; path: string; version: string; sha256: string;
    bundled_path: string; bundled_version: string; bundled_sha256: string; differs: boolean }> = [];

  for (const name of skills) {
    const dest = join(skillsDir, name);
    const sourceDir = join(source, name);
    const bundleHash = directorySha256(sourceDir);
    const bundleVer = skillVersion(sourceDir);
    const destInfo = lstatSync(dest, { throwIfNoEntry: false });

    if (destInfo?.isSymbolicLink()) throw new InputError('Use a regular skill directory: ' + dest);
    if (destInfo && !existsSync(join(dest, 'SKILL.md')) && !options.force) {
      throw new InputError('Existing directory has no SKILL.md: ' + dest);
    }

    const exists = Boolean(destInfo);
    const currentDiskHash = destInfo?.isDirectory() ? directorySha256(dest) : undefined;
    const isSameContent = Boolean(currentDiskHash && currentDiskHash === bundleHash);
    const shouldReplace = exists && (options.force || (options.upgrade && !isSameContent));

    if (!exists || shouldReplace) {
      const stage = mkdtempSync(join(skillsDir, '.evolve-install-'));
      try {
        const staged = join(stage, name);
        cpSync(sourceDir, staged, { recursive: true, force: false, errorOnExist: true });
        if (exists) {
          const backup = join(stage, `${name}.backup`);
          renameSync(dest, backup);
          try {
            renameSync(staged, dest);
          } catch (error) {
            if (!existsSync(dest) && existsSync(backup)) renameSync(backup, dest);
            throw error;
          }
          upgraded.push(name);
        } else {
          renameSync(staged, dest);
          installed.push(name);
        }
      } finally {
        if (dirname(stage) === skillsDir) rmSync(stage, { recursive: true, force: true });
      }
      const prev = skillRecords[name];
      skillRecords[name] = {
        version: bundleVer,
        sha256: bundleHash,
        installed_at: prev?.installed_at ?? now,
        updated_at: now,
      };
    } else {
      kept.push(name);
      keptSources.push({ name, path: join(dest, 'SKILL.md'), version: skillVersion(dest), sha256: currentDiskHash!,
        bundled_path: join(sourceDir, 'SKILL.md'), bundled_version: bundleVer, bundled_sha256: bundleHash, differs: !isSameContent });
      // 补录历史未建档的已存在 Skill，便于后续状态检查与升级识别。
      if (!skillRecords[name]) {
        skillRecords[name] = {
          version: skillVersion(dest),
          sha256: currentDiskHash!,
          installed_at: now,
          updated_at: now,
        };
      }
    }
  }

  const pruned: string[] = [];
  if (options.prune) {
    const shippedSet = new Set(shipped);
    const candidates = new Set([
      ...Object.keys(skillRecords).filter(name => !shippedSet.has(name)),
      ...retiredShippedSkills,
    ]);
    validatePruneDirectory(installBase, skillsDir);
    const targets = [...candidates].sort().map(name => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.endsWith('.')) {
        throw new InputError('Invalid Skill name in install manifest: ' + name);
      }
      const dest = resolve(skillsDir, name);
      if (dirname(dest) !== resolve(skillsDir)) {
        throw new InputError('Prune target must be inside the skills directory: ' + name);
      }
      return { name, dest };
    });
    for (const { name, dest } of targets) {
      const info = lstatSync(dest, { throwIfNoEntry: false });
      if (info && !info.isSymbolicLink() && info.isDirectory()) {
        if (dirname(realpathSync(dest)) !== realpathSync(skillsDir)) {
          throw new InputError('Prune target must be inside the skills directory: ' + name);
        }
        rmSync(dest, { recursive: true, force: true });
        pruned.push(name);
      }
      delete skillRecords[name];
    }
  }

  const previousAgents = existingRecord?.agents_dir === agentsTarget.agentsDir ? existingRecord.agents ?? {} : {};
  const agentInstall = installAgentsToTarget(agentsTarget, installBase, previousAgents, now, options);

  manifest.targets[targetKey] = {
    scope,
    host: target.host ?? null,
    skills_dir: skillsDir,
    agents_dir: agentsTarget.agentsDir,
    ...(agentsHost ? { agents_host: agentsHost } : {}),
    instructions: target.instructions,
    updated_at: now,
    package_version: bundlePackageVersion(),
    skills: skillRecords,
    agents: agentInstall.records,
  };
  writeManifest(filePath, manifest);

  return {
    skills,
    installed,
    upgraded,
    kept,
    kept_sources: keptSources,
    pruned,
    agents_dir: agentInstall.agents_dir,
    agents: {
      names: agentInstall.agents,
      installed: agentInstall.installed,
      upgraded: agentInstall.upgraded,
      kept: agentInstall.kept,
      pruned: agentInstall.pruned,
    },
    manifest_path: filePath,
  };
}

export function installSkills(root: string, requested: string[], hostArg?: string, options: InstallSkillsOptions = {}) {
  if (!hostArg) {
    const target = projectRootTarget(root);
    const result = installSkillsToTarget(target, 'project', root, requested, options);
    return { ...result, skills_dir: target.skillsDir };
  }
  const selectedHosts = parseInstallHosts(hostArg);
  if (selectedHosts.length === 1) {
    const target = scopeAndHost(root, 'project', selectedHosts[0]);
    const result = installSkillsToTarget(target, 'project', root, requested, options);
    return { ...result, host: target.host, skills_dir: target.skillsDir };
  }
  const targets = selectedHosts.map(host => {
    const target = scopeAndHost(root, 'project', host);
    const result = installSkillsToTarget(target, 'project', root, requested, options);
    return { host: target.host, skills_dir: target.skillsDir, ...result };
  });
  return {
    skills: targets[0].skills,
    skills_dir: targets[0].skills_dir,
    installed: [...new Set(targets.flatMap(item => item.installed))],
    upgraded: [...new Set(targets.flatMap(item => item.upgraded))],
    kept: [...new Set(targets.flatMap(item => item.kept))],
    pruned: [...new Set(targets.flatMap(item => item.pruned))],
    agents: summarizeAgentResults(targets),
    manifest_path: targets[0].manifest_path,
    targets,
  };
}

function summarizeAgentResults(targets: Array<{ agents: { names: string[]; installed: string[]; upgraded: string[]; kept: string[]; pruned: string[] } }>) {
  return {
    names: targets[0]?.agents.names ?? [],
    installed: [...new Set(targets.flatMap(item => item.agents.installed))],
    upgraded: [...new Set(targets.flatMap(item => item.agents.upgraded))],
    kept: [...new Set(targets.flatMap(item => item.agents.kept))],
    pruned: [...new Set(targets.flatMap(item => item.agents.pruned))],
  };
}

function buildManagedInstructions(skillsLabels: string[], newline: string) {
  const locations = [...new Set(skillsLabels)].sort().map(label => '`' + label + '`').join(' or ');
  const rules = readFileSync(join(bundle, 'rules', 'AGENTS.md'), 'utf8').trim()
    .replace('in `skills/` for project orchestration', `in ${locations} for project orchestration`);
  return [instructionStartMarker, ...rules.split(/\r?\n/), instructionEndMarker].join(newline);
}
function replaceManagedInstructions(current: string, guideBlock: string): string | undefined {
  const startIdx = current.indexOf(instructionStartMarker);
  if (startIdx >= 0) {
    const endIdx = current.indexOf(instructionEndMarker, startIdx + instructionStartMarker.length);
    if (endIdx >= 0) {
      return current.slice(0, startIdx) + guideBlock + current.slice(endIdx + instructionEndMarker.length);
    }
  }
  const legacyInstallMatch = /^# (?:Evolve Workflow|Self-Evolving Workflow)[ \t]*\r?\n\r?\nUse Evolve for Session and Run control\. Run `(?:agent-memory|evolve) context[^\r\n]*\r?\n[^\r\n]*\r?\nRead the relevant package in [^\r\n]*\r?\nUse `evolve skill workflows`[^\r\n]*\r?\nUse `evolve kb import`[^\r\n]*/m.exec(current);
  if (legacyInstallMatch) {
    return current.slice(0, legacyInstallMatch.index) + guideBlock + current.slice(legacyInstallMatch.index + legacyInstallMatch[0].length);
  }
  const legacyGlobalMatch = /^# Evolve Workflow[ \t]*\r?\n[\s\S]*?\S(?=(?:\r?\n)+# |\s*(?![\s\S]))/m.exec(current);
  if (legacyGlobalMatch &&
      legacyGlobalMatch[0].includes('## Project knowledge gate') &&
      legacyGlobalMatch[0].includes('never write `.workflow/specs/` or `.workflow/knowhow/` files directly')) {
    return current.slice(0, legacyGlobalMatch.index) + guideBlock + current.slice(legacyGlobalMatch.index + legacyGlobalMatch[0].length);
  }
  return undefined;
}

function resolveProjectInstructionTarget(root: string, skillsRootOrHost?: InstallHost | 'generic' | string): { path: string; label: string } {
  if (!skillsRootOrHost || skillsRootOrHost === 'generic' || skillsRootOrHost === 'skills') {
    return { path: join(root, 'AGENTS.md'), label: 'skills/' };
  }
  if (installHosts.includes(skillsRootOrHost as InstallHost)) {
    const target = scopeAndHost(root, 'project', skillsRootOrHost as InstallHost);
    return { path: target.instructions, label: target.skillsLabel };
  }
  const normalized = skillsRootOrHost.replace(/\/+$/, '');
  const instructions = normalized.startsWith('.claude/') ? join(root, 'CLAUDE.md') : join(root, 'AGENTS.md');
  return { path: instructions, label: `${normalized}/` };
}

export function projectInstructionPlan(root: string, skillsRootOrHost?: InstallHost | 'generic' | string) {
  const { path, label } = resolveProjectInstructionTarget(root, skillsRootOrHost);
  const labels = activeInstructionLabels(root, 'project', path, [label]);
  const status = managedInstructionStatus(path, labels);
  const info = lstatSync(path, { throwIfNoEntry: false });
  const current = info?.isFile() ? readFileSync(path, 'utf8') : '';
  const hasUnmarkedEvolveHeading = status === 'custom' && /^# (?:Evolve Workflow|Self-Evolving Workflow)\s*$/m.test(current);
  const needsProvision = !info ? true : info.isFile() && (status === 'outdated' || (status === 'custom' && !hasUnmarkedEvolveHeading));
  return { path, labels, status, needs_provision: needsProvision };
}

export function provisionProjectInstructions(root: string, skillsRootOrHost?: InstallHost | 'generic' | string) {
  const plan = projectInstructionPlan(root, skillsRootOrHost);
  if (!plan.needs_provision) return { path: plan.path, status: 'kept' as const };
  provisionInstructions(plan.path, plan.labels);
  return { path: plan.path, status: 'updated' as const };
}

function provisionInstructions(path: string, skillsLabels: string[]) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new InputError('Use a regular instruction file: ' + path);
  const current = info ? readFileSync(path, 'utf8') : '';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const guideBlock = buildManagedInstructions(skillsLabels, newline);
  const replaced = current ? replaceManagedInstructions(current, guideBlock) : undefined;
  if (replaced !== undefined) {
    if (replaced === current) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, replaced, 'utf8');
    return;
  }
  // Preserve unmarked custom `# Self-Evolving Workflow` / `# Evolve Workflow` instruction files (such as repo root AGENTS.md).
  if (/^# (?:Evolve Workflow|Self-Evolving Workflow)\s*$/m.test(current)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, current ? current + newline + newline + guideBlock + newline : guideBlock + newline, 'utf8');
}

function projectRootTarget(root: string): InstallTarget {
  return {
    host: undefined,
    target: root,
    skillsDir: join(root, 'skills'),
    agentsDir: join(root, 'agents'),
    instructions: join(root, 'AGENTS.md'),
    skillsLabel: 'skills/',
  };
}

function scopeAndHost(root: string, scope: InstallScope, host: InstallHost): InstallTarget {
  const config: HostScopeConfig = hosts[host][scope];
  const base = scope === 'project' ? root : homedir();
  const target = join(base, ...config.path);
  const skillsPath = config.skills ?? [...config.path, 'skills'];
  const agentsPath = config.agents ?? [...config.path, 'agents'];
  return {
    host,
    target,
    skillsDir: join(base, ...skillsPath),
    agentsDir: join(base, ...agentsPath),
    instructions: join(base, ...config.instructions),
    skillsLabel: scope === 'project' ? `${skillsPath.join('/')}/` : 'skills/',
  };
}

// Several project hosts share AGENTS.md. Retain the paths of all installed targets.
function activeInstructionLabels(root: string, scope: InstallScope, path: string, requested: string[]): string[] {
  const targets = [
    ...(scope === 'project' ? [projectRootTarget(root)] : []),
    ...installHosts.map(host => scopeAndHost(root, scope, host)),
  ];
  return [...new Set([...requested, ...targets.filter(target =>
    target.instructions === path && existsSync(target.skillsDir)).map(target => target.skillsLabel)])];
}

function managedInstructionStatus(path: string, labels: string[]): 'missing' | 'custom' | 'outdated' | 'up_to_date' {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return 'missing';
  if (!info.isFile()) return 'custom';
  const current = readFileSync(path, 'utf8');
  const start = current.indexOf(instructionStartMarker);
  if (start < 0) return current.includes(instructionEndMarker) ? 'outdated' : 'custom';
  const end = current.indexOf(instructionEndMarker, start);
  if (end < 0) return 'outdated';
  const block = current.slice(start, end + instructionEndMarker.length).replace(/\r\n/g, '\n');
  return block === buildManagedInstructions(labels, '\n') ? 'up_to_date' : 'outdated';
}

function targetAgentStatuses(target: InstallTarget, record: TargetManifestRecord | undefined): SkillInstallStatus[] {
  const shipped = shippedAgents();
  const shippedSet = new Set(shipped);
  const trackedAgents = record?.agents ?? {};
  const ext = agentFileExtension(target.host);
  const names = [...new Set([...shipped, ...Object.keys(trackedAgents)])].sort();
  return names.flatMap<SkillInstallStatus>(name => {
    const dest = join(target.agentsDir, `${name}${ext}`);
    const info = lstatSync(dest, { throwIfNoEntry: false });
    const onDisk = Boolean(info && !info.isSymbolicLink() && info.isFile());
    const tracked = trackedAgents[name];
    if (!shippedSet.has(name)) {
      if (!onDisk && !tracked) return [];
      return [{
        name,
        status: 'retired' as const,
        on_disk: onDisk,
        tracked_in_manifest: Boolean(tracked),
      }];
    }
    const rendered = renderAgentForHost(name, target.host);
    if (!onDisk) {
      return [{
        name,
        status: 'not_installed' as const,
        on_disk: false,
        tracked_in_manifest: Boolean(tracked),
        bundle_version: rendered.version,
        bundle_sha256: rendered.sha256,
      }];
    }
    const diskHash = contentSha256(readFileSync(dest));
    const status = diskHash === rendered.sha256 ? ('up_to_date' as const) : ('outdated' as const);
    return [{
      name,
      status,
      on_disk: true,
      tracked_in_manifest: Boolean(tracked),
      installed_version: tracked?.version ?? rendered.version,
      bundle_version: rendered.version,
      installed_sha256: diskHash,
      bundle_sha256: rendered.sha256,
    }];
  });
}

export function installStatus(root: string, options: { scope?: InstallScope; host?: string } = {}) {
  const scope: InstallScope = options.scope ?? 'project';
  const filePath = manifestPath(root, scope);
  const manifest = readManifest(filePath);
  const shipped = shippedSkills();
  const shippedSet = new Set(shipped);

  let targets: InstallTarget[];
  if (options.host) {
    targets = parseInstallHosts(options.host).map(host => scopeAndHost(root, scope, host));
  } else if (scope === 'user') {
    targets = installHosts.map(host => scopeAndHost(root, scope, host));
  } else {
    const allProjectTargets = [projectRootTarget(root), ...installHosts.map(host => scopeAndHost(root, scope, host))];
    const active = allProjectTargets.filter(target =>
      Boolean(manifest.targets[resolve(target.skillsDir)]) || existsSync(target.skillsDir) || existsSync(target.agentsDir),
    );
    targets = active.length ? active : [projectRootTarget(root)];
  }

  const targetStatuses = targets.map(target => {
    const targetKey = resolve(target.skillsDir);
    const record = manifest.targets[targetKey];
    const agentsTarget = record?.agents_host ? scopeAndHost(root, scope, record.agents_host) : target;
    const trackedSkills = record?.skills ?? {};
    const names = [...new Set([...shipped, ...Object.keys(trackedSkills), ...retiredShippedSkills])].sort();
    const skills = names.flatMap<SkillInstallStatus>(name => {
      const dest = join(target.skillsDir, name);
      const onDisk = existsSync(join(dest, 'SKILL.md'));
      const tracked = trackedSkills[name];
      if (!shippedSet.has(name)) {
        if (!onDisk && !tracked) return [];
        return [{
          name,
          status: 'retired' as const,
          on_disk: onDisk,
          tracked_in_manifest: Boolean(tracked),
        }];
      }
      const sourceDir = join(source, name);
      const bundleHash = directorySha256(sourceDir);
      const bundleVer = skillVersion(sourceDir);
      if (!onDisk) {
        return [{
          name,
          status: 'not_installed' as const,
          on_disk: false,
          tracked_in_manifest: Boolean(tracked),
          bundle_version: bundleVer,
          bundle_sha256: bundleHash,
        }];
      }
      const diskHash = directorySha256(dest);
      const status = diskHash === bundleHash ? ('up_to_date' as const) : ('outdated' as const);
      return [{
        name,
        status,
        on_disk: true,
        tracked_in_manifest: Boolean(tracked),
        installed_version: tracked?.version ?? skillVersion(dest),
        bundle_version: bundleVer,
        installed_sha256: diskHash,
        bundle_sha256: bundleHash,
      }];
    });
    const agents = targetAgentStatuses(agentsTarget, record);
    return {
      ...(target.host ? { host: target.host } : {}),
      root: target.target,
      skills_dir: target.skillsDir,
      agents_dir: agentsTarget.agentsDir,
      instructions: target.instructions,
      instructions_status: managedInstructionStatus(target.instructions,
        activeInstructionLabels(root, scope, target.instructions, [target.skillsLabel])),
      manifest_recorded: Boolean(record),
      package_version: record?.package_version ?? null,
      updated_at: record?.updated_at ?? null,
      skills,
      agents,
    };
  });

  return {
    schema_version: 'evolve-install-status/1.0',
    scope,
    manifest_path: filePath,
    manifest_exists: existsSync(filePath),
    bundle_version: bundlePackageVersion(),
    targets: targetStatuses,
  };
}

export async function installWorkflow(root: string, options: InstallOptions) {
  if (options.plugin) {
    return installPlugins(root, options);
  }
  const shipped = shippedSkills();
  let scope: InstallScope = options.scope ?? 'project';
  let selectedHosts = options.host === undefined ? undefined : parseInstallHosts(options.host);
  let useProjectRoot = false;
  let requested = options.skill ?? [];
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new InputError('Use an interactive terminal or pass --yes');
    }
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(workflowTitle + ' installer\n\n');
      if (!options.scope && !selectedHosts) {
        const answer = (await ui.question('Install to [1] project or [2] user profile [1]? ')).trim();
        if (answer && answer !== '1' && answer !== '2') throw new InputError('Choose project (1) or user (2)');
        scope = answer === '2' ? 'user' : 'project';
      }
      if (!selectedHosts) {
        if (scope === 'project') {
          const answer = (await ui.question('Host [1] Codex (.codex), [2] Claude (.claude), [3] Agy (.agents), [4] All, [5] Generic (skills/) or [6] OMP [3]? ')).trim() || '3';
          if (!['1', '2', '3', '4', '5', '6'].includes(answer)) {
            throw new InputError('Choose Codex (1), Claude (2), Agy (3), All (4), Generic (5) or OMP (6)');
          }
          if (answer === '5') useProjectRoot = true;
          else selectedHosts = answer === '1' ? ['codex'] : answer === '2' ? ['claude'] : answer === '3' ? ['agy'] : answer === '6' ? ['omp'] : [...installHosts];
        } else {
          const answer = (await ui.question('Host [1] Codex, [2] Claude, [3] Agy, [4] All or [5] OMP [1]? ')).trim() || '1';
          if (!['1', '2', '3', '4', '5'].includes(answer)) throw new InputError('Choose Codex (1), Claude (2), Agy (3), All (4) or OMP (5)');
          selectedHosts = answer === '1' ? ['codex'] : answer === '2' ? ['claude'] : answer === '3' ? ['agy'] : answer === '5' ? ['omp'] : [...installHosts];
        }
      }
      const targets = useProjectRoot
        ? [projectRootTarget(root)]
        : selectedHosts!.map(host => scopeAndHost(root, scope, host));
      if (!requested.length) {
        process.stdout.write(shipped.map((name, index) => {
          const present = targets.every(entry => existsSync(join(entry.skillsDir, name, 'SKILL.md')));
          const outdated = present && targets.some(entry =>
            directorySha256(join(entry.skillsDir, name)) !== directorySha256(join(source, name)));
          const tag = outdated ? ' (outdated)' : present ? ' (present)' : '';
          return `  ${index + 1}. ${name}${tag}`;
        }).join('\n') + '\n');
        const answer = (await ui.question('Skill numbers, comma separated [all]? ')).trim();
        if (answer && answer.toLowerCase() !== 'all') {
          const positions = answer.split(',').map(value => value.trim());
          if (positions.some(value => !/^\d+$/.test(value) || !shipped[Number(value) - 1])) {
            throw new InputError('Choose Skill numbers from the list');
          }
          requested = positions.map(value => shipped[Number(value) - 1]);
        }
      }
      const selected = selectSkills(shipped, requested);
      const destination = targets.map(entry => entry.skillsDir).join(', ');
      const verb = options.upgrade ? 'Install/upgrade' : 'Install';
      const answer = (await ui.question(`${verb} ${selected.join(', ')} in ${destination}? [y/N] `)).trim();
      if (!/^y(?:es)?$/i.test(answer)) return { status: 'cancelled' };
    } finally {
      ui.close();
    }
  }
  const targets = useProjectRoot
    ? [projectRootTarget(root)]
    : selectedHosts
      ? selectedHosts.map(host => scopeAndHost(root, scope, host))
      : scope === 'project'
        ? [projectRootTarget(root)]
        : [scopeAndHost(root, scope, 'codex')];
  const targetResults = targets.map(entry => {
    const result = installSkillsToTarget(entry, scope, root, requested, {
      upgrade: options.upgrade,
      prune: options.prune,
      force: options.force,
    });
    return {
      ...(entry.host ? { host: entry.host } : {}),
      root: entry.target,
      skills_dir: entry.skillsDir,
      instructions: entry.instructions,
      skillsLabel: entry.skillsLabel,
      ...result,
    };
  });
  const instructionGroups = new Map<string, string[]>();
  for (const entry of targetResults) {
    const labels = instructionGroups.get(entry.instructions) ?? [];
    labels.push(entry.skillsLabel);
    instructionGroups.set(entry.instructions, labels);
  }
  for (const [instructionsPath, labels] of instructionGroups) {
    provisionInstructions(instructionsPath, activeInstructionLabels(root, scope, instructionsPath, labels));
  }
  const skills = targetResults[0].skills;
  const workflows = workflowDocuments().filter(item => skills.includes(item.path.split('/')[1]));
  if (targetResults.length === 1) {
    const [{ skillsLabel: _label, ...single }] = targetResults;
    return { status: 'installed', scope, ...single, workflows };
  }
  return {
    status: 'installed',
    scope,
    hosts: targetResults.map(item => item.host).filter((item): item is InstallHost => Boolean(item)),
    targets: targetResults.map(({ skillsLabel: _label, ...item }) => item),
    skills,
    installed: [...new Set(targetResults.flatMap(item => item.installed))],
    upgraded: [...new Set(targetResults.flatMap(item => item.upgraded))],
    kept: [...new Set(targetResults.flatMap(item => item.kept))],
    pruned: [...new Set(targetResults.flatMap(item => item.pruned))],
    agents: summarizeAgentResults(targetResults),
    manifest_path: targetResults[0].manifest_path,
    workflows,
  };
}

const pluginHosts = ['codex', 'claude', 'agy'] as const;
type PluginHost = typeof pluginHosts[number];
type PluginBundleKind = PluginHost | 'universal';

function parsePluginHosts(value: string): PluginHost[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'all') return [...pluginHosts];
  const selected = normalized.split(',').map(item => item.trim()).filter(Boolean);
  if (!selected.length || selected.some(host => !pluginHosts.some(candidate => candidate === host))) {
    throw new InputError('Choose codex, claude, agy or all for plugin bundles; use omp plugin install for the OMP extension');
  }
  return pluginHosts.filter(host => selected.includes(host));
}

interface ResolvedPluginTarget {
  host: PluginHost;
  pluginDir: string;
  marketplaceDir?: string;
  marketplacePath?: string;
  marketplaceRelPath?: string;
  instructions?: string;
  skillsLabel?: string;
  nextCommands: string[];
}

function claudeConfigRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function codexConfigRoot(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function buildPluginRulesMarkdown(): string {
  return buildManagedInstructions(['skills/'], '\n')
    .split('\n')
    .filter(line => line !== instructionStartMarker && line !== instructionEndMarker)
    .join('\n') + '\n';
}

function buildClaudePluginManifest(selectedSkills: string[], version: string) {
  return {
    name: PLUGIN_NAME,
    version,
    description: PLUGIN_DESCRIPTION,
    author: { name: PLUGIN_AUTHOR },
    repository: PLUGIN_REPOSITORY,
    license: 'MIT',
    keywords: ['workflow', 'orchestration', 'knowledge-graph', 'memory', 'wiki', 'skills'],
    skills: selectedSkills.map(name => `./skills/${name}`),
  };
}

function buildClaudeMarketplaceManifest(sourcePath: string, version: string) {
  return {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: PLUGIN_NAME,
    description: 'Self-Evolving Workflow marketplace for Session/Run orchestration, local code graph, Markdown wiki, episodic memory, and skill evolution.',
    owner: { name: PLUGIN_AUTHOR },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: sourcePath,
        description: PLUGIN_DESCRIPTION,
        version,
        category: 'productivity',
      },
    ],
  };
}

function buildCodexInterface() {
  return {
    displayName: PLUGIN_DISPLAY_NAME,
    shortDescription: PLUGIN_SHORT_DESCRIPTION,
    longDescription: PLUGIN_LONG_DESCRIPTION,
    developerName: PLUGIN_AUTHOR,
    category: 'Developer Tools',
    capabilities: ['Interactive', 'Read', 'Write'],
    defaultPrompt: PLUGIN_SUGGESTED_PROMPTS,
    logo: './assets/logo.svg',
  };
}

function buildCodexCompatManifest(version: string) {
  return {
    name: PLUGIN_NAME,
    version,
    description: PLUGIN_DESCRIPTION,
    author: { name: PLUGIN_AUTHOR },
    repository: PLUGIN_REPOSITORY,
    license: 'MIT',
    keywords: ['workflow', 'orchestration', 'knowledge-graph', 'memory', 'wiki', 'skills'],
    skills: './skills/',
    interface: buildCodexInterface(),
  };
}

function buildPortablePluginManifest(version: string) {
  return {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: PLUGIN_NAME,
    version,
    description: PLUGIN_DESCRIPTION,
    author: { name: PLUGIN_AUTHOR },
    repository: PLUGIN_REPOSITORY,
    license: 'MIT',
    keywords: ['workflow', 'orchestration', 'knowledge-graph', 'memory', 'wiki', 'skills'],
    extensions: {
      'com.openai': {
        interface: buildCodexInterface(),
      },
    },
  };
}

function buildAgyPluginManifest(version: string) {
  return {
    name: PLUGIN_NAME,
    displayName: PLUGIN_DISPLAY_NAME,
    description: PLUGIN_DESCRIPTION,
    version,
    author: PLUGIN_AUTHOR,
    repository: PLUGIN_REPOSITORY,
    logo: 'assets/logo.svg',
    suggestedPrompts: PLUGIN_SUGGESTED_PROMPTS,
  };
}

function buildCodexMarketplaceEntry(pluginRelPath: string) {
  return {
    name: PLUGIN_NAME,
    source: { source: 'local', path: pluginRelPath },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  };
}

function upsertCodexMarketplace(marketplacePath: string, pluginRelPath: string): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(marketplacePath)) {
    try {
      const parsed = JSON.parse(readFileSync(marketplacePath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      throw new InputError(`Invalid JSON in ${marketplacePath}`);
    }
  }
  const prevPlugins = Array.isArray(existing.plugins) ? existing.plugins : [];
  const filtered = prevPlugins.filter(item =>
    !(item && typeof item === 'object' && (item as { name?: unknown }).name === PLUGIN_NAME));
  const next = {
    name: typeof existing.name === 'string' && existing.name.trim() ? existing.name : PLUGIN_NAME,
    interface: existing.interface && typeof existing.interface === 'object' && !Array.isArray(existing.interface)
      ? existing.interface
      : { displayName: PLUGIN_DISPLAY_NAME },
    ...existing,
    plugins: [...filtered, buildCodexMarketplaceEntry(pluginRelPath)],
  };
  writeJsonAtomic(marketplacePath, next);
}

function writeStageJson(stageDir: string, relPath: string, value: unknown): void {
  const dest = join(stageDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function stagePluginContents(stageDir: string, kind: PluginBundleKind, selectedSkills: string[], agents: string[]): void {
  const version = bundlePackageVersion();
  mkdirSync(join(stageDir, 'skills'), { recursive: true });
  for (const name of selectedSkills) {
    cpSync(join(source, name), join(stageDir, 'skills', name), { recursive: true, force: false, errorOnExist: true });
  }
  mkdirSync(join(stageDir, 'agents'), { recursive: true });
  const agentHost: InstallHost = kind === 'codex' ? 'codex' : 'claude';
  for (const name of agents) {
    const rendered = renderAgentForHost(name, agentHost);
    writeFileSync(join(stageDir, 'agents', rendered.fileName), rendered.content, 'utf8');
  }
  mkdirSync(join(stageDir, 'assets'), { recursive: true });
  const logoSrc = join(assetsSource, 'logo.svg');
  const logoDest = join(stageDir, 'assets', 'logo.svg');
  if (existsSync(logoSrc)) cpSync(logoSrc, logoDest);
  else writeFileSync(logoDest, FALLBACK_LOGO_SVG, 'utf8');

  if (kind === 'claude') {
    writeStageJson(stageDir, '.claude-plugin/plugin.json', buildClaudePluginManifest(selectedSkills, version));
    return;
  }
  if (kind === 'codex') {
    writeStageJson(stageDir, 'plugin.json', buildPortablePluginManifest(version));
    writeStageJson(stageDir, '.codex-plugin/plugin.json', buildCodexCompatManifest(version));
    return;
  }
  if (kind === 'agy') {
    writeStageJson(stageDir, 'plugin.json', buildAgyPluginManifest(version));
    mkdirSync(join(stageDir, 'rules'), { recursive: true });
    writeFileSync(join(stageDir, 'rules', 'AGENTS.md'), buildPluginRulesMarkdown(), 'utf8');
    return;
  }
  writeStageJson(stageDir, '.claude-plugin/plugin.json', buildClaudePluginManifest(selectedSkills, version));
  writeStageJson(stageDir, '.claude-plugin/marketplace.json', buildClaudeMarketplaceManifest('./', version));
  writeStageJson(stageDir, '.codex-plugin/plugin.json', buildCodexCompatManifest(version));
  writeStageJson(stageDir, '.agents/plugins/marketplace.json', {
    name: PLUGIN_NAME,
    interface: { displayName: PLUGIN_DISPLAY_NAME },
    plugins: [buildCodexMarketplaceEntry('./')],
  });
  writeStageJson(stageDir, '.antigravity-plugin/plugin.json', buildAgyPluginManifest(version));
  mkdirSync(join(stageDir, 'rules'), { recursive: true });
  writeFileSync(join(stageDir, 'rules', 'AGENTS.md'), buildPluginRulesMarkdown(), 'utf8');
}

function hasPluginManifest(dir: string): boolean {
  return [
    join(dir, 'plugin.json'),
    join(dir, '.claude-plugin', 'plugin.json'),
    join(dir, '.codex-plugin', 'plugin.json'),
    join(dir, '.antigravity-plugin', 'plugin.json'),
  ].some(path => existsSync(path));
}

function installPluginBundleDir(
  pluginDir: string,
  kind: PluginBundleKind,
  selectedSkills: string[],
  options: { upgrade?: boolean; force?: boolean; checkExistingDir?: boolean } = {},
) {
  const agents = shippedAgents();
  const parent = dirname(pluginDir);
  mkdirSync(parent, { recursive: true });
  const destInfo = lstatSync(pluginDir, { throwIfNoEntry: false });
  if (destInfo?.isSymbolicLink()) throw new InputError('Use a regular plugin directory: ' + pluginDir);
  if (destInfo && !destInfo.isDirectory()) throw new InputError('Existing plugin path is not a directory: ' + pluginDir);
  if (destInfo && options.checkExistingDir && !options.force && !hasPluginManifest(pluginDir)) {
    const entries = readdirSync(pluginDir);
    if (entries.length > 0) {
      throw new InputError('Existing non-empty directory is not an Evolve plugin: ' + pluginDir);
    }
  }

  const stage = mkdtempSync(join(parent, '.evolve-plugin-install-'));
  try {
    const staged = join(stage, PLUGIN_NAME);
    stagePluginContents(staged, kind, selectedSkills, agents);
    const bundleHash = directorySha256(staged);
    const exists = Boolean(destInfo);
    const diskHash = exists ? directorySha256(pluginDir) : undefined;
    const shouldReplace = exists && (options.force || (options.upgrade && diskHash !== bundleHash));
    let actionStatus: 'installed' | 'upgraded' | 'kept' = 'kept';

    if (!exists || shouldReplace) {
      if (exists) {
        const backup = join(stage, `${PLUGIN_NAME}.backup`);
        renameSync(pluginDir, backup);
        try {
          renameSync(staged, pluginDir);
        } catch (error) {
          if (!existsSync(pluginDir) && existsSync(backup)) renameSync(backup, pluginDir);
          throw error;
        }
        actionStatus = 'upgraded';
      } else {
        renameSync(staged, pluginDir);
        actionStatus = 'installed';
      }
    }
    return {
      action_status: actionStatus,
      version: bundlePackageVersion(),
      sha256: bundleHash,
      disk_sha256: actionStatus === 'kept' ? (diskHash ?? bundleHash) : bundleHash,
      skills: selectedSkills,
      agents,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function resolvePluginTarget(root: string, scope: InstallScope, host: PluginHost): ResolvedPluginTarget {
  if (host === 'agy') {
    const pluginDir = scope === 'project'
      ? join(root, '.agents', 'plugins', PLUGIN_NAME)
      : join(homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);
    return {
      host,
      pluginDir,
      nextCommands: [`agy plugin validate ${JSON.stringify(pluginDir)} --strict`],
    };
  }
  if (host === 'claude') {
    const claudeDir = claudeConfigRoot();
    const marketplaceDir = scope === 'project'
      ? join(root, '.claude', 'plugins')
      : join(claudeDir, 'plugins', 'local');
    const pluginDir = join(marketplaceDir, PLUGIN_NAME);
    return {
      host,
      pluginDir,
      marketplaceDir,
      marketplacePath: join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      marketplaceRelPath: `./${PLUGIN_NAME}`,
      instructions: scope === 'project' ? join(root, 'CLAUDE.md') : join(claudeDir, 'CLAUDE.md'),
      skillsLabel: scope === 'project' ? `.claude/plugins/${PLUGIN_NAME}/skills/` : 'skills/',
      nextCommands: [
        `claude plugin marketplace add ${JSON.stringify(marketplaceDir)}`,
        `claude plugin install ${PLUGIN_NAME}@${PLUGIN_NAME} --scope ${scope}`,
      ],
    };
  }
  const codexDir = codexConfigRoot();
  if (scope === 'project') {
    const pluginDir = join(root, '.codex', 'plugins', PLUGIN_NAME);
    return {
      host: 'codex',
      pluginDir,
      marketplaceDir: root,
      marketplacePath: join(root, '.agents', 'plugins', 'marketplace.json'),
      marketplaceRelPath: `./.codex/plugins/${PLUGIN_NAME}`,
      instructions: join(root, 'AGENTS.md'),
      skillsLabel: `.codex/plugins/${PLUGIN_NAME}/skills/`,
      nextCommands: [
        `codex plugin marketplace add ${JSON.stringify(root)}`,
        `codex plugin add ${PLUGIN_NAME}@${PLUGIN_NAME}`,
      ],
    };
  }
  const userBase = homedir();
  const pluginDir = join(userBase, '.agents', 'plugins', PLUGIN_NAME);
  return {
    host: 'codex',
    pluginDir,
    marketplaceDir: userBase,
    marketplacePath: join(userBase, '.agents', 'plugins', 'marketplace.json'),
    marketplaceRelPath: `./.agents/plugins/${PLUGIN_NAME}`,
    instructions: join(codexDir, 'AGENTS.md'),
    skillsLabel: 'skills/',
    nextCommands: [
      `codex plugin add ${PLUGIN_NAME}@${PLUGIN_NAME}`,
    ],
  };
}

export function exportPlugins(root: string, outDir: string, options: PluginInstallOptions = {}) {
  const selectedSkills = selectSkills(shippedSkills(), options.skill ?? []);
  const destination = resolve(root, outDir);
  if (!options.host) {
    const result = installPluginBundleDir(destination, 'universal', selectedSkills, {
      upgrade: options.upgrade ?? true,
      force: options.force,
      checkExistingDir: true,
    });
    return {
      status: 'exported',
      mode: 'plugin',
      kind: 'universal',
      plugin_dir: destination,
      ...result,
    };
  }
  const selectedHosts = parsePluginHosts(options.host);
  if (selectedHosts.length === 1) {
    const host = selectedHosts[0];
    const result = installPluginBundleDir(destination, host, selectedSkills, {
      upgrade: options.upgrade ?? true,
      force: options.force,
      checkExistingDir: true,
    });
    return {
      status: 'exported',
      mode: 'plugin',
      host,
      plugin_dir: destination,
      ...result,
    };
  }
  const targets = selectedHosts.map(host => {
    const dir = join(destination, host);
    const result = installPluginBundleDir(dir, host, selectedSkills, {
      upgrade: options.upgrade ?? true,
      force: options.force,
      checkExistingDir: true,
    });
    return { host, plugin_dir: dir, ...result };
  });
  return {
    status: 'exported',
    mode: 'plugin',
    hosts: selectedHosts,
    out_dir: destination,
    skills: selectedSkills,
    targets,
  };
}

export function syncProjectSkills(
  root: string,
  options: { scope?: InstallScope; host?: string; skill?: string[]; force?: boolean } = {},
) {
  const resolvedRoot = resolve(root);
  const projectSkillsDir = join(resolvedRoot, 'skills');
  if (!existsSync(projectSkillsDir)) throw new InputError(`Project skills directory not found: ${projectSkillsDir}`);
  const available = readdirSync(projectSkillsDir, { withFileTypes: true })
    .filter(item => item.isDirectory() && existsSync(join(projectSkillsDir, item.name, 'SKILL.md')))
    .map(item => item.name)
    .sort();
  const requested = options.skill ?? [];
  const selected = requested.length
    ? requested.map(name => {
        if (!available.includes(name)) throw new InputError(`Project Skill package not found: skills/${name}`);
        return name;
      })
    : available.filter(name => !nonShippedSkills.has(name));
  if (!selected.length) throw new InputError('No project Skill packages found to sync');

  const scope: InstallScope = options.scope ?? 'project';
  const filePath = manifestPath(resolvedRoot, scope);
  const manifest = readManifest(filePath);
  const hostList = options.host
    ? parseInstallHosts(options.host)
    : installHosts.filter(host => {
        const target = scopeAndHost(resolvedRoot, scope, host);
        return Boolean(manifest.targets[resolve(target.skillsDir)]) || existsSync(target.skillsDir);
      });
  const selectedHosts = hostList.length ? hostList : [...installHosts];
  const now = new Date().toISOString();

  const targetResults = selectedHosts.map(host => {
    const target = scopeAndHost(resolvedRoot, scope, host);
    const skillsDir = target.skillsDir;
    if (lstatSync(skillsDir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new InputError('Use a regular skills directory');
    mkdirSync(skillsDir, { recursive: true });
    const targetKey = resolve(skillsDir);
    const existingRecord = manifest.targets[targetKey];
    const skillRecords: Record<string, InstalledSkillRecord> = { ...(existingRecord?.skills ?? {}) };
    const installed: string[] = [];
    const upgraded: string[] = [];
    const kept: string[] = [];

    for (const name of selected) {
      const sourceDir = join(projectSkillsDir, name);
      const dest = join(skillsDir, name);
      const sourceHash = directorySha256(sourceDir);
      const sourceVer = skillVersion(sourceDir);
      const destInfo = lstatSync(dest, { throwIfNoEntry: false });
      if (destInfo?.isSymbolicLink()) throw new InputError('Use a regular skill directory: ' + dest);
      const exists = Boolean(destInfo);
      const currentDiskHash = destInfo?.isDirectory() ? directorySha256(dest) : undefined;
      const isSameContent = Boolean(currentDiskHash && currentDiskHash === sourceHash);
      if (!exists || options.force || !isSameContent) {
        const stage = mkdtempSync(join(skillsDir, '.evolve-sync-'));
        try {
          const staged = join(stage, name);
          cpSync(sourceDir, staged, { recursive: true, force: false, errorOnExist: true });
          if (exists) {
            const backup = join(stage, `${name}.backup`);
            renameSync(dest, backup);
            try {
              renameSync(staged, dest);
            } catch (error) {
              if (!existsSync(dest) && existsSync(backup)) renameSync(backup, dest);
              throw error;
            }
            upgraded.push(name);
          } else {
            renameSync(staged, dest);
            installed.push(name);
          }
        } finally {
          if (dirname(stage) === skillsDir) rmSync(stage, { recursive: true, force: true });
        }
        const prev = skillRecords[name];
        skillRecords[name] = {
          version: sourceVer,
          sha256: sourceHash,
          installed_at: prev?.installed_at ?? now,
          updated_at: now,
        };
      } else {
        kept.push(name);
      }
    }

    manifest.targets[targetKey] = {
      scope,
      host,
      skills_dir: skillsDir,
      agents_dir: target.agentsDir,
      instructions: target.instructions,
      updated_at: now,
      package_version: bundlePackageVersion(),
      skills: skillRecords,
      ...(existingRecord?.agents ? { agents: existingRecord.agents } : {}),
    };
    // Managed instructions are refreshed together with the selected Skill packages.
    const labels = activeInstructionLabels(resolvedRoot, scope, target.instructions, [target.skillsLabel]);
    provisionInstructions(target.instructions, labels);
    return { host, skills_dir: skillsDir, installed, upgraded, kept };
  });

  writeManifest(filePath, manifest);
  return {
    status: 'synced',
    scope,
    skills: selected,
    manifest_path: filePath,
    targets: targetResults,
  };
}

export async function installPlugins(root: string, options: PluginInstallOptions = {}) {
  if (options.path) {
    return exportPlugins(root, options.path, options);
  }
  let scope: InstallScope = options.scope ?? 'project';
  let selectedHosts = options.host === undefined ? undefined : parsePluginHosts(options.host);
  let requested = options.skill ?? [];
  const shipped = shippedSkills();

  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new InputError('Use an interactive terminal or pass --yes');
    }
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(workflowTitle + ' plugin installer\n\n');
      if (!options.scope && !selectedHosts) {
        const answer = (await ui.question('Install plugin to [1] project or [2] user profile [1]? ')).trim();
        if (answer && answer !== '1' && answer !== '2') throw new InputError('Choose project (1) or user (2)');
        scope = answer === '2' ? 'user' : 'project';
      }
      if (!selectedHosts) {
        const answer = (await ui.question('Host [1] Codex, [2] Claude, [3] Agy or [4] All [4]? ')).trim() || '4';
        if (!['1', '2', '3', '4'].includes(answer)) throw new InputError('Choose Codex (1), Claude (2), Agy (3) or All (4)');
        selectedHosts = answer === '1' ? ['codex'] : answer === '2' ? ['claude'] : answer === '3' ? ['agy'] : [...pluginHosts];
      }
      const selected = selectSkills(shipped, requested);
      const targets = selectedHosts.map(host => resolvePluginTarget(root, scope, host));
      const destination = targets.map(item => item.pluginDir).join(', ');
      const verb = options.upgrade ? 'Install/upgrade' : 'Install';
      const answer = (await ui.question(`${verb} plugin (${selected.length} skills) in ${destination}? [y/N] `)).trim();
      if (!/^y(?:es)?$/i.test(answer)) return { status: 'cancelled' };
    } finally {
      ui.close();
    }
  }

  const hostsToInstall = selectedHosts ?? [...pluginHosts];
  const selectedSkills = selectSkills(shipped, requested);
  const filePath = manifestPath(root, scope);
  const manifest = readManifest(filePath);
  const pluginsRecord: Record<string, PluginManifestRecord> = { ...(manifest.plugins ?? {}) };
  const now = new Date().toISOString();
  const instructionGroups = new Map<string, string[]>();

  const targetResults = hostsToInstall.map(host => {
    const resolved = resolvePluginTarget(root, scope, host);
    const result = installPluginBundleDir(resolved.pluginDir, host, selectedSkills, {
      upgrade: options.upgrade,
      force: options.force,
    });
    if (host === 'claude' && resolved.marketplacePath && resolved.marketplaceRelPath) {
      writeJsonAtomic(resolved.marketplacePath, buildClaudeMarketplaceManifest(resolved.marketplaceRelPath, result.version));
    } else if (host === 'codex' && resolved.marketplacePath && resolved.marketplaceRelPath) {
      upsertCodexMarketplace(resolved.marketplacePath, resolved.marketplaceRelPath);
    }
    if (resolved.instructions && resolved.skillsLabel) {
      const labels = instructionGroups.get(resolved.instructions) ?? [];
      labels.push(resolved.skillsLabel);
      instructionGroups.set(resolved.instructions, labels);
    }
    const key = resolve(resolved.pluginDir);
    const prev = pluginsRecord[key];
    pluginsRecord[key] = {
      scope,
      host,
      plugin_dir: resolved.pluginDir,
      ...(resolved.marketplacePath ? { marketplace_path: resolved.marketplacePath } : {}),
      ...(resolved.instructions ? { instructions: resolved.instructions } : {}),
      version: result.version,
      sha256: result.disk_sha256,
      skills: result.skills,
      agents: result.agents,
      installed_at: prev?.installed_at ?? now,
      updated_at: now,
    };
    return {
      host,
      plugin_dir: resolved.pluginDir,
      ...(resolved.marketplacePath ? { marketplace_path: resolved.marketplacePath } : {}),
      ...(resolved.instructions ? { instructions: resolved.instructions } : {}),
      ...result,
      next_commands: resolved.nextCommands,
    };
  });

  for (const [instructionsPath, labels] of instructionGroups) {
    provisionInstructions(instructionsPath, labels);
  }
  manifest.plugins = pluginsRecord;
  writeManifest(filePath, manifest);

  if (targetResults.length === 1) {
    return {
      status: 'installed',
      mode: 'plugin',
      scope,
      manifest_path: filePath,
      ...targetResults[0],
    };
  }
  return {
    status: 'installed',
    mode: 'plugin',
    scope,
    hosts: hostsToInstall,
    manifest_path: filePath,
    targets: targetResults,
    next_commands: targetResults.flatMap(item => item.next_commands),
  };
}

export function pluginStatus(root: string, options: { scope?: InstallScope; host?: string } = {}) {
  const scope: InstallScope = options.scope ?? 'project';
  const filePath = manifestPath(root, scope);
  const manifest = readManifest(filePath);
  const selectedHosts = options.host ? parsePluginHosts(options.host) : [...pluginHosts];
  const selectedSkills = shippedSkills();
  const agents = shippedAgents();

  const targets = selectedHosts.map(host => {
    const resolved = resolvePluginTarget(root, scope, host);
    const record = manifest.plugins?.[resolve(resolved.pluginDir)];
    const onDisk = hasPluginManifest(resolved.pluginDir);
    const stage = mkdtempSync(join(tmpdir(), 'evolve-plugin-status-'));
    let bundleHash = '';
    try {
      const staged = join(stage, PLUGIN_NAME);
      mkdirSync(staged, { recursive: true });
      stagePluginContents(staged, host, selectedSkills, agents);
      bundleHash = directorySha256(staged);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    const diskHash = onDisk ? directorySha256(resolved.pluginDir) : undefined;
    const status = !onDisk ? 'not_installed' : diskHash === bundleHash ? 'up_to_date' : 'outdated';
    return {
      host,
      plugin_dir: resolved.pluginDir,
      ...(resolved.marketplacePath ? { marketplace_path: resolved.marketplacePath } : {}),
      status,
      on_disk: onDisk,
      manifest_recorded: Boolean(record),
      bundle_version: bundlePackageVersion(),
      ...(record ? { installed_version: record.version } : {}),
      ...(diskHash ? { installed_sha256: diskHash } : {}),
      bundle_sha256: bundleHash,
    };
  });

  return {
    schema_version: 'evolve-plugin-status/1.0',
    scope,
    manifest_path: filePath,
    manifest_exists: existsSync(filePath),
    bundle_version: bundlePackageVersion(),
    targets,
  };
}
