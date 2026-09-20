/**
 * L1: calls Jev on real spans and scores its decisions against what the agent
 * did next. Every request is cached on disk by content, so re-running, or
 * sweeping `keepThreshold` (which does not change the request), costs nothing
 * after the first pass.
 *
 *   npx vite-node eval/l1.ts [--limit 30] [--window 128000] [--seed s]
 *        [--thresholds 0.1,0.3,0.5] [--offline] [--concurrency 4]
 *
 * Without --thresholds the sweep is derived from the data: Jev's keep
 * probabilities are far from uniform, so fixed cut-offs can all land on the
 * same side. It picks the thresholds that would keep 2%..40% of results.
 *
 * Each Jev outcome is compared with the budget-matched baselines from L0: same
 * summary size, so the only difference is which calls each policy keeps.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JevClient } from '../src/vendor/fast-jev-compaction/index.js';
import { loadConfig } from '../src/shared/config.js';
import { DEFAULT_CASE_OPTIONS } from './lib/cases.js';
import { CachingAsker } from './lib/cache.js';
import { enrich, type EnrichOptions } from './lib/enrich.js';
import { loadCases, scanCases, selectStratified } from './lib/corpus.js';
import { BUDGETED, runBaseline, runOracle, type BaselineName } from './lib/policies.js';
import { argument, flag, num, pct, quantiles, table, writeOut } from './lib/report.js';
import { prepare, runJev, type Prepared } from './lib/run.js';
import { aggregate, auc, matchedAuc, scoreOutcome, type Score } from './lib/score.js';
import { bootstrap, formatInterval } from './lib/stats.js';

const options = { ...DEFAULT_CASE_OPTIONS, window: Number(argument('--window') ?? DEFAULT_CASE_OPTIONS.window) };
const limit = Number(argument('--limit') ?? 30);
const seed = argument('--seed') ?? 'l1';
const offline = flag('--offline');
const concurrency = Number(argument('--concurrency') ?? 4);

const config = loadConfig();
if (!offline && !config.apiKey) {
  console.error('No Jev API key: set OPENROUTER_API_KEY or TYPESAFE_API_KEY, or pass --offline to replay the cache.');
  process.exit(2);
}
/** Experiment: tell Jev more than production does (see lib/enrich.ts). */
const variantName = argument('--variant');
const VARIANTS: Record<string, EnrichOptions> = {
  heads: { heads: true, recent: false },
  recent: { heads: false, recent: true },
  both: { heads: true, recent: true },
};
const variant = variantName ? VARIANTS[variantName] : undefined;
if (variantName && !variant) {
  console.error(`unknown --variant ${variantName}; use heads, recent or both`);
  process.exit(2);
}
const comparePath = argument('--compare');
const explicitThresholds = argument('--thresholds')?.split(',').map(Number);
/** Shares of results the auto sweep aims to keep verbatim. */
const KEEP_SHARES = [0.02, 0.05, 0.1, 0.2, 0.4];

const asker = new CachingAsker(
  offline ? undefined : new JevClient({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl }),
  `${config.provider}|${config.model}|${config.baseUrl}`,
  { offline, concurrency },
);

interface Row {
  caseId: string;
  project: string;
  threshold: number;
  spanTokens: number;
  fallback: boolean;
  jev: Score;
  baselines: Record<BaselineName, Score>;
  /** Keeps exactly what the future used; the bound no policy can reach. */
  oracle: Score;
  keepAll: Score;
  requests: number;
  calls: number;
  boundary: number;
  missing: number;
  guarded: number;
}

interface Example {
  caseId: string;
  tool: string;
  input: string;
  tokens: number;
  keepCall: number;
  keepResult: number;
  action: string;
  why: string;
}

/** Threshold-free ranking quality per case: AUC of each score at predicting later use. */
interface Ranking {
  caseId: string;
  jevResult: number | null;
  jevCall: number | null;
  small: number | null;
  recent: number | null;
  random: number | null;
  /** Same scores, but only comparing same-tool calls of similar size. */
  matched: { jev: number | null; recent: number | null; random: number | null };
}

const addedTokens: number[] = [];
const rows: Row[] = [];
const rankings: Ranking[] = [];
const unit = (text: string): number => createHash('sha1').update(text).digest().readUInt32BE(0) / 0xffffffff;
const keepResults: number[] = [];
const keepCalls: number[] = [];
const regrets: Example[] = [];
const waste: Example[] = [];
const failures: Array<{ caseId: string; error: string }> = [];

