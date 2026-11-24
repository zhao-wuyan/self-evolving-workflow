import { realpathSync } from 'node:fs';
import { InputError } from './common.js';
import type { OmpCommandContext, OmpExtensionApi } from './omp-contract.js';
import { loadRelease, readProjectHead, type PublishProgress } from './openviking/assets.js';
import { isUnavailable, OpenVikingClient, OpenVikingError } from './openviking/client.js';
import { connectionConfig, readPolicy, readProject } from './openviking/config.js';
import { experienceCommand } from './openviking/experience.js';
import { readExperienceProfile } from './openviking/experience-candidates.js';
import { gitText } from './openviking/git.js';
import { initializeProject } from './openviking/lifecycle.js';
import { defaultEvolutionPolicyPath } from './openviking/policy.js';
import { workflowHead, workflowPath } from './workflow-skills.js';

const commandName = 'evolve-openviking';
const progressKey = 'evolve-openviking';
const usage = `/${commandName} [init [策略文件] | status | help]`;
const subcommands = [
  { value: 'init', label: 'init [策略文件]', description: '初始化项目资产同步（省略子命令时默认执行）' },
  { value: 'status', label: 'status', description: '查看 OpenViking 连接、项目资产同步与个人经验状态' },
  { value: 'help', label: 'help', description: '查看命令用法' },
] as const;

const phaseOrder: Record<PublishProgress['phase'], [number, number]> = {
  prepare: [1, 6],
  git: [2, 6],
  check: [3, 6],
  upload: [4, 6],
  verify: [5, 6],
  finalize: [6, 6],
};

const initializationHints: Readonly<Record<string, string>> = {
  OPENVIKING_STAGED_CHANGES: '仓库中有已暂存、尚未提交的改动。为保护你的暂存内容，初始化已停止。\n请在 Git 面板查看“已暂存的更改”，确认后提交，或只取消暂存（保留文件内容），再重新初始化。\n也可运行 git diff --cached --name-status 查看文件列表；检查范围是整个仓库，不仅是 Skills。',
  OPENVIKING_MANAGED_DIRTY: 'Skills 目录中有未提交的修改，或有无法安全接管的文件。为避免覆盖本地内容，初始化已停止。\n请运行 git status --short 查看改动，确认需要保留的内容并提交后再试；不要直接丢弃文件。',
  OPENVIKING_CONFIG_INVALID: 'OpenViking 连接配置缺失或无效。\n请检查 ~/.openviking/ovcli.conf 中的服务地址和 API key；如设置了 EVOLVE_OPENVIKING_CONFIG，请检查它指向的配置文件。不要把 API key 发到聊天中。',
  OPENVIKING_CONFIG_PATH: 'OpenViking 配置文件路径无效。\n请将 EVOLVE_OPENVIKING_CONFIG 设置为配置文件的绝对路径后再试。',
  OPENVIKING_POLICY_NOT_COMMITTED: '演进策略或它引用的回放文件尚未提交，无法建立可复现的初始化基线。\n请检查下方诊断信息中的文件，确认内容并提交后再试。',
  OPENVIKING_POLICY_FILE_REQUIRED: '找不到演进策略或它引用的回放文件。\n请检查下方文件路径并补齐文件；首次只同步资产时，可直接运行 /evolve-openviking。',
  OPENVIKING_LOCAL_CHANGED: '初始化期间检测到本地文件变化，已停止以避免覆盖新内容。\n请检查并保留本地改动，待文件不再变化后重新初始化。',
  OPENVIKING_LOCAL_ADVANCED: '初始化期间 Git 提交发生了变化，无法安全应用原先准备的基线。\n请等待其他 Git 操作结束，再重新初始化并确认。',
  OPENVIKING_JOB_BUSY: '另一个 OpenViking 操作正在运行。\n请等待该操作结束后再试，不要删除锁文件或同时重复初始化。',
  OPENVIKING_RESULT_UNKNOWN: '未能确认 OpenViking 服务的处理结果，可能存在连接中断或超时。\n请先检查服务连接和项目状态；本地可能已建立基线，不要删除生成文件。连接恢复后重新运行 /evolve-openviking 可恢复未完成的发布。',
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
  if (!hint && /[\u4e00-\u9fff]/.test(detail)) return `OpenViking 操作未完成\n${detail}`;
  hint ??= '操作遇到尚未确认原因的问题。\n请将下方诊断信息交给 Agent 排查，先保留本地文件，不要反复删除文件后重试。';
  return `OpenViking 操作未完成\n${hint}\n\n诊断信息：${detail}`;
}

