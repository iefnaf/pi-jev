/**
 * L2: behaviour replay on the calls where compaction really lost something.
 *
 * An event is a tool result that (a) the agent later used from memory, with
 * strings found in no other span result, and (b) Jev's compaction did not keep
 * verbatim. At the first moment the agent used it, the context is rebuilt three
 * ways and a model takes one step:
 *
 *   full    the uncompacted history (control: can this model reproduce the step at all?)
 *   jev     what the extension would have left after compaction
 *   random  a summary of the same size that keeps random results instead
 *
 * The step is scored by whether it reproduces the specific strings the agent
 * used (`same`), or instead goes and gets the content again (`refetch`), or
 * neither (`diverge`, which is reviewed by hand).
 *
 *   npx vite-node eval/l2.ts [--threshold 0.19] [--events N] [--full N] [--budget 1.5]
 *        [--model deepseek/deepseek-v4.1-flash] [--prompt-price 0.15] [--offline]
 *
 * Session content goes to the model provider (credentials are redacted on a
 * best-effort basis; only providers that do not retain prompts are allowed).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/shared/config.js';
import { DEFAULT_CASE_OPTIONS } from './lib/cases.js';
import { CachingAsker } from './lib/cache.js';
import { loadCases, scanCases } from './lib/corpus.js';
import { argText, distinctiveTokens, firstRecall, fullText } from './lib/labels.js';
import { runBaseline, runMask } from './lib/policies.js';
import { openRouterModel, piSummary } from './lib/pisummary.js';
import { BudgetExceeded, ReplayClient, estimateChatTokens, toChat, type ReplayResponse } from './lib/replay.js';
import { argument, flag, num, OUT_DIR, pct, table, writeOut } from './lib/report.js';
import { prepare, runJev } from './lib/run.js';

const options = DEFAULT_CASE_OPTIONS;
const model = argument('--model') ?? 'deepseek/deepseek-v4.1-flash';
const promptPrice = Number(argument('--prompt-price') ?? 0.15);
const budget = Number(argument('--budget') ?? 1.5);
const eventLimit = Number(argument('--events') ?? Infinity);
const fullCount = Number(argument('--full') ?? 0);
const offline = flag('--offline');
/** Also replay the policy that kept the result when the other one lost it: what the model does with the content in hand. */
const control = flag('--control');
const MAX_CONTEXT_TOKENS = 400_000;

const config = loadConfig();
/** Jev's keep threshold for this run; the default 0.5 keeps nothing, so lower values are what test its selection. */
const runConfig = { ...config, keepThreshold: Number(argument('--threshold') ?? config.keepThreshold) };
const apiKey = process.env.OPENROUTER_API_KEY ?? '';
if (!offline && !apiKey) {
  console.error('OPENROUTER_API_KEY is not set (or pass --offline to replay the cache).');
  process.exit(2);
}
const client = new ReplayClient({ apiKey, model, promptPrice, budgetUsd: budget, offline, concurrency: 3 });
// Jev answers are read from the L1 cache; this script never calls Jev.
const jevAsker = new CachingAsker(undefined, `${config.provider}|${config.model}|${config.baseUrl}`, { offline: true });

type Condition = 'full' | 'jev' | 'random' | 'mask' | 'pi';
type Policy = 'jev' | 'random' | 'mask' | 'pi';
/** Which compacted contexts to replay (full is controlled by --full). */
const policies = (argument('--policies') ?? 'jev,random').split(',') as Policy[];
const piModel = openRouterModel(argument('--pi-model') ?? model, 0, 0);
type Outcome = 'refetch' | 'same' | 'other tool' | 'text only' | 'no output';
const OUTCOMES: Outcome[] = ['refetch', 'same', 'other tool', 'text only', 'no output'];
/** Tools that look something up: a name they are given that exists nowhere in the history was guessed. */
const LOOKUP_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'hypa_read', 'hypa_grep']);

interface Event {
  caseId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  resultTokens: number;
  /** Strings the agent produced from memory at the decision point. */
  tokens: string[];
  index: number;
  original: string;
  kept: Record<Policy, boolean>;
  /** The compacted text each policy leaves, to see whether the used content survives in it. */
  summaries: Partial<Record<Policy, string>>;
  /** Every distinctive string anywhere in the uncompacted history up to this moment. */
  history: Set<string>;
  /**
   * Strings in this call's input that no other span call's input has. A shared
   * prefix such as `cd <worktree>` would otherwise make any command in that
   * directory look like a repeat of this call.
   */
  callTokens: Set<string>;
  contexts: Partial<Record<Condition, ReturnType<typeof toChat> & { tokens: number }>>;
}

