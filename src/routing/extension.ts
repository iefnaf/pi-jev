import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { JevClient, type JevAsker } from '../vendor/fast-jev-compaction/index.js';
import { loadConfig, type RoutingConfig } from '../shared/config.js';
import { decideRouting, DIFFICULTY_LEVELS, ROUTING_CONTEXT, routingQuestions, type RoutingDecision } from './decide.js';

/** Asks Jev to rate the request difficulty and maps it to a routing target. */
export async function runRouting(
  prompt: string,
  asker: JevAsker,
  config: RoutingConfig,
): Promise<RoutingDecision> {
  const response = await asker.ask({ context: ROUTING_CONTEXT, prompt }, routingQuestions());
  return decideRouting(response.answers, config);
}

/**
 * Parses a `"provider/model-id"` reference, optionally with a `:thinking`
 * suffix (pi style, e.g. `deepseek/deepseek-flash:high`).
 */
export function parseModelRef(ref: string): { provider: string; id: string; thinking?: string } | undefined {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  const rest = ref.slice(slash + 1);
  const colon = rest.lastIndexOf(':');
  if (colon > 0) {
    const thinking = rest.slice(colon + 1);
    if (thinking) return { provider: ref.slice(0, slash), id: rest.slice(0, colon), thinking };
  }
  return { provider: ref.slice(0, slash), id: rest };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The routing extension: before each agent turn, Jev rates the request
 * difficulty; confidently easy requests switch to `JEVC_ROUTE_CHEAP`,
 * confidently hard ones to `JEVC_ROUTE_STRONG`. Every other outcome (middle
 * band, low confidence, Jev failure, model not found, auth missing) keeps the
 * current model. Prompts with images never downgrade to a text-only model.
 */
export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event, ctx) => {
    // Loaded per turn so `/jev set` applies without a restart.
    const config = loadConfig();
    const routing = config.routing;
    if (config.disabled || !config.apiKey) return;
    if (!routing.cheap && !routing.strong) return;
    if (!event.prompt.trim()) return;

    try {
      const decision = await runRouting(
        event.prompt,
        new JevClient({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl }),
        routing,
      );
      if (!decision.target) return;

      const ref = parseModelRef(decision.target === 'cheap' ? routing.cheap! : routing.strong!);
      if (!ref) {
        ctx.ui.notify(`jev-routing: invalid JEVC_ROUTE_${decision.target.toUpperCase()} reference`, 'warning');
        return;
      }
      const model = ctx.modelRegistry.find(ref.provider, ref.id);
      if (!model) {
        ctx.ui.notify(`jev-routing: ${ref.provider}/${ref.id} not found; keeping current model`, 'warning');
        return;
      }
      if (ctx.model && ctx.model.id === model.id && ctx.model.provider === model.provider) return;
      if (decision.target === 'cheap' && (event.images?.length ?? 0) > 0 && !model.input.includes('image')) {
        return; // never route an image prompt to a text-only model
      }

      const switched = await pi.setModel(model);
      if (!switched) {
        ctx.ui.notify(`jev-routing: auth not configured for ${ref.provider}/${ref.id}; keeping current model`, 'warning');
        return;
      }
      if (ref.thinking) {
        pi.setThinkingLevel(ref.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
      }
      ctx.ui.notify(
        `jev-routing: ${decision.reason} request (difficulty ${decision.levels.toFixed(1)}/${DIFFICULTY_LEVELS.length - 1}, ` +
          `confidence ${(decision.confidence * 100).toFixed(0)}%) → ${ref.provider}/${ref.id}`,
        'info',
      );
    } catch (error) {
      ctx.ui.notify(`jev-routing failed (${errorMessage(error)}); keeping current model`, 'error');
    }
  });
}