const excerpt = (input: Record<string, unknown>): string =>
  Object.values(input)
    .map(value => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 90);

async function runCase(item: Prepared, thresholds: readonly number[]): Promise<void> {
  const caseId = item.evalCase.id;
  const enriched = variant ? enrich(item, asker, config, variant) : undefined;
  if (enriched) addedTokens.push(enriched.addedTokens);
  try {
    for (const threshold of thresholds) {
      const run = await runJev(
        enriched?.prepared ?? item,
        enriched?.asker ?? asker,
        { ...(enriched?.config ?? config), keepThreshold: threshold },
      );
      const jev = scoreOutcome(item.labels, item.calls, run.outcome, item.spanTokens);
      const baselines = Object.fromEntries(
        BUDGETED.map(name => {
          const outcome = runBaseline(
            name,
            item.converted,
            item.calls,
            item.goal,
            config.truncateHeadChars,
            run.outcome.summaryTokens,
            caseId,
          );
          return [name, scoreOutcome(item.labels, item.calls, outcome, item.spanTokens)];
        }),
      ) as Record<BaselineName, Score>;
      const oracle = scoreOutcome(
        item.labels,
        item.calls,
        runOracle(item.converted, item.calls, item.goal, config.truncateHeadChars, new Set([...item.labels.calls.values()].filter(l => l.used).map(l => l.id))),
        item.spanTokens,
      );
      const keepAll = scoreOutcome(
        item.labels,
        item.calls,
        runBaseline('keep-all', item.converted, item.calls, item.goal, config.truncateHeadChars, Infinity, caseId),
        item.spanTokens,
      );
      if (!rankings.some(ranking => ranking.caseId === caseId)) {
        const labels = item.calls.map(call => item.labels.calls.get(call.id)!);
        const answers = new Map(run.decisions.map(decision => [decision.id, decision]));
        const used = labels.map(label => label.used);
        const tools = item.calls.map(call => call.tool);
        const sizes = item.calls.map(call => call.resultChars);
        const jevScores = item.calls.map(call => answers.get(call.id)?.keepResult ?? 1);
        const recentScores = item.calls.map(call => call.resultIndex);
        const randomScores = item.calls.map(call => unit(caseId + call.id));
        rankings.push({
          matched: {
            jev: matchedAuc(jevScores, used, tools, sizes),
            recent: matchedAuc(recentScores, used, tools, sizes),
            random: matchedAuc(randomScores, used, tools, sizes),
          },
          caseId,
          jevResult: auc(item.calls.map(call => answers.get(call.id)?.keepResult ?? 1), used),
          jevCall: auc(item.calls.map(call => answers.get(call.id)?.keepCall ?? 1), labels.map(label => label.callUsed)),
          small: auc(item.calls.map(call => -call.resultChars), used),
          recent: auc(item.calls.map(call => call.resultIndex), used),
          random: auc(item.calls.map(call => unit(caseId + call.id)), used),
        });
      }
      rows.push({
        caseId,
        project: item.evalCase.project,
        threshold,
        spanTokens: item.spanTokens,
        fallback: run.productionReduction < config.minReduction,
        jev,
        baselines,
        oracle,
        keepAll,
        requests: run.stats.requests,
        calls: run.stats.calls,
        boundary: run.stats.boundary,
        missing: run.stats.missing,
        guarded: run.stats.guarded,
      });

      if (threshold !== config.keepThreshold) continue;
      for (const decision of run.decisions) {
        keepResults.push(decision.keepResult);
        keepCalls.push(decision.keepCall);
      }
      const byId = new Map(item.calls.map(call => [call.id, call]));
      for (const decision of run.decisions) {
        const label = item.labels.calls.get(decision.id);
        const call = byId.get(decision.id);
        if (!label || !call) continue;
        const example: Example = {
          caseId,
          tool: call.tool,
          input: excerpt(call.input),
          tokens: label.resultTokens,
          keepCall: decision.keepCall,
          keepResult: decision.keepResult,
          action: decision.action,
          why: label.rerun ? 'rerun' : `echo ${label.echo}`,
        };
        if (label.used && decision.action !== 'keep') regrets.push(example);
        if (!label.used && !label.superseded && decision.action === 'keep') waste.push(example);
      }
    }
  } catch (error) {
    failures.push({ caseId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
    }),
  );
}

// ---------------------------------------------------------------------- main

