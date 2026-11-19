import { realpathSync } from 'node:fs';
import { InputError } from './common.js';
import type { OmpExtensionApi } from './omp-contract.js';
import { OpenVikingError } from './openviking/client.js';
import { connectionConfig, readProject } from './openviking/config.js';
import { gitText } from './openviking/git.js';
import { initializeProject } from './openviking/lifecycle.js';
import { defaultEvolutionPolicyPath } from './openviking/policy.js';
import { workflowHead, workflowPath } from './workflow-skills.js';

const usage = '/evolve-openviking init [策略文件]';
const initializationHints: Readonly<Record<string, string>> = {
  OPENVIKING_STAGED_CHANGES: '仓库中有已暂存、尚未提交的改动。为保护你的暂存内容，初始化已停止。\n请在 Git 面板查看“已暂存的更改”，确认后提交，或只取消暂存（保留文件内容），再重新初始化。\n也可运行 git diff --cached --name-status 查看文件列表；检查范围是整个仓库，不仅是 Skills。',
  OPENVIKING_MANAGED_DIRTY: 'Skills 目录中有未提交的修改，或有无法安全接管的文件。为避免覆盖本地内容，初始化已停止。\n请运行 git status --short 查看改动，确认需要保留的内容并提交后再试；不要直接丢弃文件。',
  OPENVIKING_CONFIG_INVALID: 'OpenViking 连接配置缺失或无效。\n请检查 ~/.openviking/ovcli.conf 中的服务地址和 API key；如设置了 EVOLVE_OPENVIKING_CONFIG，请检查它指向的配置文件。不要把 API key 发到聊天中。',
  OPENVIKING_CONFIG_PATH: 'OpenViking 配置文件路径无效。\n请将 EVOLVE_OPENVIKING_CONFIG 设置为配置文件的绝对路径后再试。',
  OPENVIKING_POLICY_NOT_COMMITTED: '演进策略或它引用的回放文件尚未提交，无法建立可复现的初始化基线。\n请检查下方诊断信息中的文件，确认内容并提交后再试。',
  OPENVIKING_POLICY_FILE_REQUIRED: '找不到演进策略或它引用的回放文件。\n请检查下方文件路径并补齐文件；首次只同步资产时，可不指定策略文件，运行 /evolve-openviking init。',
  OPENVIKING_LOCAL_CHANGED: '初始化期间检测到本地文件变化，已停止以避免覆盖新内容。\n请检查并保留本地改动，待文件不再变化后重新初始化。',
  OPENVIKING_LOCAL_ADVANCED: '初始化期间 Git 提交发生了变化，无法安全应用原先准备的基线。\n请等待其他 Git 操作结束，再重新初始化并确认。',
  OPENVIKING_JOB_BUSY: '另一个 OpenViking 操作正在运行。\n请等待该操作结束后再试，不要删除锁文件或同时重复初始化。',
  OPENVIKING_RESULT_UNKNOWN: '未能确认 OpenViking 服务的处理结果，可能存在连接中断或超时。\n请先检查服务连接和项目状态；本地可能已建立基线，不要删除生成文件。连接恢复后重新运行 init 可恢复未完成的发布。',
};

function initializationFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const code = detail.match(/^[A-Z][A-Z0-9_]+(?=[:\s]|$)/)?.[0];
  let hint = code ? initializationHints[code] : undefined;
  if (!hint && error instanceof OpenVikingError) {
    hint = error.status === 401 || error.status === 403
      ? 'OpenViking 服务拒绝了当前身份的请求。\n请检查 API key 是否有效，以及账号是否有项目访问权限；不要把密钥发到聊天中。'
      : 'OpenViking 服务未能完成请求。\n请检查服务是否可用，并让 Agent 根据下方诊断信息检查服务状态和项目配置。';
  }
  if (!hint && /[\u4e00-\u9fff]/.test(detail)) return `OpenViking 初始化未完成\n${detail}`;
  hint ??= '初始化遇到尚未确认原因的问题。\n请将下方诊断信息交给 Agent 排查，先保留本地文件，不要反复删除文件后重试。';
  return `OpenViking 初始化未完成\n${hint}\n\n诊断信息：${detail}`;
}

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
          : '会创建 Git 基线（含 .evolve/openviking.json，可能补装 .omp/skills/），并向服务发布项目 Skills、经批准的 Wiki 和明确标记共享的记忆。未审批的 Wiki 保留在本地。Agent 定义仅安装到 .omp/agent/agents/，不提交或上传。';
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
        const result = await initializeProject(root, policy, undefined, 'omp', 'omp');
        const status = 'recovered' in result && result.recovered ? '已恢复项目初始化' : result.existing ? '项目已初始化' : '项目初始化完成';
        const localWiki = 'local_only_wiki' in result ? result.local_only_wiki?.length : 0;
        const wikiNotice = localWiki ? `\n${localWiki} 条 Wiki 未匹配审批记录，已保留在本地，未上传。` : '';
        ctx.ui.notify(`${status}\n项目 ID：${result.project.project_id}\n资产版本：${result.head.release_id}\n配置：.evolve/openviking.json${wikiNotice}`, 'info');
      } catch (error) {
        ctx.ui.notify(initializationFailure(error), 'error');
      }
    },
  });
}
