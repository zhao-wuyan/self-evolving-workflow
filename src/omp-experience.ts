import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { InputError, requireText } from './common.js';
import { experienceCommand } from './openviking/experience.js';
import type { OmpCommandContext, OmpExtensionApi } from './omp-contract.js';

const commandName = 'evolve-experience';
const help = `/${commandName} enable | disable：开启或停止当前仓库的采集
/${commandName} status：查看当前仓库的采集状态
/${commandName} pending：查看待发布候选
/${commandName} review <候选 ID> [--relation new|duplicate|conflict] [--related <关联 ID>]：查看拟发布内容
/${commandName} publish <候选 ID> [更多候选 ID]：集中预览，统一确认；取消不发布
  单条发布时可加 --relation 和 --related 指定与已有经验的关系
/${commandName} search <领域> <技术栈版本> <关键词> [--limit <数量>]：搜索已发布经验
/${commandName} get <领域> <技术栈版本> <经验 ID>：查看完整经验`;

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

  const preview = reviews.map(({ candidate_id, destination, action, related, reference, local_evidence }) => ({
    candidate_id, destination, action, related, reference, local_evidence,
  }));
  guard?.();
  if (await ctx.ui.editor('待发布预览（修改不会保存，取消即停止）', JSON.stringify(preview, null, 2)) === undefined) {
    return { status: 'cancelled', already_published: alreadyPublished };
  }
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
    handler: async (input, ctx) => {
      if (!ctx.hasUI) throw new InputError('请使用交互式 OMP 会话或 evolve experience CLI');
      try {
        const text = input.trim();
        const { positionals: [action = 'help', ...args], values } = parseArgs({
          args: text ? text.split(/\s+/) : [], allowPositionals: true,
          options: { relation: { type: 'string' }, related: { type: 'string' }, limit: { type: 'string' } },
        });
        if (action === 'help') {
          await ctx.ui.editor('OpenViking 个人经验库', help);
          return;
        }
        const root = realpathSync(ctx.cwd);
        if (action === 'publish' && (values.limit !== undefined || args.length !== 1 && (values.relation !== undefined || values.related !== undefined))) {
          throw new InputError('批量发布只接受候选 ID；单条发布可指定 --relation 和 --related');
        }
        const positionals = action === 'search' && args.length > 2 ? [args[0], args[1], args.slice(2).join(' ')] : args;
        const result = action === 'publish'
          ? await publishExperience(root, args.map(id => ({ id, relation: values.relation, related: values.related })), ctx)
          : await experienceCommand(root, action, positionals, values);
        if (action === 'publish' && 'status' in result && result.status === 'cancelled') return;
        await ctx.ui.editor(`个人经验库：${action}`, JSON.stringify(result, null, 2));
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
