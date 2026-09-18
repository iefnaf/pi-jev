import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../src/vendor/fast-jev-compaction/index.js';
import { configFromEnv, type RoutingConfig } from '../src/shared/config.js';
import { decideRouting, DIFFICULTY_LEVELS, routingQuestions, toLevels } from '../src/routing/decide.js';
import { parseModelRef, runRouting } from '../src/routing/extension.js';
import { fakeAsker } from './helpers.js';

function routing(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    cheap: 'deepseek/deepseek-flash',
    strong: 'zai/glm-5.3',
    easyMax: 0.5,
    hardMin: 1.5,
    minConfidence: 0.6,
    ...overrides,
  };
}

function difficulty(score: number, confidence = 0.8): Record<string, JevAnswer> {
  return { difficulty: { type: 'score', score, confidence, probabilities: {} } };
}

describe('routingQuestions', () => {
  it('asks one score question over three difficulty levels', () => {
    const questions = routingQuestions();
    expect(Object.keys(questions)).toEqual(['difficulty']);
    expect(questions.difficulty.type).toBe('score');
    expect(questions.difficulty.criteria).toEqual([...DIFFICULTY_LEVELS]);
  });
});

describe('toLevels', () => {
  it('maps both score formats into the 0..2 level space, clamped', () => {
    expect(toLevels(0)).toBe(0);
    expect(toLevels(1)).toBe(2); // normalized 1.0 = hardest
    expect(toLevels(2)).toBe(2); // level index 2 of 2
    expect(toLevels(4)).toBe(2); // out-of-range clamped
  });
});

describe('decideRouting', () => {
  const config = routing();

  it('routes confidently easy requests to the cheap model', () => {
    const decision = decideRouting(difficulty(0.2), config); // 0.4 levels
    expect(decision.target).toBe('cheap');
    expect(decision.reason).toBe('easy');
  });

  it('routes confidently hard requests to the strong model', () => {
    const decision = decideRouting(difficulty(1), config); // normalized 1.0 → 2 levels
    expect(decision.target).toBe('strong');
    expect(decision.reason).toBe('hard');
  });

  it('keeps the current model in the middle band', () => {
    const decision = decideRouting(difficulty(0.5), config); // 1.0 level = moderate
    expect(decision.target).toBeNull();
    expect(decision.reason).toBe('middle');
  });

  it('keeps the current model when confidence is low', () => {
    const decision = decideRouting(difficulty(0.1, 0.4), config);
    expect(decision.target).toBeNull();
    expect(decision.reason).toBe('low-confidence');
  });

  it('keeps the current model when the answer is missing or malformed', () => {
    expect(decideRouting({}, config).reason).toBe('missing-answer');
    const malformed = { difficulty: { type: 'score', score: 'x' } as unknown as JevAnswer };
    expect(decideRouting(malformed, config).reason).toBe('missing-answer');
  });

  it('ignores tiers that are not configured', () => {
    expect(decideRouting(difficulty(0.2), routing({ cheap: undefined })).target).toBeNull();
    expect(decideRouting(difficulty(1), routing({ strong: undefined })).target).toBeNull();
  });
});

describe('parseModelRef', () => {
  it('parses provider/model references', () => {
    expect(parseModelRef('deepseek/deepseek-flash')).toEqual({ provider: 'deepseek', id: 'deepseek-flash' });
    expect(parseModelRef('bad')).toBeUndefined();
    expect(parseModelRef('/x')).toBeUndefined();
    expect(parseModelRef('x/')).toBeUndefined();
  });
});

describe('runRouting', () => {
  it('sends the prompt as state and maps the answer', async () => {
    const asker = fakeAsker({ difficulty: { score: 0.2, confidence: 0.9 } });
    const decision = await runRouting('list the files', asker, routing());
    expect(decision.target).toBe('cheap');
    const state = asker.asks[0].state as { prompt: string; context: string };
    expect(state.prompt).toBe('list the files');
    expect(state.context).toContain('coding assistant');
  });

  it('propagates Jev failures to the caller', async () => {
    const asker = { ask: async () => { throw new Error('Jev request failed (500)'); } };
    await expect(runRouting('x', asker, routing())).rejects.toThrow('Jev request failed');
  });
});

describe('configFromEnv routing section', () => {
  it('reads routing variables with defaults', () => {
    const config = configFromEnv({
      JEVC_ROUTE_CHEAP: 'deepseek/deepseek-flash',
      JEVC_ROUTE_HARD_MIN: '1.8',
    });
    expect(config.routing.cheap).toBe('deepseek/deepseek-flash');
    expect(config.routing.strong).toBeUndefined();
    expect(config.routing.hardMin).toBe(1.8);
    expect(config.routing.easyMax).toBe(0.5);
    expect(config.routing.minConfidence).toBe(0.6);
  });
});
