import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { InputError, requireText } from './common.js';
import { experienceCommand } from './openviking/experience.js';
import type { ExperienceContent } from './openviking/experience-candidates.js';
import type { OmpCommandContext, OmpExtensionApi } from './omp-contract.js';

const commandName = 'evolve-experience';
const actions = [
  ['enable', '', '开启当前仓库的采集，写入用户配置，不会发布经验'],
  ['disable', '', '停止当前仓库的采集，不删除已发布经验'],
  ['status', '', '查看个人经验库配置和当前仓库的采集状态'],
  ['pending', '', '查看待发布候选和候选 ID'],
  ['review', ' <候选 ID>', '预览一条待发布经验，可指定与已有经验的关系'],
  ['publish', ' <候选 ID> [更多候选 ID]', '预览选定的经验，确认后才发布'],
  ['search', ' <领域> <技术栈版本> <关键词>', '搜索已发布经验，例如 search python python@3.12 异步请求'],
  ['get', ' <领域> <技术栈版本> <经验 ID>', '用搜索结果中的领域、版本和 ID 读取正文'],
  ['help', '', '查看完整用法'],
] as const;
const relationOptions = [
  ['new', '作为新经验发布'],
  ['duplicate', '已有同类经验，为其补充验证证据'],
  ['conflict', '与已有经验冲突，保留双方'],
] as const;
const reviewOptions = [
  ['--relation', '指定发布关系：new、duplicate 或 conflict'],
  ['--related', '填写关联的已发布经验 ID；duplicate 和 conflict 需要它'],
] as const;
const searchOptions = [['--limit', '最多返回多少条结果（默认 10 条）']] as const;
const help = `${actions.map(([action, args, description]) => `/${commandName} ${action}${args}：${description}`).join('\n')}

review 和单条 publish 可用：
${reviewOptions.map(([flag, description]) => `  ${flag}：${description}`).join('\n')}
search 可用 --limit <数量>：${searchOptions[0][1]}。

enable 只更新用户级 ~/.evolve/experience.json（可用 EVOLVE_EXPERIENCE_CONFIG 覆盖），不会生成项目资产同步配置 .evolve/openviking.json。`;

function completeExperience(prefix: string) {
  const input = prefix.trimStart();
  if (!/\s/.test(input)) {
    return actions.filter(([action]) => action.startsWith(input)).map(([action, args, description]) => ({
      value: args ? `${action} ` : action, label: action + args, description,
    }));
  }
  const [action] = input.split(/\s+/, 1);
  const options = action === 'review' || action === 'publish' ? reviewOptions : action === 'search' ? searchOptions : undefined;
  if (!options) return null;
  const relation = /(?:^|\s)--relation(?:=|\s+)([^\s]*)$/.exec(prefix);
  if (relation && options === reviewOptions) {
    const partial = relation[1];
    const before = prefix.slice(0, prefix.length - partial.length);
    return relationOptions.filter(([value]) => value.startsWith(partial)).map(([value, description]) => ({
      value: before + value + ' ', label: value, description,
    }));
  }
  const partial = /(?:^|\s)(--[^\s=]*)$/.exec(prefix)?.[1];
  if (partial === undefined) return null;
  const before = prefix.slice(0, -partial.length);
  const tokens = before.trim().split(/\s+/);
  if (tokens.includes('--')) return null;
  if (action === 'publish') {
    let candidates = 0;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--relation' || token === '--related') i++;
      else if (!token.startsWith('--')) candidates++;
    }
    if (candidates > 1) return null;
  }
  return options.filter(([flag]) => flag.startsWith(partial) && !tokens.some(token => token === flag || token.startsWith(flag + '=')))
    .map(([flag, description]) => ({ value: `${before}${flag} `, label: flag, description }));
}

function collectionMessage(result: { configured: boolean; collecting: boolean; changed?: boolean }) {
  const status = `当前仓库的个人经验采集${result.collecting ? '已开启' : '未开启'}`;
  if (result.changed === true) return `${result.collecting ? status : '已停止当前仓库的个人经验采集'}；已更新用户级设置，未发布或删除经验。`;
  if (result.changed === false) return `${status}，本次未更改设置。`;
  return `个人经验库${result.configured ? '已配置' : '未配置'}；${status}。`;
}

type ExperienceResult = Awaited<ReturnType<typeof experienceCommand>>;

