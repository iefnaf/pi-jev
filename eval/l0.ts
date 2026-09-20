/**
 * L0: no network, no cost. Drives the real compaction pipeline over real
 * sessions to check (1) the corpus and converter cope with what pi actually
 * writes, (2) the pipeline's output is structurally sound, (3) the labels are
 * sane, and (4) how much an L1 run will cost. It also scores the API-free
 * baselines every Jev result in L1 has to beat.
 *
 *   npx vite-node eval/l0.ts [--window 128000] [--limit N]
 */
import { compactWithJev } from '../src/compaction/jev.js';
import { boundaryCallId, type DecisionOutcome } from '../src/compaction/decision.js';
import { configFromEnv } from '../src/shared/config.js';
import type { Message } from '../src/vendor/fast-jev-compaction/index.js';
import { DEFAULT_CASE_OPTIONS } from './lib/cases.js';
import { loadCases, scanCases, selectStratified } from './lib/corpus.js';
import { pseudoRandomAsker } from './lib/fake.js';
import { BUDGETED, runBaseline, type BaselineName } from './lib/policies.js';
import { argument, num, pct, quantiles, table, writeOut } from './lib/report.js';
import { prepare, runJev, type Prepared } from './lib/run.js';
import { aggregate, scoreOutcome, type Score } from './lib/score.js';
import { listSessionFiles, loadSession } from './lib/session.js';

const options = { ...DEFAULT_CASE_OPTIONS, window: Number(argument('--window') ?? DEFAULT_CASE_OPTIONS.window) };
const limit = Number(argument('--limit') ?? Infinity);
const config = configFromEnv({});

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------- corpus census

