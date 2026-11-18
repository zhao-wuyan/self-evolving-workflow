import { createServer } from 'node:http';
import { InputError, NotFoundError } from './common.js';
import { context as buildContext, parseScope, search, type SearchSources } from './search.js';
import { isRepositoryId, isWikiCategory } from './wiki-entry.js';
import { KnowledgeReads } from './knowledge-reads.js';

/** GET /search or /context with q, scope, limit and optional Wiki/Memory filters. */
export function createSearchServer(sources: SearchSources) {
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status: number, payload: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/search' && url.pathname !== '/context') return send(404, { error: 'Route not found' });
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return send(405, { error: 'Use GET /search or /context' });
      }
      const params = url.searchParams;
      const scope = parseScope(params.get('scope') ?? 'all');
      const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
      const knowledgeReads = params.get('trace') === 'true' || params.get('trace') === '1' ? new KnowledgeReads() : undefined;
      const withTrace = (payload: unknown) => {
        if (!knowledgeReads) return payload;
        return payload && typeof payload === 'object' && !Array.isArray(payload)
          ? { ...(payload as Record<string, unknown>), knowledge_reads: knowledgeReads.toJSON() }
          : { result: payload, knowledge_reads: knowledgeReads.toJSON() };
      };
      const categories = params.getAll('category');
      const validCategories = categories.filter(isWikiCategory);
      if (validCategories.length !== categories.length) throw new InputError('Unknown Wiki context category');
      const repository = params.get('repository') ?? undefined;
      if (repository !== undefined && !isRepositoryId(repository)) throw new InputError('Expected a persisted repository UUID');
      if (url.pathname === '/context') {
        const scopedSources: SearchSources = scope === 'all' ? sources : {
          ...(scope === 'code' ? { code: sources.code } : {}),
          ...(scope === 'wiki' ? { wiki: sources.wiki } : {}),
          ...(scope === 'memory' ? { memory: sources.memory } : {}),
        };
        return send(200, withTrace(await buildContext(scopedSources, params.get('q') ?? '', {
          limit,
          context: {
            task: params.get('task') ?? undefined,
            paths: params.getAll('path'),
            categories: validCategories.length ? validCategories : undefined,
            repository,
            keyword: params.get('keyword') ?? undefined,
            includePathScoped: params.get('include_path_scoped') === 'true' || params.get('include_path_scoped') === '1',
          },
          wiki: { hop: params.has('hop') ? Number(params.get('hop')) : undefined },
          memory: {
            type: params.get('type') ?? undefined,
            scene: params.get('scene') ?? undefined,
            session: params.get('memory_session') ?? undefined,
          },
          includeWorkingMemory: params.get('include_memory') === 'true' || params.get('include_memory') === '1',
          knowledgeReads,
          contextScope: {
            ...(params.get('session') ? { session_id: params.get('session')! } : {}),
            ...(params.get('task') ? { task_kind: params.get('task')! } : {}),
            ...(params.getAll('path').length ? { paths: params.getAll('path') } : {}),
          },
        })));
      }
      const results = await search(sources, params.get('q') ?? '', {
        scope,
        limit,
        wiki: { hop: params.has('hop') ? Number(params.get('hop')) : undefined },
        memory: {
          type: params.get('type') ?? undefined,
          scene: params.get('scene') ?? undefined,
          session: params.get('session') ?? undefined,
        },
        knowledgeReads,
      });
      send(200, withTrace(results));
    } catch (error) {
      if (error instanceof InputError) return send(400, { error: error.message });
      if (error instanceof NotFoundError) return send(404, { error: error.message });
      send(500, { error: 'Search failed' });
      server.emit('searchError', error);
    }
  });
  return server;
}
