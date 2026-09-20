# Compaction eval

Measures Jev's compaction decisions against what agents actually did next in
real pi sessions (`~/.pi/agent/sessions`). Nothing here ships in the npm package
and nothing derived from sessions is committed (`eval/.cache`, `eval/out` are
gitignored).

```
npm run eval:l0                          # free: structure, labels, baselines
npm run eval:l1 -- --limit 91            # calls Jev; every request is cached
npm run eval:l1 -- --limit 91 --offline  # replay from cache, no API
npm run eval:l1 -- --limit 91 --variant both --compare eval/out/<baseline>.json
npm run eval:audit -- sample|judge|score|check ...   # label audit
npm run eval:l2 -- --policies jev,mask,pi            # behaviour replay
npm run eval:vs-pi                                    # against pi's own summary
```

## How a case is built

A session file keeps every entry even after compaction, so the history before
its first real compaction is the raw context the agent saw. `lib/cases.ts`
replays pi's trigger over it (`window - reserveTokens`, cut at a turn end, then
pi's own `prepareCompaction`, loaded from the installed dist so the span is
exactly what `session_before_compact` would receive). Cuts chain the way pi's do
(summary placeholder + kept tail), so spans have realistic sizes.

Each case has the **span** (what Jev sees), pi's kept **tail**, and the
**future** up to the next simulated cut.

## Labels: what the agent did next

No judge model in the pipeline. For each tool call in the span (`lib/labels.ts`):

- **echo**: distinctive strings from the result (paths, identifiers, hex ids)
  that the agent wrote, thought, or passed to a tool *before any newer user
  message or tool output had shown them*, i.e. from memory. Strings already in
  kept material (span text, span call inputs, pi's tail) are excluded. Two or
  more distinct strings, each present in **no other span result**, make the call
  **used**. Strings shared by several results still count toward the
  token-level `recall` (any one copy preserves them) but are not attributed to a
  single call.
- **rerun**: the agent repeats an idempotent read-style call with the same
  arguments and nothing edited the target between. Diagnostic only, not
  evidence of need (see the audit).
- **superseded**: a later call in the span repeats it.

These are lower bounds on need: information used without being repeated
verbatim is invisible. Large results hold more distinctive strings and are
easier to label used, so raw AUCs are confounded by size; use the size-matched
AUC or compare at equal summary size.

## Label audit

`eval/audit.ts` samples calls, writes blinded packets (no label shown), and
scores verdicts against the rule labels: `sample`, then judge into
`eval/out/audit/verdicts.json`, then `score [--relabel]`. `check <id> <string>`
shows where a string occurs (this result, other span results, pi's tail, the
future) to settle provenance.

One audit was run, 25 calls the rules marked used and 25 marked unused (>=200
tokens), judged by Claude, not a human, and Claude also wrote the rules, so
errors may be correlated. Verdicts: **Y** used from memory and unique to that
result; **D** used but duplicated elsewhere in the span or in pi's tail; **R**
re-read anyway, as it would happen without compaction; **N** unused.

| rules said | n | Y | D | R | N |
|---|---|---|---|---|---|
| used, via rerun | 10 | 0 | 2 | 7 | 1 |
| used, via echo only | 15 | 5 | 7 | 0 | 3 |
| not used | 25 | 0 | 6 | 0 | 19 |

Findings: `read` returns hash anchors that `edit` needs, so agents re-read
files they still have in context, and reruns say nothing about loss (0/10 were
needed from memory). Echo was right that the content was used 80% of the time,
but only a third was unique to one result. No unique memory use was missed among
the 25 unused (95% upper bound about 12%). The rules were then changed to what
is described above; on the same 50 verdicts the new "used" set is 5 Y and 2 N of
7. That check is in-sample and needs a fresh sample to count.

## Metrics

| metric | meaning |
|---|---|
| reduction | `1 - summaryTokens / spanTokens` |
| recall | share of echoed result strings still present in the summary (mean over cases that have any) |
| call recall | same for strings from call inputs the agent recalled |
| rerun lost | share of later re-run calls whose result was not kept verbatim (diagnostic) |
| refetch tok | result tokens of used calls that were not kept |
| effective | summary tokens + refetch tokens: what the agent needs in context or must fetch again |
| waste | share of verbatim-kept result tokens that nothing later used |
| AUC | how well a score orders used above unused calls, independent of any threshold |

Baselines (`lib/policies.ts`) are sized to the same summary tokens as the Jev
outcome they are compared with: `recent`, `small-first`, `random`, plus
`large-first` as a size-bias diagnostic and `oracle` (keeps exactly the used
calls) as an upper bound. Intervals are 95% bootstrap over cases.

## L2: behaviour replay on real losses

`eval/l2.ts` takes the calls where compaction really lost something: a result
the agent later used from memory (unique strings, see the audit) that Jev did
not keep. At the first moment the agent used it, the context is rebuilt and a
model takes one step, with pi's summary wrapper and the tail as in production:

- `full`: the uncompacted history (control),
- `jev`: what the extension leaves, at the configured `keepThreshold`,
- `random`: a summary of the same size that keeps random results.

Each step is classified: **refetch** (a tool call for the dropped content,
matched on strings unique to that call's input), **same** (reproduces the
strings), **other tool**, **text only**, **no output**, plus a count of names
found nowhere in the history. The automatic classes are coarse, so the
`jev` steps that were not refetches were read by hand and labelled **R**
(recovers by looking it up another way), **O** (the step did not need it),
**S** (stalled, no output), **B** (proceeds blind on guessed content).

`--threshold` sets Jev's keep threshold for the run (the default 0.5 keeps
nothing, so Jev and `random` are nearly the same condition there). Each policy
is replayed only on the calls it lost; `--control` also replays the policy that
kept the result when the other lost it, to see what the model does with the
content in hand. Before any model call the run prints how many of the
used-from-memory calls each policy kept at equal summary size, which costs
nothing and does not depend on the replay model.

