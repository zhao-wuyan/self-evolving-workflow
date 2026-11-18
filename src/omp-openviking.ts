import { realpathSync } from 'node:fs';
import { InputError } from './common.js';
import type { OmpExtensionApi } from './omp-contract.js';
import { connectionConfig, readProject } from './openviking/config.js';
import { gitText } from './openviking/git.js';
import { initializeProject } from './openviking/lifecycle.js';
import { workflowHead, workflowPath } from './workflow-skills.js';

const usage = '/evolve-openviking init [策略文件]';

export function registerOmpOpenViking(api: OmpExtensionApi) {
  api.registerCommand('evolve-openviking', {
    description: '显式初始化 OpenViking 项目资产同步，不是个人经验采集',
    getArgumentCompletions: prefix => 'init'.startsWith(prefix.trimStart())
      ? [{ value: 'init ', label: 'init [策略文件]', description: '默认 evolution.json；确认后创建 Git 基线并发布首个项目资产版本' }]
      : null,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new InputError('请在交互式 OMP 中运行此命令，或使用 evolve openviking init CLI');
      try {
        const input = args.trim();
        if (!input || input === 'help' || input === '--help') {
          ctx.ui.notify(`${usage}\n默认策略文件：evolution.json。策略、回放脚本和场景文件必须先提交到 Git。\n只想开启个人经验采集？用 /evolve-experience enable。`, 'info');
          return;
        }
        const match = /^init(?:\s+(.+))?$/.exec(input);
        if (!match || match[1]?.startsWith('--')) throw new InputError(usage);
        const root = realpathSync(ctx.cwd);
        if (realpathSync(gitText(root, ['rev-parse', '--show-toplevel'])) !== root) throw new InputError('请从项目 Git 根目录运行此命令');
        const base = workflowHead(root);
        const existing = readProject(root);
        const policy = workflowPath(match[1]?.replace(/^("|')(.*)\1$/, '$2') ?? existing?.evolution_policy ?? 'evolution.json');
        if (existing && policy !== existing.evolution_policy) throw new InputError('该项目已绑定另一份策略，不会切换现有配置');
        const session = ctx.sessionManager.getSessionId();
        const connection = connectionConfig();
        const effect = existing
          ? '读取已有项目版本；若上次初始化未完成，会重试发布。'
          : '会创建 Git 基线（含 .evolve/openviking.json，可能补装 Skills），并向服务发布项目 Skills、经批准的 Wiki 和明确标记共享的记忆。';
        if (!await ctx.ui.confirm('确认初始化 OpenViking 项目资产？', `项目：${root}\n服务：${connection.url}\n策略：${policy}\n${effect}`)) {
          ctx.ui.notify('已取消，未初始化项目。', 'info');
          return;
        }
        const current = connectionConfig();
        if (ctx.sessionManager.getSessionId() !== session || realpathSync(ctx.cwd) !== root || workflowHead(root) !== base ||
            JSON.stringify(readProject(root)) !== JSON.stringify(existing) || current.url !== connection.url || current.api_key !== connection.api_key) {
          throw new InputError('项目或连接已变更，请重新执行命令并确认');
        }
        const result = await initializeProject(root, policy);
        const status = 'recovered' in result && result.recovered ? '已恢复项目初始化' : result.existing ? '项目已初始化' : '项目初始化完成';
        ctx.ui.notify(`${status}\n项目 ID：${result.project.project_id}\n资产版本：${result.head.release_id}\n配置：.evolve/openviking.json`, 'info');
      } catch (error) {
        ctx.ui.notify(`OpenViking 初始化未完成：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}
