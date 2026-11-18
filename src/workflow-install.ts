import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { EVOLVE_DIR, InputError, evolveDir } from './common.js';
import { workflowName } from './workflow-names.js';

const bundle = fileURLToPath(new URL('../', import.meta.url));
const source = join(bundle, 'skills');
const agentsSource = join(bundle, 'agents');
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
    project: { path: ['.omp', 'agent'], instructions: ['AGENTS.md'] },
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

interface InstallOptions {
  scope?: InstallScope;
  host?: string;
  skill?: string[];
  yes?: boolean;
  upgrade?: boolean;
  prune?: boolean;
  force?: boolean;
}

export interface InstallSkillsOptions {
  upgrade?: boolean;
  prune?: boolean;
  force?: boolean;
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
  instructions: string;
  updated_at: string;
  package_version: string;
  skills: Record<string, InstalledSkillRecord>;
  agents?: Record<string, InstalledSkillRecord>;
}

interface InstallManifest {
  schema_version: typeof INSTALL_MANIFEST_VERSION;
  targets: Record<string, TargetManifestRecord>;
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

function bundlePackageVersion(): string {
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
      return { schema_version: INSTALL_MANIFEST_VERSION, targets: parsed.targets };
    }
  } catch {
    // 损坏的旧记录不阻断重装，重建为空记录。
  }
  return { schema_version: INSTALL_MANIFEST_VERSION, targets: {} };
}