function progressBar(current: number, total: number, width = 20) {
  const clamped = Math.max(0, Math.min(current, total));
  const ratio = total > 0 ? clamped / total : 0;
  const filled = Math.round(ratio * width);
  const percent = Math.round(ratio * 100);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${percent}% (${clamped}/${total})`;
}

function createProgressReporter(ctx: OmpCommandContext, title: string) {
  let lastPhase: string | undefined;
  let lastUpdate = 0;
  const render = (progress: PublishProgress) => {
    const now = Date.now();
    const boundary = progress.phase !== lastPhase || progress.current === undefined ||
      progress.total === undefined || progress.current === 0 || progress.current === progress.total;
    if (!boundary && now - lastUpdate < 60) return;
    lastPhase = progress.phase;
    lastUpdate = now;
    const [step, totalSteps] = phaseOrder[progress.phase];
    const detail = progress.current !== undefined && progress.total !== undefined
      ? `${progress.label}  ${progressBar(progress.current, progress.total)}`
      : progress.label;
    const statusLine = `OpenViking [${step}/${totalSteps}] ${detail}`;
    ctx.ui.setStatus?.(progressKey, statusLine);
    ctx.ui.setWorkingMessage?.(statusLine);
    ctx.ui.setWidget?.(progressKey, [
      `${title}  [${step}/${totalSteps}]`,
      detail,
    ], { placement: 'aboveEditor' });
  };
  const clear = () => {
    ctx.ui.setStatus?.(progressKey, undefined);
    ctx.ui.setWidget?.(progressKey, undefined);
    ctx.ui.setWorkingMessage?.();
  };
  return { render, clear };
}

function helpText() {
  return [
    'OpenViking 集成管理',
    '',
    `用法：${usage}`,
    '',
    '常用入口：',
    `  /${commandName}              初始化项目资产同步（首次缺失则创建空策略 ${defaultEvolutionPolicyPath}），并可选顺手开启个人经验采集`,
    `  /${commandName} init [策略]  指定已有演进策略文件进行初始化`,
    `  /${commandName} status       查看当前项目的同步配置、远端版本与个人经验采集状态`,
    `  /${commandName} help         显示此帮助`,
    '',
    '说明：空策略只同步项目资产（Skills / 已批 Wiki / 共享记忆），不自动修改 Skill。',
    '单独管理个人经验（审阅、发布、检索）请使用 /evolve-experience。',
  ].join('\n');
}

function formatStatus(sections: Array<{ title: string; items: string[] }>, footer?: string) {
  const blocks = sections.map(({ title, items }) => [`▸ ${title}`, ...items.map(line => `  ${line}`)].join('\n'));
  if (footer) blocks.push(footer);
  return ['OpenViking 状态', '', ...blocks].join('\n\n');
}

async function handleStatus(root: string, ctx: OmpCommandContext) {
  const project = readProject(root);
  const profile = readExperienceProfile();
  const experienceLine = !profile
    ? '个人经验库未配置（未开启采集）'
    : profile.roots.includes(root)
      ? '当前仓库已开启采集'
      : '当前仓库未开启采集';

  if (!project) {
    ctx.ui.notify(formatStatus([
      {
        title: '项目资产同步',
        items: [
          `项目目录：${root}`,
          '同步状态：未初始化（当前使用本地知识，未触网）',
        ],
      },
      {
        title: '个人经验采集',
        items: [experienceLine],
      },
    ], `提示：运行 /${commandName} 可一站式初始化项目资产同步，并按需开启个人经验采集。`), 'info');
    return;
  }

  let policyLine = project.evolution_policy ?? '未绑定（仅同步资产）';
  if (project.evolution_policy) {
    try {
      const policy = readPolicy(root, project.evolution_policy);
      policyLine = policy.targets.length
        ? `${project.evolution_policy}（${policy.targets.length} 个演进目标）`
        : `${project.evolution_policy}（空策略，仅同步资产）`;
    } catch (error) {
      policyLine = `${project.evolution_policy}（读取失败：${error instanceof Error ? error.message : String(error)}）`;
    }
  }

  if (project.enabled === false) {
    ctx.ui.notify(formatStatus([
      {
        title: '项目资产同步',
        items: [
          `项目目录：${root}`,
          `项目 ID：${project.project_id}`,
          '同步状态：已停用（当前使用本地知识）',
          `演进策略：${policyLine}`,
        ],
      },
      {
        title: '个人经验采集',
        items: [experienceLine],
      },
    ]), 'info');
    return;
  }

  let endpoint = '未配置';
  try { endpoint = connectionConfig().url; } catch { /* handled during remote check */ }

  const progress = createProgressReporter(ctx, 'OpenViking 状态检查');
  try {
    progress.render({ phase: 'prepare', label: '正在读取远端项目版本' });
    const client = new OpenVikingClient();
    const { head } = await readProjectHead(client, project);
    const manifest = await loadRelease(client, project, head.release_id);
    const nextHint = !profile?.roots.includes(root)
      ? '提示：当前仓库尚未开启个人经验采集，可运行 /evolve-experience enable 开启。'
      : undefined;
    ctx.ui.notify(formatStatus([
      {
        title: '服务连接',
        items: [
          `服务地址：${endpoint}`,
          `连接状态：已连通（账号 ${project.account_id} / 用户 ${project.user_id}）`,
        ],
      },
      {
        title: '项目资产同步',
        items: [
          `项目 ID：${project.project_id}`,
          `远端版本：${head.release_id.slice(0, 12)}（共 ${manifest.files.length} 个资产文件 · ${manifest.wiki.length} 条 Wiki · ${manifest.memory.length} 条共享记忆）`,
          `演进策略：${policyLine}`,
          `故障策略：${project.failure_policy === 'fail' ? 'fail（离线报错）' : 'local（离线回退本地）'}`,
        ],
      },
      {
        title: '个人经验采集',
        items: [experienceLine],
      },
    ], nextHint), 'info');
  } catch (error) {
    if (project.failure_policy === 'fail' || !isUnavailable(error)) throw error;
    const reason = error instanceof Error ? error.message : 'OPENVIKING_UNAVAILABLE';
    ctx.ui.notify(formatStatus([
      {
        title: '服务连接',
        items: [
          `服务地址：${endpoint}`,
          `连接状态：不可用，已按 local 策略回退本地（${reason}）`,
        ],
      },
      {
        title: '项目资产同步',
        items: [
          `项目 ID：${project.project_id}`,
          `演进策略：${policyLine}`,
        ],
      },
      {
        title: '个人经验采集',
        items: [experienceLine],
      },
    ]), 'warning');
  } finally {
    progress.clear();
  }
}

async function maybeEnableExperience(root: string, ctx: OmpCommandContext) {
  const profile = readExperienceProfile();
  if (profile?.roots.includes(root)) return '已开启';
  const confirmed = await ctx.ui.confirm(
    '顺手开启当前仓库的个人经验采集？',
    [
      `项目：${root}`,
      '仅写入本机用户配置 ~/.evolve/experience.json，记录本仓库参与跨项目个人经验采集。',
      '不会自动发布任何经验；后续发布前仍需审阅并确认（/evolve-experience）。',
    ].join('\n'),
  );
  if (!confirmed) return '暂未开启（后续可运行 /evolve-experience enable）';
  try {
    await experienceCommand(root, 'enable', [], {});
    return '已开启（不会自动发布）';
  } catch (error) {
    return `未开启（${error instanceof Error ? error.message : String(error)}）`;
  }
}

export function registerOmpOpenViking(api: OmpExtensionApi) {
  api.registerCommand(commandName, {
    description: '初始化或查看 OpenViking 项目资产同步与个人经验采集',
    getArgumentCompletions: prefix => {
      const trimmed = prefix.trimStart();
      if (/\s/.test(trimmed)) return null;
      return subcommands.filter(item => item.value.startsWith(trimmed));
    },
    handler: async (args, ctx) => {
      if (ctx.agent?.kind !== 'main') return;
      if (!ctx.hasUI) throw new InputError('请在交互式 OMP 中运行此命令，或使用 evolve openviking CLI');
      try {
        const input = args.trim();
        if (input === 'help' || input === '--help' || input === '-h') {
          ctx.ui.notify(helpText(), 'info');
          return;
        }
        const root = realpathSync(ctx.cwd);
        if (input === 'status') {
          await handleStatus(root, ctx);
          return;
        }
        const match = /^(?:init(?:\s+(.+))?)?$/.exec(input);
        if (!match || match[1]?.startsWith('--')) throw new InputError(usage);
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
        if (!await ctx.ui.confirm('确认初始化 OpenViking 项目资产？', [
          `项目：${root}`,
          `服务：${connection.url}`,
          `策略：${policySummary}`,
          '',
          effect,
        ].join('\n'))) {
          ctx.ui.notify('已取消，未初始化项目。', 'info');
          return;
        }
        const current = connectionConfig();
        if (ctx.sessionManager.getSessionId() !== session || realpathSync(ctx.cwd) !== root || workflowHead(root) !== base ||
            JSON.stringify(readProject(root)) !== JSON.stringify(existing) || current.url !== connection.url || current.api_key !== connection.api_key) {
          throw new InputError('项目或连接已变更，请重新执行命令并确认');
        }
        const progress = createProgressReporter(ctx, 'OpenViking 项目初始化');
        const result = await (async () => {
          try { return await initializeProject(root, policy, undefined, 'omp', 'omp', progress.render); }
          finally { progress.clear(); }
        })();
        const statusTitle = 'recovered' in result && result.recovered ? '已恢复项目初始化' : result.existing ? '项目已初始化' : '项目初始化完成';
        const localWiki = 'local_only_wiki' in result ? result.local_only_wiki?.length : 0;
        const experienceStatus = await maybeEnableExperience(root, ctx);
        const lines = [
          statusTitle,
          '',
          `• 项目 ID：${result.project.project_id}`,
          `• 资产版本：${result.head.release_id}`,
          '• 配置文件：.evolve/openviking.json',
          `• 个人经验：${experienceStatus}`,
        ];
        if (localWiki) lines.push(`• 本地保留：${localWiki} 条 Wiki 未匹配审批记录，已保留在本地，未上传。`);
        ctx.ui.notify(lines.join('\n'), 'info');
      } catch (error) {
        ctx.ui.notify(initializationFailure(error), 'error');
      }
    },
  });
}
