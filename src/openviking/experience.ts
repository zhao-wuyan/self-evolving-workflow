import { existsSync, realpathSync } from 'node:fs';
import { InputError, openDb, searchLimit } from '../common.js';
import { workflowRecord } from '../workflow-skills.js';
import { sha256, stableJson } from './assets.js';
import { ensureDirectory, isMissing, OpenVikingClient, personalExperienceUri } from './client.js';
import {
  collectExperience, experienceContent, experienceDigest, experienceDomain, experienceId, experienceStack, experienceText,
  readExperienceProfile, setExperienceCollection, type ExperienceCandidate, type ExperienceContent, type ExperienceProfile,
} from './experience-candidates.js';

const schema = 'evolve-personal-experience/1.0';
const trust_boundary = 'untrusted_evidence_data_only';
type Assertion = { source: string; verification: string };
type Conflict = { id: string; sha256: string };
type Reference = { schema_version: typeof schema; mode: 'reference'; id: string; content: ExperienceContent;
  evidence: Assertion[]; conflicts: Conflict[] };
type Located = { reference: Reference; content_sha256: string; uri: string };
type Receipt = { id: string; uri: string; content_sha256: string; action: Relation; related?: string };
type Relation = 'new' | 'duplicate' | 'conflict';

function digestId(value: unknown) {
  if (typeof value !== 'string' || !experienceId.test(value)) throw new InputError('Expected an exact experience SHA-256 ID');
  return value;
}

function relationValue(value: unknown): Relation {
  if (value !== 'new' && value !== 'duplicate' && value !== 'conflict') throw new InputError('Experience relation must be new, duplicate or conflict');
  return value;
}

function parseReference(body: Buffer, id: string, scope: { domain: string; stack: string }): Located['reference'] {
  if (!body.length || body.length > 64 * 1024) throw new InputError('Invalid stored experience size');
  const raw = workflowRecord(JSON.parse(body.toString('utf8')), 'stored experience');
  const record = workflowRecord(raw.reference, 'experience reference');
  const content = experienceContent(record.content);
  if (record.schema_version !== schema || record.mode !== 'reference' || record.id !== id || experienceDigest(content) !== id ||
      content.domain !== scope.domain || content.stack !== scope.stack || !Array.isArray(record.evidence) || !record.evidence.length ||
      !Array.isArray(record.conflicts)) throw new InputError('Stored experience identity or scope mismatch');
  const evidence = record.evidence.map(item => {
    const value = workflowRecord(item, 'experience evidence');
    return { source: digestId(value.source), verification: experienceText(value.verification, 'experience verification', 500) };
  });
  if (new Set(evidence.map(item => item.source)).size !== evidence.length) throw new InputError('Duplicate experience evidence');
  const conflicts = record.conflicts.map(item => {
    const value = workflowRecord(item, 'experience conflict');
    const other = digestId(value.id);
    if (other === id) throw new InputError('Self-referential experience conflict');
    return { id: other, sha256: digestId(value.sha256) };
  });
  const reference: Reference = { schema_version: schema, mode: 'reference', id, content, evidence, conflicts };
  if (experienceDigest(reference) !== raw.sha256) throw new InputError('Stored experience checksum mismatch');
  return reference;
}

class ExperienceLibrary {
  private readonly root: string;
  private readonly client = new OpenVikingClient();
  constructor(private readonly profile: ExperienceProfile) { this.root = personalExperienceUri(profile.user_id); }
  get destination() { return { endpoint: this.client.endpoint, account_id: this.profile.account_id, root_uri: this.root }; }

  private scopePath(scope: { domain: string; stack: string }) { return scope.domain + '/' + experienceDigest(scope.stack); }

  async read(scope: { domain: string; stack: string }, id: string): Promise<Located | undefined> {
    await this.client.identity(this.profile);
    const uri = this.root + '/' + this.scopePath(scope) + '/' + id + '.md';
    let body: Buffer;
    try { body = await this.client.download(uri); }
    catch (error) { if (isMissing(error)) return; throw error; }
    return { uri, content_sha256: sha256(body), reference: parseReference(body, id, scope) };
  }

