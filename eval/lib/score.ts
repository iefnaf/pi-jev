import type { ToolCall } from '../../src/vendor/fast-jev-compaction/index.js';
import type { CaseLabels } from './labels.js';
import type { Outcome } from './policies.js';

export interface Score {
  /** 1 - summaryTokens / spanTokens. */
  reduction: number;
  summaryTokens: number;
  /** Share of `needed` tokens still present in the summary; null when none were needed. */
  recall: number | null;
  needed: number;
  /** Same for strings from call inputs the agent later recalled; null when none. */
  callRecall: number | null;
  /** Calls the agent later re-ran, and how many of those lost their verbatim result. */
  rerunCalls: number;
  rerunLost: number;
  /** Calls with any evidence of later use, and how many lost their verbatim result. */
  usedCalls: number;
  usedLost: number;
  /** Verbatim result tokens kept, and the part of it nothing ever used. */
  keptResultTokens: number;
  wastedTokens: number;
  /** Result tokens of used calls that were not kept: what the agent must fetch again. */
  refetchTokens: number;
  calls: number;
  kept: number;
}

export function scoreOutcome(
  labels: CaseLabels,
  calls: readonly ToolCall[],
  outcome: Outcome,
  spanTokens: number,
): Score {
  let rerunCalls = 0;
  let rerunLost = 0;
  let usedCalls = 0;
  let usedLost = 0;
  let keptResultTokens = 0;
  let wastedTokens = 0;
  let refetchTokens = 0;
  let kept = 0;

  for (const call of calls) {
    const label = labels.calls.get(call.id);
    if (!label) continue;
    const keep = outcome.actions.get(call.id) === 'keep';
    if (keep) {
      kept += 1;
      keptResultTokens += label.resultTokens;
      if (!label.used) wastedTokens += label.resultTokens;
    }
    if (label.rerun) {
      rerunCalls += 1;
      if (!keep) rerunLost += 1;
    }
    if (label.used) {
      usedCalls += 1;
      if (!keep) {
        usedLost += 1;
        refetchTokens += label.resultTokens;
      }
    }
  }

  let present = 0;
  for (const token of labels.needed) if (outcome.summary.includes(token)) present += 1;

  let callPresent = 0;
  for (const token of labels.neededCall) if (outcome.summary.includes(token)) callPresent += 1;

  return {
    reduction: spanTokens === 0 ? 0 : 1 - outcome.summaryTokens / spanTokens,
    summaryTokens: outcome.summaryTokens,
    recall: labels.needed.size === 0 ? null : present / labels.needed.size,
    needed: labels.needed.size,
    callRecall: labels.neededCall.size === 0 ? null : callPresent / labels.neededCall.size,
    rerunCalls,
    rerunLost,
    usedCalls,
    usedLost,
    keptResultTokens,
    wastedTokens,
    refetchTokens,
    calls: calls.length,
    kept,
  };
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

export interface Aggregate {
  cases: number;
  reduction: number;
  summaryTokens: number;
  /** Mean over cases that had something to preserve. */
  recall: number;
  callRecall: number;
  /** Lost / total, pooled over all cases. */
  rerunLostRate: number;
  usedLostRate: number;
  wasteShare: number;
  /** Mean per case: tokens kept, tokens to fetch again, and their sum. */
  refetchTokens: number;
  effectiveTokens: number;
}

export function aggregate(scores: readonly Score[]): Aggregate {
  const sum = (pick: (score: Score) => number): number =>
    scores.reduce((total, score) => total + pick(score), 0);
  const ratio = (num: number, den: number): number => (den === 0 ? NaN : num / den);
  return {
    cases: scores.length,
    reduction: mean(scores.map(score => score.reduction)),
    summaryTokens: mean(scores.map(score => score.summaryTokens)),
    recall: mean(scores.flatMap(score => (score.recall === null ? [] : [score.recall]))),
    callRecall: mean(scores.flatMap(score => (score.callRecall === null ? [] : [score.callRecall]))),
    rerunLostRate: ratio(sum(score => score.rerunLost), sum(score => score.rerunCalls)),
    usedLostRate: ratio(sum(score => score.usedLost), sum(score => score.usedCalls)),
    wasteShare: ratio(sum(score => score.wastedTokens), sum(score => score.keptResultTokens)),
    refetchTokens: mean(scores.map(score => score.refetchTokens)),
    effectiveTokens: mean(scores.map(score => score.summaryTokens + score.refetchTokens)),
  };
}

/**
 * Probability that a random positive outranks a random negative (ties count
 * half). Independent of any threshold, so it isolates how well a score orders
 * calls from how well its cut-off was chosen. Null without both classes.
 */
export function auc(scores: readonly number[], positive: readonly boolean[]): number | null {
  const pos: number[] = [];
  const neg: number[] = [];
  scores.forEach((score, index) => (positive[index] ? pos : neg).push(score));
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/**
 * AUC restricted to pairs of the same tool whose result sizes are within
 * `tolerance` (natural log) of each other. Size is the main confound in the
 * used/unused labels (bigger outputs hold more distinctive strings, so they
 * are easier to "use"); comparing like with like leaves only the ordering
 * signal. Null when no pair qualifies.
 */
export function matchedAuc(
  scores: readonly number[],
  positive: readonly boolean[],
  tools: readonly string[],
  sizes: readonly number[],
  tolerance = Math.log(2),
): number | null {
  let wins = 0;
  let pairs = 0;
  for (let i = 0; i < scores.length; i++) {
    if (!positive[i]) continue;
    for (let j = 0; j < scores.length; j++) {
      if (positive[j] || tools[i] !== tools[j]) continue;
      if (Math.abs(Math.log1p(sizes[i]!) - Math.log1p(sizes[j]!)) > tolerance) continue;
      pairs += 1;
      wins += scores[i]! > scores[j]! ? 1 : scores[i] === scores[j] ? 0.5 : 0;
    }
  }
  return pairs === 0 ? null : wins / pairs;
}