const started = Date.now();
const metas = selectStratified(scanCases(options), limit, seed);
const prepared = loadCases(metas, options).flatMap(evalCase => {
  const item = prepare(evalCase);
  return item ? [item] : [];
});
const projects = new Set(prepared.map(item => item.evalCase.project));
console.log(
  `${prepared.length} cases from ${projects.size} projects, window ${options.window}, ` +
    `${config.provider}/${config.model}, keepThreshold ${config.keepThreshold}` +
    (variantName ? `, variant ${variantName}` : '') +
    (offline ? ', offline (cache only)' : ''),
);

async function sweepPass(thresholds: readonly number[]): Promise<void> {
  let done = 0;
  await pool(prepared, 3, async item => {
    await runCase(item, thresholds);
    done += 1;
    process.stderr.write(`\r${done}/${prepared.length} cases, ${asker.stats.misses} live requests, ${asker.stats.hits} cached`);
  });
  process.stderr.write('\n');
}

// Pass 1 fetches from the API (at the configured threshold, or the explicit
// list); pass 2 replays the cache at thresholds derived from what Jev answered.
await sweepPass(explicitThresholds ?? [config.keepThreshold]);
const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] ?? NaN;
};
const derived = explicitThresholds
  ? []
  : KEEP_SHARES.map(share => Math.round(quantile(keepResults, 1 - share) * 1000) / 1000).filter(
      value => Number.isFinite(value) && value > 0,
    );
const extra = [...new Set(derived)].filter(value => value !== config.keepThreshold);
if (extra.length > 0) await sweepPass(extra);
const thresholds = [...new Set(rows.map(row => row.threshold))].sort((a, b) => a - b);

if (failures.length > 0) {
  console.log(`\n!! ${failures.length} cases failed (production would fall back to pi):`);
  for (const failure of failures.slice(0, 5)) console.log(`   ${failure.caseId}: ${failure.error.slice(0, 120)}`);
}

// -------------------------------------------------------------------- report

const mean = (values: readonly number[]): number =>
  values.length === 0 ? NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

function rowsAt(threshold: number): Row[] {
  return rows.filter(row => row.threshold === threshold);
}

function pooledRate(sample: readonly Row[], pick: (row: Row) => Score, lost: 'rerunLost' | 'usedLost'): number {
  const denominator = lost === 'rerunLost' ? 'rerunCalls' : 'usedCalls';
  const den = sample.reduce((sum, row) => sum + pick(row)[denominator], 0);
  return den === 0 ? NaN : sample.reduce((sum, row) => sum + pick(row)[lost], 0) / den;
}

function pairedRecall(sample: readonly Row[], jevScore: (row: Row) => Score, other: (row: Row) => Score): number {
  return mean(
    sample.flatMap(row => {
      const a = jevScore(row).recall;
      const b = other(row).recall;
      return a === null || b === null ? [] : [a - b];
    }),
  );
}

console.log('\n== how confident Jev is (share of calls at or above each level) ==');
const levels = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9];
console.log(
  table([
    ['P(keep) >=', ...levels.map(String)],
    ['result verbatim', ...levels.map(level => pct(keepResults.filter(v => v >= level).length / keepResults.length, 1))],
    ['call itself', ...levels.map(level => pct(keepCalls.filter(v => v >= level).length / keepCalls.length, 1))],
  ]),
);

console.log('\n== ranking quality, independent of any threshold (AUC at predicting which results the agent later used; 0.5 = chance) ==');
{
  const auc_ = (pick: (ranking: Ranking) => number | null, sample: readonly Ranking[]): number =>
    mean(sample.flatMap(ranking => (pick(ranking) === null ? [] : [pick(ranking)!])));
  const row = (name: string, sample: readonly Ranking[], pick: (ranking: Ranking) => number | null): string[] => [
    name,
    formatInterval(bootstrap(sample, resampled => auc_(pick, resampled)), 1, 3, ''),
  ];
  const eligible = rankings.filter(ranking => ranking.jevResult !== null);
  console.log(`all pairs (${eligible.length}/${rankings.length} cases have both used and unused calls):`);
  console.log(
    table([
      ['score', 'mean AUC [95% CI]'],
      row('jev P(keep result)', eligible, r => r.jevResult),
      row('large-first (label size bias)', eligible, r => (r.small === null ? null : 1 - r.small)),
      row('small-first', eligible, r => r.small),
      row('recent', eligible, r => r.recent),
      row('random', eligible, r => r.random),
    ]),
  );
  const matched = rankings.filter(ranking => ranking.matched.jev !== null);
  console.log(`\nsame tool and size within 2x, which removes the size effect (${matched.length} cases have such pairs):`);
  console.log(
    table([
      ['score', 'mean AUC [95% CI]'],
      row('jev P(keep result)', matched, r => r.matched.jev),
      row('recent', matched, r => r.matched.recent),
      row('random', matched, r => r.matched.random),
    ]),
  );
  console.log(
    `Δ jev - random: ${formatInterval(bootstrap(matched, sample => auc_(r => r.matched.jev, sample) - auc_(r => r.matched.random, sample)), 1, 3, '')}`,
  );
  const callEligible = rankings.filter(ranking => ranking.jevCall !== null);
  console.log(
    `\njev P(keep call) predicting which calls the agent later recalled: AUC ${formatInterval(bootstrap(callEligible, sample => auc_(r => r.jevCall, sample)), 1, 3, '')} over ${callEligible.length} cases`,
  );
}

