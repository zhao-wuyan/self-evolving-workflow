// Adapts TencentDB Agent Memory's Wiki ingest-v2 pipeline (MIT).
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { InputError, requireText } from './common.js';
import { chunkText } from './upstream/chunker.js';
import { normalizeWikiPath, parseFileBlocks } from './upstream/file-protocol.js';
import { buildPage, parseFrontmatter, readSources } from './upstream/frontmatter.js';
import type { LlmClient } from './upstream/llm.js';
import { mergePage, unionSources } from './upstream/merge.js';
import { buildAnalysisPrompt, buildAnalysisSystemPrompt, buildGenerateFromAnalysisPrompt, buildGeneratePrompt, buildSystemPrompt } from './upstream/prompts.js';
import { pageRelPath, slugify } from './upstream/slug.js';
import { loadTemplate } from './upstream/template.js';
import { proposeWikiChange } from './wiki-change.js';
import { readWikiPages, structuralPages, type Wiki } from './wiki.js';

export interface WikiIngestOptions {
  llm: LlmClient;
  mode?: 'two-stage' | 'single-stage';
  propose?: boolean;
}

const inProgress = new Set<string>();

export async function ingestWiki(wiki: Wiki, source: string, options: WikiIngestOptions) {
  const sourceName = basename(source);
  if (!['.md', '.markdown', '.txt'].includes(extname(sourceName).toLowerCase())) {
    throw new InputError('Wiki ingest supports Markdown and plain text sources');
  }
  const sourceText = requireText(readFileSync(source, 'utf8'), 'source text');
  mkdirSync(wiki.root, { recursive: true });
  const root = realpathSync(wiki.root);
  if (inProgress.has(root)) throw new Error('Wiki ingest is already running for this directory');
  inProgress.add(root);
  try {
    checkedPath(root, 'wiki');
    mkdirSync(join(root, 'wiki'), { recursive: true });
    checkedPath(root, 'wiki/purpose.md');
    checkedPath(root, 'wiki/schema.md');
    const existingPages = readWikiPages(root).map(page => ({
      relPath: page.path, title: page.title, type: page.type, description: page.snippet,
    }));
    const template = loadTemplate(root);
    const chunks = sourceText.length > 28_000 ? chunkText(sourceText, { targetChars: 28_000 }) : [sourceText];
    const staged = new Map<string, string>();
    const original = new Map<string, string | null>();
    const warnings: string[] = [];
    let generated = 0;
    for (const [index, text] of chunks.entries()) {
      const context = {
        sourceName: chunks.length === 1 ? sourceName : `${sourceName} (chunk ${index + 1}/${chunks.length})`,
        sourceText: text, existingPages,
      };
      const analysis = options.mode === 'single-stage' ? '' : await options.llm.chat({
        system: buildAnalysisSystemPrompt(template), prompt: buildAnalysisPrompt(context), label: 'wiki-analysis',
      });
      const raw = await options.llm.chat({
        system: buildSystemPrompt(template),
        prompt: analysis.trim() ? buildGenerateFromAnalysisPrompt({ ...context, analysis }) : buildGeneratePrompt(context),
        label: 'wiki-generate',
      });
      const parsed = parseFileBlocks(raw);
      warnings.push(...parsed.warnings);
      if (!parsed.files.length) throw new Error(`Wiki generation returned no complete pages for chunk ${index + 1}`);
      for (const file of parsed.files) {
        const page = parseFrontmatter(file.content);
        if (!page.hasFrontmatter || !page.body.trim()) {
          warnings.push(`Invalid frontmatter or empty body: ${file.path}`);
          continue;
        }
        const title = page.frontmatter.title;
        const path = typeof title === 'string' && slugify(title) ? pageRelPath(page.frontmatter.type, title) : file.path;
        if (structuralPages.has(file.path.toLowerCase()) || structuralPages.has(path.toLowerCase())) continue;
        if (file.path.toLowerCase().startsWith('wiki/entries/') || path.toLowerCase().startsWith('wiki/entries/')) {
          warnings.push(`Managed Wiki entries require the publishing workflow: ${file.path}`);
          continue;
        }
        const full = checkedPath(root, path);
        const candidate = buildPage({ ...page.frontmatter, sources: unionSources(readSources(file.content), [sourceName]) }, page.body);
        if (!original.has(path)) original.set(path, readIfPresent(full));
        const previous = staged.get(path) ?? original.get(path)!;
        const decision = await mergePage(previous, candidate, options.llm);
        generated++;
        if (decision.action === 'write' && decision.content !== previous) staged.set(path, decision.content);
      }
    }
    if (!generated) throw new Error('Wiki generation returned no usable content pages');
    for (const path of staged.keys()) {
      if (readIfPresent(checkedPath(root, path)) !== original.get(path)) {
        throw new Error(`Wiki page changed during ingestion: ${path}`);
      }
    }
    for (const [path, content] of staged) {
      const full = checkedPath(root, path);
      mkdirSync(dirname(full), { recursive: true });
      const temp = join(dirname(full), `.${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
        renameSync(temp, full);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    const buildResult = wiki.build();
    const proposedChanges: Array<ReturnType<typeof proposeWikiChange>> = [];
    if (options.propose) {
      for (const [path, content] of staged) {
        const parsed = parseFrontmatter(content);
        const body = parsed.body.trim();
        if (!body || wiki.getEntriesByExactBody(body).length > 0) continue;
        const title = typeof parsed.frontmatter.title === 'string' && parsed.frontmatter.title.trim()
          ? parsed.frontmatter.title.trim()
          : basename(path, '.md');
        const rawSlug = (slugify(title) || slugify(basename(path, '.md')) || 'ingest-page')
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^[^a-z0-9]+|-+$/g, '');
        if (!rawSlug) continue;
        const entryId = `entries/${rawSlug}`;
        const existing = wiki.getEntry(entryId);
        if (existing && (!existing.entry || existing.entry.mode !== 'reference' || existing.entry.status !== 'active' || existing.body.trim() === body)) {
          continue;
        }
        try {
          proposedChanges.push(proposeWikiChange(wiki, {
            operation: existing ? 'update' : 'create',
            entry: entryId,
            title,
            mode: 'reference',
            scope: ['project'],
            body,
          }, [`ingest:${sourceName}`]));
        } catch (error) {
          warnings.push(`Skipped proposal for ${entryId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return {
      written: [...staged.keys()],
      warnings,
      ...buildResult,
      ...(options.propose ? { proposed_changes: proposedChanges } : {}),
    };
  } finally {
    inProgress.delete(root);
  }
}

function readIfPresent(path: string): string | null {
  return lstatSync(path, { throwIfNoEntry: false }) ? readFileSync(path, 'utf8') : null;
}

function checkedPath(root: string, path: string): string {
  if (path !== 'wiki' && (normalizeWikiPath(path) !== path || extname(path).toLowerCase() !== '.md')) {
    throw new InputError(`Invalid wiki path: ${path}`);
  }
  let full = root;
  for (const part of path.split('/')) {
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new InputError(`Invalid wiki path component: ${part}`);
    }
    full = join(full, part);
    if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new InputError(`Wiki path contains a symbolic link: ${path}`);
    }
  }
  return full;
}
