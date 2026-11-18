import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { InputError, requireText } from '../common.js';
import { readCompletedVerificationArtifacts } from '../workflow-runtime.js';
import { workflowRecord } from '../workflow-skills.js';
import { sha256, stableJson } from './assets.js';
import { OpenVikingClient, personalExperienceUri } from './client.js';
import { replaceJson } from './config.js';
import { gitText } from './git.js';

export const experienceDigest = (value: unknown) => sha256(Buffer.from(stableJson(value)));
export const experienceId = /^[a-f0-9]{64}$/;

const profileSchema = 'evolve-experience-profile/1.0';

export function experienceText(value: unknown, label: string, max: number) {
  const text = requireText(value, label);
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new InputError('Invalid ' + label);
  return text;
}

export function experienceDomain(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new InputError('Invalid experience domain');
  return value;
}

export function experienceStack(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9.-]{0,47}@[0-9][a-z0-9.+-]{0,23}$/.test(value)) {
    throw new InputError('Expected a versioned experience stack, e.g. python@3.12');
  }
  return value;
}

export function experienceContent(value: unknown) {
  const item = workflowRecord(value, 'experience');
  return { domain: experienceDomain(item.domain), stack: experienceStack(item.stack),
    title: experienceText(item.title, 'experience title', 160),
    applicability: experienceText(item.applicability, 'experience applicability', 500),
    lesson: experienceText(item.lesson, 'experience lesson', 1000) };
}

function experienceProfilePath() {
  const path = process.env.EVOLVE_EXPERIENCE_CONFIG ?? join(homedir(), '.evolve', 'experience.json');
  if (!isAbsolute(path)) throw new InputError('EVOLVE_EXPERIENCE_CONFIG must be absolute');
  return path;
}

function readProfileBytes(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return;
  if (!entry.isFile()) throw new InputError('Invalid personal experience profile');
  return readFileSync(path);
}

function parseProfile(bytes: Buffer) {
  const data = workflowRecord(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), 'personal experience profile');
  if (data.schema_version !== profileSchema || !Array.isArray(data.collect_from) ||
      data.collect_from.some(root => typeof root !== 'string' || !isAbsolute(root))) {
    throw new InputError('Invalid personal experience profile');
  }
  const user_id = requireText(data.user_id, 'OpenViking user');
  if (!/^[a-zA-Z0-9_-]+$/.test(user_id)) throw new InputError('Invalid personal experience user');
  const account_id = requireText(data.account_id, 'OpenViking account');
  return { data, account_id, user_id, collect_from: data.collect_from as string[] };
}

export function readExperienceProfile() {
  const path = experienceProfilePath();
  const bytes = readProfileBytes(path);
  if (!bytes) return;
  const { account_id, user_id, collect_from } = parseProfile(bytes);
  return { account_id, user_id, roots: [...new Set(collect_from.map(root => resolve(root)))], ledger: path + '.db' };
}

export async function setExperienceCollection(root: string, enable: boolean) {
  const repository = realpathSync(root);
  let topLevel: string;
  try { topLevel = gitText(repository, ['rev-parse', '--show-toplevel']); }
  catch { throw new InputError('Run experience enable/disable from a Git worktree root'); }
  if (realpathSync(topLevel) !== repository) throw new InputError('Run experience enable/disable from the Git worktree root');

  const path = experienceProfilePath();
  const identity = enable ? await new OpenVikingClient().health() : undefined;
  if (identity) personalExperienceUri(identity.user_id);
  const bytes = readProfileBytes(path);
  const current = bytes ? parseProfile(bytes) : undefined;
  if (identity && current && (identity.account_id !== current.account_id || identity.user_id !== current.user_id)) {
    throw new InputError('OPENVIKING_IDENTITY_MISMATCH: the personal experience profile belongs to a different identity');
  }
  const alreadyEnabled = current?.collect_from.some(path => resolve(path) === repository) ?? false;
  const changed = enable !== alreadyEnabled;
  if (changed && current) {
    const roots = current.collect_from;
    replaceJson(path, bytes, { ...current.data, collect_from: enable ? [...roots, repository] : roots.filter(path => resolve(path) !== repository) });
  } else if (identity && !current) {
    replaceJson(path, undefined, { schema_version: profileSchema, account_id: identity.account_id, user_id: identity.user_id, collect_from: [repository] });
  }
  return { configured: enable || Boolean(current), collecting: enable, changed };
}
export type ExperienceProfile = NonNullable<ReturnType<typeof readExperienceProfile>>;
export type ExperienceContent = ReturnType<typeof experienceContent>;

export type ExperienceCandidate = { id: string; source: string; verification: string; content: ExperienceContent;
  local_evidence: { root: string; session: string; artifact: string; sha256: string; check: string } };

export function collectExperience(root: string, session?: string) {
  const candidates = new Map<string, ExperienceCandidate>();
  let rejected = 0;
  for (const artifact of readCompletedVerificationArtifacts(root, session)) {
    const test = artifact.schema === 'test-results/1.0';
    const body = artifact.body;
    if (!Array.isArray(body.experiences) || !body.experiences.length) continue;
    const checks = test ? body.tests : body.truths;
    const summary = test && body.summary && typeof body.summary === 'object' ? body.summary as Record<string, unknown> : undefined;
    if (!Array.isArray(checks) || (test ? !summary || summary.failed !== 0 || !(Number(summary.passed) > 0) : body.status !== 'passed') ||
        body.experiences.length > 10) {
      rejected += body.experiences.length;
      continue;
    }
    for (const draft of body.experiences) {
      try {
        const item = workflowRecord(draft, 'experience draft');
        const evidence = experienceText(item.evidence, 'experience evidence ID', 128);
        const matching = checks.filter(check => check && typeof check === 'object' &&
          (test ? check.test_id : check.id) === evidence);
        if (matching.length !== 1 || (test ? matching[0].status !== 'passed' : !['VERIFIED', 'verified'].includes(matching[0].status))) {
          throw new InputError('Experience evidence is not a uniquely verified check');
        }
        const verification = experienceText(item.verification, 'experience verification', 500);
        const content = experienceContent(item);
        const source = experienceDigest([root, artifact.session, artifact.sha256, evidence]);
        const id = experienceDigest([content, source, verification]);
        candidates.set(id, { id, source, verification, content,
          local_evidence: { root, session: artifact.session, artifact: artifact.id, sha256: artifact.sha256, check: evidence } });
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        rejected++;
      }
    }
  }
  return { candidates: [...candidates.values()], rejected };
}

export function completedExperience(root: string, session: string) {
  try {
    const profile = readExperienceProfile();
    if (!profile) return;
    const source = realpathSync(root);
    if (!profile.roots.includes(source)) return;
    const { candidates, rejected } = collectExperience(source, session);
    return { status: 'staged_locally', candidates: candidates.length, rejected };
  } catch (error) {
    // 会话已经完成；只报告独立的经验提取错误，不改变业务结果。
    return { status: 'collection_failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
