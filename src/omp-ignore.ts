import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';
import { InputError } from './common.js';
import type { OmpExtensionApi } from './omp-contract.js';
import { gitText } from './openviking/git.js';

const directories = ['.evolve/', '.agent-memory/', '.codegraph/'];
const usage = '/evolve-ignore [check|apply|help]';
const actions = [
  { value: 'check', label: 'check', description: '检查缺少的忽略规则，不写入' },
  { value: 'apply', label: 'apply', description: '补齐仓库根 .gitignore 的忽略规则（默认）' },
  { value: 'help', label: 'help', description: '查看用法' },
];

export function registerOmpIgnore(api: OmpExtensionApi) {
  api.registerCommand('evolve-ignore', {
    description: 'Self-Evolving Workflow：补齐当前仓库 .gitignore 中的 Evolve 本地产物规则',
    getArgumentCompletions: prefix => actions.filter(action => action.value.startsWith(prefix.trimStart())),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new InputError('请在交互式 OMP 会话中运行 /evolve-ignore');
      try {
        const input = args.trim() || 'apply';
        if (input === 'help') {
          ctx.ui.notify(`${usage}\ncheck 只检查，不写入；apply 补齐仓库根 .gitignore，省略子命令时默认 apply。`, 'info');
          return;
        }
        if (input !== 'check' && input !== 'apply') throw new InputError(usage);
        const root = gitText(ctx.cwd, ['rev-parse', '--show-toplevel']);
        const path = join(root, '.gitignore');
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat && !stat.isFile()) throw new InputError('仓库根 .gitignore 不是普通文件，未修改。');
        const current = stat ? readFileSync(path, 'utf8') : '';
        const matcher = ignore({ ignorecase: false }).add(current);
        const missing = directories.filter(dir => !matcher.ignores(dir)).map(dir => `/${dir}`);
        const indexed = gitText(root, ['ls-files', '-z', '--', ...directories]).split('\0');
        const tracked = directories.filter(dir => indexed.some(file => file.startsWith(dir)));
        if (missing.length && input === 'apply') {
          const eol = current.match(/\r?\n/)?.[0] ?? '\n';
          const separator = current ? (current.endsWith('\n') ? eol : eol + eol) : '';
          appendFileSync(path, `${separator}# Evolve 本地运行产物${eol}${missing.join(eol)}${eol}`);
        }
        const outcome = !missing.length ? '规则已齐全，未修改。'
          : `${input === 'check' ? '缺少规则（未写入）' : '已补齐规则'}：\n${missing.join('\n')}`;
        const warning = tracked.length ? `\n以下目录中有已被 Git 跟踪的文件，忽略规则不会取消跟踪：${tracked.join('、')}` : '';
        ctx.ui.notify(`${path}\n${outcome}${warning}`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