function census(): Record<string, unknown> {
  const roles = new Map<string, number>();
  const blocks = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void => void map.set(key, (map.get(key) ?? 0) + 1);
  const known = new Set(['text', 'thinking', 'toolCall', 'image']);
  let sessions = 0;
  let empty = 0;
  let cleanEntries = 0;
  for (const file of listSessionFiles()) {
    const session = loadSession(file);
    if (!session) {
      empty += 1;
      continue;
    }
    sessions += 1;
    cleanEntries += session.clean.length;
    for (const entry of session.clean) {
      if (entry.type !== 'message') continue;
      bump(roles, entry.message.role);
      const content = (entry.message as { content?: unknown }).content;
      if (Array.isArray(content)) for (const block of content) bump(blocks, String(block?.type));
    }
  }
  const unknownBlocks = [...blocks].filter(([type]) => !known.has(type));
  console.log(`sessions loaded ${sessions}, empty ${empty}, clean-segment entries ${cleanEntries}`);
  console.log(`message roles: ${[...roles].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`content blocks: ${[...blocks].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (unknownBlocks.length > 0) console.log(`!! unknown block types: ${unknownBlocks.map(([k]) => k).join(', ')}`);
  return { sessions, empty, roles: Object.fromEntries(roles), blocks: Object.fromEntries(blocks) };
}

// ------------------------------------------------------- pipeline integrity

function integrity(prepared: Prepared, kept: Message[], decisions: DecisionOutcome[]): string[] {
  const problems: string[] = [];
  const { converted, calls } = prepared;
  const idsOf = (messages: readonly Message[]) => ({
    uses: messages.flatMap(m => m.toolUses.map(t => t.tool_use_id)),
    results: messages.flatMap(m => (m.toolResults ?? []).map(r => r.tool_use_id)),
  });
  const before = idsOf(converted);
  const after = idsOf(kept);
  const usesAfter = new Set(after.uses);
  const resultsAfter = new Set(after.results);

  const orphansBefore = before.results.filter(id => !new Set(before.uses).has(id)).length;
  const orphansAfter = after.results.filter(id => !usesAfter.has(id)).length;
  if (orphansAfter > orphansBefore) problems.push(`orphan results grew ${orphansBefore} -> ${orphansAfter}`);
  if (kept.length > converted.length) problems.push('output has more messages than input');

  const byId = new Map(calls.map(call => [call.id, call]));
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (!call) {
      problems.push(`decision for unknown call ${decision.id}`);
      continue;
    }
    const present = usesAfter.has(call.tool_use_id);
    const answered = resultsAfter.has(call.tool_use_id);
    if (decision.action === 'drop_call' && (present || answered)) {
      problems.push(`${decision.id} drop_call left ${present ? 'call' : 'result'} behind`);
    }
    if (decision.action !== 'drop_call' && (!present || !answered)) {
      problems.push(`${decision.id} ${decision.action} lost its ${present ? 'result' : 'call'}`);
    }
    if (decision.boundary && decision.action === 'drop_call') problems.push(`${decision.id} boundary call was dropped`);
  }

  const originalText = new Map(
    converted.flatMap(m => (m.toolResults ?? []).map(r => [r.tool_use_id, r.text.length] as const)),
  );
  for (const message of kept) {
    for (const result of message.toolResults ?? []) {
      if ((originalText.get(result.tool_use_id) ?? Infinity) < result.text.length - 200) {
        problems.push(`result ${result.tool_use_id.slice(0, 12)} grew`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------- main

const t0 = Date.now();
section('corpus');
const censusResult = census();

section(`cases (window ${options.window})`);
const metas = scanCases(options);
const chosen = Number.isFinite(limit) ? selectStratified(metas, limit, 'l0') : metas;
const cases = loadCases(chosen, options);
const prepared = cases.flatMap(evalCase => {
  const result = prepare(evalCase);
  return result ? [result] : [];
});
const projects = new Set(prepared.map(p => p.evalCase.project));
console.log(`${metas.length} cases in corpus, ${prepared.length} prepared, across ${projects.size} projects`);

const spanQ = quantiles(prepared.map(p => p.spanTokens));
console.log(`span tokens p50/p90/max: ${spanQ.map(v => num(v)).join(' / ')}`);
console.log(`calls per span p50/p90/max: ${quantiles(prepared.map(p => p.calls.length)).join(' / ')}`);
console.log(`split-turn cuts: ${pct(prepared.filter(p => p.evalCase.isSplitTurn).length / prepared.length)}`);

const shapes = new Map<string, number>();
let duplicateIds = 0;
let orphanResults = 0;
let danglingCalls = 0;
for (const { converted, calls } of prepared) {
  const last = converted[converted.length - 1]!;
  const shape = (last.toolResults ?? []).length > 0 ? 'tool-result' : last.toolUses.length > 0 ? 'tool-call' : 'text';
  shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  const uses = converted.flatMap(m => m.toolUses.map(t => t.tool_use_id));
  const results = converted.flatMap(m => (m.toolResults ?? []).map(r => r.tool_use_id));
  duplicateIds += uses.length - new Set(uses).size;
  orphanResults += results.filter(id => !uses.includes(id)).length;
  danglingCalls += uses.length - calls.length;
}
console.log(`span ends with: ${[...shapes].map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`duplicate tool_use ids ${duplicateIds}, results whose call is outside the span ${orphanResults}, calls without a result ${danglingCalls}`);

section('labels');
const allLabels = prepared.flatMap(p => [...p.labels.calls.values()]);
const total = allLabels.length;
const share = (n: number): string => `${n} (${pct(n / total, 1)})`;
console.log(`calls ${total}: rerun ${share(allLabels.filter(l => l.rerun).length)}, superseded ${share(allLabels.filter(l => l.superseded).length)}, echoed>=2 ${share(allLabels.filter(l => l.echo >= 2).length)}, used ${share(allLabels.filter(l => l.used).length)}`);
const tokensOfLabel = (pick: (l: (typeof allLabels)[number]) => boolean): number =>
  allLabels.filter(pick).reduce((sum, l) => sum + l.resultTokens, 0);
const resultTokens = tokensOfLabel(() => true);
console.log(`result tokens ${resultTokens}: used ${pct(tokensOfLabel(l => l.used) / resultTokens, 1)}, unused ${pct(tokensOfLabel(l => !l.used) / resultTokens, 1)}`);
console.log(`cases with no result content to preserve: ${prepared.filter(p => p.labels.needed.size === 0).length}/${prepared.length}; no call info: ${prepared.filter(p => p.labels.neededCall.size === 0).length}/${prepared.length}`);
const byTool = new Map<string, { calls: number; used: number; rerun: number; tokens: number }>();
for (const label of allLabels) {
  const row = byTool.get(label.tool) ?? { calls: 0, used: 0, rerun: 0, tokens: 0 };
  row.calls += 1;
  row.used += label.used ? 1 : 0;
  row.rerun += label.rerun ? 1 : 0;
  row.tokens += label.resultTokens;
  byTool.set(label.tool, row);
}
console.log(
  table([
    ['tool', 'calls', 'used', 'rerun', 'result tok'],
    ...[...byTool]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 8)
      .map(([tool, row]) => [tool, String(row.calls), pct(row.used / row.calls), String(row.rerun), String(row.tokens)]),
  ]),
);

section('pipeline integrity (pseudo-random asker)');
const violations: Array<{ id: string; problems: string[] }> = [];
let boundaryCases = 0;
let requests = 0;
let stateTokenRequests = 0;
const stages = new Map<string, number>();
let failures = 0;
for (const item of prepared) {
  try {
    const asker = pseudoRandomAsker(item.evalCase.id);
    const outcome = await compactWithJev(item.converted, asker, config, item.goal);
    const again = await compactWithJev(item.converted, pseudoRandomAsker(item.evalCase.id), config, item.goal);
    const problems = integrity(item, outcome.messages, outcome.decisions);
    if (JSON.stringify(outcome.messages) !== JSON.stringify(again.messages)) problems.push('non-deterministic output');
    const run = await runJev(item, pseudoRandomAsker(item.evalCase.id), config);
    if (!(run.productionReduction <= 1)) problems.push(`reduction ${run.productionReduction} out of range`);
    if (boundaryCallId(item.converted, item.calls) !== undefined) boundaryCases += 1;
    requests += outcome.stats.requests;
    stateTokenRequests += outcome.stats.requests * outcome.stats.stateTokens;
    stages.set(outcome.stats.stateStage || 'none', (stages.get(outcome.stats.stateStage || 'none') ?? 0) + 1);
    if (problems.length > 0) violations.push({ id: item.evalCase.id, problems });
  } catch (error) {
    failures += 1;
    violations.push({ id: item.evalCase.id, problems: [`threw: ${error instanceof Error ? error.message : String(error)}`] });
  }
}
console.log(`${prepared.length} cases, ${failures} threw, ${violations.length} with problems, ${boundaryCases} with a boundary call`);
for (const violation of violations.slice(0, 8)) console.log(`  ${violation.id}: ${violation.problems.slice(0, 3).join('; ')}`);

section('L1 cost forecast');
console.log(`Jev requests ${requests}, state tokens sent ~${(stateTokenRequests / 1e6).toFixed(2)}M (+ questions), per case ~${num(requests / prepared.length, 1)} requests`);
console.log(`state fitting stage: ${[...stages].map(([k, v]) => `${k}=${v}`).join(' ')}`);

section('baselines (no API), scored against the same labels');
const policies: Array<{ name: BaselineName; target?: number }> = [
  { name: 'keep-all' },
  { name: 'drop-all' },
  ...[0.5, 0.75, 0.9].flatMap(target => BUDGETED.map(name => ({ name, target }))),
];
const rows: string[][] = [['policy', 'reduction', 'recall', 'call recall', 'rerun lost', 'used lost', 'waste']];
const baselineSummary: Record<string, unknown> = {};
for (const { name, target } of policies) {
  const scores: Score[] = prepared.map(item => {
    const budget = target === undefined ? Infinity : item.spanTokens * (1 - target);
    const outcome = runBaseline(name, item.converted, item.calls, item.goal, config.truncateHeadChars, budget, item.evalCase.id);
    return scoreOutcome(item.labels, item.calls, outcome, item.spanTokens);
  });
  const agg = aggregate(scores);
  const label = target === undefined ? name : `${name} @${pct(target)}`;
  rows.push([label, pct(agg.reduction), pct(agg.recall), pct(agg.callRecall), pct(agg.rerunLostRate), pct(agg.usedLostRate), pct(agg.wasteShare)]);
  baselineSummary[label] = agg;
}
console.log(table(rows));

// Sanity: keeping everything must preserve everything the labels ask for.
const keepAll = prepared.map(item =>
  scoreOutcome(item.labels, item.calls, runBaseline('keep-all', item.converted, item.calls, item.goal, config.truncateHeadChars, Infinity, ''), item.spanTokens),
);
const keepAllRecall = aggregate(keepAll).recall;
const sane = keepAll.every(score => score.rerunLost === 0 && score.usedLost === 0) && keepAllRecall > 0.999;
console.log(`\nlabel sanity (keep-all loses nothing): ${sane ? 'ok' : `FAILED (recall ${keepAllRecall})`}`);

const path = writeOut('l0.json', {
  window: options.window,
  census: censusResult,
  cases: prepared.length,
  violations,
  requests,
  baselines: baselineSummary,
});
console.log(`\nwrote ${path} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exitCode = violations.length > 0 || !sane ? 1 : 0;