interface Result {
  condition: Condition;
  outcome: Outcome;
  /** The policy kept this result verbatim, so the model had it. */
  intact?: boolean;
  /** At least half of the strings the agent used are present in the policy's compacted text. */
  preserved?: boolean;
  fraction: number;
  refetches: boolean;
  /** Names in lookups or prose that exist nowhere in the history. */
  invented: string[];
  text: string;
  toolCalls: Array<{ name: string; args: string }>;
  promptTokens: number;
  costUsd: number;
}

const flat = (text: string, limit: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= limit ? one : `${one.slice(0, limit - 1)}…`;
};
const hash = (text: string): string => createHash('sha1').update(text).digest('hex');

function classify(event: Event, response: ReplayResponse): Omit<Result, 'condition' | 'promptTokens' | 'costUsd'> {
  const output = `${response.text}\n${response.toolCalls.map(call => call.args).join('\n')}`;
  const fraction = event.tokens.filter(token => output.includes(token)).length / event.tokens.length;
  const command = flat(argText(event.input), 60);
  const refetches = response.toolCalls.some(
    call =>
      [...event.callTokens].some(token => call.args.includes(token)) ||
      (event.callTokens.size === 0 && call.name === event.tool && command.length > 0 && flat(call.args, 400).includes(command.slice(0, 40))),
  );
  const guessed = `${response.text}\n${response.toolCalls.filter(call => LOOKUP_TOOLS.has(call.name)).map(call => argText(safeJson(call.args))).join('\n')}`;
  const invented = [...distinctiveTokens(guessed)].filter(token => !event.history.has(token));
  const outcome: Outcome = refetches
    ? 'refetch'
    : fraction >= 0.5
      ? 'same'
      : response.toolCalls.length > 0
        ? 'other tool'
        : response.text.trim() === ''
          ? 'no output'
          : 'text only';
  return { outcome, fraction, refetches, invented, text: response.text, toolCalls: response.toolCalls };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
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

// ---------------------------------------------------------------------- events

const started = Date.now();
const metas = scanCases(options);
const prepared = loadCases(metas, options).flatMap(evalCase => {
  const item = prepare(evalCase);
  return item ? [item] : [];
});

const events: Event[] = [];
let usedCalls = 0;
let keptByJev = 0;
let noMoment = 0;
let skippedSize = 0;
for (const item of prepared) {
  const { evalCase } = item;
  const usedHere = item.calls.filter(call => item.labels.calls.get(call.id)?.used);
  if (usedHere.length === 0) continue;
  const jev = await runJev(item, jevAsker, runConfig);
  const random = runBaseline('random', item.converted, item.calls, item.goal, config.truncateHeadChars, jev.outcome.summaryTokens, evalCase.id);
  const mask = runMask(item.converted, item.calls, item.goal, runConfig.truncateHeadChars);

  for (const call of usedHere) {
    usedCalls += 1;
    const label = item.labels.calls.get(call.id)!;
    // A short result survives `drop_result` untouched, so it is not really lost.
    const intact = (action: string | undefined): boolean =>
      action === 'keep' || (action === 'drop_result' && call.resultChars <= runConfig.truncateHeadChars + 120);
    if (intact(jev.outcome.actions.get(call.id))) keptByJev += 1;
    const moment = firstRecall(evalCase.future, new Set(label.uniqueTokens));
    if (!moment) {
      noMoment += 1;
      continue;
    }
    const prefix = evalCase.future.slice(0, moment.index);
    const make = (messages: typeof prefix, summary?: string) => {
      const chat = toChat(messages, summary);
      return { ...chat, tokens: estimateChatTokens(chat) };
    };
    const contexts: Event['contexts'] = {
      jev: make([...evalCase.tail, ...prefix], jev.outcome.summary),
      random: make([...evalCase.tail, ...prefix], random.summary),
      full: make([...evalCase.span, ...evalCase.tail, ...prefix]),
    };
    const summaries: Event['summaries'] = { jev: jev.outcome.summary, random: random.summary };
    if (policies.includes('mask')) {
      summaries.mask = mask.summary;
      contexts.mask = make([...evalCase.tail, ...prefix], mask.summary);
    }
    if (policies.includes('pi')) {
      const cached = await piSummary(evalCase, { model: piModel, apiKey: '', offline: true }).catch(() => undefined);
      if (cached) {
        summaries.pi = cached.summary;
        contexts.pi = make([...evalCase.tail, ...prefix], cached.summary);
      }
    }
    if (Math.max(...Object.values(contexts).map(context => context?.tokens ?? 0)) > MAX_CONTEXT_TOKENS) {
      skippedSize += 1;
      continue;
    }
    const at = evalCase.future[moment.index]!;
    const history = new Set<string>();
    for (const message of [...evalCase.span, ...evalCase.tail, ...prefix]) {
      for (const token of distinctiveTokens(fullText(message))) history.add(token);
    }
    const others = new Set<string>();
    for (const other of item.calls) {
      if (other.id !== call.id) for (const token of distinctiveTokens(argText(other.input))) others.add(token);
    }
    const callTokens = new Set([...distinctiveTokens(argText(call.input))].filter(token => !others.has(token)));
    events.push({
      caseId: evalCase.id,
      callId: call.id,
      tool: call.tool,
      input: call.input,
      resultTokens: label.resultTokens,
      tokens: moment.tokens,
      index: moment.index,
      original: flat(fullText(at), 400),
      kept: {
        jev: intact(jev.outcome.actions.get(call.id)),
        random: intact(random.actions.get(call.id)),
        mask: intact(mask.actions.get(call.id)),
        pi: false,
      },
      summaries,
      history,
      callTokens,
      contexts,
    });
  }
}

const ordered = events.sort((a, b) => hash(a.caseId + a.callId).localeCompare(hash(b.caseId + b.callId))).slice(0, eventLimit);
console.log(
  `${prepared.length} cases; ${usedCalls} calls used from memory; ${noMoment} without a locatable moment, ${skippedSize} too long; ` +
    `${events.length} events at keepThreshold ${runConfig.keepThreshold}, running ${ordered.length}`,
);
{
  const tokens = (pick: (event: Event) => boolean): number => events.filter(pick).reduce((sum, e) => sum + e.resultTokens, 0);
  const totalTokens = tokens(() => true);
  console.log(
    `\nretention of the ${events.length} calls that were used from memory, at the same summary size:\n` +
      table([
        ['policy', 'kept intact', 'share', 'of their tokens'],
        ...(['jev', 'random'] as const).map(policy => [
          policy,
          `${events.filter(e => e.kept[policy]).length}/${events.length}`,
          pct(events.filter(e => e.kept[policy]).length / events.length),
          pct(tokens(e => e.kept[policy]) / totalTokens),
        ]),
      ]),
  );
}
const meanOf = (pick: (event: Event) => number): number => events.reduce((sum, e) => sum + pick(e), 0) / Math.max(1, events.length);
console.log(`mean context over all ${events.length} events: ~${num(meanOf(e => (e.contexts.jev?.tokens ?? 0)))} tokens compacted, ~${num(meanOf(e => (e.contexts.full?.tokens ?? 0)))} full, max full ~${num(Math.max(...events.map(e => (e.contexts.full?.tokens ?? 0))))}`);
console.log(`projected prompt cost for all events at $${promptPrice}/M: jev+random $${((meanOf(e => (e.contexts.jev?.tokens ?? 0)) + meanOf(e => (e.contexts.random?.tokens ?? 0))) * events.length * promptPrice / 1e6).toFixed(2)}, plus full control $${(meanOf(e => (e.contexts.full?.tokens ?? 0)) * Math.min(fullCount, events.length) * promptPrice / 1e6).toFixed(2)} for ${Math.min(fullCount, events.length)} events`);

// ------------------------------------------------------------------------ run

const results = new Map<string, Result[]>();
const skipped: string[] = [];
let done = 0;
await pool(ordered, 3, async event => {
  const id = `${event.caseId}/${event.callId}`;
  // Only where the policy lost the result: if it kept it verbatim the model sees the original.
  const asymmetric = event.kept.jev !== event.kept.random;
  const conditions: Condition[] = [
    ...policies.filter(policy => event.contexts[policy] && (!event.kept[policy] || (control && asymmetric && (policy === 'jev' || policy === 'random')))),
    ...(ordered.indexOf(event) < fullCount ? (['full'] as const) : []),
  ];
  const out: Result[] = [];
  try {
    for (const condition of conditions) {
      const response = await client.complete(event.contexts[condition]!);
      out.push({
        condition,
        intact: condition === 'full' ? undefined : event.kept[condition],
        preserved:
          condition === 'full'
            ? undefined
            : event.tokens.filter(token => (event.summaries[condition] ?? '').includes(token)).length / event.tokens.length >= 0.5,
        ...classify(event, response),
        promptTokens: response.promptTokens,
        costUsd: response.costUsd,
      });
    }
    results.set(id, out);
  } catch (error) {
    skipped.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof BudgetExceeded) results.set(id, out);
  }
  done += 1;
  process.stderr.write(`\r${done}/${ordered.length} events, ${client.live} live calls, $${client.spent.toFixed(3)} spent`);
});
process.stderr.write('\n');