Session content is sent to a model provider through OpenRouter, credentials are
redacted on a best-effort basis, and only providers that do not retain prompts
are allowed. A `--budget` cap refuses calls that would exceed it. Responses are
cached, so re-scoring is free.

Two harness bugs are worth remembering. Matching a repeat call on strings from
its input counted any command in the same worktree as a repeat, because of the
shared `cd <worktree>` prefix; only strings unique to the call are used now.
And a small `max_tokens` made a reasoning model spend everything on thinking
and emit nothing, which looked like a behaviour when it was a truncation.

## Experiment: telling Jev more

Production sends Jev the span's messages and tool calls, but for results only
"ok, N chars (omitted)", and nothing from the tail pi keeps. `--variant heads`,
`recent` or `both` (`lib/enrich.ts`) adds how each result begins (up to 300
chars, fewer when the span has hundreds of calls, about 5k tokens in all) and/or
the newest six kept messages, with the goal taken from the newest user prompts.
The base history is fitted to a smaller budget by the amount added, so requests
stay near the same size. `--compare` pairs the ranking results with an earlier
run on the same cases.

With `both`, 91 cases: size-matched AUC 0.510 against 0.507 (paired change
+0.003, 95% interval -0.07 to +0.07), all-pairs AUC 0.557 against 0.548, and the
distribution of Jev's keep probabilities is nearly unchanged (still none above
0.5). At equal summary size Jev still keeps no more of what the agent later used
than random does. A gain larger than about 0.07 AUC is ruled out on this
sample; a small one is not. Only the state was changed, not the questions or the
note that tells Jev an output can always be re-read.

## Against pi's own LLM summary

`eval/vs-pi.ts` compares, on the cases that have a call used from memory (32
here), the extension at `keepThreshold` 0.5 (`jev@0.5`), a plain rule (`mask`:
keep every message and call, cut the output of reproducible tools to its head,
keep other tools whole; no model call), pi's `compact()` summary (its real
prompts, redacted, routed to providers that do not retain data), and random
results kept at the pi summary's size. A used call counts as preserved when at
least half of the strings only its result held appear in the compacted text.
`l2.ts --policies jev,mask,pi` replays the same 61 events for each.

| | summary tokens | reduction | used calls preserved | call records recalled |
|---|---|---|---|---|
| jev@0.5 | 9.4k | 88% | 4/60 | 28% |
| mask | 26.5k | 69% | 16/60 | 68% |
| pi summary | 3.2k | 96% | 4/60 | 42% |
| random | 8.8k | 89% | 4/60 | 27% |

The replayed step is nearly the same for all three (re-fetch 15-18%, another
tool 75-78%, prompt 42k for pi, 46k for jev, 62k for mask); the only text-only
answers were two events from one context, under pi's summary, and read as an
informed design opinion, not guessed names. The string measure undervalues a
prose summary, which can keep the meaning without the exact strings. Costs per
compaction: mask nothing, jev one to a few requests of about 2 s, pi one LLM
call over the whole span (about $0.015 with a flash model, on the order of a
minute here). One of 33 pi summaries failed on a provider stream error.

## Known limits

- Rendering truncates call arguments at 160 chars, so even keeping everything
  loses about 9% of the call-level strings the agent later recalled.
- About half the cases have no echoed result content, so recall rests on the
  rest, and only 61 calls in 91 cases at 128k are marked used, so intervals are
  wide (the size-matched AUC rests on 29 cases).
- Chained cuts use a fixed-size summary placeholder, and one window (128k by
  default, `--window`) is scored at a time. Real compactions happen at
  ~160–230k tokens; 128k keeps enough cases.
- L2 replays one step per event with a different model than the one that ran
  the session, so it shows what a model does at that point, not what the
  original agent would have done, and it does not follow the session onward.
