import { describe, expect, it } from 'vitest';
import { runJevCompaction } from '../src/compaction/extension.js';
import { fakeAsker, withDefaults, bigText, spanMessages } from './helpers.js';

const input = {
  firstKeptEntryId: 'entry-9',
  tokensBefore: 120_000,
};

describe('runJevCompaction', () => {
  it('produces a verbatim summary with truncation notes and details', async () => {
    const asker = fakeAsker({
      t1: { keepCall: 0.95, keepResult: 0.95 },
      t2: { keepCall: 0.9, keepResult: 0.1 },
      t3: { keepCall: 0.05, keepResult: 0.05 },
    });
    const run = await runJevCompaction(
      { ...input, messagesToSummarize: spanMessages(), turnPrefixMessages: [] },
      asker,
      withDefaults({}),
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.compaction.firstKeptEntryId).toBe('entry-9');
    expect(run.compaction.tokensBefore).toBe(120_000);
    expect(run.reduction).toBeGreaterThan(0.15);

    const summary = run.compaction.summary;
    expect(summary).toContain('<compacted-conversation>');
    expect(summary).toContain('[User]: Fix the failing test. Never edit src/generated.');
    expect(summary).toContain('[Tool result]: ' + 'A'.repeat(50));
    expect(summary).toContain('[jev-compaction truncated');
    expect(summary).not.toContain('obsolete grep result'); // dropped call gone
    expect(summary).toContain('1 obsolete tool calls were removed');

    expect(run.compaction.usage).toEqual({
      input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(run.compaction.details.engine).toBe('jev');
    expect(run.compaction.details.stats.callsDropped).toBe(1);
    expect(run.compaction.estimatedTokensAfter).toBeGreaterThan(0);
  });

  it('prepends the previous summary verbatim', async () => {
    const asker = fakeAsker({ t1: { keepCall: 0.1, keepResult: 0.1 }, t2: { keepCall: 0.1, keepResult: 0.1 }, t3: { keepCall: 0.1, keepResult: 0.1 } });
    const run = await runJevCompaction(
      { ...input, messagesToSummarize: spanMessages(), turnPrefixMessages: [], previousSummary: 'earlier work summary' },
      asker,
      withDefaults({}),
    );
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.compaction.summary.startsWith('<summary-of-earlier-context>\nearlier work summary')).toBe(true);
    }
  });

  it('falls back when Jev keeps almost everything', async () => {
    const asker = fakeAsker({ t1: { keepCall: 0.99, keepResult: 0.99 }, t2: { keepCall: 0.99, keepResult: 0.99 }, t3: { keepCall: 0.99, keepResult: 0.99 } });
    const run = await runJevCompaction(
      { ...input, messagesToSummarize: spanMessages(), turnPrefixMessages: [] },
      asker,
      withDefaults({}),
    );
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toBe('low-reduction');
  });

  it('falls back on an empty span', async () => {
    const run = await runJevCompaction(
      { ...input, messagesToSummarize: [], turnPrefixMessages: [] },
      fakeAsker({}),
      withDefaults({}),
    );
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toBe('empty-span');
  });

  it('propagates Jev failures so the hook can fall back', async () => {
    const asker = { ask: async () => { throw new Error('Jev request failed (500)'); } };
    await expect(
      runJevCompaction({ ...input, messagesToSummarize: spanMessages(), turnPrefixMessages: [] }, asker, withDefaults({})),
    ).rejects.toThrow('Jev request failed');
  });
});