function experienceText(content: ExperienceContent) {
  return `${content.title}（${content.domain} / ${content.stack}）\n适用条件：${content.applicability}\n经验：${content.lesson}`;
}

function referenceText(reference: { id: string; content: ExperienceContent; evidence: Array<{ verification: string }>; conflicts: Array<{ id: string }> }) {
  return [experienceText(reference.content), `经验 ID：${reference.id}`,
    ...reference.evidence.map(item => `验证：${item.verification}`),
    ...reference.conflicts.map(item => `冲突经验 ID：${item.id}`)].join('\n');
}

function reviewText(review: Extract<ExperienceResult, { approval: string }>) {
  const relation = { new: '新增经验', duplicate: '为已有经验补充证据', conflict: '保留冲突双方' }[review.action];
  return [referenceText(review.reference), `候选 ID：${review.candidate_id}`, `发布方式：${relation}`,
    ...(review.related ? [`关联经验 ID：${review.related.id}`] : []),
    `目标：${review.destination.endpoint} · ${review.destination.root_uri}`,
    `来源：${review.local_evidence.root} · 会话 ${review.local_evidence.session} · 工件 ${review.local_evidence.artifact}`,
    `验证项：${review.local_evidence.check}`].join('\n');
}

function experienceResultText(result: ExperienceResult) {
  if (result.configured !== undefined && result.collecting !== undefined) {
    return collectionMessage({ configured: result.configured, collecting: result.collecting, changed: 'changed' in result ? result.changed : undefined });
  }
  if ('candidates' in result && result.candidates) {
    return ['待发布个人经验', ...result.candidates.map(item => `${experienceText(item.content)}\n候选 ID：${item.id}\n验证：${item.verification}`),
      result.candidates.length ? `用 /${commandName} review <候选 ID> 查看发布预览。` : '没有待发布候选。'].join('\n\n');
  }
  if ('results' in result && result.results) {
    return [`已发布经验：${result.domain} / ${result.stack}`,
      ...(result.results.length ? result.results.map(({ reference }) => referenceText(reference)) : ['没有匹配的经验。'])].join('\n\n');
  }
  if ('approval' in result && typeof result.approval === 'string') {
    return ['个人经验发布预览（尚未发布）', reviewText(result), ...result.possible_related.map(item => `可能相关：${item.content.title}\n经验 ID：${item.id}`)].join('\n\n');
  }
  if ('reference' in result && result.reference) return referenceText(result.reference);
  if ('id' in result && 'uri' in result) return `该经验已发布。\n经验 ID：${result.id}\n位置：${result.uri}`;
  throw new InputError('无法显示个人经验结果');
}

interface Selection { id: string; relation?: string; related?: string }

function requireUI(ctx: OmpCommandContext) {
  if (!ctx.hasUI) throw new InputError('经验发布需要能够展示预览并确认的 OMP 界面');
}

