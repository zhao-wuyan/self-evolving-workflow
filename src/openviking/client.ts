import { InputError, requireText } from '../common.js';
import { workflowRecord } from '../workflow-skills.js';
import { connectionConfig } from './config.js';
import type { OpenVikingProject, WriteOperation } from './types.js';

export class OpenVikingError extends InputError {
  constructor(readonly code: string, readonly status?: number, readonly task_id?: string) {
    super(`${code}${status === undefined ? '' : ` (HTTP ${status})`}${task_id ? ` task_id=${task_id}` : ''}`);
  }
}
export function isMissing(error: unknown) {
  return error instanceof OpenVikingError && (error.status === 404 || error.code === 'NOT_FOUND');
}
export function isUnavailable(error: unknown) {
  return error instanceof OpenVikingError && (['OPENVIKING_RESULT_UNKNOWN', 'OPENVIKING_DISABLED'].includes(error.code) || (error.status ?? 0) >= 500 || error.status === 429) ||
    error instanceof InputError && error.message.startsWith('OPENVIKING_CONFIG_INVALID');
}
function responseError(status: number, value: unknown) {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const error = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : {};
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const safe = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : undefined;
  return new OpenVikingError(safe(error.code) ?? 'OPENVIKING_REQUEST_FAILED', status, safe(details.task_id ?? error.task_id ?? data.task_id));
}

export class OpenVikingClient {
  private connection?: { url: string; api_key: string };
  private verifiedIdentity?: { version: string; account_id: string; user_id: string };
  constructor(private readonly offline = false) {}
  private get config() {
    if (this.offline) throw new OpenVikingError('OPENVIKING_DISABLED');
    return this.connection ??= connectionConfig();
  }

