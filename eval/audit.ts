/**
 * Label audit: checks the rule-based "used later" labels against a human (or
 * model) reading of the real session.
 *
 *   npx vite-node eval/audit.ts sample [--used 25] [--unused 25] [--seed s]
 *   npx vite-node eval/audit.ts score
 *
 * `sample` writes blinded packets (no label shown) to eval/out/audit/packets.txt
 * and the answer key to key.json. Judge each packet, write verdicts to
 * verdicts.json as {"A01": {"v": "Y"|"N"|"?", "note": "..."}}, and only then
 * run `score`. Everything here is derived from private sessions and lives in
 * the gitignored eval/out.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { DEFAULT_CASE_OPTIONS } from './lib/cases.js';
import { loadCases, scanCases } from './lib/corpus.js';
import { distinctiveTokens } from './lib/labels.js';
import { argument, OUT_DIR } from './lib/report.js';
import { prepare } from './lib/run.js';

const DIR = join(OUT_DIR, 'audit');
const options = DEFAULT_CASE_OPTIONS;

const hash = (text: string): string => createHash('sha1').update(text).digest('hex');
const flat = (text: string, limit: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= limit ? one : `${one.slice(0, limit - 1)}…`;
};

type Block = { type: string; [key: string]: unknown };
const blocks = (message: AgentMessage): Block[] => {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Block[]) : [];
};
const textOf = (message: AgentMessage): string => {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  return blocks(message).map(block => (typeof block.text === 'string' ? block.text : '')).join('\n');
};
const argsOf = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? Object.values(value).map(argsOf).join(' ')
      : String(value ?? '');

/** Everything the agent said, thought, or passed to a tool in one message. */
function agentOutput(message: AgentMessage): string {
  if (message.role !== 'assistant') return '';
  return blocks(message)
    .map(block =>
      block.type === 'text'
        ? String(block.text ?? '')
        : block.type === 'thinking'
          ? String(block.thinking ?? '')
          : block.type === 'toolCall'
            ? argsOf(block.arguments)
            : '',
    )
    .join('\n');
}

function timeline(future: readonly AgentMessage[], maxLines: number): string[] {
  const lines: string[] = [];
  future.forEach((message, index) => {
    if (message.role === 'assistant') {
      const said = flat(blocks(message).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join(' '), 110);
      const calls = blocks(message)
        .filter(b => b.type === 'toolCall')
        .map(b => `${b.name}(${flat(argsOf(b.arguments), 70)})`);
      lines.push(`#${index} A: ${said}${calls.length ? ` ▸ ${calls.join('; ')}` : ''}`);
    } else if (message.role === 'user') {
      lines.push(`#${index} USER: ${flat(textOf(message), 150)}`);
    } else if (message.role === 'toolResult') {
      lines.push(`#${index} ↳ ${flat(textOf(message), 50)}`);
    }
  });
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines (${future.length} messages in all)`];
}

/** Where the agent's later output mentions a string, and whether something newer showed it first. */
function hits(future: readonly AgentMessage[], needle: string, limit = 3): string[] {
  const out: string[] = [];
  let firstObserved = -1;
  future.forEach((message, index) => {
    if (out.length >= limit) return;
    if (message.role !== 'assistant') {
      if (firstObserved < 0 && textOf(message).includes(needle)) firstObserved = index;
      return;
    }
    const output = agentOutput(message);
    const at = output.indexOf(needle);
    if (at < 0) return;
    const seen = firstObserved >= 0 ? ` [already shown at #${firstObserved}]` : ' [not shown earlier]';
    out.push(`#${index}${seen}: …${flat(output.slice(Math.max(0, at - 60), at + needle.length + 60), 190)}…`);
  });
  return out;
}

interface Candidate {
  caseId: string;
  file: string;
  callId: string;
  tool: string;
  rerun: boolean;
  echo: number;
  used: boolean;
  packet: string;
}

