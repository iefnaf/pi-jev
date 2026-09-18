import { describe, expect, it } from 'vitest';
import { completeJevArguments } from '../src/commands/completions.js';

function values(argText: string): string[] {
  const items = completeJevArguments(argText);
  return items ? items.map((item) => item.value) : [];
}

describe('completeJevArguments', () => {
  it('completes actions from a partial or bare space', () => {
    expect(values('se')).toEqual(['set']);
    expect(values('')).toEqual(['set', 'get', 'unset', 'keys', 'path']);
    expect(values(' ')).toEqual(['set', 'get', 'unset', 'keys', 'path']);
  });

  it('completes config keys for set/get/unset, values replace the whole argument', () => {
    const keys = values('set routing.ch');
    expect(keys).toContain('set routing.cheap');
    expect(values('get compaction.min'))
      .toContain('get compaction.minReduction');
    expect(values('unset ')).toContain('unset model');
  });

  it('offers enum values where they exist', () => {
    expect(values('set provider ')).toContain('set provider openrouter');
    expect(values('set disabled ').length).toBe(2);
    // free-form keys get no value completion
    expect(completeJevArguments('set model ')).toBeNull();
  });

  it('keeps the -l flag in completed values', () => {
    expect(values('set -l routing.ch')).toContain('set -l routing.cheap');
    expect(values('set provider o')).not.toContain('set provider typesafe -l');
  });

  it('stops completing after key/value positions', () => {
    expect(completeJevArguments('keys ')).toBeNull();
    expect(completeJevArguments('path ')).toBeNull();
    expect(completeJevArguments('set model foo ')).toBeNull();
    expect(completeJevArguments('nonsense ')).toBeNull();
  });

  it('api keys are never offered', () => {
    const keys = values('set api');
    expect(keys).toEqual([]);
  });
});
