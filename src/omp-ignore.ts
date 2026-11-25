import { InputError } from './common.js';
import type { OmpExtensionApi } from './omp-contract.js';
import { manageEvolveIgnore } from './workflow-ignore.js';

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
        const result = manageEvolveIgnore(ctx.cwd, input);
        const outcome = result.status === 'up_to_date' ? '规则已齐全，未修改。'
          : `${result.status === 'missing' ? '缺少规则（未写入）' : '已补齐规则'}：\n${result.missing.join('\n')}`;
        const warning = result.tracked.length ? `\n以下目录中有已被 Git 跟踪的文件，忽略规则不会取消跟踪：${result.tracked.join('、')}` : '';
        ctx.ui.notify(`${result.gitignore_path}\n${outcome}${warning}`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