function build(): Candidate[] {
  const metas = scanCases(options);
  const prepared = loadCases(metas, options).flatMap(evalCase => {
    const item = prepare(evalCase);
    return item ? [item] : [];
  });
  const candidates: Candidate[] = [];
  for (const item of prepared) {
    const resultText = new Map(
      item.converted.flatMap(m => (m.toolResults ?? []).map(r => [r.tool_use_id, r.text] as const)),
    );
    const lastUser = [...item.converted].reverse().find(m => m.role === 'user' && m.text.trim() && !(m.toolResults ?? []).length);
    const { future } = item.evalCase;
    for (const call of item.calls) {
      const label = item.labels.calls.get(call.id)!;
      if (label.superseded && !label.used) continue;
      const result = resultText.get(call.tool_use_id) ?? '';
      const input = argsOf(call.input);
      const key = typeof (call.input as Record<string, unknown>).path === 'string'
        ? String((call.input as Record<string, unknown>).path)
        : flat(input, 60);
      const tokens = [...distinctiveTokens(result)].filter(t => !input.includes(t));
      const withHits = tokens
        .map(token => ({ token, at: future.findIndex(m => agentOutput(m).includes(token)) }))
        .filter(entry => entry.at >= 0)
        .sort((a, b) => b.token.length - a.token.length)
        .slice(0, 5);

      const packet = [
        `PROJECT ${item.evalCase.project.replace(/^--|--$/g, '')}`,
        `USER GOAL (last prompt before the cut): ${flat(lastUser?.text ?? '', 320)}`,
        '',
        `CALL   ${call.tool}(${flat(input, 320)})`,
        `RESULT ${result.length} chars, ~${label.resultTokens} tokens${call.isError ? ' (error)' : ''}`,
        `  head: ${flat(result.slice(0, 500), 500)}`,
        result.length > 900 ? `  tail: ${flat(result.slice(-200), 200)}` : '',
        '',
        `WHERE THE AGENT LATER MENTIONS THE CALL (${flat(key, 60)}):`,
        ...(hits(future, key).length ? hits(future, key).map(h => `  ${h}`) : ['  (never)']),
        'STRINGS FROM THE RESULT THE AGENT LATER WROTE:',
        ...(withHits.length
          ? withHits.flatMap(entry => [`  • ${entry.token}`, ...hits(future, entry.token, 1).map(h => `      ${h}`)])
          : ['  (none)']),
        '',
        `WHAT THE AGENT DID NEXT (${future.length} messages):`,
        ...timeline(future, 14).map(line => `  ${line}`),
      ]
        .filter(line => line !== '')
        .join('\n');

      candidates.push({
        caseId: item.evalCase.id,
        file: item.evalCase.file,
        callId: call.id,
        tool: call.tool,
        rerun: label.rerun,
        echo: label.echo,
        used: label.used,
        packet: label.resultTokens >= 200 || label.used ? packet : '',
      });
    }
  }
  return candidates.filter(candidate => candidate.packet !== '');
}

/** At most `perCase` per case, in seeded order. */
function pick(pool: Candidate[], count: number, perCase: number, seed: string): Candidate[] {
  const taken = new Map<string, number>();
  const chosen: Candidate[] = [];
  for (const candidate of [...pool].sort((a, b) => hash(seed + a.caseId + a.callId).localeCompare(hash(seed + b.caseId + b.callId)))) {
    if (chosen.length >= count) break;
    if ((taken.get(candidate.caseId) ?? 0) >= perCase) continue;
    taken.set(candidate.caseId, (taken.get(candidate.caseId) ?? 0) + 1);
    chosen.push(candidate);
  }
  return chosen;
}

