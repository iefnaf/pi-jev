import type { JevAnswer, JevQuestions } from '../vendor/fast-jev-compaction/index.js';
import type { RoutingConfig } from '../shared/config.js';

export const DIFFICULTY_LEVELS = ['trivial', 'simple', 'moderate', 'complex', 'very complex'] as const;

export const ROUTING_CONTEXT =
  'A coding assistant is about to start a turn. `prompt` is the user request starting it. The question rates how demanding the request is for the assistant, so that easy requests can go to a cheaper model and hard ones to a stronger model.';

export function routingQuestions(): JevQuestions {
  return {
    difficulty: {
      type: 'score',
      instructions: `Rate how demanding this coding request is: level 0 is trivial (greetings, simple lookups, formatting), level ${DIFFICULTY_LEVELS.length - 1} is very complex (multi-file refactors, subtle debugging, architecture decisions)`,
      criteria: [...DIFFICULTY_LEVELS],
    },
  };
}

export type RoutingTarget = 'cheap' | 'strong' | null;

export interface RoutingDecision {
  target: RoutingTarget;
  /** Raw Jev score, as returned. */
  score: number;
  /** Score mapped to the 0..4 level space (see `decideRouting`). */
  levels: number;
  confidence: number;
  reason: 'easy' | 'hard' | 'middle' | 'low-confidence' | 'missing-answer';
}

function scoreFrom(answers: Record<string, JevAnswer>): { score: number; confidence: number } | undefined {
  const answer = answers.difficulty;
  if (
    answer === null ||
    typeof answer !== 'object' ||
    !('score' in answer) ||
    typeof (answer as { score?: unknown }).score !== 'number' ||
    !Number.isFinite((answer as { score: number }).score)
  ) {
    return undefined;
  }
  const confidence =
    'confidence' in answer && typeof (answer as { confidence?: unknown }).confidence === 'number'
      ? (answer as { confidence: number }).confidence
      : 0;
  return { score: (answer as { score: number }).score, confidence };
}

/**
 * Maps a Jev score to the 0..4 level space. Jev returns either a 0..1
 * continuous score or a level index; `score <= 1` is read as normalized
 * (a literal 1 therefore means "hardest", the conservative direction).
 */
export function toLevels(score: number): number {
  return (score <= 1 ? score : score / (DIFFICULTY_LEVELS.length - 1)) * (DIFFICULTY_LEVELS.length - 1);
}
/**
 * Pure decision: easy requests go to the cheap model, hard ones to the strong
 * model, everything else (middle band, low confidence, missing or malformed
 * answer) keeps the current model.
 */
export function decideRouting(answers: Record<string, JevAnswer>, config: RoutingConfig): RoutingDecision {
  const answer = scoreFrom(answers);
  if (!answer) {
    return { target: null, score: 0, levels: 0, confidence: 0, reason: 'missing-answer' };
  }
  const levels = toLevels(answer.score);
  const base = { score: answer.score, levels, confidence: answer.confidence };

  if (answer.confidence < config.minConfidence) {
    return { ...base, target: null, reason: 'low-confidence' };
  }
  if (config.cheap && levels <= config.easyMax) {
    return { ...base, target: 'cheap', reason: 'easy' };
  }
  if (config.strong && levels >= config.hardMin) {
    return { ...base, target: 'strong', reason: 'hard' };
  }
  return { ...base, target: null, reason: 'middle' };
}
