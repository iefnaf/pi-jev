import { CONFIG_KEYS } from '../shared/config.js';

/**
 * Completion items as pi's autocomplete expects them: `value` replaces the
 * entire argument text after `/jev `, so multi-word values carry the leading
 * tokens (e.g. `"set routing.easyMax"`).
 */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

const ACTIONS: CompletionItem[] = [
  { value: 'set', label: 'set', description: 'write a key (add -l for the project file)' },
  { value: 'get', label: 'get', description: 'print the resolved value of a key' },
  { value: 'unset', label: 'unset', description: 'remove a key' },
  { value: 'keys', label: 'keys', description: 'list all keys with types and env overrides' },
  { value: 'path', label: 'path', description: 'print the config file path' },
];

const FLAG_RE = /^(-l|--project)$/;

function filterItems(items: CompletionItem[], prefix: string): CompletionItem[] | null {
  const normalized = prefix.trim().toLowerCase();
  const matches = items.filter((item) => item.value.toLowerCase().startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

function keyItems(action: string): CompletionItem[] {
  return CONFIG_KEYS.map((meta) => ({
    value: `${action} ${meta.path}`,
    label: meta.path,
    description: meta.description,
  }));
}

/** Enum-valued keys offer their options; free-form keys get no value completion. */
const VALUE_OPTIONS: Record<string, { label: string; description: string }[]> = {
  provider: [
    { label: 'openrouter', description: 'OpenRouter Decisions API' },
    { label: 'typesafe', description: 'TypeSafe System One' },
  ],
  disabled: [
    { label: 'true', description: 'bypass all pi-jev hooks' },
    { label: 'false', description: 'enable pi-jev hooks' },
  ],
};

/**
 * Completes the argument text after `/jev `. Flags are position-neutral; the
 * last non-flag token in progress decides what is offered.
 */
export function completeJevArguments(argText: string): CompletionItem[] | null {
  const endsWithSpace = /\s$/.test(argText);
  const tokens = argText.trim().split(/\s+/).filter(Boolean);
  const prior = (endsWithSpace ? tokens : tokens.slice(0, -1)).filter((token) => !FLAG_RE.test(token));
  const partial = endsWithSpace || tokens.length === 0 ? '' : tokens[tokens.length - 1];

  // Completing the action itself.
  if (prior.length === 0 && !endsWithSpace) {
    return filterItems(ACTIONS, partial);
  }
  if (prior.length === 0) return ACTIONS; // space typed, nothing yet: offer the menu

  const action = prior[0];
  const flags = argText.trim().split(/\s+/).some((token) => FLAG_RE.test(token));
  const suffix = flags ? ' -l' : '';

  if (action === 'set' || action === 'get' || action === 'unset') {
    if (prior.length === 1) {
      const items = keyItems(action + suffix);
      return filterItems(items, `${action}${suffix} ${partial}`.trim());
    }
    if (action === 'set' && prior.length === 2) {
      const key = prior[1];
      const options = VALUE_OPTIONS[key] ?? [];
      if (options.length === 0) return null;
      const items = options.map((option) => ({
        value: `set ${key} ${option.label}${suffix}`,
        label: option.label,
        description: option.description,
      }));
      return filterItems(items, `set ${key}${suffix} ${partial}`.trim());
    }
  }
  return null;
}