function sample(): void {
  const usedCount = Number(argument('--used') ?? 25);
  const unusedCount = Number(argument('--unused') ?? 25);
  const seed = argument('--seed') ?? 'audit';
  const candidates = build();
  const rerun = candidates.filter(c => c.used && c.rerun);
  const echoOnly = candidates.filter(c => c.used && !c.rerun);
  const unused = candidates.filter(c => !c.used);
  const rerunCount = Math.round(usedCount * 0.4);
  const chosen = [
    ...pick(rerun, rerunCount, 2, seed),
    ...pick(echoOnly, usedCount - rerunCount, 2, seed),
    ...pick(unused, unusedCount, 2, seed),
  ].sort((a, b) => hash(seed + 'order' + a.caseId + a.callId).localeCompare(hash(seed + 'order' + b.caseId + b.callId)));

  const ids = chosen.map((_, index) => `A${String(index + 1).padStart(2, '0')}`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, 'packets.txt'),
    chosen.map((c, i) => `${'='.repeat(100)}\n[${ids[i]}]\n${c.packet}\n`).join('\n'),
  );
  writeFileSync(
    join(DIR, 'key.json'),
    JSON.stringify(Object.fromEntries(chosen.map((c, i) => [ids[i], { caseId: c.caseId, callId: c.callId, tool: c.tool, rerun: c.rerun, echo: c.echo, used: c.used }])), null, 1),
  );
  writeFileSync(
    join(DIR, 'locator.json'),
    JSON.stringify(Object.fromEntries(chosen.map((c, i) => [ids[i], { file: c.file, caseId: c.caseId, callId: c.callId }])), null, 1),
  );
  console.log(
    `pool: ${rerun.length} rerun, ${echoOnly.length} echo-only, ${unused.length} unused candidates; sampled ${chosen.length} into ${DIR}/packets.txt (labels are in key.json, do not read before judging)`,
  );
}

// ---------------------------------------------------------------------- score

/**
 * Y: the agent used content unique to this result, from memory.
 * D: used, but the same content is in another span result or pi's kept tail.
 * R: the agent re-read/re-ran it anyway, as it would without compaction.
 * N: not used. ?: cannot tell.
 */
interface Verdict {
  v: 'Y' | 'D' | 'R' | 'N' | '?';
  note?: string;
}

function score(): void {
  const key = JSON.parse(readFileSync(join(DIR, 'key.json'), 'utf8')) as Record<string, { caseId: string; callId: string; tool: string; rerun: boolean; echo: number; used: boolean }>;
  const verdicts = JSON.parse(readFileSync(join(DIR, 'verdicts.json'), 'utf8')) as Record<string, Verdict>;
  const ids = Object.keys(key);
  const missing = ids.filter(id => !verdicts[id]);
  if (missing.length > 0) throw new Error(`no verdict for ${missing.join(', ')}`);

  const usedIds = ids.filter(id => key[id]!.used);
  const unusedIds = ids.filter(id => !key[id]!.used);
  const tally = (group: string[]): Record<string, number> => {
    const counts: Record<string, number> = { Y: 0, D: 0, R: 0, N: 0, '?': 0 };
    for (const id of group) counts[verdicts[id]!.v] += 1;
    return counts;
  };
  const row = (title: string, group: string[]): void => {
    const c = tally(group);
    console.log(`${title.padEnd(30)} n=${String(group.length).padStart(2)}   Y ${String(c.Y).padStart(2)}   D ${String(c.D).padStart(2)}   R ${String(c.R).padStart(2)}   N ${String(c.N).padStart(2)}   ? ${c['?']}`);
  };
  console.log('rule label vs judgement (Y unique memory use, D used but duplicated, R re-read anyway, N unused)');
  row('rule says used', usedIds);
  row('  via rerun', usedIds.filter(id => key[id]!.rerun));
  row('  via echo only', usedIds.filter(id => !key[id]!.rerun));
  row('rule says not used (>=200 tok)', unusedIds);

  const share = (group: string[], kinds: string[]): string =>
    `${((group.filter(id => kinds.includes(verdicts[id]!.v)).length / Math.max(1, group.filter(id => verdicts[id]!.v !== '?').length)) * 100).toFixed(0)}%`;
  console.log(`\nof calls the rule marks used:  needed from memory (Y) ${share(usedIds, ['Y'])}, used at all (Y+D) ${share(usedIds, ['Y', 'D'])}, and not caused by compaction (R) ${share(usedIds, ['R'])}, not used (N) ${share(usedIds, ['N'])}`);
  console.log(`of calls the rule marks unused: actually used from memory (Y) ${share(unusedIds, ['Y'])}, used at all (Y+D) ${share(unusedIds, ['Y', 'D'])}`);

  if (process.argv.includes('--relabel')) {
    const metas = scanCases(options);
    const wanted = new Set(ids.map(id => key[id]!.caseId));
    const cases = loadCases(metas.filter(meta => wanted.has(meta.id)), options);
    const now = new Map<string, boolean>();
    for (const evalCase of cases) {
      const item = prepare(evalCase);
      for (const call of item?.calls ?? []) now.set(`${evalCase.id}|${call.id}`, item!.labels.calls.get(call.id)!.used);
    }
    console.log('\ncurrent labelling rule against the same verdicts (used = unique echo, no rerun)');
    const rows: Array<[string, string[]]> = [['rule says used now', ids.filter(id => now.get(`${key[id]!.caseId}|${key[id]!.callId}`))], ['rule says not used now', ids.filter(id => !now.get(`${key[id]!.caseId}|${key[id]!.callId}`))]];
    for (const [title, group] of rows) row(title, group);
  }

  console.log('\nrule marks used, judged N or R');
  for (const id of usedIds) {
    if (['N', 'R'].includes(verdicts[id]!.v)) console.log(`${id} ${verdicts[id]!.v} ${key[id]!.tool} rerun=${key[id]!.rerun} echo=${key[id]!.echo}`);
  }
  console.log('\nrule marks unused, judged Y or D');
  for (const id of unusedIds) {
    if (['Y', 'D'].includes(verdicts[id]!.v)) console.log(`${id} ${verdicts[id]!.v} ${key[id]!.tool}: ${verdicts[id]!.note ?? ''}`);
  }
}

