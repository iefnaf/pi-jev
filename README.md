# pi-jev

A [pi](https://github.com/earendil-works/pi-mono) extension suite powered by [Jev](https://typesafe.ai): each feature is a small extension that uses Jev's fast, cheap, typed judgments where an LLM call would be overkill. Every feature is optional and fails back to pi's native behavior.

| Extension | What it does | pi hook | Jev questions |
| --- | --- | --- | --- |
| **compaction** | Replaces the LLM-summary compaction with selective retention: stale tool outputs dropped/truncated, everything else verbatim | `session_before_compact` | `noul` keep-call, `noul` keep-result, `score` staleness |
| **routing** | Routes each turn to a cheap or strong model by request difficulty | `before_agent_start` | `score` difficulty (3 levels) + confidence |

Planned: auto-mode safety gate (`tool_call`), prompt-injection screening (`tool_result`), continuous context trimming (`context`).

## Layout

```
pi-jev/                    # one pi package, many extensions
├── extensions/            # pi convention dir: one extension per file
│   ├── compaction.ts        → src/compaction/extension.ts
│   └── routing.ts           → src/routing/extension.ts
├── src/
│   ├── shared/config.ts   # JEVC_* env parsing, shared by all features
│   ├── compaction/        # convert / decision / jev / summarize / extension
│   └── routing/           # decide (pure) / extension (hook)
└── test/                  # vitest, fully offline via a fake JevAsker
```

Why one package with multiple extensions instead of one extension with a feature registry: pi's package model already gives per-extension enable/disable (`pi config`), per-file load isolation, and a single install unit — no need to invent a plugin system inside the plugin.

## Install

```sh
# TypeSafe directly...
export TYPESAFE_API_KEY=...
# ...or through OpenRouter (auto-detected from the key you set)
export OPENROUTER_API_KEY=sk-or-v1-...

pi install https://github.com/iefnaf/pi-jev
pi config                    # toggle extensions/routing, extensions/compaction individually
```

Both transports speak the same `{ model, state, questions }` → `{ answers }` protocol, so switching is purely configuration:

> Note: the Jev client and decision primitives in `src/vendor/fast-jev-compaction/` are vendored from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT).

| | TypeSafe (default) | OpenRouter |
| --- | --- | --- |
| Endpoint | `api.typesafe.ai/v1/systemone` | `openrouter.ai/api/alpha/decisions` (alpha) |
| Key | `TYPESAFE_API_KEY` | `OPENROUTER_API_KEY` |
| Model | `jev-latest` (TypeSafe) | `typesafe/jev-1.13` |

`JEVC_PROVIDER` (`typesafe` / `openrouter`) overrides auto-detection; `JEVC_API_KEY` is provider-neutral (declare `JEVC_PROVIDER=openrouter` to use it with OpenRouter). `JEVC_MODEL` / `JEVC_BASE_URL` override slug and endpoint on either transport.

For local development in this repo the loaders under `.pi/extensions/jev-compaction/` and `.pi/extensions/jev-routing/` are auto-discovered once the project is trusted; or quick-test with `pi -e ./extensions/routing.ts`.

## compaction

Replaces pi's default compaction summary with a Jev-compacted **verbatim transcript**. Nothing is rewritten: Jev scores every tool call in the span; calls and outputs it deems stale are dropped or head-truncated (marked), everything else stays verbatim, in order. A `score` staleness answer with high confidence rescues borderline results. Any failure — missing key, Jev error, abort, or an estimated reduction below `JEVC_MIN_REDUCTION` — falls back to pi's default compaction.

Reads `messagesToSummarize` + `turnPrefixMessages`, keeps `firstKeptEntryId` as-is, prepends the previous compaction summary verbatim, records every decision and Jev usage in the entry's `details`.

## routing

Before each turn, Jev rates the request difficulty (`trivial / moderate / complex`). Confidently easy requests switch to `JEVC_ROUTE_CHEAP`, confidently hard ones to `JEVC_ROUTE_STRONG`; the middle band, low confidence, missing answers, unknown models, or missing auth keep the current model. Prompts with images never downgrade to a text-only model. The decision re-runs on every user prompt, so it self-corrects.

```sh
export JEVC_ROUTE_CHEAP=deepseek/deepseek-flash
export JEVC_ROUTE_STRONG=zai/glm-5.3   # optional
```

## Configuration (environment)

Shared:

| Variable | Default | Description |
| --- | --- | --- |
| `JEVC_API_KEY` / `TYPESAFE_API_KEY` | — | TypeSafe API key (required for all features) |
| `JEVC_MODEL` | `jev-latest` | Jev model name (override per provider, e.g. `typesafe/jev-1.13` on OpenRouter) |
| `JEVC_BASE_URL` | System One endpoint | Endpoint override |
| `JEVC_DISABLED` | — | `1`/`true` bypasses all hooks |

compaction:

| Variable | Default | Description |
| --- | --- | --- |
| `JEVC_KEEP_THRESHOLD` | `0.5` | Minimum keep probability for a call or result |
| `JEVC_BORDERLINE` | `0.1` | Band under the threshold where a confident low-staleness score rescues a result |
| `JEVC_PRESERVE_RECENT` | `3` | Newest messages in the span never touched |
| `JEVC_TRUNCATE_HEAD` | `300` | Characters kept when a result is truncated |
| `JEVC_MIN_REDUCTION` | `0.15` | Below this estimated reduction, fall back to default compaction |
| `JEVC_MAX_STATE_TOKENS` | `25000` | State ceiling for Jev |
| `JEVC_MAX_REQUEST_TOKENS` | `30000` | State + one question batch ceiling |

routing:

| Variable | Default | Description |
| --- | --- | --- |
| `JEVC_ROUTE_CHEAP` | — | `"provider/model-id"` for easy requests (enables routing) |
| `JEVC_ROUTE_STRONG` | — | `"provider/model-id"` for hard requests (optional) |
| `JEVC_ROUTE_EASY_MAX` | `0.5` | Difficulty level (0..2) at or below which the cheap model is used |
| `JEVC_ROUTE_HARD_MIN` | `1.5` | Difficulty level at or above which the strong model is used |
| `JEVC_ROUTE_MIN_CONFIDENCE` | `0.6` | Minimum Jev confidence to act |

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 39 tests, offline via fake JevAsker
```

`fast-jev-compaction` is consumed via `file:../fast-jev-compaction`, which installs a **copy**. After changing it, rebuild it there (`npm run build`) and re-run `npm install` here. Pi types come from `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` devDependencies; those imports are type-only and erased at runtime.

Adding a feature: create `src/<feature>/` with an `extension.ts` default-export factory plus pure modules, a thin re-export in `extensions/<feature>.ts`, its config section in `src/shared/config.ts`, and tests in `test/`. Keep the invariant: Jev failure ⇒ pi native behavior.
