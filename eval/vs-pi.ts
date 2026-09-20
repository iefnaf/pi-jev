/**
 * Compares compaction policies on the calls the agent later used from memory:
 * how big the result is, and how much of what was used is still in it.
 *
 *   jev@0.5   the extension as configured (keeps almost nothing verbatim)
 *   mask      a plain rule: keep messages and calls, cut reproducible tool
 *             outputs to their head, keep other tools whole. No model call.
 *   pi        pi's own LLM summary (`compact()` and its prompts)
 *   random    random results kept verbatim, at the size of the pi summary
 *
 * A used call counts as preserved when at least half of the strings that only
 * its result held (the ones the agent later produced from memory) appear in the
 * compacted text. The same measure applies to any policy, prose included.
 *
 *   npx vite-node eval/vs-pi.ts [--cases N] [--budget 1.0] [--offline]
 *        [--model deepseek/deepseek-v4.1-flash] [--prompt-price 0.15] [--completion-price 0.6]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/shared/config.js';
import { estimateTokens } from '../src/vendor/fast-jev-compaction/index.js';
import { DEFAULT_CASE_OPTIONS } from './lib/cases.js';
import { CachingAsker } from './lib/cache.js';
import { loadCases, scanCases } from './lib/corpus.js';
import { openRouterModel, piSummary } from './lib/pisummary.js';
import { runBaseline, runMask } from './lib/policies.js';
import { argument, flag, num, OUT_DIR, pct, table, writeOut } from './lib/report.js';
import { prepare, runJev, type Prepared } from './lib/run.js';
import { bootstrap, formatInterval } from './lib/stats.js';

const options = DEFAULT_CASE_OPTIONS;
const limit = Number(argument('--cases') ?? Infinity);
const budget = Number(argument('--budget') ?? 1.0);
const offline = flag('--offline');
const modelId = argument('--model') ?? 'deepseek/deepseek-v4.1-flash';
const promptPrice = Number(argument('--prompt-price') ?? 0.15);
const completionPrice = Number(argument('--completion-price') ?? 0.6);
const apiKey = process.env.OPENROUTER_API_KEY ?? '';
if (!offline && !apiKey) {
  console.error('OPENROUTER_API_KEY is not set (or pass --offline to use cached summaries).');
  process.exit(2);
}

const config = loadConfig();
const jevAsker = new CachingAsker(undefined, `${config.provider}|${config.model}|${config.baseUrl}`, { offline: true });
const model = openRouterModel(modelId, promptPrice, completionPrice);
const hash = (text: string): string => createHash('sha1').update(text).digest('hex');

type Policy = 'jev@0.5' | 'mask' | 'pi' | 'random';
const POLICIES: Policy[] = ['jev@0.5', 'mask', 'pi', 'random'];

interface Measure {
  tokens: number;
  reduction: number;
  /** Used calls with at least half of their unique strings present. */
  preserved: number;
  used: number;
  /** Share of echoed result strings, and of recalled call-input strings, present. */
  recall: number | null;
  callRecall: number | null;
}

function measure(item: Prepared, text: string): Measure {
  const usedCalls = item.calls.filter(call => item.labels.calls.get(call.id)?.used);
  const preserved = usedCalls.filter(call => {
    const tokens = item.labels.calls.get(call.id)!.uniqueTokens;
    return tokens.filter(token => text.includes(token)).length / tokens.length >= 0.5;
  }).length;
  const share = (tokens: ReadonlySet<string>): number | null =>
    tokens.size === 0 ? null : [...tokens].filter(token => text.includes(token)).length / tokens.size;
  const tokens = estimateTokens(text);
  return {
    tokens,
    reduction: 1 - tokens / item.spanTokens,
    preserved,
    used: usedCalls.length,
    recall: share(item.labels.needed),
    callRecall: share(item.labels.neededCall),
  };
}

const started = Date.now();
const prepared = loadCases(scanCases(options), options).flatMap(evalCase => {
  const item = prepare(evalCase);
  return item ? [item] : [];
});
const withUse = prepared
  .filter(item => item.calls.some(call => item.labels.calls.get(call.id)?.used))
  .sort((a, b) => hash(a.evalCase.id).localeCompare(hash(b.evalCase.id)))
  .slice(0, limit);
