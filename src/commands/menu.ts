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
import { THINKING_LEVELS, type ModelOption } from './models.js';

export type MenuScreenId = 'main' | 'general' | 'compaction' | 'routing' | 'chooseValue' | 'chooseModel' | 'chooseThinking' | 'inputValue';
export type MenuActionId =
  | 'toggleScope'
  | 'editKey'
  | 'setEnum'
  | 'setValue'
  | 'pickModel'
  | 'pickThinking'
  | 'showResolved';

export interface EditorState {
  scope: 'global' | 'project';
  editingKey: string;
  /** Model picked in chooseModel, awaiting an optional thinking level. */
  selectedModelRef?: string;
  /** Whether the selected model supports thinking. */
  selectedModelReasoning?: boolean;
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
  models: readonly ModelOption[] = [],
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
      chooseModel: () => {
        const current = displayValue(keyMeta(state.editingKey)!, paths);
        const items = [
          ...(current !== 'unset' ? [{ id: '__unset__', label: '(unset)', description: 'clear this key' }] : []),
          ...models.map((model) => ({
            id: model.ref,
            label: model.name,
            description: `${model.provider}${model.image ? ' · images' : ''}${model.reasoning ? ' · thinking' : ''}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k ctx` : ''}`,
          })),
        ];
        return {
          kind: 'choice',
          title: `pi-jev — ${state.editingKey}`,
          lines: models.length === 0 ? ['No models found in pi (check provider auth).'] : [],
          items,
          action: 'pickModel',
          enableSearch: true,
          hint: 'back',
        };
      },
      chooseThinking: () => {
        const model = models.find((entry) => entry.modelRef === state.selectedModelRef);
        return {
          kind: 'choice',
          title: `pi-jev — thinking level`,
          lines: [`${state.selectedModelRef ?? ''} (thinking optional — default keeps the model's own)`],
          items: [
            { id: '__default__', label: 'default', description: "no override (model default)" },
            ...(model?.reasoning !== false && model ? THINKING_LEVELS.map((level) => ({ id: level, label: level })) : []),
          ],
          action: 'pickThinking',
          initialItemId: '__default__',
          hint: 'back',
        };
      },
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
        if (itemId === 'routing.cheap' || itemId === 'routing.strong') return { kind: 'to', screen: 'chooseModel' };
        return VALUE_OPTIONS[itemId] ? { kind: 'to', screen: 'chooseValue' } : { kind: 'to', screen: 'inputValue' };
      },
      setEnum: ({ itemId }) => {
        writeKey(paths, state.scope, state.editingKey, itemId);
        return { kind: 'back' };
      },
      pickModel: ({ itemId }) => {
        if (itemId === '__unset__') {
          const targetPath = state.scope === 'project' ? paths.projectPath : paths.globalPath;
          const file = readOrInit(targetPath);
          const [section, key] = state.editingKey.split('.') as [string, string];
          delete ((file as Record<string, Record<string, unknown>>)[section] ??= {})[key];
          if (Object.keys((file as Record<string, Record<string, unknown>>)[section]).length === 0) {
            delete (file as Record<string, unknown>)[section];
          }
          saveFile(targetPath, file);
          return { kind: 'back' };
        }
        const model = models.find((entry) => entry.ref === itemId);
        state.selectedModelRef = itemId;
        state.selectedModelReasoning = model?.reasoning ?? false;
        if (state.selectedModelReasoning) return { kind: 'to', screen: 'chooseThinking' };
        writeKey(paths, state.scope, state.editingKey, itemId);
        return { kind: 'back' };
      },
      pickThinking: ({ itemId }) => {
        const ref = itemId === '__default__' ? state.selectedModelRef : `${state.selectedModelRef}:${itemId}`;
        writeKey(paths, state.scope, state.editingKey, ref ?? '');
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
  const { modelsFromContext } = await import('./models.js');
  const menu = buildJevMenu(paths, state, io, modelsFromContext(ctx));
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