if (comparePath) {
  const before = new Map(
    (JSON.parse(readFileSync(comparePath, 'utf8')).rankings as Ranking[]).map(ranking => [ranking.caseId, ranking]),
  );
  const paired = rankings.flatMap(now => {
    const then = before.get(now.caseId);
    return then ? [{ now, then }] : [];
  });
  const meanOf = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
  const diff = (pick: (r: Ranking) => number | null) => (sample: readonly (typeof paired)[number][]): number =>
    meanOf(sample.flatMap(({ now, then }) => (pick(now) === null || pick(then) === null ? [] : [pick(now)! - pick(then)!])));
  console.log(`\n== against the run in ${comparePath.split('/').pop()} (same cases, paired) ==`);
  console.log(`size-matched AUC change: ${formatInterval(bootstrap(paired, diff(r => r.matched.jev)), 1, 3, '')}`);
  console.log(`all-pairs AUC change:    ${formatInterval(bootstrap(paired, diff(r => r.jevResult)), 1, 3, '')}`);
  console.log(`keep-call AUC change:    ${formatInterval(bootstrap(paired, diff(r => r.jevCall)), 1, 3, '')}`);
}
if (addedTokens.length > 0) {
  console.log(`\ntokens added to each Jev state: mean ${num(addedTokens.reduce((a, b) => a + b, 0) / addedTokens.length)}, max ${num(Math.max(...addedTokens))}`);
}

console.log('\n== keepThreshold sweep: Jev vs the budget-matched baseline that re-fetches least ==');
console.log('refetch = result tokens of later-used calls that were not kept; effective = summary + refetch, per case');
const sweep: string[][] = [
  ['threshold', 'reduction', 'summary tok', 'recall', 'rerun lost', 'refetch tok', 'effective', 'fallback', 'best baseline', 'Δ recall vs it', 'Δ refetch tok vs it'],
];
const sweepData: Record<string, unknown>[] = [];
for (const threshold of thresholds) {
  const at = rowsAt(threshold);
  if (at.length === 0) continue;
  const jev = aggregate(at.map(row => row.jev));
  const baselineAggs = BUDGETED.map(name => ({ name, agg: aggregate(at.map(row => row.baselines[name])) }));
  // large-first is a label-bias diagnostic, not something a policy could ship.
  const best = baselineAggs
    .filter(entry => entry.name !== 'large-first')
    .reduce((a, b) => (b.agg.refetchTokens < a.agg.refetchTokens ? b : a));
  const dRecall = bootstrap(at, sample => pairedRecall(sample, row => row.jev, row => row.baselines[best.name]));
  const dRefetch = bootstrap(at, sample => mean(sample.map(row => row.jev.refetchTokens - row.baselines[best.name].refetchTokens)));
  const mark = threshold === config.keepThreshold ? '*' : ' ';
  sweep.push([
    `${mark}${threshold}`,
    pct(jev.reduction),
    num(jev.summaryTokens),
    pct(jev.recall),
    pct(jev.rerunLostRate),
    num(jev.refetchTokens),
    num(jev.effectiveTokens),
    pct(at.filter(row => row.fallback).length / at.length),
    best.name,
    formatInterval(dRecall),
    formatInterval(dRefetch, 1, 0, ' tok'),
  ]);
  sweepData.push({ threshold, jev, baselines: Object.fromEntries(baselineAggs.map(b => [b.name, b.agg])), best: best.name, dRecall, dRefetch });
}
{
  const anyRows = rowsAt(thresholds[0]!);
  const oracle = aggregate(anyRows.map(row => row.oracle));
  const keepAll = aggregate(anyRows.map(row => row.keepAll));
  sweep.push(['oracle', pct(oracle.reduction), num(oracle.summaryTokens), pct(oracle.recall), pct(oracle.rerunLostRate), num(oracle.refetchTokens), num(oracle.effectiveTokens), '', '', '', '']);
  sweep.push(['keep-all', pct(keepAll.reduction), num(keepAll.summaryTokens), pct(keepAll.recall), pct(keepAll.rerunLostRate), num(keepAll.refetchTokens), num(keepAll.effectiveTokens), '', '', '', '']);
}
console.log(table(sweep));
console.log('(* = configured keepThreshold. Δ recall > 0 and Δ refetch < 0 mean Jev beats the baseline at the same summary size; brackets are 95% bootstrap over cases)');