// ---------------------------------------------------------------------- report

if (skipped.length > 0) {
  console.log(`\n!! ${skipped.length} events not completed:`);
  for (const line of skipped.slice(0, 4)) console.log(`   ${line.slice(0, 200)}`);
}

const byCondition = (condition: Condition, intact = false): Array<{ event: Event; result: Result }> =>
  ordered.flatMap(event => {
    const result = results.get(`${event.caseId}/${event.callId}`)?.find(r => r.condition === condition && Boolean(r.intact) === intact);
    return result ? [{ event, result }] : [];
  });

console.log('\n== what a model does at the moment the agent used content that compaction dropped ==');
const rows: string[][] = [['condition', 'events', 'in summary', 'refetch', 'same', 'other tool', 'text only', 'no output', 'guessed names', 'prompt tok']];
for (const condition of ['full', ...policies] as const) {
  const items = byCondition(condition);
  if (items.length === 0) continue;
  const share = (outcome: Outcome): string => pct(items.filter(i => i.result.outcome === outcome).length / items.length);
  rows.push([
    condition,
    String(items.length),
    condition === 'full' ? '—' : pct(items.filter(i => i.result.preserved).length / items.length),
    ...OUTCOMES.map(share),
    num(items.reduce((sum, i) => sum + i.result.invented.length, 0) / items.length, 2),
    num(items.reduce((sum, i) => sum + i.result.promptTokens, 0) / items.length),
  ]);
}
console.log(table(rows));
console.log(
  'refetch = a tool call that goes for the dropped content again; same = reproduces >=50% of the strings the agent used; ' +
    'other tool = acts elsewhere; text only = answers without a tool; guessed names = mean count of names in lookups/prose found nowhere in the history',
);

