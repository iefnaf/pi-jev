import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildJevMenu, type EditorState, type MenuPaths } from '../src/commands/menu.js';
import { resolveMenuScreen } from '@narumitw/pi-tui-kit';
import { completeJevArguments, setModelOptions } from '../src/commands/completions.js';
import type { ModelOption } from '../src/commands/models.js';
import { parseModelRef } from '../src/routing/extension.js';

const MODELS: ModelOption[] = [
  { ref: 'deepseek/deepseek-flash', modelRef: 'deepseek/deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', reasoning: true, image: true, contextWindow: 1_000_000 },
  { ref: 'openrouter/gpt-x', modelRef: 'openrouter/gpt-x', name: 'GPT X', provider: 'openrouter', reasoning: false, image: false, contextWindow: 400_000 },
];

const dirs: string[] = [];
function makePaths(files: { global?: unknown } = {}): MenuPaths {
  const dir = mkdtempSync(join(tmpdir(), 'pi-jev-picker-'));
  dirs.push(dir);
  const paths = { globalPath: join(dir, 'global.json'), projectPath: join(dir, 'project', 'jev.json') };
  if (files.global !== undefined) writeFileSync(paths.globalPath, JSON.stringify(files.global));
  return paths;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setModelOptions([]);
});

function menu(paths: MenuPaths, state?: Partial<EditorState>) {
  const editor: EditorState = { scope: 'global', editingKey: 'routing.cheap', ...state };
  const definition = buildJevMenu(paths, editor, { out: () => {} }, MODELS);
  return { definition, editor };
}
function call(handler: unknown, context: Record<string, unknown>): unknown {
  return (handler as (input: Record<string, unknown>) => unknown)(context);
}

describe('menu model picker', () => {
  it('chooseModel lists pi models with capability hints', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths);
    const screen = resolveMenuScreen(definition, 'chooseModel', editor) as unknown as { items: { id: string; description?: string }[] };
    expect(screen.items.map((item) => item.id)).toEqual(['deepseek/deepseek-flash', 'openrouter/gpt-x']);
    expect(screen.items[0].description).toContain('thinking');
    expect(screen.items[0].description).toContain('images');
  });

  it('reasoning model goes through chooseThinking and writes provider/id:level', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths);
    expect(call(definition.actions.pickModel, { state: editor, itemId: 'deepseek/deepseek-flash' })).toEqual({ kind: 'to', screen: 'chooseThinking' });
    expect(editor.selectedModelRef).toBe('deepseek/deepseek-flash');
    expect(call(definition.actions.pickThinking, { state: editor, itemId: 'high' })).toEqual({ kind: 'back' });
    expect(JSON.parse(readFileSync(paths.globalPath, 'utf8'))).toEqual({ routing: { cheap: 'deepseek/deepseek-flash:high' } });
  });

  it('default thinking writes the bare ref', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths);
    call(definition.actions.pickModel, { state: editor, itemId: 'deepseek/deepseek-flash' });
    call(definition.actions.pickThinking, { state: editor, itemId: '__default__' });
    expect(JSON.parse(readFileSync(paths.globalPath, 'utf8'))).toEqual({ routing: { cheap: 'deepseek/deepseek-flash' } });
  });

  it('non-reasoning model writes immediately', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths);
    expect(call(definition.actions.pickModel, { state: editor, itemId: 'openrouter/gpt-x' })).toEqual({ kind: 'back' });
    expect(JSON.parse(readFileSync(paths.globalPath, 'utf8'))).toEqual({ routing: { cheap: 'openrouter/gpt-x' } });
  });

  it('unset clears an existing value', () => {
    const paths = makePaths({ global: { routing: { cheap: 'openrouter/gpt-x' } } });
    const { definition, editor } = menu(paths);
    expect(call(definition.actions.pickModel, { state: editor, itemId: '__unset__' })).toEqual({ kind: 'back' });
    expect(readFileSync(paths.globalPath, 'utf8').trim()).toBe('{}');
  });
});

describe('model completions', () => {
  it('completes cheap/strong values from the model snapshot', () => {
    setModelOptions(MODELS);
    const items = completeJevArguments('set routing.cheap ');
    expect(items?.map((item) => item.value)).toContain('set routing.cheap deepseek/deepseek-flash');
    const filtered = completeJevArguments('set routing.cheap dee');
    expect(filtered?.map((item) => item.value)).toEqual(['set routing.cheap deepseek/deepseek-flash']);
  });

  it('no snapshot means no model completions', () => {
    setModelOptions([]);
    expect(completeJevArguments('set routing.cheap ')).toBeNull();
  });
});

describe('parseModelRef with thinking suffix', () => {
  it('splits provider/id:level', () => {
    expect(parseModelRef('deepseek/deepseek-flash:high')).toEqual({ provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' });
    expect(parseModelRef('deepseek/deepseek-flash')).toEqual({ provider: 'deepseek', id: 'deepseek-flash' });
    expect(parseModelRef('bad')).toBeUndefined();
  });
});