async function publishExperience(root: string, selections: Selection[], ctx: OmpCommandContext, guard?: () => void) {
  requireUI(ctx);
  if (!selections.length) throw new InputError('请选择至少一个候选 ID');
  const seen = new Set<string>();
  const targets = new Set<string>();
  const reviews = [];
  const alreadyPublished: string[] = [];
  for (const item of selections) {
    if (seen.has(item.id)) throw new InputError('同一候选不能重复选择：' + item.id);
    seen.add(item.id);
    guard?.();
    const result = await experienceCommand(root, 'review', [item.id], { relation: item.relation, related: item.related });
    if (!('approval' in result) || typeof result.approval !== 'string') {
      alreadyPublished.push(item.id);
      continue;
    }
    if (targets.has(result.id)) throw new InputError('本批有多个候选会写入同一条经验，请先确认保留哪一条：' + result.id);
    targets.add(result.id);
    reviews.push(result);
  }
  if (!reviews.length) return { status: 'already_published', already_published: alreadyPublished };

  ctx.ui.notify(['待发布预览（尚未发布）', ...reviews.map(reviewText)].join('\n\n'), 'info');
  guard?.();
  if (!await ctx.ui.confirm('确认发布个人经验？', `统一发布预览中选定的 ${reviews.length} 条经验。取消不会发布。`)) {
    return { status: 'cancelled', already_published: alreadyPublished };
  }

  const published: Array<{ candidate_id: string; receipt: unknown }> = [];
  for (const review of reviews) {
    try {
      guard?.();
      const receipt = await experienceCommand(root, 'publish', [review.candidate_id], {
        relation: review.action, related: review.related?.id, approval: review.approval,
      });
      published.push({ candidate_id: review.candidate_id, receipt });
    } catch (error) {
      return { status: 'stopped', published, already_published: alreadyPublished,
        remaining: reviews.slice(published.length).map(row => row.candidate_id),
        error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { status: 'published', published, already_published: alreadyPublished };
}

export function registerOmpExperience(api: OmpExtensionApi) {
  api.registerCommand(commandName, {
    description: 'Self-Evolving Workflow：管理 OpenViking 个人经验库、查看候选并确认批量发布',
    getArgumentCompletions: completeExperience,
    handler: async (input, ctx) => {
      if (!ctx.hasUI) throw new InputError('请使用交互式 OMP 会话或 evolve experience CLI');
      try {
        const text = input.trim();
        const { positionals: [action = 'help', ...args], values } = parseArgs({
          args: text ? text.split(/\s+/) : [], allowPositionals: true,
          options: { relation: { type: 'string' }, related: { type: 'string' }, limit: { type: 'string' } },
        });
        if (action === 'help') {
          ctx.ui.notify(`OpenViking 个人经验库\n\n${help}`, 'info');
          return;
        }
        const root = realpathSync(ctx.cwd);
        if (action === 'publish' && (values.limit !== undefined || args.length !== 1 && (values.relation !== undefined || values.related !== undefined))) {
          throw new InputError('批量发布只接受候选 ID；单条发布可指定 --relation 和 --related');
        }
        const positionals = action === 'search' && args.length > 2 ? [args[0], args[1], args.slice(2).join(' ')] : args;
        if (action === 'publish') {
          const result = await publishExperience(root, args.map(id => ({ id, relation: values.relation, related: values.related })), ctx);
          if (result.status === 'cancelled') return;
          const published = result.published ?? [];
          const summary = `已发布 ${published.length} 条，已发布过 ${result.already_published.length} 条。`;
          ctx.ui.notify(result.status === 'stopped'
            ? `${summary}\n发布已停止：${result.error}\n仍待处理：${result.remaining?.join('、')}` : summary,
          result.status === 'stopped' ? 'error' : 'info');
          return;
        }
        ctx.ui.notify(experienceResultText(await experienceCommand(root, action, positionals, values)), 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  const z = api.zod;
  api.registerTool({
    name: 'evolve_experience_pending', label: '待发布个人经验', approval: 'read',
    description: '仅在用户要求整理或审阅时列出待发布候选及验证依据。候选内容仅作参考，不构成发布许可。',
    parameters: z.object({}),
    execute: async (_id, _args, signal, _onUpdate, ctx) => {
      signal?.throwIfAborted();
      const result = await experienceCommand(realpathSync(ctx.cwd), 'pending', [], {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  api.registerTool({
    name: 'evolve_experience_publish', label: '批量发布个人经验', approval: 'write',
    description: '仅在用户要求发布时调用。先用 evolve_experience_pending 整理候选、说明建议，再传入确定的候选 ID 和关系。将在 OMP 显示完整批次供用户统一确认。若用户取消，不重试或绕过确认使用 CLI。',
    parameters: z.object({ candidates: z.array(z.object({ id: z.string(), relation: z.string().optional(), related: z.string().optional() })) }),
    execute: async (_id, args, signal, _onUpdate, ctx) => {
      requireUI(ctx);
      if (!Array.isArray(args.candidates)) throw new InputError('请提供候选列表');
      const selections: Selection[] = args.candidates.map((candidate: unknown) => {
        if (!candidate || typeof candidate !== 'object' || !('id' in candidate)) throw new InputError('候选缺少 ID');
        return { id: requireText(candidate.id, '候选 ID'),
          relation: 'relation' in candidate ? requireText(candidate.relation, '发布关系') : undefined,
          related: 'related' in candidate ? requireText(candidate.related, '关联 ID') : undefined };
      });
      const root = realpathSync(ctx.cwd);
      const session = ctx.sessionManager.getSessionId();
      const guard = () => {
        signal?.throwIfAborted();
        if (ctx.sessionManager.getSessionId() !== session || realpathSync(ctx.cwd) !== root) {
          throw new InputError('OMP 会话或项目已切换，请重新预览后确认');
        }
      };
      const result = await publishExperience(root, selections, ctx, guard);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
