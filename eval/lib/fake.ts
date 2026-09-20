import { createHash } from 'node:crypto';
import type {
  JevAnswer,
  JevAsker,
  JevQuestions,
  JevResponse,
} from '../../src/vendor/fast-jev-compaction/index.js';

function unit(text: string): number {
  return createHash('sha1').update(text).digest().readUInt32BE(0) / 0xffffffff;
}

/**
 * Answers every question with a stable pseudo-random value derived from its
 * name. It says nothing about Jev's quality; it exists so L0 can drive the
 * real pipeline over real spans, with a mix of keep/truncate/drop decisions,
 * without an API call.
 */
export function pseudoRandomAsker(seed = ''): JevAsker & { requests: number } {
  const asker = {
    requests: 0,
    async ask(_state: unknown, questions: JevQuestions): Promise<JevResponse> {
      asker.requests += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        const value = unit(`${seed}${name}`);
        answers[name] =
          question.type === 'noul'
            ? { type: 'noul', noul: value }
            : { type: 'score', score: value * 4, confidence: unit(`${seed}c${name}`), probabilities: {} };
      }
      return { model: 'fake', answers, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
  return asker;
}