const primary = rowsAt(config.keepThreshold);
if (primary.length > 0) {
  console.log(`\n== at keepThreshold ${config.keepThreshold}: Jev and baselines at the same summary size ==`);
  const detail: string[][] = [['policy', 'reduction', 'recall', 'call recall', 'rerun lost', 'used lost', 'waste', 'refetch tok', 'effective']];
  const line = (name: string, scores: Score[]): void => {
    const agg = aggregate(scores);
    detail.push([name, pct(agg.reduction), pct(agg.recall), pct(agg.callRecall), pct(agg.rerunLostRate), pct(agg.usedLostRate), pct(agg.wasteShare), num(agg.refetchTokens), num(agg.effectiveTokens)]);
  };
  line('jev', primary.map(row => row.jev));
  for (const name of BUDGETED) line(name, primary.map(row => row.baselines[name]));
  line('oracle', primary.map(row => row.oracle));
  line('keep-all', primary.map(row => row.keepAll));
  console.log(table(detail));

  const informative = primary.filter(row => row.jev.recall !== null).length;
  console.log(`\nrecall is averaged over the ${informative}/${primary.length} cases where the agent recalled result content; rerun lost pools ${primary.reduce((s, r) => s + r.jev.rerunCalls, 0)} re-run calls`);
  const fallback = primary.filter(row => row.fallback).length;
  const boundary = primary.reduce((sum, row) => sum + row.boundary, 0);
  const missing = primary.reduce((sum, row) => sum + row.missing, 0);
  const guarded = primary.reduce((sum, row) => sum + row.guarded, 0);
  const calls = primary.reduce((sum, row) => sum + row.calls, 0);
  console.log(`fallback to pi (reduction < ${config.minReduction}): ${fallback}/${primary.length}; boundary calls ${boundary}; guarded ${guarded}; missing answers ${missing} of ${calls} calls`);

  const show = (title: string, examples: Example[], count: number): void => {
    console.log(`\n== ${title} ==`);
    for (const example of examples.sort((a, b) => b.tokens - a.tokens).slice(0, count)) {
      console.log(
        `${example.caseId} ${example.tool.padEnd(11)} ${String(example.tokens).padStart(6)} tok  ` +
          `call ${example.keepCall.toFixed(2)} result ${example.keepResult.toFixed(2)} ${example.action.padEnd(11)} ${example.why.padEnd(7)} ${example.input}`,
      );
    }
  };
  show(`regrets: used later but not kept verbatim (${regrets.length} total)`, regrets, 12);
  show(`waste: kept verbatim, never used (${waste.length} total)`, waste, 8);
}

const latencies = quantiles(asker.stats.latenciesMs);
console.log('\n== cost ==');
console.log(
  `requests: ${asker.stats.misses} live, ${asker.stats.hits} from cache; live tokens in ${asker.stats.inputTokens} / out ${asker.stats.outputTokens}; ` +
    `request latency p50/p90/max ${latencies.map(v => num(v)).join(' / ')} ms`,
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const path = writeOut(`l1-${variantName ?? 'base'}-${stamp}.json`, {
  variant: variantName ?? null,
  options,
  provider: config.provider,
  model: config.model,
  config: { keepThreshold: config.keepThreshold, borderline: config.borderline, truncateHeadChars: config.truncateHeadChars, minReduction: config.minReduction },
  cases: prepared.length,
  failures,
  sweep: sweepData,
  rankings,
  rows,
  regrets,
  waste,
});
console.log(`\nwrote ${path} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