function writeManifest(path: string, manifest: InstallManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.install-manifest-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function workflowDocuments(): WorkflowDocument[] {
  const documents: WorkflowDocument[] = JSON.parse(readFileSync(join(bundle, 'workflows', 'index.json'), 'utf8'));
  const skills = shippedSkills();
  return documents.filter(item => skills.includes(item.path.split('/')[1]));
}

export function workflowDocument(id: string) {
  const name = id === 'odyssey' || id === 'skill-design' ? 'ew-' + id : workflowName(id);
  const document = workflowDocuments().find(item => item.id === name);
  if (!document) throw new InputError('Unknown workflow: ' + id);
  return readFileSync(join(bundle, document.path), 'utf8');
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

  const agentInstall = installAgentsToTarget(target, installBase, existingRecord?.agents ?? {}, now, options);

  manifest.targets[targetKey] = {
    scope,
    host: target.host ?? null,
    skills_dir: skillsDir,
    agents_dir: target.agentsDir,
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
    return installSkillsToTarget(projectRootTarget(root), 'project', root, requested, options);
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
  const locations = [...new Set(skillsLabels)].map(label => '`' + label + '`').join(' or ');
  return [
    instructionStartMarker,
    '# ' + workflowTitle,
    '',
    `When a project uses Evolve Session/Run orchestration (\`ew-orchestrate\`) or the user invokes it, read the relevant package in ${locations} for a project installation and commit those packages so Evolve can bind Runs to a Git revision. Keep ordinary task orchestration (\`ew-orchestrate\`) separate from Skill/harness modification (\`workflow-evolve\`, explicit \`/workflow-evolve\` only).`,
    '',
    '## Knowledge Gate',
    '',
    '- Run `evolve search "<task keywords>" --mode context` before inspecting project files. Follow project instructions for knowledge scope, open controlling entries by ID (`evolve kb get <id> --resolved` or `evolve kb get <id>`), and record Run knowledge reads.',
    '- Never write `wiki/entries/`, `.workflow/specs/`, or `.workflow/knowhow/` directly; publish or update Wiki entries only through governed `evolve kb propose` / `evolve kb apply` commands.',
    '- Run `evolve skill workflows` to list bundled workflow docs and `evolve skill workflows show session-run` (or `evolve skill workflows show <id>`) to read Session/Run dispatch, Knowledge Gate, and recovery rules.',
    '- Use `evolve kb import` to preview legacy Spec and Knowhow in the source project. Add `--apply` to import them.',
    '',
    '## Memory Recording',
    '',
    '- Record useful working evidence as `--kind episodic` during execution. On the first confirmed misunderstanding or user correction, save the mistaken interpretation, the correction and its basis before continuing work that depends on it; do not wait for repeated corrections or task completion.',
    '- Also record key evidence that changes a judgment or rules out a hypothesis, confirmed requirements and decisions with their rationale, informative failed approaches with their conditions, non-obvious verified methods, and blockers needed for handoff. Evidence can be recorded before the root cause is known; label unresolved conclusions as unverified.',
    '- Each memory must be independently understandable: include the subject, applicable project/version/environment, observation or decision, evidence/source references and verification state. Distinguish user decisions, suggestions, tool observations and Agent inferences; omit fragments, routine progress and unsupported causes. Use `correction`, `work_fact`, `error` or `verified_fix` as appropriate; reserve `verified_fix` for a demonstrated fix.',
    '- Search for an existing memory before adding one. Update the same subject when conclusions change, preserve supporting sources, and state what is superseded or still unresolved. Omitting `--evidence` preserves existing source IDs; supplying it replaces the source list, so repeat `--evidence` for every old and new reference that should remain. Keep project-specific evidence in project scope; do not silently turn it into a global rule.',
    '- Before context compaction, handoff and task closeout, check that material findings and unresolved state were saved. Background extraction and reminders are fallback mechanisms. Confirm the write result and read back the record with `evolve kb get <id>` before claiming it was saved.',
    '',
    '## Wiki Recording',
    '',
    '- Propose Wiki knowledge when a reusable method, reference or constraint has sufficient evidence and a stable applicability scope. During a Run, stage findings and evidence in its required outputs/report; after the whole Session completes, run its returned `closeout_command`. For a standalone task, harvest the actual host conversation. Do not wait until closeout to save important working memory.',
    '- Compare candidates with existing entries before proposing additions, updates or retirements. Keep suggestions, unresolved hypotheses and one-off task state in working memory; do not promote them as established Wiki knowledge.',
    '- `kb harvest` generates review candidates; an exact duplicate may only supplement sources through governance. `kb propose` stages a change without publishing it. Inspect the concrete change and apply it only within explicit human authorization for its IDs, targets and action; otherwise retain it for review. Follow `evolve skill workflows show ew-knowledge` for publication and conflict handling.',
    '',
    '## Key Knowledge Commands',
    '',
    '| Command | Purpose and timing |',
    '| --- | --- |',
    '| `evolve search "<keywords>" --mode context` | Before project exploration or a change of scope, retrieve applicable constraints, references, memories and code. |',
    '| `evolve kb get <id>` / `evolve kb sources <memory-id>` | Read a complete record; trace a memory to its original messages when its meaning or evidence is uncertain. |',
    '| `evolve kb add "<memory>" --kind episodic --type <type> --scene <step> --session <session-id> --evidence <source-ref>` | Save an in-flight memory immediately; include real evidence references, not invented IDs. |',
    '| `evolve kb update <memory-id> "<revised memory>" --kind episodic` | Revise content while retaining original provenance. To replace sources, add repeated `--evidence <source-ref>` flags containing the full desired source list. |',
    '| `evolve kb delete <memory-id> --kind episodic` | Remove an exact memory when explicitly requested; do not use it to hide failed attempts. |',
    '| `evolve kb harvest session <session-id> --project <project-id>` | After Evolve Session completion, collect evidence-backed Wiki candidates; prefer the returned `closeout_command`. |',
    '| `evolve kb harvest conversation <conversation-id> --host <host> --project <project-id>` | Collect candidates after a standalone task using its actual conversation ID and host (`codex`, `claude` or `agy`). |',
    '| `evolve kb candidates show <receipt-id> --project <project-id>` | Inspect candidates using `receipt_id` from the harvest result and the same `--project` value. |',
    '| `evolve kb propose <change.json> --evidence <source-ref>` / `evolve kb changes <change-id>` | Stage and inspect a governed Wiki change; neither command publishes it. |',
    '| `evolve kb apply <change-id>` | Publish the inspected Wiki change after authorization, then read back the affected entry and change receipt. |',
    '',
    'Use actual IDs returned by the CLI and the intended project root (`--root <project-root>`). In a Run, use the same `--reads "<run-dir>/knowledge-reads.json"` for searches and exact reads, bind searches with `--session <session-id>`, and link reads with `--from-search <search-id>`. Reads default to local project + global knowledge; writes default to project. Consult `evolve kb --help` for additional options.',
    '',
    '## Closeout & Self-Evolution',
    '',
    '- After `evolve session complete`, run its `closeout_command` (`evolve kb harvest session <id> --project <id>`). Do not auto-invoke `workflow-evolve` during task execution; only mention `/workflow-evolve` at closeout when `evolve_reminder` reflects a confirmed Skill or workflow defect.',
    '- At standalone task closeout, check memory completeness and harvest reusable findings using the actual conversation ID and host as described above; zero eligible Wiki candidates is valid.',
    '- Reserve `workflow-evolve` (`disable-model-invocation: true`) for explicit user requests to modify Skill/harness behavior (`skills/<id>/SKILL.md`), never for ordinary code bugs, failing tests, or routine task execution. Only suggest `/workflow-evolve` when repeated corrections (`>= 2`) or retries clearly expose a Skill/process gap; record the first user correction directly in episodic memory.',
    instructionEndMarker,
  ].join(newline);
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
  const config = hosts[host][scope];
  const base = scope === 'project' ? root : homedir();
  const target = join(base, ...config.path);
  return {
    host,
    target,
    skillsDir: join(target, 'skills'),
    agentsDir: join(target, 'agents'),
    instructions: join(base, ...config.instructions),
    skillsLabel: scope === 'project' ? `${config.path.join('/')}/skills/` : 'skills/',
  };
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
    const agents = targetAgentStatuses(target, record);
    return {
      ...(target.host ? { host: target.host } : {}),
      root: target.target,
      skills_dir: target.skillsDir,
      agents_dir: target.agentsDir,
      instructions: target.instructions,
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
    provisionInstructions(instructionsPath, labels);
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
