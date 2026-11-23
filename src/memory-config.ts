import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EVOLVE_DIR, InputError, LEGACY_AGENT_MEMORY_DIR, resolveEvolveStorage } from './common.js';

const hosts = {
  codex: { label: 'Codex', file: ['.codex', 'hooks.json'] },
  claude: { label: 'Claude Code', file: ['.claude', 'settings.local.json'] },
  agy: { label: 'Antigravity CLI', file: ['.agents', 'hooks.json'] },
} as const;

export type MemoryHost = keyof typeof hosts;
export type MemoryConfigScope = 'project' | 'user';
export type MemoryHookAction = 'host-hook' | 'session-start-hook';
export const memoryHosts = Object.keys(hosts) as MemoryHost[];
const agyHookName = 'evolve-agent-memory';
const codexStatus = 'Extracting Agent Memory from Codex';
const codexStartStatus = 'Loading Agent Memory reminders for Codex';

type JsonObject = Record<string, unknown>;
interface JsonFile { path: string; previous?: string; content: JsonObject }

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function readJson(path: string): JsonFile {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (previous === undefined) return { path, content: {} };
  let content: JsonObject | undefined;
  try {
    content = object(JSON.parse(previous.replace(/^\uFEFF/, '')));
  } catch {
    throw new InputError(`Invalid JSON in ${path}`);
  }
  if (!content) throw new InputError(`Expected a JSON object in ${path}`);
  return { path, previous, content };
}

