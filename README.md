# debrief

See exactly what happened in an AI agent chat, and what the model had in front of it at every step.

Paste a chat link and debrief shows each turn on a timeline: what the user asked, every model call and tool run with its start time and duration, what ran in parallel, and the time spent outside any step. For each model call it shows everything the model received, verbatim and in order: system prompt, tools, and every message. Each view ends with the next command to run, so a coding agent can do the reading for you.

debrief reports what the trace recorded. It does not judge, flag or diagnose; that is left to you.

debrief reads [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) traces. If your agent already emits them, there is nothing to install in the agent.

```
$ debrief examples/demo-trace.jsonl
chat demo-trace.jsonl · file · 3 turns · 55.9k in · cache read 34.6k · cache write 21.3k · 380 out

turn 1  09:00    38.7s   5 steps  "Find me the cheapest flight from Stockholm to Lisbon next Friday." · a span ended with an error
        reply: "The cheapest flight I found is TAP F1000 on Friday at 06:05 for €212, direct. Want me to …"
turn 2  09:09    5.63s   3 steps  "Is there nothing cheaper? A friend found one for €149."
        reply: "You're right: Norwegian F1087 departs Friday at 09:40 for €149, direct. I missed it becau…"
turn 3  09:10    4.43s   3 steps  "Yes, book it."
        reply: "Booked: Norwegian F1087 on Friday at 09:40 for €149. Your reference is WYF-7Q2K."

not recorded by the tracer:
  - Tool definitions (gen_ai.tool.definitions) were not recorded; only tool names are known.

next: debrief turn N
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
      │    ├─ step 2  tool    search_flights  failed: timeout
      │    ├─ step 3  model   asked for search_flights
      │    ├─ step 4  tool    search_flights  → 160 flights
      │    └─ step 5  model   said "The cheapest is €212"
      │                 │
      │                 └─ prompt: what the model received for this step, in order
      │                      ├─ system prompt, verbatim and by section
      │                      ├─ tools
      │                      ├─ message items, each numbered and linked to its step
      │                      └─ reported input not covered by recorded content
      ├─ turn 2   "Is there nothing cheaper?"
      └─ turn 3   "Yes, book it."
```

- A **turn** is one user message and everything the agent did to answer it.
- A **step** is one model call or one tool run within a turn, numbered by start time. Steps can overlap; the turn view says which ran at the same time.
- A model step's **prompt** is the input the model saw for that call, with an estimated size for every part.

## Using it

The loop:

```
1. debrief '<chat link>'                  the turns
2. debrief turn N                         the steps in a turn, on a timeline
3. debrief turn N --step S                one step in full
4. debrief turn N --step S --prompt       what the model received, part by part
   ... --prompt --full                    all of it, verbatim
```

Try it on the bundled demo:

```
$ debrief examples/demo-trace.jsonl
$ debrief turn 1
turn 1 of 3 · 09:00:00 · 38.7s · 5 steps · a span ended with an error

user: Find me the cheapest flight from Stockholm to Lisbon next Friday.

step    start     took
  1    +0.01s    2.10s  model      said: "I'll search for flights."  ·  asked for search_flights
  2    +2.12s    30.0s  tool       search_flights  {"from":"ARN","to":"LIS","date":"2026-10-23"}  (failed)
                                   error: upstream timeout (504)
  3    +32.1s    1.50s  model      asked for search_flights
  4    +33.6s    0.90s  tool       search_flights  {"from":"ARN","to":"LIS","date":"2026-10-23"}
                                   → {"results":[{"flight_id":"F1000","airline":"TAP","depart":"2026-10-23T06:05","stops":0,"price_eur":212,"fare_rules":"Ha…
  5    +34.5s    4.20s  model      said: "The cheapest flight I found is TAP F1000 on Friday at 06:05 for €212, direct. Want me to book it?"

next: debrief turn 1 --step N  ·  debrief turn 1 --step 5 --prompt  ·  debrief turn 1 --all

$ debrief turn 1 --step 5 --prompt
turn 1 · step 5 · what the model received, in the order it was sent
reported by the provider: 10.5k in · cache read 1.3k · cache write 9.2k · 70 out
sizes below are estimates (o200k tokenizer)

     95  system prompt, 4 sections
              25  role
              32  tool_policy
              25  booking_rules
              13  style
         tools: 4 names recorded, definitions not recorded
   9.2k  5 message items
              12  1  user message, turn 1
              27  2  model asked for tools  → debrief turn 1 --step 1
              15  3  result of search_flights (error)  → debrief turn 1 --step 2
              22  4  model asked for tools  → debrief turn 1 --step 3
            9.2k  5  result of search_flights  → debrief turn 1 --step 4
   1.2k  reported input tokens not covered by the recorded content

next: debrief turn 1 --step 5 --prompt --full  (all of it, verbatim)  ·  debrief turn 1 --step 5 --prompt --section NAME  ·  debrief turn 1 --step 5 --prompt --message N

$ debrief turn 1 --step 5 --prompt --message 5
{"results":[{"flight_id":"F1000","airline":"TAP","depart":"2026-10-23T06:05","stops":0,"price_eur":212,…

$ debrief find 149
turn 1 step 4  tool search_flights result
    …", "stops": 0, "price_eur": 149, "fare_rules": "Hand luggage only. Changes allowed fo
    → debrief turn 1 --step 4
…
```

