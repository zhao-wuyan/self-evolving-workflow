import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InputError } from './common.js';
import type { OmpExtensionApi } from './omp-contract.js';
import { migrateLegacyWiki } from './wiki-migration.js';
import { Wiki } from './wiki.js';

const usage = '/evolve-migrate [--knowhow-only] [旧项目目录]';
const knowhowFlag = /^--knowhow-only(?:\s+|$)/;

function migrationFingerprint(source: string, entries: Array<{ origin: string }>) {
  const hash = createHash('sha256').update(JSON.stringify(entries));
  for (const origin of new Set(entries.map(entry => entry.origin.replace(/#L\d+$/, '')))) {
    const body = readFileSync(join(source, origin));
    hash.update(`${body.length}:`).update(body);
  }
  return hash.digest('hex');
}

export function registerOmpMigration(api: OmpExtensionApi) {
  api.registerCommand('evolve-migrate', {
    description: 'Self-Evolving Workflow：预览并迁移 Maestro Flow 旧版 Spec / Knowhow 到当前项目 Wiki',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new InputError('请使用交互式 OMP 会话或 evolve kb import CLI');
      try {
        const input = args.trim();
        if (input === 'help' || input === '--help') {
          await ctx.ui.editor('迁移旧版知识', `${usage}\n省略目录时读取当前项目的旧知识。先预览、再确认写入；不转换旧 Session、Run 或工作流产物。`);
          return;
        }
        const knowhowOnly = knowhowFlag.test(input);
        const path = input.replace(knowhowFlag, '');
        if (path.startsWith('--')) throw new InputError(usage);
        const target = realpathSync(ctx.cwd);
        const source = realpathSync(resolve(target, path.replace(/^(["'])(.*)\1$/, '$2') || '.'));
        const project = 'legacy-' + createHash('sha256').update(source).digest('hex').slice(0, 16);
        const wiki = new Wiki(target);
        const layer = { scope: 'project', knowhowOnly } as const;
        const entries = migrateLegacyWiki(wiki, source, project, false, layer);
        const fingerprint = migrationFingerprint(source, entries);
        const added = entries.filter(entry => !entry.existing).length;
        const review = entries.filter(entry => entry.status === 'needs_review').length;
        const preview = { 来源: source, 目标: join(target, 'wiki', 'entries'), 新增: added, 已存在: entries.length - added, 待审: review, 条目: entries };
        if (await ctx.ui.editor('迁移预览（修改不会保存，取消即停止）', JSON.stringify(preview, null, 2)) === undefined || !added) return;
        if (!await ctx.ui.confirm('确认迁移旧版知识？', `向当前项目 Wiki 写入 ${added} 条新条目。待审项保留待审状态，不改动旧文件。`)) return;
        if (realpathSync(ctx.cwd) !== target || migrationFingerprint(source, migrateLegacyWiki(wiki, source, project, false, layer)) !== fingerprint) {
          throw new InputError('来源或目标在预览后发生变化，请重新运行 /evolve-migrate');
        }
        const imported = migrateLegacyWiki(wiki, source, project, true, layer);
        ctx.ui.notify(`迁移完成：新增 ${imported.filter(entry => !entry.existing).length} 条，保留已有条目。`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
