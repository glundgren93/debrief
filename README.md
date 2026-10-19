# debrief

Find out what happened in an AI agent chat that went wrong.

Paste a chat link and debrief shows each turn step by step: what the user asked, what the model said, which tools it called, what came back, and what the model actually had in front of it when it answered. Each view ends with the next command to run, so a coding agent can do the digging for you.

debrief reads [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) traces. If your agent already emits them, there is nothing to install in the agent.

```
$ debrief examples/demo-trace.jsonl
chat demo-trace.jsonl · file · 3 turns · 55.9k tokens in (62% from cache)

✗ turn 1  09:00   38.7s   5 steps  "Find me the cheapest flight from Stockholm to Lisbon next Friday."
         reply: "The cheapest flight I found is TAP F1000 on Friday at 06:05 for €212, direct…"
         ✗ search_flights failed: upstream timeout (504)  → debrief turn 1 --step 2
         ! search_flights returned 9.2k tokens to the model  → debrief turn 1 --step 4
         ! search_flights called again with the same input as an earlier step  → debrief turn 1 --step 4
  turn 2  09:09    5.6s   3 steps  "Is there nothing cheaper? A friend found one for €149."
         reply: "You're right: Norwegian F1087 departs Friday at 09:40 for €149, direct…"
         · none of 10.6k input tokens read from cache (idle 9 min, past the 5 min cache TTL)
  turn 3  09:10    4.4s   3 steps  "Yes, book it."

next: debrief turn 1
```

## Where it fits

```
 your agent                     where traces already live             debrief
┌──────────────┐  OTel spans   ┌──────────────────────────┐  read   ┌────────────────────┐
│ LLM calls    │ ────────────▶ │ CloudWatch, a file, ...  │ ──────▶ │ summary            │
│ tool calls   │               │ (one trace per turn)     │  only   │ turn → steps       │
└──────────────┘               └──────────────────────────┘         │ step → prompt      │
                                                                    └─────────┬──────────┘
                                                                              │
                                                                   you, or a coding agent
```

debrief never writes to your trace store. It fetches one conversation, keeps a local copy for 24 hours, and answers everything from that copy.

## The model: chats, turns, steps

```
chat ─┬─ turn 1   "Find me the cheapest flight…"
      │    ├─ step 1  model   asked for search_flights
      │    ├─ step 2  tool    search_flights  ✗ timeout
      │    ├─ step 3  model   asked for search_flights
      │    ├─ step 4  tool    search_flights  → 160 flights
      │    └─ step 5  model   said "The cheapest is €212"
      │                 │
      │                 └─ prompt: what the model received for this step
      │                      ├─ system prompt, by section
      │                      ├─ conversation so far, each item linked to its step
      │                      └─ not recorded by the tracer (e.g. tool definitions)
      ├─ turn 2   "Is there nothing cheaper?"
      └─ turn 3   "Yes, book it."
```

- A **turn** is one user message and everything the agent did to answer it.
- A **step** is one model call or one tool run within a turn, numbered in time order.
- A model step's **prompt** is the input the model saw for that call, broken down by size.

## Using it

The three-step loop:

```
1. debrief '<chat link>'              what happened, with flags
2. debrief turn N                     the steps in the flagged turn
3. debrief turn N --step S [--prompt] the step that went wrong, and what the model saw
```

Try it on the bundled demo:

```
$ debrief examples/demo-trace.jsonl
$ debrief turn 1
turn 1 of 3 · 09:00:00 · 38.7s · 5 steps

user: Find me the cheapest flight from Stockholm to Lisbon next Friday.

  1  model    2.1s  said: "I'll search for flights."  ·  asked for search_flights
  2  tool    30.0s  search_flights  {"from":"ARN","to":"LIS","date":"2026-10-23"}  ✗ failed
                    error: upstream timeout (504)
  3  model    1.5s  asked for search_flights
  4  tool     0.9s  search_flights  {"from":"ARN","to":"LIS","date":"2026-10-23"}
                    → {"results":[{"flight_id":"F1000","airline":"TAP",…
  5  model    4.2s  said: "The cheapest flight I found is TAP F1000 on Friday at 06:05 for €212…"

next: debrief turn 1 --step N  ·  debrief turn 1 --step 5 --prompt  ·  debrief turn 1 --all

$ debrief turn 1 --step 5 --prompt
turn 1 · step 5 · what the model received · 10.5k tokens (13% from cache)

   9.2k  conversation so far, 5 items. Largest:
             9.2k  result of search_flights  → debrief turn 1 --step 4
               27  model asked for tools  → debrief turn 1 --step 1
               …
   1.2k  not recorded by the tracer (likely the 4 tool definitions)
     95  system prompt, 4 sections. Largest:
               32  tool_policy
               …

$ debrief find 149
turn 1 step 4  tool search_flights result
    …"stops": 0, "price_eur": 149, …
    → debrief turn 1 --step 4
```

The answer is there in three commands. The €149 flight was in the 9.2k-token result at step 4, and the model answered €212 anyway.

### Commands

