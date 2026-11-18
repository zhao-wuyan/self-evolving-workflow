import { realpathSync } from 'node:fs';
import { InputError } from './common.js';
import { readProject } from './openviking/config.js';
import { readExperienceProfile } from './openviking/experience-candidates.js';
import type { OmpExtensionApi } from './omp-contract.js';
import { installStatus } from './workflow-install.js';
import { readEvolveSessions } from './workflow-runtime.js';

const runStatuses: Record<string, string> = {
  running: '运行中', blocked: '已阻塞', failed: '已失败', cancelled: '已取消', sealed: '已封存',
};

function section(title: string, read: () => string) {
  try { return `${title}\n${read()}`; }
  catch (error) { return `${title}\n读取失败：${error instanceof Error ? error.message : String(error)}`; }
}

function sessionSummary(root: string) {
  const sessions = readEvolveSessions(root);
  let open = 0;
  const lines = [''];
  for (const session of sessions) {
    if (session.status !== 'open') continue;
    open++;
    let finished = 0;
    for (const step of session.steps) {
      if (step.status === 'completed' || step.status === 'skipped') finished++;
    }
    lines.push(`${session.id}：${session.objective}（已处理 ${finished}/${session.steps.length} 步）`);
    const run = session.runs.at(-1);
    if (run) lines.push(`  最近 Run：${run.task.command} · ${runStatuses[run.status] ?? run.status} · ${run.id}`);
  }
  lines[0] = `进行中：${open}；已完成：${sessions.length - open}`;
  return lines.join('\n');
}

function skillSummary(root: string) {
  const status = installStatus(root, { scope: 'project' });
  const lines = [`随包版本：${status.bundle_version}`];
  for (const target of status.targets) {
    let installed = 0;
    let missing = 0;
    const different: string[] = [];
    const retired: string[] = [];
    for (const skill of target.skills) {
      if (skill.status === 'retired') { retired.push(skill.name); continue; }
      if (skill.on_disk) installed++;
      else missing++;
      if (skill.status === 'outdated') different.push(skill.name);
    }
    lines.push(`${target.skills_dir}：已安装 ${installed}，未安装 ${missing}`);
    if (different.length) lines.push(`  与随包版本不同：${different.join('、')}`);
    if (retired.length) lines.push(`  已退役：${retired.join('、')}`);
  }
  return lines.join('\n');
}

export function registerOmpStatus(api: OmpExtensionApi) {
  api.registerCommand('evolve-status', {
    description: 'Self-Evolving Workflow：查看当前项目的会话、Skill 安装和 OpenViking 配置',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new InputError('请在交互式 OMP 会话中运行 /evolve-status');
      if (args.trim()) { ctx.ui.notify('/evolve-status 不接受参数，仅读取当前项目。', 'error'); return; }
      const root = realpathSync(ctx.cwd);
      const sections = [
        `当前项目：${root}`,
        section('Session / Run', () => sessionSummary(root)),
        section('项目 Skill 安装', () => skillSummary(root)),
        section('OpenViking 项目配置（未联网检查）', () => {
          const project = readProject(root);
          return !project ? '未配置，使用本地知识' : project.enabled === false ? '已配置，当前停用' : '已配置并启用';
        }),
        section('个人经验采集', () => {
          const profile = readExperienceProfile();
          return !profile ? '个人经验库未配置' : profile.roots.includes(root) ? '当前项目已开启' : '当前项目未开启';
        }),
      ];
      await ctx.ui.editor('Evolve 项目状态（只读）', sections.join('\n\n'));
    },
  });
}
