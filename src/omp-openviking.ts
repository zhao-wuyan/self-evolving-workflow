import { realpathSync } from 'node:fs';
import { InputError } from './common.js';
import type { OmpExtensionApi } from './omp-contract.js';
import { connectionConfig, readProject } from './openviking/config.js';
import { gitText } from './openviking/git.js';
import { initializeProject } from './openviking/lifecycle.js';
import { defaultEvolutionPolicyPath } from './openviking/policy.js';
import { workflowHead, workflowPath } from './workflow-skills.js';

const usage = '/evolve-openviking init [策略文件]';

export function registerOmpOpenViking(api: OmpExtensionApi) {
  api.registerCommand('evolve-openviking', {
    description: '显式初始化 OpenViking 项目资产同步，不是个人经验采集',
    getArgumentCompletions: prefix => 'init'.startsWith(prefix.trimStart())
      ? [{ value: 'init ', label: 'init [已有策略文件]', description: '首次初始化默认在 .evolve 下准备策略；空策略只同步资产' }]
      : null,
    handler: async (args, ctx) => {
      if (ctx.agent?.kind !== 'main') return;
      if (!ctx.hasUI) throw new InputError('请在交互式 OMP 中运行此命令，或使用 evolve openviking init CLI');
      try {
        const input = args.trim();
        if (!input || input === 'help' || input === '--help') {
          ctx.ui.notify(`${usage}\n首次不指定策略时使用 ${defaultEvolutionPolicyPath}，缺失则创建空策略。空策略只同步资产。\n只想开启个人经验采集？用 /evolve-experience enable。`, 'info');
          return;
        }
        const match = /^init(?:\s+(.+))?$/.exec(input);
        if (!match || match[1]?.startsWith('--')) throw new InputError(usage);
        const root = realpathSync(ctx.cwd);
        if (realpathSync(gitText(root, ['rev-parse', '--show-toplevel'])) !== root) throw new InputError('请从项目 Git 根目录运行此命令');
        const base = workflowHead(root);
        const existing = readProject(root);
        const specified = match[1]?.replace(/^("|')(.*)\1$/, '$2');
        const policy = specified === undefined ? existing?.evolution_policy : workflowPath(specified);
        if (existing && policy !== existing.evolution_policy) throw new InputError('项目已初始化，请通过 Agent 管理策略，不要重跑 init 来切换策略');
        const session = ctx.sessionManager.getSessionId();
        const connection = connectionConfig();
        const effect = existing
          ? '读取已有项目版本；若上次初始化未完成，会重试发布。'
          : '会创建 Git 基线（含 .evolve/openviking.json，可能补装 Skills），并向服务发布项目 Skills、经批准的 Wiki 和明确标记共享的记忆。未审批的 Wiki 保留在本地。Agent 定义仅安装到 .omp/agent/agents/，不提交或上传。';
        const policySummary = policy ?? (existing ? '未绑定（仅同步资产）' : `${defaultEvolutionPolicyPath}（若缺失则创建空策略，只同步资产）`);
        if (!await ctx.ui.confirm('确认初始化 OpenViking 项目资产？', `项目：${root}\n服务：${connection.url}\n策略：${policySummary}\n${effect}`)) {
          ctx.ui.notify('已取消，未初始化项目。', 'info');
          return;
        }
        const current = connectionConfig();
        if (ctx.sessionManager.getSessionId() !== session || realpathSync(ctx.cwd) !== root || workflowHead(root) !== base ||
            JSON.stringify(readProject(root)) !== JSON.stringify(existing) || current.url !== connection.url || current.api_key !== connection.api_key) {
          throw new InputError('项目或连接已变更，请重新执行命令并确认');
        }
        const result = await initializeProject(root, policy, undefined, 'omp');
        const status = 'recovered' in result && result.recovered ? '已恢复项目初始化' : result.existing ? '项目已初始化' : '项目初始化完成';
        const localWiki = 'local_only_wiki' in result ? result.local_only_wiki?.length : 0;
        const wikiNotice = localWiki ? `\n${localWiki} 条 Wiki 未匹配审批记录，已保留在本地，未上传。` : '';
        ctx.ui.notify(`${status}\n项目 ID：${result.project.project_id}\n资产版本：${result.head.release_id}\n配置：.evolve/openviking.json${wikiNotice}`, 'info');
      } catch (error) {
        ctx.ui.notify(`OpenViking 初始化未完成：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}
