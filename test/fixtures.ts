import type { Span } from "../src/spans.ts";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAABbAAAALOCAYAAAB4VzWEAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const tinyPng = PNG_1x1;

let clock = 1_700_000_000_000_000_000;
let counter = 0;

function nextId(): string {
  counter += 1;
  return counter.toString(16).padStart(16, "0");
}

interface SpanInput {
  traceId: string;
  name: string;
  parent?: Span;
  durationMs?: number;
  attributes?: Record<string, string | number>;
  events?: { name: string; attributes: Record<string, string> }[];
  status?: "ok" | "error";
  gapMs?: number;
}

export function span(input: SpanInput): Span {
  clock += (input.gapMs ?? 10) * 1e6;
  const start = clock;
  const end = start + (input.durationMs ?? 100) * 1e6;
  return {
    traceId: input.traceId,
    spanId: nextId(),
    parentSpanId: input.parent?.spanId,
    name: input.name,
    startNano: start,
    endNano: end,
    status: input.status ?? "ok",
    attributes: { "session.id": "conv-1", ...(input.attributes ?? {}) },
    events: (input.events ?? []).map((event) => ({ name: event.name, timeUnixNano: start, attributes: event.attributes })),
  };
}

export function blocks(...items: unknown[]): string {
  return JSON.stringify(items);
}

export function agentSpan(traceId: string, userText: string, extra: Record<string, string | number> = {}): Span {
  return span({
    traceId,
    name: "invoke_agent Strands Agent",
    durationMs: 5000,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "main-agent",
      "gen_ai.request.model": "model-x",
      "gen_ai.agent.tools": JSON.stringify(["search", "fetch"]),
      ...extra,
    },
    events: [{ name: "gen_ai.user.message", attributes: { content: blocks({ text: userText }) } }],
  });
}

export function chatSpan(
  traceId: string,
  parent: Span,
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[],
  choice: string,
  usage: { input: number; output?: number; cacheRead?: number; cacheWrite?: number },
  gapMs?: number,
): Span {
  return span({
    traceId,
    parent,
    name: "chat",
    gapMs,
    durationMs: 1000,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "model-x",
      "gen_ai.usage.input_tokens": usage.input,
      "gen_ai.usage.output_tokens": usage.output ?? 10,
      ...(usage.cacheRead !== undefined ? { "gen_ai.usage.cache_read_input_tokens": usage.cacheRead } : {}),
      ...(usage.cacheWrite !== undefined ? { "gen_ai.usage.cache_write_input_tokens": usage.cacheWrite } : {}),
    },
    events: [
      ...messages.map((message) => ({ name: `gen_ai.${message.role}.message`, attributes: { content: message.content } })),
      { name: "gen_ai.choice", attributes: { message: choice, finish_reason: "endTurn" } },
    ],
  });
}

export function toolSpan(traceId: string, parent: Span, name: string, input: unknown, output: unknown, status: "success" | "error" = "success", callId = `call-${name}`): Span {
  return span({
    traceId,
    parent,
    name: `execute_tool ${name}`,
    status: status === "error" ? "error" : "ok",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "gen_ai.tool.status": status,
      "gen_ai.tool.call.id": callId,
    },
    events: [
      { name: "gen_ai.tool.message", attributes: { content: JSON.stringify(input) } },
      { name: "gen_ai.choice", attributes: { message: blocks({ json: output }) } },
    ],
  });
}