console.log(`${withUse.length} cases with a call used from memory; pi summaries by ${modelId}, budget $${budget}`);

const rows: Array<{ caseId: string; measures: Record<Policy, Measure> }> = [];
const piTexts = new Map<string, string>();
let spent = 0;
let live = 0;
let failed = 0;
const queue = [...withUse];
async function work(): Promise<void> {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const estimate = (item.spanTokens / 1e6) * promptPrice * 1.15;
    if (!offline && spent + estimate > budget) {
      failed += 1;
      console.log(`\nskipped ${item.evalCase.id}: budget $${budget} would be exceeded`);
      continue;
    }
    try {
      const summary = await piSummary(item.evalCase, { model, apiKey, offline });
      if (!summary.cached) {
        spent += summary.costUsd;
        live += 1;
      }
      piTexts.set(item.evalCase.id, summary.summary);
      const jev = await runJev(item, jevAsker, config);
      const mask = runMask(item.converted, item.calls, item.goal, config.truncateHeadChars);
      const piTokens = estimateTokens(summary.summary);
      const random = runBaseline('random', item.converted, item.calls, item.goal, config.truncateHeadChars, piTokens, item.evalCase.id);
      rows.push({
        caseId: item.evalCase.id,
        measures: {
          'jev@0.5': measure(item, jev.outcome.summary),
          mask: measure(item, mask.summary),
          pi: measure(item, summary.summary),
          random: measure(item, random.summary),
        },
      });
    } catch (error) {
      failed += 1;
      console.log(`\n${item.evalCase.id}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
    process.stderr.write(`\r${rows.length}/${withUse.length} cases, ${live} live summaries, $${spent.toFixed(3)} spent`);
  }
}
await Promise.all([work(), work(), work(), work()]);
process.stderr.write('\n');
if (failed > 0) console.log(`!! ${failed} cases not completed`);

// ---------------------------------------------------------------------- report

const mean = (values: readonly number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
const totalUsed = rows.reduce((sum, row) => sum + row.measures.pi.used, 0);

console.log(`\n== ${rows.length} cases, ${totalUsed} calls the agent later used from memory ==`);
console.log(
  table([
    ['policy', 'summary tok', 'reduction', 'used calls preserved', 'recall (result strings)', 'call recall'],
    ...POLICIES.map(policy => {
      const ms = rows.map(row => row.measures[policy]);
      const preserved = ms.reduce((sum, m) => sum + m.preserved, 0);
      return [
        policy,
        num(mean(ms.map(m => m.tokens))),
        pct(mean(ms.map(m => m.reduction))),
        `${preserved}/${totalUsed} (${pct(preserved / totalUsed)})`,
        pct(mean(ms.flatMap(m => (m.recall === null ? [] : [m.recall])))),
        pct(mean(ms.flatMap(m => (m.callRecall === null ? [] : [m.callRecall])))),
      ];
    }),
  ]),
);

const perCase = (a: Policy, b: Policy) => (sample: readonly (typeof rows)[number][]): number =>
  mean(sample.map(row => row.measures[a].preserved / Math.max(1, row.measures[a].used) - row.measures[b].preserved / Math.max(1, row.measures[b].used)));
console.log('\npaired over cases, share of used calls preserved (95% bootstrap):');
for (const [a, b] of [['pi', 'jev@0.5'], ['mask', 'jev@0.5'], ['pi', 'mask'], ['pi', 'random']] as const) {
  console.log(`  ${a} - ${b}: ${formatInterval(bootstrap(rows, perCase(a, b)))}`);
}
console.log(`\nsummary tokens: pi mean ${num(mean(rows.map(r => r.measures.pi.tokens)))}, median span ${num(mean(withUse.map(i => i.spanTokens)))}; pi cost so far $${spent.toFixed(3)} for ${live} live summaries`);

const sample = withUse.find(item => piTexts.has(item.evalCase.id));
if (sample) {
  writeFileSync(join(OUT_DIR, 'pi-summary-sample.txt'), `${sample.evalCase.id}\n\n${piTexts.get(sample.evalCase.id)}`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const path = writeOut(`vs-pi-${stamp}.json`, { model: modelId, cases: rows, spent });
console.log(`wrote ${path} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
