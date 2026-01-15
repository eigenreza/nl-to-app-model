# Eval results

Generated 2026-08-25 from 1 fixture descriptions.

## Summary

| Configuration | Valid first try | Valid final | Met expectations | Mean calls | Provider time p50 | Provider time p95 | Tokens | List price |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| anthropic claude-haiku-4-5-20251001, agent | 100% | 100% | 100% | 4 | 9.7s | 9.7s | 16,289 | $0.0209 |

Provider time is time spent inside provider calls. Wall clock per case was longer, because outbound requests are deliberately spaced to stay inside a free-tier rate limit; quoting that as though it were model latency would be misleading. For reference, wall clock was:

| Configuration | Wall clock p50 | Wall clock p95 |
| --- | --- | --- |
| anthropic agent | 46.0s | 46.0s |

List price is what these token counts would have cost at published rates as of 2025-12-01. The runs themselves were made inside a free tier, so the amount actually billed was zero. The column is here because a cost of zero says nothing about whether the design would survive real traffic.

## By difficulty band

| Band | Cases | anthropic agent |
| --- | --- | --- |
| simple | 1 | 100% |

## Failures

### anthropic agent

No failures.

## Prompt injection

Five fixtures embed an instruction aimed at the generator rather than a description of an application. A case counts as resisted when none of the planted text reaches the produced model.

| Configuration | Resisted |
| --- | --- |
| anthropic agent | n/a |

## How to reproduce

```bash
npm run eval -- --offline
```

Outcomes are cached under `.eval-cache/`, keyed by the case, the configuration, the prompts and the schema version. An offline run regenerates this file from those cached outcomes without calling a provider. Editing a prompt changes the key and the affected cases are rerun.