### Commands

```
debrief <chat>                       load a chat and summarize it (it stays loaded for later commands)
debrief                              summarize the loaded chat again
debrief turn N                       the steps in turn N on a timeline (start, duration, what ran in parallel)
debrief turn N --all                 every step in turn N, in full
debrief turn N --step S              one step in full
debrief turn N --step S --prompt     what the model received at that step: every part, in order, with sizes
      --full                         all of it, verbatim
      --section NAME                 one system prompt section, verbatim
      --message N                    one message item, verbatim
debrief find TEXT                    steps that mention TEXT
debrief find --errors                failed tool runs and turns with an error status

--chat C    read chat C instead of the loaded one
--json      machine-readable output (every item includes the command to open it)
--full      do not shorten long text (with --prompt: print everything the model received)
--refresh   fetch the chat again instead of using the cache
```

`<chat>` is a link that matches a configured source, `<source>:<id>`, or a trace file. Exit codes: 0 ok, 1 usage or source error, 2 not found.

### Which chat a command reads

Every view names its chat in its first line. A command reads the first of:

1. `--chat <chat>`: this command only. The `next:` commands it prints repeat it, as `--chat <source>:<id>`.
2. `$DEBRIEF_CHAT`: this shell only.
3. The loaded chat: whatever the last `debrief <chat>` loaded, from any shell. It is shared by every process.

Use `--chat` or `$DEBRIEF_CHAT` when several investigations run at the same time, for example parallel agents; otherwise one `debrief <chat>` switches the chat for all of them.

### For coding agents

Give your agent one line:

> Use `debrief --chat '<chat link>'` to investigate. Start with the summary, then follow the `next:` commands it prints.

Every view supports `--json`, and every item in it carries the command that opens it. The prompt view's JSON includes the full text of every section and message item.

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
                                                       │ timeline          │
                                                       │ capture gaps      │
                                                       └───────────────────┘
```

1. **Resolver.** It turns what you pasted into a conversation id using a pattern from your config, for example the last part of a chat URL.
2. **Source.** It fetches every span carrying that id: from CloudWatch Logs Insights over `aws/spans`, or from a file.
3. **Normalizer.** It groups spans by trace into turns, and finds model calls (`gen_ai.operation.name = chat`) and tool runs (`execute_tool`).
   - It reads message content from span events (`gen_ai.user.message`, `gen_ai.choice`, …) or from the newer `gen_ai.input.messages` / `gen_ai.output.messages` attributes.
   - It accepts Bedrock Converse blocks and OTel message parts.
4. **Sizes and timeline.** Every piece of the prompt gets a token estimate.
   - Reported input that the recorded content does not cover is shown as its own line, without guessing what it is.
   - Each step gets its start offset in the turn and the steps it overlaps with. Time in the turn not covered by any step is listed with the other spans (HTTP calls, database calls, …) that started in it.
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
