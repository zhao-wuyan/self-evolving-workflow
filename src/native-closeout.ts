import { evolvePath, InputError } from './common.js';
import { harvestCompletion, readHarvest } from './closeout.js';
import { tryMemoryFileLock, releaseMemoryFileLock } from './memory-file-lock.js';
import { readNativeCloseoutJobs, updateNativeCloseoutJob, type NativeCloseoutJob } from './workflow-runtime.js';
import { Wiki } from './wiki.js';
import type { LlmClient } from './upstream/llm.js';

export function nativeCloseoutStatus(root: string) {
  return readNativeCloseoutJobs(root).map(({ receipt, ...job }) => ({
    ...job, evidence_count: receipt.messages.length,
  }));
}

export function hasPendingNativeCloseouts(root: string) {
  return readNativeCloseoutJobs(root).some(job => job.state === 'pending' || job.state === 'running');
}

/** Same receipt and same destination for every retry. The worker never approves a Wiki/Skill change. */
async function processJob(root: string, wiki: Wiki, job: NativeCloseoutJob, model: () => LlmClient): Promise<Awaited<ReturnType<typeof harvestCompletion>>> {
  if (job.state === 'done') return { ...readHarvest(wiki, job.project, job.receipt_id), replayed: true, session_id: job.session_id, receipt_id: job.receipt_id };
  updateNativeCloseoutJob(root, job.receipt_id, 'running');
  try {
    const result = await harvestCompletion(wiki, job.project, job.receipt, model);
    updateNativeCloseoutJob(root, job.receipt_id, 'done');
    return result;
  } catch (error) {
    updateNativeCloseoutJob(root, job.receipt_id, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function processNativeCloseout(root: string, session: string, model: () => LlmClient): Promise<Awaited<ReturnType<typeof harvestCompletion>>> {
  const lock = tryMemoryFileLock(evolvePath(root, 'closeout-worker.lock'));
  if (!lock) throw new InputError('Knowledge closeout is processing; inspect evolve kb closeouts and retry.');
  try {
    const [job] = readNativeCloseoutJobs(root, session);
    if (!job) throw new InputError('No frozen Session closeout receipt: ' + session);
    return await processJob(root, new Wiki(root), job, model);
  } finally {
    releaseMemoryFileLock(lock);
  }
}

export async function drainNativeCloseouts(root: string, model: () => LlmClient, retryFailed = false) {
  const eligible = (job: NativeCloseoutJob) => job.state === 'pending' || job.state === 'running' || (retryFailed && job.state === 'failed');
  const results: Array<{ session_id: string; receipt_id: string; candidates: number; replayed: boolean }> = [];
  const errors: Array<{ session_id: string; receipt_id: string; error: string }> = [];
  if (!readNativeCloseoutJobs(root).some(eligible)) return { results, errors, already_running: false };
  const lock = tryMemoryFileLock(evolvePath(root, 'closeout-worker.lock'));
  if (!lock) return { results, errors, already_running: true };
  try {
    const wiki = new Wiki(root);
    const seen = new Set<string>();
    while (true) {
      const jobs = readNativeCloseoutJobs(root).filter(job => eligible(job) && !seen.has(job.receipt_id));
      if (!jobs.length) break;
      for (const job of jobs) {
        seen.add(job.receipt_id);
        try {
          const result = await processJob(root, wiki, job, model);
          results.push({ session_id: job.session_id, receipt_id: job.receipt_id, candidates: result.candidates.length, replayed: result.replayed });
        } catch (error) {
          errors.push({ session_id: job.session_id, receipt_id: job.receipt_id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  } finally {
    releaseMemoryFileLock(lock);
  }
  return { results, errors, already_running: false };
}
