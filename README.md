<div align="center">

# pi-jev

**Jev-powered extensions for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Typed System One judgments where an LLM call would be overkill — verbatim context compaction and per-turn model routing, each an independently toggleable extension._

<img src="https://raw.githubusercontent.com/iefnaf/pi-jev/151c1d07cefd549848b85f8cbccf2ce538ed93c9/media/banner.svg" alt="pi events trigger typed Jev requests: keep scores select verbatim context, and a difficulty score selects a model" width="100%">

[![checks](https://img.shields.io/github/actions/workflow/status/iefnaf/pi-jev/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/iefnaf/pi-jev/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![Jev](https://img.shields.io/badge/Jev-TypeSafe%20%7C%20OpenRouter-0ea5e9?style=for-the-badge)](https://typesafe.ai)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

<p align="center">
  ⚡ One Jev request compacted a 32-message span from <strong>39,379</strong> to <strong>9,553</strong> characters in <strong>757 ms</strong> — 652 output tokens, no summarization model involved.
</p>

</div>

---

pi-jev gives Pi two things it otherwise burns a model on: context compaction and model choice. Both are answered by [Jev](https://typesafe.ai) — typed questions with a small, fast, cheap model — and both are optional: every feature fails back to pi's native behavior, and each one can be toggled off on its own.

| Extension | What it does | pi hook | Jev questions |
| --- | --- | --- | --- |
| **compaction** | Replaces LLM-summary compaction with selective retention: stale tool outputs dropped or truncated, everything else verbatim | `session_before_compact` | `noul` keep-call, `noul` keep-result, `score` staleness |
| **routing** | Routes each turn to a cheap or strong model by request difficulty | `before_agent_start` | `score` difficulty (3 levels) + confidence |
| **`/jev`** | Configures the whole suite from inside pi; changes apply without a restart | command | — |

## Why pi-jev?

|     | Capability | What it unlocks |
| :-: | ---------- | --------------- |
| ⚡ | **Cheap judgments** | One Jev request per compaction, one per turn — hundreds of tokens instead of thousands. |
| 🧹 | **Verbatim compaction** | Nothing is rewritten: stale tool calls are dropped or head-truncated (and marked), the rest stays verbatim, in order. |
| 🎯 | **Difficulty routing** | Easy prompts go to a cheap model, hard ones to a strong model, the middle band keeps whatever you are on. |
| 🛡️ | **Fails back, always** | Missing key, Jev error, abort, thin reduction, unknown model, missing auth — pi's native behavior takes over. |
| 🎛️ | **Zero memorization** | Bare `/jev` opens a menu; routing targets are picked from the models already configured in pi, thinking level included. |
| 🧩 | **Toggleable per feature** | One pi package, three extensions, each visible in `pi config` and each with its own config section. |

## How it works

1. A pi hook fires — `session_before_compact` before a summary, `before_agent_start` before a turn.
2. The feature converts the relevant pi messages into one Jev `state` plus typed questions.
3. Jev answers in a single request: keep/drop/truncate probabilities per tool call, or a difficulty score with confidence.
4. The answers become a decision — a verbatim transcript, or a model switch applied to the session.
5. Anything unexpected keeps pi's default behavior, and every decision is written into session history for audit.

A real compaction entry (numbers from an actual run, fields trimmed and decisions abbreviated):

```json
{
  "engine": "jev",
  "stats": {
    "messagesBefore": 32, "messagesAfter": 16,
    "charsBefore": 39379, "charsAfter": 9553,
    "calls": 15, "pinned": 3, "drop_call": 12,
    "ms": 757, "requests": 1,
    "jevUsage": { "input": 9784, "output": 652 }
  },
  "decisions": [
    { "id": "…", "tool": "bash", "action": "drop_call", "keepCall": 0.21, "keepResult": 0.18 },
    { "id": "…", "tool": "write", "action": "keep",      "keepCall": 0.78, "keepResult": 0.81 }
  ]
}
```

## Install

```sh
# TypeSafe directly…
export TYPESAFE_API_KEY=...
# …or through OpenRouter (auto-detected from the key you set)
export OPENROUTER_API_KEY=sk-or-v1-...

pi install https://github.com/iefnaf/pi-jev
pi config                      # toggle extensions/compaction, extensions/routing, extensions/jev-commands
```

<details>
<summary>Other install methods</summary>

From a local checkout:

```sh
npm install && npm run build
pi install /absolute/path/to/pi-jev
```

One development run, no install:

```sh
pi -e ./extensions/routing.ts        # a single extension
```

The project-local loaders under `.pi/extensions/jev-*` are auto-discovered once this repository is trusted, which is how the features are developed here.

</details>

## What you can ask for

| You want | Run |
| -------- | --- |
| See every setting and where its value comes from | `/jev` |
| Send trivial prompts to a cheap model | `/jev` → Routing → `cheap`, or `/jev set routing.cheap deepseek/deepseek-flash` |
| Send hard prompts to a strong model with max reasoning | `/jev` → Routing → `strong` → pick model → pick thinking level |
| Reclaim context in a long session | `/compact` (compaction also runs automatically at pi's threshold) |
| Switch a feature off for one session | toggle it in `pi config`, or start pi with `JEVC_DISABLED=1` |
| Audit what Jev decided | open the session's `compaction` entry: `details.engine`, `details.stats`, `details.decisions` |

## compaction

Jev scores every tool call in the span that pi is about to summarize, then removes what is stale instead of paraphrasing everything:

- **Kept verbatim** — user and assistant text, the newest `preserveRecentMessages` messages, and every call Jev wants kept. The previous compaction summary is embedded as-is.
- **Dropped** — calls and results below the keep threshold disappear as whole entries; the transcript header counts them (`N obsolete tool calls were removed`).
- **Truncated** — borderline results keep their head (`truncateHeadChars`) with an explicit marker, so nothing silently changes meaning.
- **Rescued** — inside the borderline band, a confident low-staleness `score` answer keeps a result that the raw probability would have cut.
- **Aborted** — if the estimated reduction is below `minReduction`, pi's default compaction runs instead. Same for a missing key, a Jev error, or an aborted request.
- **Recorded** — every decision, threshold, and Jev usage number lands in the entry's `details`, and `firstKeptEntryId` is preserved so the transcript stays replayable.

From a real run: 32 messages and 39,379 characters became 16 messages and 9,553 characters — 15 tool calls scored, 3 pinned, 12 dropped, in one 757 ms request.

## routing

Before each turn, Jev rates the request on a three-level rubric and returns a confidence:

| Level | Meaning |
| :-: | --- |
| `0` trivial | Greetings, quick lookups, formatting, mechanical single-file edits |
| `1` moderate | Everyday coding — the home turf of your default model |
| `2` complex | Multi-file refactors, subtle debugging, architecture decisions |

Only the two ends act, and only when Jev is confident:

| Condition | Result |
| --- | --- |
| levels ≤ `0.5` and `routing.cheap` is set | switch to the cheap model |
| levels ≥ `1.5` and `routing.strong` is set | switch to the strong model |
| anything in between, or confidence < 0.6, or no answer | keep the current model |

Safety nets, in order: an unparsable ref, a model that pi does not know, an image prompt heading for a text-only model, a provider without auth, or a Jev failure — each one warns and keeps the current model. The decision re-runs on every user prompt, so it self-corrects, and switching to the model you are already on is a no-op.

Model refs follow pi conventions, with an optional thinking suffix that is applied after the switch:

```sh
/jev set routing.cheap deepseek/deepseek-flash
/jev set routing.strong zhipu/glm-5.3:max          # :max pinned thinking level
```

## Configuration

Values resolve from layered sources, highest first: **environment variables** > **project file** (`.pi/jev.json`) > **global file** (`~/.pi/agent/jev.json`) > defaults. API keys are environment-only and are never written to files.

Inside pi, bare `/jev` opens an interactive settings menu (arrow keys, built on [@narumitw/pi-tui-kit](https://www.npmjs.com/package/@narumitw/pi-tui-kit)):

```
pi-jev
├─ Toggle scope (global ⇄ project)      # which file writes go to
├─ General        provider · model · baseUrl · disabled
├─ Compaction     thresholds and ceilings
├─ Routing        cheap · strong → pick from the models configured in pi
└─ Show resolved config
```

Routing targets are chosen from pi's own model list — the same set `/model` shows — with an optional thinking level, never typed by hand. Typed arguments keep working and autocomplete fully (actions, keys, model refs):

```
/jev set routing.cheap deepseek/deepseek-flash
/jev set provider openrouter -l              # -l targets the project file
/jev get routing.cheap
/jev unset routing.strong
```

Hooks re-read config on every event, so `/jev set` applies to the next turn — no restart. From a checkout, the bundled CLI manages the same files from a shell:

```sh
node bin/pi-jev.js config                    # resolved values + each value's source
node bin/pi-jev.js config set routing.cheap deepseek/deepseek-flash
node bin/pi-jev.js config get routing.cheap
node bin/pi-jev.js config unset routing.strong
node bin/pi-jev.js config keys               # every key, type, and env override
```

### Transports

Both transports speak the same `{ model, state, questions }` → `{ answers }` protocol, so switching is pure configuration:

| | TypeSafe (default) | OpenRouter |
| --- | --- | --- |
| Endpoint | `api.typesafe.ai/v1/systemone` | `openrouter.ai/api/alpha/decisions` (alpha) |
| Key | `TYPESAFE_API_KEY` | `OPENROUTER_API_KEY` |
| Model | `jev-latest` | `typesafe/jev-1.13` |

`JEVC_PROVIDER` (`typesafe` / `openrouter`) overrides auto-detection; `JEVC_API_KEY` is provider-neutral (declare the provider to use it with OpenRouter); `JEVC_MODEL` and `JEVC_BASE_URL` override slug and endpoint on either transport.

### Environment variables

Shared:

| Variable | Default | Description |
| --- | --- | --- |
| `JEVC_API_KEY` / `TYPESAFE_API_KEY` | — | TypeSafe API key (required for all features) |
| `JEVC_PROVIDER` | auto-detected | `typesafe` or `openrouter` |
| `JEVC_MODEL` | per transport | Jev model slug (e.g. `typesafe/jev-1.13` on OpenRouter) |
| `JEVC_BASE_URL` | per transport | Endpoint override |
| `JEVC_DISABLED` | — | `1`/`true` bypasses all hooks |

compaction:

| Variable | Default | Description |
| --- | --- | --- |
| `JEVC_KEEP_THRESHOLD` | `0.5` | Minimum keep probability for a call or result |
| `JEVC_BORDERLINE` | `0.1` | Band under the threshold where a confident low-staleness score rescues a result |
| `JEVC_PRESERVE_RECENT` | `3` | Newest messages in the span never touched |
| `JEVC_TRUNCATE_HEAD` | `300` | Characters kept when a result is truncated |
| `JEVC_MIN_REDUCTION` | `0.15` | Below this estimated reduction, fall back to pi's default compaction |
| `JEVC_MAX_STATE_TOKENS` | `25000` | State ceiling for Jev |
| `JEVC_MAX_REQUEST_TOKENS` | `30000` | State + one question batch ceiling |

routing:

| Variable | Default | Description |
| --- | --- | --- |
| `JEVC_ROUTE_CHEAP` | — | `"provider/model-id"` for easy requests (enables routing) |
| `JEVC_ROUTE_STRONG` | — | `"provider/model-id"` for hard requests (optional) |

The difficulty thresholds and the confidence gate are internal defaults for now — only the two model targets are user-facing.

## Reference

- [src/compaction](src/compaction) — `convert` (messages → Jev state), `decision` (answers → keep/drop), `jev` (client + retries), `summarize` (verbatim transcript), `extension` (the hook).
- [src/routing](src/routing) — `decide` (pure, no side effects) and `extension` (the hook, safety nets, model switch).
- [src/commands](src/commands) — the `/jev` command: menu, completions, model picker, CLI bridge.
- [src/cli](src/cli) — the config CLI engine shared with the slash command.
- [src/shared/config.ts](src/shared/config.ts) — layered resolution, key metadata, defaults.
- [src/vendor/fast-jev-compaction](src/vendor/fast-jev-compaction) — vendored MIT client and decision primitives.
- [test](test) — 89 vitest cases, fully offline through a fake `JevAsker`.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 89 tests, 11 files, no network
npm run build       # tsc -p tsconfig.build.json → dist/ (the bin needs it)
```

The suite covers the decision rules (compaction keep/drop/truncate, routing bands), Jev request and response conversion, the layered config and CLI, argument completions, and the menu screens — all against fixtures, so tests never call Jev.

The invariant every feature keeps: **a Jev failure is never fatal** — the hook returns nothing and pi's own behavior proceeds.

Adding a feature: create `src/<feature>/` with an `extension.ts` default-export factory plus pure modules, a thin re-export in `extensions/<feature>.ts`, its config section in `src/shared/config.ts`, and tests in `test/`.

## Acknowledgments

- [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) — the Jev client and decision primitives in `src/vendor/fast-jev-compaction/` are vendored from it (MIT), with the license kept alongside.
- [@narumitw/pi-tui-kit](https://www.npmjs.com/package/@narumitw/pi-tui-kit) — the same menu framework that powers `pi-statusline` drives the `/jev` editor.
- [TypeSafe](https://typesafe.ai) for Jev System One, and OpenRouter for hosting it behind the alpha Decisions API.

## License

MIT — see [LICENSE](LICENSE).
