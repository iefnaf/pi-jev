import { createHash } from 'node:crypto';
import {
  generateCases,
  metaOf,
  type CaseMeta,
  type CaseOptions,
  type EvalCase,
} from './cases.js';
import { listSessionFiles, loadSession } from './session.js';

/** Sessions smaller than this cannot reach a compaction trigger. */
const MIN_SESSION_BYTES = 100_000;

/** Every case in the corpus, as lightweight metadata (spans are not kept in memory). */
export function scanCases(options: CaseOptions): CaseMeta[] {
  const metas: CaseMeta[] = [];
  for (const file of listSessionFiles()) {
    if (file.bytes < MIN_SESSION_BYTES) continue;
    const session = loadSession(file);
    if (session) metas.push(...generateCases(session, options).map(metaOf));
  }
  return metas;
}

/** Rebuilds the full cases for the given metadata, in metadata order. */
export function loadCases(metas: readonly CaseMeta[], options: CaseOptions): EvalCase[] {
  const wanted = new Set(metas.map(meta => meta.id));
  const files = [...new Set(metas.map(meta => meta.file))];
  const byId = new Map<string, EvalCase>();
  for (const file of listSessionFiles().filter(entry => files.includes(entry.file))) {
    const session = loadSession(file);
    if (!session) continue;
    for (const evalCase of generateCases(session, options)) {
      if (wanted.has(evalCase.id)) byId.set(evalCase.id, evalCase);
    }
  }
  return metas.flatMap(meta => {
    const evalCase = byId.get(meta.id);
    return evalCase ? [evalCase] : [];
  });
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Picks `limit` cases round-robin across projects, so one busy project cannot
 * dominate the sample; within a project the order is a seeded shuffle.
 */
export function selectStratified(metas: readonly CaseMeta[], limit: number, seed: string): CaseMeta[] {
  const groups = new Map<string, CaseMeta[]>();
  for (const meta of metas) groups.set(meta.project, [...(groups.get(meta.project) ?? []), meta]);
  const queues = [...groups.entries()]
    .sort(([a], [b]) => hash(seed + a).localeCompare(hash(seed + b)))
    .map(([, items]) => items.sort((a, b) => hash(seed + a.id).localeCompare(hash(seed + b.id))));
  const picked: CaseMeta[] = [];
  while (picked.length < limit && queues.some(queue => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && picked.length < limit) picked.push(next);
    }
  }
  return picked;
}
