<div align="center">

# pi-jev

**Selective context compaction and per-turn model routing for [pi](https://github.com/earendil-works/pi-coding-agent), powered by [Jev](https://typesafe.ai).**

**English** · [简体中文](README.zh-CN.md)

<img src="media/banner.svg" alt="Pi events trigger typed Jev requests: keep scores select context, and a difficulty score selects a model" width="100%">

[![checks](https://img.shields.io/github/actions/workflow/status/iefnaf/pi-jev/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/iefnaf/pi-jev/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![Jev](https://img.shields.io/badge/Jev-TypeSafe%20%7C%20OpenRouter-0ea5e9?style=for-the-badge)](https://typesafe.ai)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

pi-jev uses Jev's typed judgments to decide which tool outputs still matter and how demanding a user request is. It retains useful text instead of generating a new compaction summary, and can switch models before each turn. Both features are optional; if Jev is unavailable, pi continues with its normal compaction or the current model.

| Extension | Purpose | Pi integration |
| --- | --- | --- |
| **Compaction** | Remove obsolete tool calls, shorten unneeded results, and retain remaining text verbatim | `session_before_compact` |
| **Routing** | Send easy requests to a cheaper model and hard requests to a stronger model | `before_agent_start` |
| **`/jev` settings** | Configure providers, compaction, and routing from an interactive menu | `/jev` command |

Each extension can be enabled or disabled independently through `pi config`. Configuration changes are read on the next hook, without restarting pi.

## Quick start

You need pi installed and an API key for **one** Jev transport: TypeSafe or OpenRouter. Routing targets also need to be configured and authenticated in pi.

### 1. Configure a Jev API key

Choose one option in the shell where you will launch pi:

```sh
# Option A: TypeSafe
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

```sh
# Option B: OpenRouter
export OPENROUTER_API_KEY="your-openrouter-api-key"
```

The provider is auto-detected when no provider is explicitly configured. If both keys are present, TypeSafe wins; set `JEVC_PROVIDER=openrouter` to select OpenRouter explicitly.

### 2. Install and launch

```sh
pi install https://github.com/iefnaf/pi-jev
pi config   # Review which pi-jev extensions are enabled
pi
```

If you install into an already running pi session, use `/reload` to load the extensions.

### 3. Configure inside pi

```text
/jev
```

Open **Routing**, choose a `cheap` and/or `strong` target from pi's model list, then optionally choose a thinking level. **Routing stays inactive until at least one target is set.** Compaction needs no model-target configuration; it runs with `/compact` or pi's automatic compaction.

| Task | Command or action |
| --- | --- |
| Open settings | `/jev` |
| Compact the current session | `/compact` |
| Inspect available settings | `/jev keys` |
| Read a routing target | `/jev get routing.cheap` |
| Remove a routing target | `/jev unset routing.strong` |
| Temporarily bypass both features | `/jev set disabled true` |
| Re-enable both features | `/jev set disabled false` |
| Write a project setting | Append `-l`, e.g. `/jev set provider openrouter -l` |

Settings writes are **global by default**, including `disabled`; use `-l` for project scope. To bypass both features for one pi process, launch it with `JEVC_DISABLED=1 pi`.

<details>
<summary>Install from a checkout or load a single extension</summary>

```sh
git clone https://github.com/iefnaf/pi-jev.git
cd pi-jev
npm ci
npm run build
pi install /absolute/path/to/pi-jev
```

For a development run from the repository root:

```sh
pi -e ./extensions/compaction.ts
pi -e ./extensions/routing.ts
pi -e ./extensions/jev.ts
```

Each command loads one extension explicitly. The project's `.pi/extensions/jev-*` loaders are also auto-discovered once the repository is trusted.

</details>

## Context compaction

Instead of asking a summarization model to rewrite the conversation, pi-jev asks Jev typed questions about each eligible tool call: whether to keep the call, whether to keep its full result (`noul`), and how stale the result is (`score`). It then renders the retained content as a transcript.

- **Keep:** retain user and assistant text, pinned recent messages, and useful tool calls/results. The previous compaction summary is included as-is.
- **Drop:** remove obsolete tool calls together with their results. The transcript header reports the removal count.
- **Shorten:** retain a tool call but shorten a long result to its first `truncateHeadChars` characters, followed by an explicit truncation marker. Short results may remain unchanged.
- **Rescue:** preserve a borderline result if a confident staleness judgment says it is still needed.
- **Fall back:** let pi generate its normal summary when Jev fails, the request is aborted, the span is empty, or the estimated reduction is below `minReduction`. Missing or malformed per-call answers conservatively retain the affected call.

Requests are batched to fit the configured state and request budgets; a compaction can use multiple Jev requests. Recent-message protection applies to the converted messages within the span pi supplies for compaction.

**Verbatim applies to retained text, not every original message field:** images become `[image]` placeholders and assistant thinking blocks are omitted during conversion. Tool inputs are serialized into the transcript.

### Example result

An example run recorded in this project reduced a converted span from **32 messages / 39,379 characters** to **16 messages / 9,553 characters** in **757 ms**, using one Jev request and 652 output tokens. This is an illustrative result, not a latency or reduction guarantee.

Successful compactions store audit data in the session's `compaction` entry:

```json
{
  "engine": "jev",
  "stats": {
    "messagesBefore": 32,
    "messagesAfter": 16,
    "charsBefore": 39379,
    "charsAfter": 9553,
    "calls": 15,
    "pinned": 3,
    "callsDropped": 12,
    "ms": 757,
    "requests": 1,
    "jevUsage": { "input": 9784, "output": 652 }
  }
}
```

This abbreviated example is the entry's `details` object. Inspect `details.engine`, `details.stats`, and `details.decisions` for the full outcome. The hook preserves `firstKeptEntryId` so pi can retain the rest of the session correctly.

## Model routing

Before a turn, Jev evaluates the **current user prompt** on a three-level difficulty rubric:

| Level | Typical request |
| --- | --- |
| `0` — trivial | Greetings, quick questions, formatting, mechanical single-file edits |
| `1` — moderate | Everyday coding tasks |
| `2` — complex | Multi-file refactors, subtle debugging, architecture decisions |

With the default thresholds:

| Condition | Action |
| --- | --- |
| Difficulty ≤ `0.5`, confidence ≥ `0.6`, and `routing.cheap` is set | Switch to the cheap model |
| Difficulty ≥ `1.5`, confidence ≥ `0.6`, and `routing.strong` is set | Switch to the strong model |
| Middle band, low confidence, missing answer, or unset target | Keep the current model |

**A middle-band request keeps the current model, including a model selected by an earlier turn.** It does not reset to an initial default. Routing uses the prompt rather than the full conversation history.

Invalid model references, unknown models, missing provider authentication, and Jev failures keep the current model. A cheap target that only accepts text is skipped when the prompt includes images. Switching to the model already in use is a no-op. Successful switches and routing errors appear as pi UI notifications.

Targets use `provider/model-id`, with an optional `:thinking` suffix, such as `:high` or `:max`. Use `/jev` to select models actually configured in your pi installation; thinking settings take effect when a model switch occurs.

## Configuration

Settings resolve in this order, highest priority first:

1. Environment variables
2. Project file: `.pi/jev.json`
3. Global file: `~/.pi/agent/jev.json`
4. Built-in defaults

API keys are **environment-only** and are never written to configuration files. Hooks reload configuration on every event, so changes apply to the next turn or compaction. Environment overrides continue to win over settings changed through `/jev`.

### Interactive menu and commands

Bare `/jev` opens the settings menu in interactive pi:

```text
pi-jev
├─ Toggle scope (global ⇄ project)
├─ General        provider · model · baseUrl · disabled
├─ Compaction     thresholds and token budgets
├─ Routing        cheap · strong → model → thinking level
└─ Show resolved config
```

Typed commands support completion for actions, keys, and model references:

```text
/jev set provider openrouter -l
/jev get routing.cheap
/jev unset routing.strong
/jev keys
/jev path -l
```

### Configuration file example

A project `.pi/jev.json` can set the transport and compaction policy:

```json
{
  "provider": "openrouter",
  "disabled": false,
  "compaction": {
    "keepThreshold": 0.5,
    "preserveRecentMessages": 3,
    "minReduction": 0.15
  }
}
```

Add routing targets through `/jev` → **Routing**, or set `routing.cheap` / `routing.strong` to your configured model references. Either target can enable routing independently.

### Shell CLI

From a built checkout, the CLI manages the same settings files:

```sh
node bin/pi-jev.js config
node bin/pi-jev.js config set provider openrouter -l
node bin/pi-jev.js config get routing.cheap
node bin/pi-jev.js config unset routing.strong
node bin/pi-jev.js config keys
node bin/pi-jev.js config path -l
```

If the package's executable is on your `PATH`, use `pi-jev config …` instead. `get` reads the resolved value; `set`, `unset`, and `path` use global scope unless `-l` / `--project` is supplied.

### Jev transports

These are the defaults implemented by this project:

| Setting | TypeSafe | OpenRouter |
| --- | --- | --- |
| Provider | `typesafe` | `openrouter` |
| Endpoint | `https://api.typesafe.ai/v1/systemone` | `https://openrouter.ai/api/alpha/decisions` (alpha) |
| API key | `TYPESAFE_API_KEY` | `OPENROUTER_API_KEY` |
| Jev model | `jev-latest` | `typesafe/jev-1.13` |

Both use the `{ model, state, questions }` → `{ answers }` protocol. The Jev model is separate from the pi models chosen as routing targets.

`JEVC_API_KEY` overrides the selected provider's key. It does not select the provider by itself; pair it with `JEVC_PROVIDER=openrouter` when using an OpenRouter key.

### Environment variables

General:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Unset | TypeSafe authentication |
| `OPENROUTER_API_KEY` | Unset | OpenRouter authentication |
| `JEVC_API_KEY` | Unset | Override the selected provider's API key |
| `JEVC_PROVIDER` | Auto-detected | `typesafe` or `openrouter` |
| `JEVC_MODEL` | Per transport | Jev model slug |
| `JEVC_BASE_URL` | Per transport | Jev endpoint URL |
| `JEVC_DISABLED` | `false` | `1`, `true`, or `yes` bypasses both hooks |

Compaction:

| Variable | Config key | Default |
| --- | --- | --- |
| `JEVC_KEEP_THRESHOLD` | `compaction.keepThreshold` | `0.5` |
| `JEVC_BORDERLINE` | `compaction.borderline` | `0.1` |
| `JEVC_PRESERVE_RECENT` | `compaction.preserveRecentMessages` | `3` |
| `JEVC_TRUNCATE_HEAD` | `compaction.truncateHeadChars` | `300` |
| `JEVC_MIN_REDUCTION` | `compaction.minReduction` | `0.15` |
| `JEVC_MAX_STATE_TOKENS` | `compaction.maxStateTokens` | `25000` |
| `JEVC_MAX_REQUEST_TOKENS` | `compaction.maxRequestTokens` | `30000` |

`keepThreshold` controls verbatim retention, while `borderline` defines the band below it where a staleness answer can rescue a result. `preserveRecentMessages` pins recent converted messages; `truncateHeadChars` limits shortened result heads. `minReduction` is the estimated reduction required to replace pi's summary. The token ceilings bound Jev state and state-plus-questions requests.

Routing:

| Variable | Default | Purpose |
| --- | --- | --- |
| `JEVC_ROUTE_CHEAP` | Unset | Easy-request model reference |
| `JEVC_ROUTE_STRONG` | Unset | Hard-request model reference |
| `JEVC_ROUTE_EASY_MAX` | `0.5` | Maximum difficulty for the cheap target |
| `JEVC_ROUTE_HARD_MIN` | `1.5` | Minimum difficulty for the strong target |
| `JEVC_ROUTE_MIN_CONFIDENCE` | `0.6` | Minimum confidence to switch models |

The routing thresholds are advanced overrides supported by the config loader; they are not exposed in the settings menu or CLI key list.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `/jev` is unavailable | Enable `extensions/jev.ts` through `pi config`, then `/reload` if needed |
| Compaction uses pi's normal summary | Check the selected provider's API key, `disabled`, Jev errors, and `minReduction` |
| Routing never switches models | Set at least one target, verify pi model authentication, and check difficulty/confidence gates |
| A setting change has no effect | Check environment overrides and project settings, which take priority over global settings |
| The checkout CLI cannot find `dist/cli/main.js` | Run `npm run build` |

## Development

Node.js 22 is used in CI. From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Tests use fixtures and fake `JevAsker` implementations and do not call the Jev API. They cover compaction decisions and conversion, routing, configuration precedence, the CLI, completions, model picking, and menu screens.

| Path | Responsibility |
| --- | --- |
| [src/compaction](src/compaction) | Message conversion, Jev batching, retention rules, transcript rendering, and the compaction hook |
| [src/routing](src/routing) | Difficulty decisions and model switching |
| [src/commands](src/commands) | `/jev`, settings menus, completion, and model selection |
| [src/cli](src/cli) | Shared configuration command engine |
| [src/shared/config.ts](src/shared/config.ts) | Configuration layers, defaults, and key metadata |
| [extensions](extensions) | Extension entry points |
| [src/vendor/fast-jev-compaction](src/vendor/fast-jev-compaction) | Vendored Jev client and compaction primitives |
| [test](test) | Offline test suite |

To add a feature, create `src/<feature>/` with a default-export extension factory and pure helper modules, add a thin entry point in `extensions/`, define configuration in `src/shared/config.ts`, and cover the behavior in `test/`. Jev request failures must allow pi to continue.

## Acknowledgments

- [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction): vendored MIT Jev client and compaction primitives; its license is retained alongside the source.
- [@narumitw/pi-tui-kit](https://www.npmjs.com/package/@narumitw/pi-tui-kit): the interactive `/jev` settings menu.
- [TypeSafe](https://typesafe.ai): Jev System One; OpenRouter provides the alternative Decisions API transport.

## License

[MIT](LICENSE).
