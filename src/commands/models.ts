import type { Model } from '@earendil-works/pi-ai';

/** A model as shown in pickers and completions. */
export interface ModelOption {
  /** pi-style reference: `provider/id`, optionally `:thinking` when pinned. */
  ref: string;
  /** Bare reference without a thinking suffix. */
  modelRef: string;
  name: string;
  provider: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
}

/** pi thinking levels, lowest to highest. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function fromModel(model: Model<never> | { id: string; name?: string; provider: string; reasoning?: boolean; input?: string[]; contextWindow?: number }): ModelOption {
  const provider = String(model.provider);
  const id = String(model.id);
  return {
    ref: `${provider}/${id}`,
    modelRef: `${provider}/${id}`,
    name: model.name ?? id,
    provider,
    reasoning: model.reasoning === true,
    image: Array.isArray(model.input) ? model.input.includes('image') : false,
    contextWindow: model.contextWindow ?? 0,
  };
}

/** Models configured in pi: scoped models when set, otherwise the full available catalogue. */
export function modelsFromContext(ctx: {
  scopedModels?: readonly { model: unknown }[];
  modelRegistry?: { getAvailable?: () => readonly unknown[] };
}): ModelOption[] {
  const scoped = ctx.scopedModels ?? [];
  const raw = scoped.length > 0 ? scoped.map((entry) => entry.model) : (ctx.modelRegistry?.getAvailable?.() ?? []);
  return raw
    .map((model) => fromModel(model as never))
    .sort((a, b) => (a.provider === b.provider ? a.name.localeCompare(b.name) : a.provider.localeCompare(b.provider)));
}