/** Where a string occurs around one sampled call: its result, the rest of the span, pi's tail, and the future. */
function check(): void {
  const id = process.argv[3]!;
  const needle = process.argv[4]!;
  const locator = JSON.parse(readFileSync(join(DIR, 'locator.json'), 'utf8')) as Record<string, { caseId: string; callId: string }>;
  const entry = locator[id];
  if (!entry) throw new Error(`unknown id ${id}`);
  const meta = scanCases(options).find(m => m.id === entry.caseId)!;
  const evalCase = loadCases([meta], options)[0]!;
  const item = prepare(evalCase)!;
  const call = item.calls.find(c => c.id === entry.callId)!;
  const own = item.converted.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === call.tool_use_id)!.text;
  console.log(`in this result: ${own.includes(needle)}`);
  const others = item.calls.filter(c => c.id !== call.id).filter(c => (item.converted.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === c.tool_use_id)?.text ?? '').includes(needle));
  console.log(`in other span results: ${others.map(c => `${c.id}:${c.tool}(${flat(argsOf(c.input), 50)})`).slice(0, 4).join(' | ') || 'no'}`);
  console.log(`in span text or call inputs: ${item.converted.some(m => m.text.includes(needle) || m.toolUses.some(t => argsOf(t.input).includes(needle)))}`);
  console.log(`in pi's kept tail: ${evalCase.tail.some(m => agentOutput(m).includes(needle) || textOf(m).includes(needle))}`);
  const at = evalCase.future.findIndex(m => agentOutput(m).includes(needle));
  const shown = evalCase.future.findIndex(m => m.role !== 'assistant' && textOf(m).includes(needle));
  console.log(`future: agent first says it at #${at}, something newer first shows it at #${shown}`);
  if (at >= 0) console.log(`  …${flat(agentOutput(evalCase.future[at]!).slice(Math.max(0, agentOutput(evalCase.future[at]!).indexOf(needle) - 200), agentOutput(evalCase.future[at]!).indexOf(needle) + 200), 420)}…`);
}

const mode = process.argv[2];
if (mode === 'sample') sample();
else if (mode === 'score') score();
else if (mode === 'check') check();
else console.error('usage: audit.ts sample|score');