  private async request(path: string, body?: unknown, binary = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.config.url + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        // Git 和回放子进程会同步阻塞事件循环，不复用可能已被服务端关闭的空闲连接。
        headers: { 'X-API-Key': this.config.api_key, Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
      });
    } catch (error) { if (error instanceof OpenVikingError) throw error; throw new OpenVikingError('OPENVIKING_RESULT_UNKNOWN'); }
    if (binary && response.ok) {
      try { return Buffer.from(await response.arrayBuffer()); }
      catch { throw new OpenVikingError('OPENVIKING_RESULT_UNKNOWN', response.status); }
    }
    let data: Record<string, unknown>;
    try { data = workflowRecord(await response.json(), 'OpenViking envelope'); }
    catch { throw new OpenVikingError('OPENVIKING_INVALID_RESPONSE', response.status); }
    if (!response.ok || data.status !== 'ok' || data.error !== undefined && data.error !== null) {
      throw responseError(response.status, data);
    }
    if (!Object.hasOwn(data, 'result')) throw new OpenVikingError('OPENVIKING_INVALID_RESPONSE', response.status);
    return data.result;
  }

  async health(): Promise<{ version: string; account_id: string; user_id: string }> {
    // health 是服务状态接口，不使用业务 API envelope。
    const { url, api_key } = this.config;
    let response: Response;
    try { response = await fetch(url + '/health', { headers: { 'X-API-Key': api_key, Connection: 'close' },
      redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch (error) { if (error instanceof OpenVikingError) throw error; throw new OpenVikingError('OPENVIKING_RESULT_UNKNOWN'); }
    const data = workflowRecord(await response.json(), 'OpenViking health');
    if (!response.ok) throw responseError(response.status, data);
    return { version: requireText(data.version, 'OpenViking version'), account_id: requireText(data.account_id, 'OpenViking account'),
      user_id: requireText(data.user_id, 'OpenViking user') };
  }

  async assertCapabilities() {
    let response: Response;
    try { response = await fetch(this.config.url + '/openapi.json', { headers: { 'X-API-Key': this.config.api_key, Connection: 'close' }, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch (error) { if (error instanceof OpenVikingError) throw error; throw new OpenVikingError('OPENVIKING_RESULT_UNKNOWN'); }
    if (!response.ok) throw new OpenVikingError('OPENVIKING_CAPABILITY_CHECK_FAILED', response.status);
    const document = workflowRecord(await response.json(), 'OpenViking OpenAPI');
    const schemas = workflowRecord(workflowRecord(document.components, 'OpenAPI components').schemas, 'OpenAPI schemas');
    const resolve = (value: unknown): Record<string, unknown> => {
      const schema = workflowRecord(value, 'OpenAPI schema');
      if (typeof schema.$ref !== 'string') return schema;
      if (!schema.$ref.startsWith('#/components/schemas/')) throw new OpenVikingError('OPENVIKING_CAPABILITY_UNSUPPORTED');
      return workflowRecord(schemas[schema.$ref.slice('#/components/schemas/'.length)], 'OpenAPI referenced schema');
    };
    const paths = workflowRecord(document.paths, 'OpenAPI paths');
    const operation = workflowRecord(workflowRecord(paths['/api/v1/content/batch-write'], 'batch-write route').post, 'batch-write operation');
    const content = workflowRecord(workflowRecord(operation.requestBody, 'batch-write body').content, 'batch-write content');
    const body = resolve(workflowRecord(content['application/json'], 'batch-write JSON').schema);
    const properties = workflowRecord(body.properties, 'batch-write properties');
    const operations = resolve(properties.operations);
    const fields = workflowRecord(resolve(operations.items).properties, 'batch-write item properties');
    if (['root_uri', 'wait', 'skip_conflicts', 'defer_processing'].some(key => !Object.hasOwn(properties, key)) ||
        ['uri', 'mode', 'content_base64', 'expected_sha256', 'if_absent'].some(key => !Object.hasOwn(fields, key))) {
      throw new OpenVikingError('OPENVIKING_CAPABILITY_UNSUPPORTED');
    }
  }

  get endpoint() { return this.config.url; }

  async identity(project: Pick<OpenVikingProject, 'account_id' | 'user_id'>) {
    const health = this.verifiedIdentity ??= await this.health();
    if (health.account_id !== project.account_id || health.user_id !== project.user_id) throw new OpenVikingError('OPENVIKING_IDENTITY_MISMATCH');
    return health;
  }
  async stat(uri: string): Promise<{ isDir: boolean }> {
    const value = workflowRecord(await this.request('/api/v1/fs/stat?' + new URLSearchParams({ uri })), 'OpenViking stat');
    if (typeof value.isDir !== 'boolean') throw new OpenVikingError('OPENVIKING_INVALID_STAT');
    return { isDir: value.isDir };
  }
  async mkdir(uri: string): Promise<void> {
    try { await this.request('/api/v1/fs/mkdir', { uri }); }
    catch (error) {
      if (!(error instanceof OpenVikingError) || error.code !== 'ALREADY_EXISTS' || !(await this.stat(uri)).isDir) throw error;
    }
  }
  async download(uri: string): Promise<Buffer> {
    return await this.request('/api/v1/content/download?' + new URLSearchParams({ uri }), undefined, true) as Buffer;
  }
  async find(query: string, target: string, limit: number): Promise<Array<{ uri: string; score: number }>> {
    const value = workflowRecord(await this.request('/api/v1/search/find', {
      query, target_uri: target, context_type: 'resource', level: 2, limit, read_content: false,
    }), 'OpenViking search');
    if (!Array.isArray(value.resources)) throw new OpenVikingError('OPENVIKING_INVALID_SEARCH');
    return value.resources.map(item => {
      const hit = workflowRecord(item, 'OpenViking hit');
      if (typeof hit.uri !== 'string' || typeof hit.score !== 'number' || !Number.isFinite(hit.score)) {
        throw new OpenVikingError('OPENVIKING_INVALID_SEARCH');
      }
      return { uri: hit.uri, score: hit.score };
    });
  }
  async batchWrite(root: string, operations: WriteOperation[], deferred: boolean): Promise<void> {
    if (!operations.length || operations.some(item => !item.uri.startsWith(root + '/') || item.mode !== 'replace' ||
      !/^(?:current\.json|blobs\/[a-f0-9]{64}\.bin|releases\/[a-f0-9]{64}\/(?:manifest\.json|memory\/[a-f0-9]{64}\.md))$/.test(item.uri.slice(root.length + 1)) ||
      (item.if_absent && item.expected_sha256) || (!item.if_absent && !item.expected_sha256))) {
      throw new OpenVikingError('OPENVIKING_INVALID_WRITE');
    }
    await this.writeBatch(root, operations, deferred);
  }

  async writeExperience(identity: Pick<OpenVikingProject, 'account_id' | 'user_id'>, path: string, body: Buffer, previous?: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(identity.user_id) ||
        !/^[a-z][a-z0-9-]{0,31}\/[a-f0-9]{64}\/[a-f0-9]{64}\.md$/.test(path) ||
        body.length > 64 * 1024 || previous !== undefined && !/^[a-f0-9]{64}$/.test(previous)) {
      throw new OpenVikingError('OPENVIKING_INVALID_EXPERIENCE_WRITE');
    }
    await this.identity(identity);
    const root = personalExperienceUri(identity.user_id);
    await this.writeBatch(root, [{ uri: root + '/' + path, mode: 'replace', content_base64: body.toString('base64'),
      ...(previous ? { expected_sha256: previous } : { if_absent: true }) }], false);
  }

  private async writeBatch(root: string, operations: WriteOperation[], deferred: boolean): Promise<void> {
    const value = workflowRecord(await this.request('/api/v1/content/batch-write', {
      root_uri: root, operations, wait: true, skip_conflicts: false, defer_processing: deferred,
    }), 'OpenViking batch result');
    const committed = ['created', 'updated', 'unchanged'].flatMap(key => {
      if (!Array.isArray(value[key]) || value[key].some(uri => typeof uri !== 'string')) {
        throw new OpenVikingError('OPENVIKING_BATCH_INCOMPLETE');
      }
      return value[key] as string[];
    });
    const queue = value.queue_status;
    const queueErrors = queue && typeof queue === 'object' && Object.values(queue).some(item =>
      item && typeof item === 'object' && (Number((item as Record<string, unknown>).error_count ?? 0) > 0 ||
        Array.isArray((item as Record<string, unknown>).errors) && ((item as Record<string, unknown>).errors as unknown[]).length > 0));
    if (operations.some(item => !committed.includes(item.uri)) || queueErrors ||
        !['complete', 'skipped', ...(deferred ? ['deferred'] : [])].includes(String(value.semantic_status)) ||
        !['complete', 'skipped', ...(deferred ? ['deferred'] : [])].includes(String(value.vector_status))) {
      throw new OpenVikingError('OPENVIKING_BATCH_INCOMPLETE', undefined,
        typeof value.task_id === 'string' && /^[\w-]+$/.test(value.task_id) ? value.task_id : undefined);
    }
  }
}

export function personalExperienceUri(user: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) throw new OpenVikingError('OPENVIKING_IDENTITY_MISMATCH');
  return `viking://user/${user}/resources/evolve/personal-experience`;
}

export async function ensureDirectory(client: OpenVikingClient, uri: string) {
  const match = /^(viking:\/\/user\/[^/]+\/resources)(\/.*)?$/.exec(uri);
  if (!match) throw new OpenVikingError('OPENVIKING_PROJECT_ROOT_INVALID');
  let current = match[1];
  for (const part of (match[2] ?? '').split('/').filter(Boolean)) {
    current += '/' + part;
    try { if (!(await client.stat(current)).isDir) throw new OpenVikingError('OPENVIKING_NOT_DIRECTORY'); }
    catch (error) { if (!isMissing(error)) throw error; await client.mkdir(current); }
  }
}
