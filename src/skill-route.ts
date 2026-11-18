import { InputError, requireText } from './common.js';

export type SkillRetentionRoute = 'wiki' | 'skill-addition' | 'skill-design';

export interface SkillRouteContext {
  content: string;
  sources: string[];
  matchedEntry?: string | null;
  relatedEntries?: string[];
  skillId?: string;
  skillVersion?: string;
  signalKinds?: string[];
  repeatCount?: number;
  stepCount?: number;
  crossSkill?: boolean;
  requiresNewContract?: boolean;
  requiresNewArtifacts?: boolean;
  requiresRouting?: boolean;
  explicitSkillIntent?: boolean;
  /** 目标 Skill 当前 learning 清单统计；超过阈值时转为整合设计。 */
  learnings?: { inline: number; total: number; consolidate_recommended: boolean; reasons: string[] };
}

export interface SkillRouteDecision {
  route: SkillRetentionRoute;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  invoke_meta_skill: boolean;
  meta_skill?: {
    id: 'ew-skill-design';
    mode: 'design';
    instruction: string;
  };
  priority?: 'high' | 'normal' | 'low';
}

function list(value: string[] | undefined, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new InputError(`${field} must be a list of non-empty strings`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function count(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new InputError(`${field} must be a non-negative integer`);
  return value;
}

export function decideSkillRoute(input: SkillRouteContext): SkillRouteDecision {
  const content = requireText(input.content, 'Skill route content');
  const normalized = content.toLowerCase();
  const sources = list(input.sources, 'Skill route sources');
  if (!sources.length) throw new InputError('Skill route requires at least one evidence source');
  const signalKinds = list(input.signalKinds, 'Skill route signal kinds');
  const repeatCount = count(input.repeatCount, 'repeatCount');
  const stepCount = count(input.stepCount, 'stepCount');
  const reasons: string[] = [];
  const inferredSkillIntent = /(?:新增|设计|创建|建立).{0,12}skill|new\s+skill|design\s+(?:a\s+)?skill/.test(normalized);
  const inferredContract = /(?:新增|设计|创建).{0,12}(?:契约|contract)|new\s+skill\s+contract/.test(normalized);
  const inferredArtifacts = /(?:新增|设计|创建).{0,12}(?:产物|artifact|output)/.test(normalized);
  const inferredRouting = /(?:跨|多).{0,8}skill|(?:新|多阶段|多步骤).{0,8}(?:路由|分支|流程链)|cross[- ]skill|multi[- ]stage/.test(normalized);
  const consolidate = Boolean(input.skillId && input.learnings?.consolidate_recommended);
  const structural = Boolean(input.requiresNewContract || inferredContract || input.requiresNewArtifacts || inferredArtifacts ||
    input.requiresRouting || inferredRouting || input.crossSkill || input.explicitSkillIntent || inferredSkillIntent || stepCount >= 3 ||
    consolidate);
  if (structural) {
    if (input.requiresNewContract || inferredContract) reasons.push('需要新的 Skill contract 或生命周期门禁');
    if (input.requiresNewArtifacts || inferredArtifacts) reasons.push('需要新的产物类型或验证输出');
    if (input.requiresRouting || inferredRouting) reasons.push('需要新增路由、分支或阶段链');
    if (input.crossSkill) reasons.push('影响多个 Skill 或需要跨 Skill 协作');
    if (input.explicitSkillIntent || inferredSkillIntent) reasons.push('上下文明确要求设计或新增 Skill');
    if (stepCount >= 3) reasons.push('可复用流程包含至少 3 个稳定步骤');
    if (consolidate) reasons.push(`Skill learning 已膨胀（${input.learnings!.reasons.join('；')}），需整合进正文而非继续追加`);
    return {
      route: 'skill-design', confidence: 'high', reasons,
      invoke_meta_skill: true,
      meta_skill: {
        id: 'ew-skill-design', mode: 'design',
        instruction: `基于已验证证据设计 Skill。保留当前入口约束，声明 Markdown 链接、契约、产物、恢复路径和验收场景。${consolidate ? '将现有 learning 合并进正文并删除被吸收的 learning 文件，保留全部历史回归场景。' : ''}证据：${sources.join(', ')}`,
      },
    };
  }

  if (input.skillId) {
    reasons.push(`信号可以归因到 Skill ${input.skillId}`);
    if (input.skillVersion) reasons.push(`已固定 Skill 版本 ${input.skillVersion}`);
    if (repeatCount >= 2) reasons.push('同类信号至少重复两次');
    if (signalKinds.some(kind => ['correction', 'error', 'retry', 'workflow_issue'].includes(kind))) {
      reasons.push('证据包含可修正的执行信号');
    }
    return {
      route: 'skill-addition', confidence: input.skillVersion ? 'high' : 'medium', reasons,
      invoke_meta_skill: false,
      priority: repeatCount >= 2 || signalKinds.includes('workflow_issue') ? 'high' : 'normal',
    };
  }

  if (input.matchedEntry || input.relatedEntries?.length) reasons.push('候选已有 Wiki 关系，需要沿 Wiki 审查流程处理');
  else reasons.push('当前证据适合沉淀为项目级 Wiki reference');
  return { route: 'wiki', confidence: input.matchedEntry ? 'high' : 'medium', reasons, invoke_meta_skill: false };
}