function replaceJson({ path, previous, content }: JsonFile) {
  const result = JSON.stringify(content, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, result, { flag: 'wx' });
    if ((existsSync(path) ? readFileSync(path, 'utf8') : undefined) !== previous) {
      throw new InputError(`Configuration changed while saving ${path}`);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function quoteCommand(args: string[]): string {
  if (process.platform === 'win32') {
    return '& ' + args.map(arg => `'${arg.replaceAll("'", "''")}'`).join(' ');
  }
  return args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
}

const agyWindowsHook = ' memory host-hook --host agy';

function hookPath(root: string, host: MemoryHost, scope: MemoryConfigScope): string {
  if (scope === 'project') return join(root, ...hosts[host].file);
  if (host === 'codex') return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
  if (host === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  return join(homedir(), '.gemini', 'config', 'hooks.json');
}

function agyWindowsCommand(entry: string, root: string, action: MemoryHookAction, scope: MemoryConfigScope) {
  // Antigravity 在 Windows 按空白拆词且不做引号反转义，命令必须保持无引号、无未编码空白。
  const rootFlag = scope === 'user' ? '--root auto' : `--root-b64 ${Buffer.from(root).toString('base64url')}`;
  const background = action === 'host-hook' ? ' --background' : '';
  if (!/\s/.test(entry)) {
    return `node ${entry} kb ${action} --host agy ${rootFlag}${background}`;
  }
  const urlB64 = Buffer.from(pathToFileURL(entry).href).toString('base64url');
  return `node --input-type=module -e process.argv.splice(1,0,0),import(Buffer.from('${urlB64}','base64url').toString()) kb ${action} --host agy ${rootFlag}${background}`;
}

function memoryHandler(host: MemoryHost, root: string, scope: MemoryConfigScope = 'project', action: MemoryHookAction = 'host-hook') {
  const args = host === 'codex' && action === 'host-hook' ? ['codex-hook'] : [action, '--host', host];
  const rootArgs = scope === 'user' ? ['--root', 'auto'] : ['--root', root];
  const backgroundArgs = action === 'host-hook' ? ['--background'] : [];
  const entry = fileURLToPath(new URL('./workflow-cli.js', import.meta.url));
  const command = host === 'agy' && process.platform === 'win32'
    ? agyWindowsCommand(entry, root, action, scope)
    : quoteCommand([process.execPath, entry, 'kb', ...args, ...rootArgs, ...backgroundArgs]);
  return { type: 'command', command, timeout: 300,
    ...(host === 'codex' ? { statusMessage: action === 'host-hook' ? codexStatus : codexStartStatus } : {}),
    ...(host === 'claude' && process.platform === 'win32' ? { shell: 'powershell' } : {}),
  };
}

function ownsHandler(host: MemoryHost, value: unknown, action: MemoryHookAction): boolean {
  const hook = object(value);
  if (typeof hook?.command !== 'string') return false;
  const command = hook.command;
  if (host === 'codex') {
    return (hook.statusMessage === codexStatus || hook.statusMessage === codexStartStatus) &&
      command.includes(action === 'host-hook' ? 'codex-hook' : 'session-start-hook');
  }
  if (host === 'agy') {
    if (action === 'host-hook' && command.startsWith('node --input-type=commonjs -e ') && command.endsWith(agyWindowsHook)) return true;
    if (new RegExp(` (?:memory|kb) ${action} --host agy (?:--root-b64 [A-Za-z0-9_-]+|--root auto)(?: --background)?$`).test(command)) return true;
    return ['memory', 'kb'].some(group =>
      command.includes(`'${group}' '${action}' '--host' 'agy'`));
  }
  return ['memory', 'kb'].some(group => command.includes(`'${group}' '${action}' '--host' '${host}' '--root'`));
}

function hookFile(root: string, host: MemoryHost, scope: MemoryConfigScope = 'project') {
  const file = readJson(hookPath(root, host, scope));
  if (host === 'agy') {
    const own = object(file.content[agyHookName]);
    const validStop = Array.isArray(own?.Stop) && own.Stop.length === 1 && ownsHandler(host, own.Stop[0], 'host-hook');
    const validSessionStart = own?.SessionStart === undefined ||
      (Array.isArray(own.SessionStart) && own.SessionStart.length <= 1 && own.SessionStart.every(item => ownsHandler(host, item, 'session-start-hook')));
    if (file.content[agyHookName] !== undefined && (!validStop || !validSessionStart)) {
      throw new InputError(`Conflicting hook ${agyHookName} in ${file.path}`);
    }
    return { file, configured: !!own && own.enabled !== false, update(enable: boolean) {
      if (!enable && !own) return;
      const { [agyHookName]: previousHook, ...other } = file.content;
      const next = enable ? {
        ...own,
        enabled: true,
        SessionStart: [memoryHandler(host, root, scope, 'session-start-hook')],
        Stop: [memoryHandler(host, root, scope, 'host-hook')],
      } : undefined;
      if (JSON.stringify(next) === JSON.stringify(previousHook)) return;
      return { ...file, content: next ? { ...other, [agyHookName]: next } : other };
    } };
  }
  const hooks = file.content.hooks === undefined ? {} : object(file.content.hooks);
  if (!hooks) throw new InputError(`Invalid hooks in ${file.path}`);
  const events = ([['Stop', 'host-hook'], ['SessionStart', 'session-start-hook']] as const).map(([name, action]) => {
    const groups = hooks[name] ?? [];
    if (!Array.isArray(groups)) throw new InputError(`Invalid ${name} hooks in ${file.path}`);
    const own = groups.flatMap(group => Array.isArray(group?.hooks)
      ? group.hooks.filter((handler: unknown) => ownsHandler(host, handler, action)) : []);
    return { name, action, groups, own };
  });
  return { file, configured: events[0].own.length > 0, update(enable: boolean) {
    const nextHooks = { ...hooks };
    for (const { name, action, groups, own } of events) {
      if (!enable && !own.length) continue;
      const entry = memoryHandler(host, root, scope, action);
      if (enable && own.length === 1 && JSON.stringify(own[0]) === JSON.stringify(entry)) continue;
      const otherGroups = groups.flatMap(group => {
        if (!Array.isArray(group?.hooks) || !group.hooks.some((handler: unknown) => ownsHandler(host, handler, action))) return [group];
        const remaining = group.hooks.filter((handler: unknown) => !ownsHandler(host, handler, action));
        return remaining.length ? [{ ...group, hooks: remaining }] : [];
      });
      if (!enable && name === 'SessionStart' && !otherGroups.length) delete nextHooks[name];
      else nextHooks[name] = enable ? [...otherGroups, { hooks: [entry] }] : otherGroups;
    }
    if (JSON.stringify(nextHooks) === JSON.stringify(hooks)) return;
    return { ...file, content: { ...file.content, hooks: nextHooks } };
  } };
}

export function installCodexMemoryHook(root: string) {
  const hook = hookFile(root, 'codex');
  const updated = hook.update(true);
  if (updated) replaceJson(updated);
  return { path: hook.file.path, changed: !!updated };
}

function globalConfigPath() {
  return join(homedir(), EVOLVE_DIR, 'config.json');
}

function settingsFile(root: string, scope: MemoryConfigScope = 'project') {
  if (scope === 'user') return readJson(globalConfigPath());
  return readJson(resolveEvolveStorage(root, ['config.json'], join(resolve(root), LEGACY_AGENT_MEMORY_DIR, 'config.json')));
}

function setting(file: JsonFile, field: string) {
  const value = file.content[field];
  if (value !== undefined && typeof value !== 'string') throw new InputError(`Invalid ${field} in ${file.path}`);
  return value;
}

function timeoutSetting(file: JsonFile): number | undefined {
  const value = file.content.timeoutMs;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InputError(`Invalid timeoutMs in ${file.path}`);
  }
  return Math.floor(value);
}

export function memoryModelSettings(root: string) {
  const { AGENT_MEMORY_LLM_BASE_URL: baseUrl, AGENT_MEMORY_LLM_MODEL: model, AGENT_MEMORY_LLM_TIMEOUT_MS: rawTimeout } = process.env;
  const trimmedTimeout = rawTimeout?.trim();
  const parsedTimeout = trimmedTimeout ? Number(trimmedTimeout) : undefined;
  if (parsedTimeout !== undefined && (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)) {
    throw new InputError('AGENT_MEMORY_LLM_TIMEOUT_MS must be a positive number');
  }
  const envTimeout = parsedTimeout === undefined ? undefined : Math.floor(parsedTimeout);
  const projectFile = settingsFile(root, 'project');
  const globalFile = resolve(root) === resolve(dirname(globalConfigPath()))
    ? projectFile
    : readJson(globalConfigPath());
  return {
    baseUrl: baseUrl || setting(projectFile, 'baseUrl') || setting(globalFile, 'baseUrl'),
    model: model || setting(projectFile, 'model') || setting(globalFile, 'model'),
    timeoutMs: envTimeout ?? timeoutSetting(projectFile) ?? timeoutSetting(globalFile),
  };
}

export function parseMemoryHosts(value: string, allowNone = false): MemoryHost[] {
  if (value.toLowerCase() === 'all') return memoryHosts;
  if (allowNone && value.toLowerCase() === 'off') return [];
  const selected = value.toLowerCase().split(',').map(item => item.trim());
  if (selected.some(host => !memoryHosts.includes(host as MemoryHost))) {
    throw new InputError(`Choose ${memoryHosts.join(', ')} or all${allowNone ? ' or off' : ''}`);
  }
  return memoryHosts.filter(host => selected.includes(host));
}

interface ConfigOptions { scope?: MemoryConfigScope; host?: string; baseUrl?: string; model?: string; timeoutMs?: number; yes?: boolean }

export async function configureMemory(root: string, options: ConfigOptions) {
  const scope = options.scope ?? 'project';
  const file = settingsFile(root, scope);
  const hooks = memoryHosts.map(host => ({ host, ...hookFile(root, host, scope) }));
  const currentHosts = hooks.filter(hook => hook.configured).map(hook => hook.host);
  let selected = options.host;
  let baseUrl = options.baseUrl ?? setting(file, 'baseUrl');
  let model = options.model ?? setting(file, 'model');
  const timeoutMs = options.timeoutMs ?? timeoutSetting(file);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new InputError('Timeout must be a positive number of milliseconds');
  }
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new InputError('Use an interactive terminal or pass --yes');
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\nAgent Memory (${scope})\n${scope === 'user' ? homedir() : root}\n\nAutomatic extraction\n`);
      for (const { host, configured } of hooks) {
        process.stdout.write(`  ${configured ? '[x]' : '[ ]'} ${host.padEnd(7)} ${hosts[host].label}\n`);
      }
      selected ??= (await ui.question('Host names, all, or off [keep current]: ')).trim() || undefined;
      if (selected !== undefined) parseMemoryHosts(selected, true);
      process.stdout.write('\nExtraction model (AGENT_MEMORY_LLM_* environment variables take precedence)\n');
      baseUrl = (await ui.question(`Base URL${baseUrl ? ` [${baseUrl}]` : ' [environment]'}: `)).trim() || baseUrl;
      model = (await ui.question(`Model${model ? ` [${model}]` : ' [environment]'}: `)).trim() || model;
      if (!/^y(?:es)?$/i.test((await ui.question(`Save ${scope} settings? [y/N] `)).trim())) return { status: 'cancelled' };
    } finally {
      ui.close();
    }
  }

  if (baseUrl !== undefined) {
    if (!URL.canParse(baseUrl) || !['http:', 'https:'].includes(new URL(baseUrl).protocol)) {
      throw new InputError('Base URL must start with http:// or https://');
    }
  }
  const enabled = selected === undefined ? currentHosts : parseMemoryHosts(selected, true);
  const updates = hooks.map(hook => hook.update(enabled.includes(hook.host)));
  const content = {
    ...file.content,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: Math.floor(options.timeoutMs) }),
  };
  if (JSON.stringify(content) !== JSON.stringify(file.content)) replaceJson({ ...file, content });
  for (const update of updates) if (update) replaceJson(update);
  const resolved = memoryModelSettings(scope === 'user' ? dirname(globalConfigPath()) : root);
  return {
    status: 'configured',
    scope,
    settings_path: file.path,
    hosts: hooks.map(({ host, file }) => ({ host, configured: enabled.includes(host), path: file.path })),
    model_configured: !!(resolved.model && resolved.baseUrl),
    ...(enabled.includes('codex') ? { codex: 'Review and trust the hooks with /hooks or Settings > Hooks in Codex.' } : {}),
  };
}