```
debrief <chat>                       load a chat and summarize it (it stays loaded)
debrief                              summarize the loaded chat again
debrief turn N                       the steps in turn N, in order
debrief turn N --all                 every step in turn N, in full
debrief turn N --step S              one step in full
debrief turn N --step S --prompt     what the model received at that step, biggest parts first
      --section NAME                 print one system prompt section
debrief find TEXT                    steps that mention TEXT
debrief find --errors                steps that failed

--json      machine-readable output (every item includes the command to open it)
--full      do not shorten long text
--refresh   fetch the chat again instead of using the cache
```

`<chat>` is a link that matches a configured source, `<source>:<id>`, or a trace file. Exit codes: 0 ok, 1 usage or source error, 2 not found.

### For coding agents

Give your agent one line:

> Use `debrief '<chat link>'` to investigate. Start with the summary, then follow the `next:` commands it prints.

Every view supports `--json`, and every item in it carries the command that opens it.

## How it works inside

```
 input            resolver           source              normalizer            views
┌────────────┐   ┌──────────────┐   ┌───────────────┐   ┌─────────────────┐   ┌───────────────┐
│ chat link  │──▶│ config regex │──▶│ fetch spans   │──▶│ OTel GenAI spans│──▶│ summary       │
│ source:id  │   │ → chat id    │   │ for that id   │   │ → chat, turns,  │   │ turn, step    │
│ trace file │   │              │   │ (cached 24 h) │   │   steps, prompt │   │ prompt, find  │
└────────────┘   └──────────────┘   └───────────────┘   └────────┬────────┘   └───────────────┘
                                                                 │
                                                       ┌─────────┴─────────┐
                                                       │ token sizes       │
                                                       │ flags             │
                                                       │ capture gaps      │
                                                       └───────────────────┘
```

1. **Resolver.** It turns what you pasted into a conversation id using a pattern from your config, for example the last part of a chat URL.
2. **Source.** It fetches every span carrying that id: from CloudWatch Logs Insights over `aws/spans`, or from a file.
3. **Normalizer.** It groups spans by trace into turns, and finds model calls (`gen_ai.operation.name = chat`) and tool runs (`execute_tool`).
   - It reads message content from span events (`gen_ai.user.message`, `gen_ai.choice`, …) or from the newer `gen_ai.input.messages` / `gen_ai.output.messages` attributes.
   - It accepts Bedrock Converse blocks and OTel message parts.
4. **Sizes and flags.** Every piece of the prompt gets a token estimate.
   - Reported input that captured content does not explain is shown as "not recorded by the tracer".
   - Deterministic rules flag tool errors, results over 8k tokens, duplicate tool calls, images resent across calls, cache misses and slow first tokens.
5. **Views.** They render the same data as text or `--json`, and end with the next command.

Token counts per piece use the o200k tokenizer as an approximation; the per-call totals reported by your provider are exact.

## Setup

```
bun install
bun run build
ln -s "$PWD/dist/debrief" /usr/local/bin/debrief
```

Trace files work without any config. To load chats by link, add a source to `.debrief.yaml` in your project (or any parent directory), `$DEBRIEF_CONFIG`, or `~/.config/debrief/config.yaml`:

```yaml
sources:
  - name: my-app-stage
    type: cloudwatch-spans
    match: "app\\.example\\.com/chat/(?<id>[A-Za-z0-9_-]+)"
    region: eu-west-1
    logGroup: aws/spans
    attribute: session.id
    lookbackDays: 30
    credentialProcess: "aws-vault export --format=json my-profile"
redact:
  - "sk-[A-Za-z0-9]{20,}"
```

- `match` pulls the conversation id out of a link (named group `id`).
- `attribute` is the span attribute that holds that id on every span. `session.id` is the common choice. Set it with OpenTelemetry baggage so it reaches every span.
- Credentials come from `credentialProcess` (any command that prints AWS `credential_process` JSON), else `profile`, else the default AWS chain.

### What your traces need

| For | Your agent must record |
|---|---|
| turns | one trace per user message, plus the conversation id attribute on every span |
| model steps | `chat` spans with message content (span events or `gen_ai.input.messages`) |
| tool steps | `execute_tool` spans with `gen_ai.tool.name`, call id, input and result |
| token sizes | `gen_ai.usage.*` on model spans, including cache read/write if you use caching |
| tool definitions | `gen_ai.tool.definitions` (otherwise they show as "not recorded") |

## Privacy

Traces often contain prompts and user data.

- debrief keeps fetched spans under `~/.cache/debrief`, with files readable only by you, and deletes them after 24 hours.
- JWTs and AWS access keys are redacted before anything is cached or printed. Add your own patterns under `redact`.

## Development

```
bun install
bun test
bun run typecheck
bun src/cli.ts examples/demo-trace.jsonl
bun examples/make-demo-trace.ts     # regenerate the demo trace
```

## Status

Early. Today's sources are CloudWatch spans and trace files. The design leaves room for other sources (Langfuse, Tempo, a local OTLP receiver) and other provider message formats, each as one adapter.

## License

MIT
