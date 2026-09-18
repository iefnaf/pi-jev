import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { defineMenu, runMenu } from '@narumitw/pi-tui-kit';
import {
  CONFIG_KEYS,
  configFromEnv,
  mergeConfigFiles,
  readConfigFile,
  type ConfigKeyMeta,
  type JevFileConfig,
} from '../shared/config.js';
import { coerce, keyMeta, readOrInit, saveFile, setPath, valueAt } from '../cli/main.js';
import { VALUE_OPTIONS } from './completions.js';

export type MenuScreenId = 'main' | 'general' | 'compaction' | 'routing' | 'chooseValue' | 'inputValue';
export type MenuActionId =
  | 'toggleScope'
  | 'editKey'
  | 'setEnum'
  | 'setValue'
  | 'showResolved';

export interface EditorState {
  scope: 'global' | 'project';
  editingKey: string;
}

export interface MenuPaths {
  globalPath: string;
  projectPath: string;
}

function readFileTolerant(path: string): JevFileConfig | undefined {
  try {
    return readConfigFile(path);
  } catch {
    return undefined;
  }
}

function merged(paths: MenuPaths): JevFileConfig | undefined {
  return mergeConfigFiles(readFileTolerant(paths.globalPath), readFileTolerant(paths.projectPath));
}

/** Effective value of a key, tagged with where it comes from. */
function displayValue(meta: ConfigKeyMeta, paths: MenuPaths): string {
  const config = configFromEnv(process.env, merged(paths));
  const raw = valueAt(config, meta.path);
  if (raw === undefined) return 'unset';
  const fromEnv = meta.env ? (process.env[meta.env] ?? '').trim() : '';
  return `${String(raw)}${fromEnv ? ' [env]' : ''}`;
}

function groupKeys(prefix: string): ConfigKeyMeta[] {
  return CONFIG_KEYS.filter((meta) =>
    prefix === '' ? !meta.path.includes('.') : meta.path.startsWith(`${prefix}.`),
  );
}

function groupScreen(
  screenId: 'general' | 'compaction' | 'routing',
  title: string,
  paths: MenuPaths,
): { kind: 'settings'; title: string; items: { id: string; label: string; description?: string; currentValue: string; action: MenuActionId }[] } {
  const prefix = screenId === 'general' ? '' : screenId;
  const action: MenuActionId = 'editKey';
  return {
    kind: 'settings',
    title,
    items: groupKeys(prefix).map((meta) => ({
      id: meta.path,
      label: meta.path,
      description: meta.description,
      currentValue: displayValue(meta, paths),
      action,
    })),
  };
}

function writeKey(paths: MenuPaths, scope: 'global' | 'project', keyPath: string, value: string): void {
  const meta = keyMeta(keyPath);
  if (!meta) throw new Error(`unknown key "${keyPath}"`);
  const targetPath = scope === 'project' ? paths.projectPath : paths.globalPath;
  const file = readOrInit(targetPath);
  setPath(file, meta.path, coerce(meta, value));
  saveFile(targetPath, file);
}

/**
 * Builds the interactive `/jev` settings menu on top of `@narumitw/pi-tui-kit`.
 * `state` is mutated by actions (scope toggle, key being edited).
 */
export function buildJevMenu(
  paths: MenuPaths,
  state: EditorState,
  io: { out(text: string): void },
) {
  return defineMenu<EditorState, MenuScreenId, MenuActionId, ExtensionCommandContext>({
    start: 'main',
    screens: {
      main: () => {
        const config = configFromEnv(process.env, merged(paths));
        const scopePath = state.scope === 'project' ? paths.projectPath : paths.globalPath;
        return {
          kind: 'actions',
          title: 'pi-jev',
          lines: [`Scope: ${state.scope} (${scopePath}) — 'toggle scope' switches it`],
          items: [
            {
              id: 'toggleScope',
              label: `Toggle scope (currently ${state.scope})`,
              action: 'toggleScope',
            },
            {
              id: 'general',
              label: `General (provider ${config.provider})`,
              to: 'general',
            },
            {
              id: 'compaction',
              label: 'Compaction',
              to: 'compaction',
            },
            {
              id: 'routing',
              label: `Routing (${config.routing.cheap || config.routing.strong ? 'enabled' : 'disabled'})`,
              to: 'routing',
            },
            { id: 'showResolved', label: 'Show resolved config', action: 'showResolved' },
          ],
          hint: 'close',
        };
      },
      general: () => groupScreen('general', 'pi-jev — General', paths),
      compaction: () => groupScreen('compaction', 'pi-jev — Compaction', paths),
      routing: () => groupScreen('routing', 'pi-jev — Routing', paths),
      chooseValue: () => {
        const options = VALUE_OPTIONS[state.editingKey] ?? [];
        return {
          kind: 'choice',
          title: `pi-jev — ${state.editingKey}`,
          items: options.map((option) => ({
            id: option.label,
            label: option.label,
            description: option.description,
          })),
          action: 'setEnum',
          hint: 'back',
        };
      },
      inputValue: () => {
        const meta = keyMeta(state.editingKey);
        return {
          kind: 'input',
          title: `pi-jev — set ${state.editingKey}`,
          lines: meta ? [meta.description] : [],
          placeholder: '(new value)',
          action: 'setValue',
          hint: 'back',
        };
      },
    },
    actions: {
      toggleScope: () => {
        state.scope = state.scope === 'global' ? 'project' : 'global';
        return { kind: 'stay' };
      },
      editKey: ({ itemId }) => {
        if (!keyMeta(itemId)) return { kind: 'rejected', error: new Error(`unknown key "${itemId}"`) };
        state.editingKey = itemId;
        return VALUE_OPTIONS[itemId] ? { kind: 'to', screen: 'chooseValue' } : { kind: 'to', screen: 'inputValue' };
      },
      setEnum: ({ itemId }) => {
        writeKey(paths, state.scope, state.editingKey, itemId);
        return { kind: 'back' };
      },
      setValue: ({ value }) => {
        if (value === undefined || !value.trim()) return { kind: 'rejected', error: new Error('empty value') };
        try {
          writeKey(paths, state.scope, state.editingKey, value.trim());
        } catch (error) {
          return { kind: 'rejected', error };
        }
        return { kind: 'back' };
      },
      showResolved: () => {
        const lines: string[] = [];
        const global = readFileTolerant(paths.globalPath);
        const project = readFileTolerant(paths.projectPath);
        const config = configFromEnv(process.env, mergeConfigFiles(global, project));
        for (const meta of CONFIG_KEYS) {
          lines.push(`${meta.path} = ${valueAt(config, meta.path) ?? 'unset'}`);
        }
        io.out(lines.join('\n'));
        return { kind: 'close' };
      },
    },
  });
}

/** Opens the interactive menu; falls back to text output outside TUI mode. */
export async function openJevSettingsMenu(
  ctx: ExtensionCommandContext,
  paths: MenuPaths,
  io: { out(text: string): void },
): Promise<void> {
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    io.out('/jev menu requires an interactive pi UI; use `/jev set <key> <value>` instead');
    return;
  }
  const controller = new AbortController();
  const state: EditorState = { scope: 'global', editingKey: 'model' };
  const menu = buildJevMenu(paths, state, io);
  try {
    await runMenu(ctx, menu, {
      getState: () => state,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    });
  } finally {
    controller.abort();
  }
}