if (control) {
  const tally = (items: Array<{ result: Result }>): string =>
    OUTCOMES.map(o => `${o} ${items.filter(i => i.result.outcome === o).length}`).join(', ');
  const onlyJevLost = ordered.filter(e => !e.kept.jev && e.kept.random);
  const lost = byCondition('jev').filter(i => onlyJevLost.includes(i.event));
  const kept = byCondition('random', true).filter(i => onlyJevLost.includes(i.event));
  console.log(`\nthe ${onlyJevLost.length} events only Jev lost:\n  without the content (Jev): ${tally(lost)}\n  with the content (random kept it): ${tally(kept)}`);
}
{
  const both = ordered.filter(e => !e.kept.jev && !e.kept.random);
  console.log(`\nlost under both policies: ${both.length} events; only Jev lost it: ${ordered.filter(e => !e.kept.jev && e.kept.random).length}; only random lost it: ${ordered.filter(e => e.kept.jev && !e.kept.random).length}`);
}

const spent = client.spent;
console.log(`\ncost: $${spent.toFixed(3)} for ${client.live} live calls (${client.hits} cached), model ${model}`);

// Full transcripts for reading by hand.
const review = ordered.flatMap(event => {
  const list = results.get(`${event.caseId}/${event.callId}`);
  if (!list) return [];
  return [
    `${'='.repeat(90)}\n${event.caseId}/${event.callId} ${event.tool}(${flat(argText(event.input), 160)}) ~${event.resultTokens} tok  tokens: ${event.tokens.slice(0, 5).join(' | ')}`,
    `ORIGINAL AGENT (full context): ${event.original}`,
    ...list.map(r => `[${r.condition}${r.intact ? '*kept' : ''}] ${r.outcome} overlap ${pct(r.fraction)}${r.invented.length ? ` guessed ${r.invented.slice(0, 3).join(',')}` : ''}: ${flat(r.text, 260)} ${r.toolCalls.map(c => `▸ ${c.name}(${flat(c.args, 200)})`).join(' ')}`),
  ];
});
writeFileSync(join(OUT_DIR, 'l2-review.txt'), review.join('\n'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const path = writeOut(`l2-${stamp}.json`, {
  model,
  threshold: runConfig.keepThreshold,
  events: ordered.map(event => ({ id: `${event.caseId}/${event.callId}`, tool: event.tool, tokens: event.tokens, resultTokens: event.resultTokens, results: results.get(`${event.caseId}/${event.callId}`) ?? [] })),
  spent,
});
console.log(`wrote ${path} and eval/out/l2-review.txt in ${((Date.now() - started) / 1000).toFixed(0)}s`);