  async search(scope: { domain: string; stack: string }, query: string, limit: number) {
    await this.client.identity(this.profile);
    const dir = this.root + '/' + this.scopePath(scope);
    try { if (!(await this.client.stat(dir)).isDir) throw new InputError('Experience scope is not a directory'); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const candidates = await this.client.find(query, dir, Math.min(limit + 5, 100));
    const results: Array<Located & { score: number }> = [];
    const seen = new Set<string>();
    for (const hit of candidates) {
      if (!hit.uri.startsWith(dir + '/')) continue;
      const name = hit.uri.slice(dir.length + 1);
      if (!/^[a-f0-9]{64}\.md$/.test(name) || seen.has(name)) continue;
      seen.add(name);
      const item = await this.read(scope, name.slice(0, -3));
      if (item) results.push({ ...item, score: hit.score });
      if (results.length === limit) break;
    }
    return results;
  }

  async prepare(candidate: ExperienceCandidate, relation?: Relation, related?: string) {
    const content = candidate.content;
    const id = experienceDigest(content);
    const existing = await this.read(content, id);
    const action = relation ?? (existing ? 'duplicate' : 'new');
    if (action === 'conflict' && (!related || related === id) || action === 'new' && related) {
      throw new InputError('A conflict needs one distinct related experience ID; new does not take a related ID');
    }
    if (action !== 'duplicate' && existing) throw new InputError('Exact experience already exists; review as duplicate');
    const other = action === 'new' ? undefined : related && related !== id ? await this.read(content, related) : existing;
    if (action !== 'new' && !other) throw new InputError('Related experience does not exist in this stack');
    const evidence = { source: candidate.source, verification: candidate.verification };
    let reference: Reference;
    if (action === 'duplicate' && other) {
      const recorded = other.reference.evidence.find(item => item.source === evidence.source);
      if (recorded && recorded.verification !== evidence.verification) throw new InputError('Conflicting verification for the same source');
      reference = recorded ? other.reference : { ...other.reference, evidence: [...other.reference.evidence, evidence] };
    } else {
      reference = { schema_version: schema, mode: 'reference', id, content, evidence: [evidence],
        conflicts: other ? [{ id: other.reference.id, sha256: other.content_sha256 }] : [] };
    }
    const binding = { candidate_id: candidate.id, destination: this.destination, action, id: reference.id,
      related: other ? { id: other.reference.id, sha256: other.content_sha256 } : null,
      reference_sha256: experienceDigest(reference) };
    return { binding, reference, approval: experienceDigest(binding), previous: action === 'duplicate' ? other : undefined };
  }

  async commit(plan: Awaited<ReturnType<ExperienceLibrary['prepare']>>): Promise<Receipt> {
    const { reference, previous, binding } = plan;
    const body = Buffer.from(stableJson({ reference, sha256: binding.reference_sha256 }));
    const expected = sha256(body);
    if (body.length > 64 * 1024) throw new InputError('Published experience exceeds the size limit');
    const path = this.scopePath(reference.content);
    if (previous?.content_sha256 !== expected) {
      await this.client.assertCapabilities();
      await ensureDirectory(this.client, this.root + '/' + path);
      await this.client.writeExperience(this.profile, path + '/' + reference.id + '.md', body, previous?.content_sha256);
    }
    const observed = await this.read(reference.content, reference.id);
    if (observed?.content_sha256 !== expected) throw new InputError('Experience publication readback mismatch');
    return { id: reference.id, uri: observed.uri, content_sha256: expected, action: binding.action,
      ...(binding.related ? { related: binding.related.id } : {}) };
  }
}

function ledger(profile: ExperienceProfile, readonly: boolean) {
  if (readonly && !existsSync(profile.ledger)) return;
  const db = openDb(profile.ledger, readonly);
  if (!readonly) db.exec('CREATE TABLE IF NOT EXISTS experience_publications (destination TEXT, candidate TEXT, approval TEXT, receipt TEXT, PRIMARY KEY (destination, candidate)) STRICT');
  return db;
}

function ack(profile: ExperienceProfile, destination: string, candidate?: string) {
  const db = ledger(profile, true);
  try {
    if (candidate) return db?.prepare('SELECT candidate, approval, receipt FROM experience_publications WHERE destination = ? AND candidate = ?').all(destination, candidate) ?? [];
    return db?.prepare('SELECT candidate, approval, receipt FROM experience_publications WHERE destination = ?').all(destination) ?? [];
  } finally { db?.close(); }
}

function candidates(profile: ExperienceProfile) {
  return profile.roots.flatMap(root => existsSync(root) && realpathSync(root) === root ? collectExperience(root).candidates : []);
}

export const experienceHelp = [
  'evolve experience enable|disable   Toggle local collection for the current Git worktree',
  'evolve experience status', 'evolve experience pending',
  'evolve experience review <candidate-id> [--relation new|duplicate|conflict] [--related <id>]',
  'evolve experience publish <candidate-id> --relation new|duplicate|conflict --approval <review-sha256> [--related <id>]',
  'evolve experience search <domain> <stack> <query> [--limit <n>]',
  'evolve experience get <domain> <stack> <id>',
  'Enable reuses the configured OpenViking identity and updates only the local personal profile. It never publishes experience.',
].join('\n');

export async function experienceCommand(root: string, action: string, args: string[], flags: {
  relation?: string; related?: string; approval?: string; limit?: string;
}) {
  if (action === 'enable' || action === 'disable') {
    if (args.length || Object.values(flags).some(value => value !== undefined)) throw new InputError(experienceHelp);
    return setExperienceCollection(root, action === 'enable');
  }
  const profile = readExperienceProfile();
  if (action === 'status' && !args.length && !Object.values(flags).some(value => value !== undefined)) {
    return { configured: Boolean(profile), collecting: profile?.roots.includes(realpathSync(root)) ?? false };
  }
  if (!profile) throw new InputError('Personal experience profile is not configured');
  const library = new ExperienceLibrary(profile);
  if (action === 'search' || action === 'get') {
    if (args.length !== 3 || flags.approval || flags.relation || flags.related || action === 'get' && flags.limit) throw new InputError(experienceHelp);
    const scope = { domain: experienceDomain(args[0]), stack: experienceStack(args[1]) };
    if (action === 'search') return { trust_boundary, ...scope, results: await library.search(scope,
      experienceText(args[2], 'experience query', 500), searchLimit(flags.limit === undefined ? 10 : Number(flags.limit))) };
    const result = await library.read(scope, digestId(args[2]));
    if (!result) throw new InputError('Experience not found in this stack');
    return { trust_boundary, ...result };
  }
  if (action === 'pending' && !args.length && !Object.values(flags).some(value => value !== undefined)) {
    const destination = experienceDigest(library.destination);
    const published = new Set(ack(profile, destination).map(item => item.candidate));
    return { trust_boundary, candidates: candidates(profile).filter(row => !published.has(row.id)) };
  }
  if (!['review', 'publish'].includes(action) || args.length !== 1 || flags.limit !== undefined || action === 'review' && flags.approval !== undefined) {
    throw new InputError(experienceHelp);
  }
  const id = digestId(args[0]);
  const relation = action === 'publish' || flags.relation !== undefined ? relationValue(flags.relation) : undefined;
  const related = flags.related === undefined ? undefined : digestId(flags.related);
  const approval = action === 'publish' ? digestId(flags.approval) : undefined;
  const candidate = candidates(profile).find(row => row.id === id);
  if (!candidate) throw new InputError('Experience candidate is not in an authorized completed workflow');
  const destination = experienceDigest(library.destination);
  const [published] = ack(profile, destination, candidate.id);
  if (published) {
    if (approval && published.approval !== approval) throw new InputError('Experience candidate already published under a different approval');
    const receipt = JSON.parse(String(published.receipt)) as Receipt;
    if (relation && receipt.action !== relation) throw new InputError('Experience candidate already published under a different relation');
    if (related && receipt.related !== related) throw new InputError('Experience candidate already published against a different reference');
    return { ...receipt, replayed: true };
  }
  if (action === 'review') {
    const plan = await library.prepare(candidate, relation, related);
    const possible = await library.search(candidate.content, 'verified software engineering experience', 10);
    return { trust_boundary, ...plan.binding, approval: plan.approval, reference: plan.reference, local_evidence: candidate.local_evidence,
      possible_related: possible.map(item => ({ id: item.reference.id, content: item.reference.content, conflicts: item.reference.conflicts })) };
  }
  const plan = await library.prepare(candidate, relation, related);
  if (plan.approval !== approval) throw new InputError('Experience approval is stale or does not match this exact action and destination; review again');
  const db = ledger(profile, false)!;
  try {
    // 本地串行化同一候选的批准；远端 CAS 仍保护其他客户端的并发变更。
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare('SELECT approval, receipt FROM experience_publications WHERE destination = ? AND candidate = ?')
      .get(destination, candidate.id);
    if (existing) {
      if (existing.approval !== approval) throw new InputError('Experience candidate already published under a different approval');
      db.exec('COMMIT');
      return { ...JSON.parse(String(existing.receipt)) as Receipt, replayed: true };
    }
    const receipt = await library.commit(plan);
    db.prepare('INSERT INTO experience_publications VALUES (?, ?, ?, ?)')
      .run(destination, candidate.id, plan.approval, JSON.stringify(receipt));
    db.exec('COMMIT');
    return { ...receipt, replayed: false };
  } finally { db.close(); }
}
