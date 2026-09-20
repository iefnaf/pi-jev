import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { prepareCompaction, type CompactionPreparation } from './pi.js';
import type { LoadedSession } from './session.js';

export interface CaseOptions {
  /** Model context window the trigger is derived from. */
  window: number;
  /** pi's `compaction.reserveTokens`; compaction fires at `window - reserve`. */
  reserveTokens: number;
  /** pi's `compaction.keepRecentTokens`. */
  keepRecentTokens: number;
  /** Assumed size of the summary that stands in for earlier context after a cut. */
  summaryTokens: number;
  /** Cuts with less future than this carry no signal and are dropped. */
  minFutureTokens: number;
}

export const DEFAULT_CASE_OPTIONS: CaseOptions = {
  window: 128_000,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  summaryTokens: 6_000,
  minFutureTokens: 3_000,
};

export interface CaseMeta {
  id: string;
  project: string;
  file: string;
  window: number;
}

/** One simulated compaction of a real session, plus what happened afterwards. */
export interface EvalCase extends CaseMeta {
  isSplitTurn: boolean;
  /** Span pi hands to `session_before_compact`. */
  span: AgentMessage[];
  /** Messages pi keeps verbatim after the cut; safe under any policy. */
  tail: AgentMessage[];
  /** What the agent did after the cut, up to the next simulated cut. */
  future: AgentMessage[];
  preparation: CompactionPreparation;
}

function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap(entry => sessionEntryToContextMessages(entry));
}

function tokensOf(entries: readonly SessionEntry[]): number {
  return messagesOf(entries).reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** The agent loop only checks for compaction once a turn has ended. */
function endsTurn(entry: SessionEntry): boolean {
  if (entry.type !== 'message' || entry.message.role !== 'assistant') return false;
  return !entry.message.content.some(block => block.type === 'toolCall');
}

/** Re-links the chain in array order so `prepareCompaction` sees a valid path. */
function relink(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    parentId: index === 0 ? null : entries[index - 1]!.id,
  }));
}

interface RawCut {
  /** Indexes into `session.clean`. */
  triggerIdx: number;
  firstKeptIdx: number;
  preparation: CompactionPreparation;
}

/**
 * Replays pi's trigger over the raw history: accumulate estimated tokens, cut
 * at the first turn end past `window - reserveTokens`, then continue as pi
 * would with a summary plus the kept tail as the new context. The summary is a
 * fixed-size placeholder (`summaryTokens`): the eval only needs realistic span
 * sizes, and each cut is scored independently of any earlier one.
 */
function findCuts(session: LoadedSession, options: CaseOptions): RawCut[] {
  const settings = {
    enabled: true,
    reserveTokens: options.reserveTokens,
    keepRecentTokens: options.keepRecentTokens,
  };
  const trigger = options.window - options.reserveTokens;

  let work = relink(session.clean);
  const origin: Array<number | null> = session.clean.map((_, index) => index);
  const cuts: RawCut[] = [];
  let running = 0;

  for (let w = 0; w < work.length; w++) {
    running += tokensOf([work[w]!]);
    if (running < trigger || !endsTurn(work[w]!)) continue;

    const preparation = prepareCompaction(work.slice(0, w + 1), settings);
    if (!preparation) continue;
    const keptAt = work.findIndex(entry => entry.id === preparation.firstKeptEntryId);
    const firstKeptIdx = origin[keptAt];
    const triggerIdx = origin[w];
    if (keptAt < 0 || firstKeptIdx == null || triggerIdx == null) continue;
    cuts.push({ triggerIdx, firstKeptIdx, preparation });

    const marker: CompactionEntry = {
      type: 'compaction',
      id: `eval-cut-${cuts.length}`,
      parentId: work[w]!.id,
      timestamp: work[w]!.timestamp,
      summary: 'x'.repeat(options.summaryTokens * 4),
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    };
    running = options.summaryTokens + tokensOf(work.slice(keptAt, w + 1));
    work = relink([...work.slice(0, w + 1), marker, ...work.slice(w + 1)]);
    origin.splice(w + 1, 0, null);
    w += 1; // skip the marker
  }
  return cuts;
}

export function generateCases(
  session: LoadedSession,
  options: CaseOptions = DEFAULT_CASE_OPTIONS,
): EvalCase[] {
  const cuts = findCuts(session, options);
  const cases: EvalCase[] = [];
  cuts.forEach((cut, index) => {
    const futureEnd = cuts[index + 1]?.triggerIdx ?? session.clean.length - 1;
    const futureEntries = session.clean.slice(cut.triggerIdx + 1, futureEnd + 1);
    if (tokensOf(futureEntries) < options.minFutureTokens) return;
    const { preparation } = cut;
    cases.push({
      id: `${session.id.slice(-8)}:${options.window / 1000}k:${index + 1}`,
      project: session.project,
      file: session.file,
      window: options.window,
      isSplitTurn: preparation.isSplitTurn,
      span: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
      tail: messagesOf(session.clean.slice(cut.firstKeptIdx, cut.triggerIdx + 1)),
      future: messagesOf(futureEntries),
      preparation,
    });
  });
  return cases;
}

export function metaOf(evalCase: EvalCase): CaseMeta {
  const { id, project, file, window } = evalCase;
  return { id, project, file, window };
}
