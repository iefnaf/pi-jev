import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMenuScreen } from '@narumitw/pi-tui-kit';
import { buildJevMenu, type EditorState, type MenuPaths } from '../src/commands/menu.js';

const dirs: string[] = [];
function makePaths(files: { global?: unknown; project?: unknown } = {}): MenuPaths {
  const dir = mkdtempSync(join(tmpdir(), 'pi-jev-menu-'));
  dirs.push(dir);
  const paths = { globalPath: join(dir, 'global.json'), projectPath: join(dir, 'project', 'jev.json') };
  if (files.global !== undefined) writeFileSync(paths.globalPath, JSON.stringify(files.global));
  if (files.project !== undefined) writeFileSync(paths.projectPath, JSON.stringify(files.project));
  return paths;
}
function menu(paths: MenuPaths, state?: Partial<EditorState>) {
  const editor: EditorState = { scope: 'global', editingKey: 'model', ...state };
  const lines: string[] = [];
  const definition = buildJevMenu(paths, editor, { out: (text) => lines.push(text) });
  return { definition, editor, lines };
}
function screen(paths: MenuPaths, screenId: string, state?: Partial<EditorState>) {
  const { definition, editor } = menu(paths, state);
  return resolveMenuScreen(definition, screenId as never, editor) as never as {
    kind: string;
    items?: { id: string; currentValue?: string; action?: string }[];
    lines?: string[];
  };
}

type ActionContext = { state: EditorState; value?: string; itemId?: string };
function call(handler: unknown, context: ActionContext): unknown {
  return (handler as (input: ActionContext) => unknown)(context);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('jev settings menu', () => {
  it('shows group screens with effective values from the files', () => {
    const paths = makePaths({ global: { routing: { cheap: 'deepseek/deepseek-flash' } } });
    const routing = screen(paths, 'routing');
    expect(routing.items?.map((item) => item.id)).toEqual(['routing.cheap', 'routing.strong']);
    const cheap = routing.items?.find((item) => item.id === 'routing.cheap');
    expect(cheap?.currentValue).toContain('deepseek/deepseek-flash');
    const general = screen(paths, 'general');
    expect(general.items?.map((item) => item.id)).toEqual(['provider', 'model', 'baseUrl', 'disabled']);
  });

  it('main screen reflects routing state and scope', () => {
    const paths = makePaths();
    const main = screen(paths, 'main');
    expect(JSON.stringify(main)).toContain('Routing (disabled)');
    const enabled = screen(makePaths({ global: { routing: { cheap: 'a/b' } } }), 'main');
    expect(JSON.stringify(enabled)).toContain('Routing (enabled)');
  });

  it('setValue writes the file and goes back', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths, { editingKey: 'compaction.keepThreshold' });
    expect(call(definition.actions.setValue, { state: editor, value: '0.7' })).toEqual({ kind: 'back' });
    expect(JSON.parse(readFileSync(paths.globalPath, 'utf8'))).toEqual({ compaction: { keepThreshold: 0.7 } });
  });

  it('setValue rejects invalid values without writing', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths, { editingKey: 'compaction.keepThreshold' });
    const result = call(definition.actions.setValue, { state: editor, value: 'NaN!' }) as { kind: string };
    expect(result.kind).toBe('rejected');
    expect(() => readFileSync(paths.globalPath, 'utf8')).toThrow();
  });

  it('setEnum writes the chosen enum value', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths, { editingKey: 'provider' });
    expect(call(definition.actions.setEnum, { state: editor, itemId: 'openrouter' })).toEqual({ kind: 'back' });
    expect(JSON.parse(readFileSync(paths.globalPath, 'utf8'))).toEqual({ provider: 'openrouter' });
  });

  it('editKey routes enums to chooseValue, models to chooseModel, free-form to inputValue', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths);
    expect(call(definition.actions.editKey, { state: editor, itemId: 'routing.cheap' })).toEqual({ kind: 'to', screen: 'chooseModel' });
    expect(call(definition.actions.editKey, { state: editor, itemId: 'provider' })).toEqual({ kind: 'to', screen: 'chooseValue' });
    expect(editor.editingKey).toBe('provider');
    expect(call(definition.actions.editKey, { state: editor, itemId: 'model' })).toEqual({ kind: 'to', screen: 'inputValue' });
  });

  it('toggleScope flips the scope and stays', () => {
    const paths = makePaths();
    const { definition, editor } = menu(paths);
    expect(call(definition.actions.toggleScope, { state: editor })).toEqual({ kind: 'stay' });
    expect(editor.scope).toBe('project');
  });

  it('showResolved prints every key and closes', () => {
    const paths = makePaths();
    const { definition, editor, lines } = menu(paths);
    expect(call(definition.actions.showResolved, { state: editor })).toEqual({ kind: 'close' });
    expect(lines[0]).toContain('model = ');
    expect(lines[0]).toContain('routing.cheap');
  });
});
