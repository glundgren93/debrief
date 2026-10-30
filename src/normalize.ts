import { parseOtelMessages, parseParts, textOf } from "./content.ts";
import type { CaptureGap, Context, Conversation, Message, ModelCall, OtherSpan, Part, Role, Section, SpanError, ToolDefinition, ToolExecution, Turn, Usage } from "./model.ts";
import { numberAttr, type Span, stringAttr } from "./spans.ts";

const MESSAGE_EVENT_ROLES: Record<string, Role> = {
  "gen_ai.system.message": "system",
  "gen_ai.user.message": "user",
  "gen_ai.assistant.message": "assistant",
  "gen_ai.tool.message": "tool",
};

function operation(span: Span): string | undefined {
  const explicit = stringAttr(span.attributes, "gen_ai.operation.name");
  if (explicit) return explicit;
  if (span.name.startsWith("invoke_agent")) return "invoke_agent";
  if (span.name.startsWith("execute_tool")) return "execute_tool";
  if (span.name === "chat" || span.name.startsWith("chat ")) return "chat";
  return undefined;
}

function isoTime(nano: number): string {
  return new Date(Math.floor(nano / 1e6)).toISOString();
}

function durationMs(span: Span): number {
  return Math.round((span.endNano - span.startNano) / 1e6);
}

function hasContent(span: Span): boolean {
  return (
    span.events.some((event) => event.name in MESSAGE_EVENT_ROLES || event.name === "gen_ai.choice") ||
    "gen_ai.input.messages" in span.attributes
  );
}

export function splitSections(text: string): Section[] {
  const tagPattern = /^<([A-Za-z][\w-]*)>\s*$[\s\S]*?^<\/\1>\s*$/gm;
  const sections: Section[] = [];
  let cursor = 0;
  for (const match of text.matchAll(tagPattern)) {
    const start = match.index ?? 0;
    const before = text.slice(cursor, start);
    if (before.trim().length > 0) sections.push({ label: "(untagged)", text: before });
    sections.push({ label: `<${match[1]}>`, text: match[0] });
    cursor = start + match[0].length;
  }
  const rest = text.slice(cursor);
  if (rest.trim().length > 0) sections.push({ label: sections.length === 0 ? "prompt" : "(untagged)", text: rest });
  if (sections.some((section) => section.label.startsWith("<"))) return sections;
  const headingPattern = /^#{1,2} .+$/gm;
  const headings = [...text.matchAll(headingPattern)];
  if (headings.length < 2) return [{ label: "prompt", text }];
  const byHeading: Section[] = [];
  const first = headings[0]?.index ?? 0;
  if (text.slice(0, first).trim().length > 0) byHeading.push({ label: "(preamble)", text: text.slice(0, first) });
  headings.forEach((heading, index) => {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? text.length;
    byHeading.push({ label: heading[0].replace(/^#+ /, "").slice(0, 60), text: text.slice(start, end) });
  });
  return byHeading;
}

function systemSections(parts: Part[]): Section[] {
  return parts.flatMap((part, index) => {
    if (part.kind !== "text") return [];
    const sections = splitSections(part.text);
    return parts.length > 1 ? sections.map((section) => ({ ...section, label: `${index}:${section.label}` })) : sections;
  });
}

function usageOf(span: Span): Usage | undefined {
  const a = span.attributes;
  const input = numberAttr(a, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens");
  const output = numberAttr(a, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens");
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = numberAttr(a, "gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cache_read.input_tokens");
  const cacheWrite = numberAttr(
    a,
    "gen_ai.usage.cache_write_input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.cache_creation_input_tokens",
  );
  let inputTokens = input ?? 0;
  if (inputTokens < (cacheRead ?? 0) + (cacheWrite ?? 0)) inputTokens += (cacheRead ?? 0) + (cacheWrite ?? 0);
  return { inputTokens, outputTokens: output ?? 0, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

function toolDefinitions(raw: string | undefined): ToolDefinition[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [];
    return list.map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const spec = (record.toolSpec ?? record.function ?? record) as Record<string, unknown>;
      return {
        name: String(spec.name ?? ""),
        description: String(spec.description ?? ""),
        inputSchema: spec.inputSchema ?? spec.parameters ?? spec.input_schema ?? null,
      };
    });
  } catch {
    return undefined;
  }
}

function toolNames(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function contextOf(span: Span, agent: Span | undefined): { context: Context; output?: Message; finishReason?: string } {
  const system: Part[] = [];
  const messages: Message[] = [];
  let output: Message | undefined;
  let finishReason: string | undefined;

  const instructions = stringAttr(span.attributes, "gen_ai.system_instructions");
  if (instructions) system.push(...parseParts(instructions));
  const inputMessages = stringAttr(span.attributes, "gen_ai.input.messages");
  if (inputMessages) {
    for (const message of parseOtelMessages(inputMessages)) {
      if (message.role === "system") system.push(...message.parts);
      else messages.push(message);
    }
  }
  const outputMessages = stringAttr(span.attributes, "gen_ai.output.messages");
  if (outputMessages) output = parseOtelMessages(outputMessages)[0];

  for (const event of span.events) {
    const role = MESSAGE_EVENT_ROLES[event.name];
    if (role) {
      const parts = parseParts(event.attributes.content ?? event.attributes.message ?? "");
      if (role === "system") system.push(...parts);
      else messages.push({ role, parts });
    } else if (event.name === "gen_ai.choice") {
      output = { role: "assistant", parts: parseParts(event.attributes.message ?? event.attributes.content ?? "") };
      const reason = event.attributes.finish_reason;
      if (typeof reason === "string") finishReason = reason;
    }
  }

  const definitionSource = stringAttr(span.attributes, "gen_ai.tool.definitions") ?? (agent ? stringAttr(agent.attributes, "gen_ai.tool.definitions") : undefined);
  const definitions = toolDefinitions(definitionSource);
  const names = agent ? toolNames(stringAttr(agent.attributes, "gen_ai.agent.tools")) : [];
  return {
    context: {
      systemPrompt: textOf(system.filter((part) => part.kind === "text")),
      system: systemSections(system),
      tools: definitions ?? { notCaptured: true, names },
      messages,
    },
    output,
    finishReason: finishReason ?? stringAttr(span.attributes, "gen_ai.response.finish_reasons"),
  };
}

function findAncestor(span: Span, byId: Map<string, Span>, predicate: (span: Span) => boolean): Span | undefined {
  let current = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
  while (current) {
    if (predicate(current)) return current;
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return undefined;
}

function spanError(span: Span): string | undefined {
  if (span.statusMessage) return span.statusMessage;
  for (const event of span.events) {
    if (!event.name.toLowerCase().includes("exception")) continue;
    const message = stringAttr(event.attributes, "exception.message", "message", "exception.stacktrace");
    if (message) return message.split("\n", 1)[0];
  }
  return undefined;
}

function interruptName(span: Span): string | undefined {
  const message = span.statusMessage;
  if (!message) return undefined;
  const match = message.match(/^Interrupt raised:\s*(.+)$/);
  return match?.[1];
}

function firstResultLine(parts: Part[] | undefined): string | undefined {
  if (!parts || parts.length === 0) return undefined;
  const text = parts.length === 1 && parts[0]?.kind === "data" && typeof parts[0].value === "string" ? parts[0].value.trim() : textOf(parts).trim();
  return text ? text.split("\n", 1)[0] : undefined;
}

function toolExecution(span: Span): ToolExecution {
  const a = span.attributes;
  const toolStatus = stringAttr(a, "gen_ai.tool.status");
  let input: unknown = stringAttr(a, "gen_ai.tool.call.arguments");
  let output: Part[] | undefined;
  const result = stringAttr(a, "gen_ai.tool.call.result");
  if (result) output = parseParts(result);
  for (const event of span.events) {
    if (event.name === "gen_ai.tool.message") input = parseParts(event.attributes.content ?? "")[0];
    if (event.name === "gen_ai.choice") output = parseParts(event.attributes.message ?? event.attributes.content ?? "");
  }
  if (input && typeof input === "object" && "kind" in input && (input as Part).kind === "data") input = (input as unknown as { value: unknown }).value;
  const failed = span.status === "error" || (toolStatus !== undefined && toolStatus !== "success");
  const error = failed ? spanError(span) ?? firstResultLine(output) ?? (toolStatus !== "success" ? toolStatus : undefined) : undefined;
  const status = failed ? "error" : toolStatus === undefined && output === undefined ? "unknown" : "ok";
  return {
    spanId: span.spanId,
    callId: stringAttr(a, "gen_ai.tool.call.id"),
    name: stringAttr(a, "gen_ai.tool.name") ?? span.name.replace(/^execute_tool\s*/, ""),
    startedAt: isoTime(span.startNano),
    durationMs: durationMs(span),
    status,
    input,
    output,
    error,
  };
}

function primaryAgent(agents: Span[]): Span | undefined {
  return [...agents].sort((a, b) => durationMs(b) - durationMs(a))[0];
}

function userInputOf(agent: Span | undefined, calls: ModelCall[]): Part[] {
  if (agent) {
    const event = agent.events.find((item) => item.name === "gen_ai.user.message");
    if (event) return parseParts(event.attributes.content ?? "");
    const input = stringAttr(agent.attributes, "gen_ai.input.messages");
    if (input) {
      const users = parseOtelMessages(input).filter((message) => message.role === "user");
      const last = users[users.length - 1];
      if (last) return last.parts;
    }
  }
  const messages = calls[0]?.context?.messages ?? [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user" && message.parts.some((part) => part.kind === "text"));
  return lastUser?.parts ?? [];
}

function spanLabel(span: Span): string {
  const url = stringAttr(span.attributes, "url.full", "http.url");
  const host = stringAttr(span.attributes, "server.address") ?? (url ? safeHost(url) : undefined);
  return host ? `${span.name} ${host}` : span.name;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function otherSpansOf(spans: Span[], stepSpans: Span[], byId: Map<string, Span>): OtherSpan[] {
  const containers = new Set<string>();
  for (const span of stepSpans) {
    let parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
    while (parent && !containers.has(parent.spanId)) {
      containers.add(parent.spanId);
      parent = parent.parentSpanId ? byId.get(parent.parentSpanId) : undefined;
    }
  }
  return spans
    .filter((span) => operation(span) === undefined && !containers.has(span.spanId))
    .sort((a, b) => a.startNano - b.startNano)
    .map((span) => ({
      spanId: span.spanId,
      name: spanLabel(span),
      startedAt: isoTime(span.startNano),
      durationMs: durationMs(span),
      status: span.status === "error" ? "error" : "ok",
      error: span.status === "error" ? spanError(span) : undefined,
    }));
}

function spanErrors(spans: Span[], calls: ModelCall[], tools: ToolExecution[], byId: Map<string, Span>): SpanError[] {
  const stepBySpanId = new Map<string, number>();
  const toolBySpanId = new Map(tools.map((tool) => [tool.spanId, tool]));
  [...calls, ...tools]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .forEach((step, index) => stepBySpanId.set(step.spanId, index + 1));
  return spans.flatMap((span) => {
    const toolStatus = stringAttr(span.attributes, "gen_ai.tool.status");
    const failed = span.status === "error" || (toolStatus !== undefined && toolStatus !== "success");
    if (!failed || interruptName(span)) return [];
    const step = stepBySpanId.get(span.spanId) ?? findAncestor(span, byId, (candidate) => stepBySpanId.has(candidate.spanId));
    const stepNumber = typeof step === "number" ? step : step ? stepBySpanId.get(step.spanId) : undefined;
    return [{ spanId: span.spanId, name: spanLabel(span), message: toolBySpanId.get(span.spanId)?.error ?? spanError(span), step: stepNumber }];
  });
}

function buildTurn(traceId: string, spans: Span[], index: number): Turn {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const agents = spans.filter((span) => operation(span) === "invoke_agent");
  const chatSpans = spans.filter((span) => operation(span) === "chat");
  const withContent = chatSpans.filter(hasContent);
  const callSpans = [...new Map((withContent.length > 0 ? [...withContent, ...chatSpans.filter((span) => span.status === "error")] : chatSpans).map((span) => [span.spanId, span])).values()].sort(
    (a, b) => a.startNano - b.startNano,
  );

  const calls: ModelCall[] = callSpans.map((span) => {
    const agent = findAncestor(span, byId, (candidate) => operation(candidate) === "invoke_agent");
    const content = hasContent(span) ? contextOf(span, agent) : undefined;
    const ttftSeconds = numberAttr(span.attributes, "gen_ai.server.time_to_first_token");
    return {
      spanId: span.spanId,
      agent: (agent && stringAttr(agent.attributes, "gen_ai.agent.id", "gen_ai.agent.name")) ?? "agent",
      model: stringAttr(span.attributes, "gen_ai.request.model", "gen_ai.response.model") ?? (agent && stringAttr(agent.attributes, "gen_ai.request.model")) ?? "unknown",
      startedAt: isoTime(span.startNano),
      durationMs: durationMs(span),
      status: span.status === "error" ? "error" : "ok",
      error: span.status === "error" ? spanError(span) : undefined,
      timeToFirstTokenMs: ttftSeconds === undefined ? undefined : Math.round(ttftSeconds * 1000),
      usage: usageOf(span),
      context: content?.context,
      output: content?.output,
      finishReason: content?.finishReason,
    };
  });

  const toolSpans = spans.filter((span) => operation(span) === "execute_tool").sort((a, b) => a.startNano - b.startNano);
  const tools = toolSpans.map(toolExecution);

  const start = Math.min(...spans.map((span) => span.startNano));
  const end = Math.max(...spans.map((span) => span.endNano));
  const agent = primaryAgent(agents);
  const interruption = spans.map(interruptName).find((name): name is string => name !== undefined);
  const errors = spanErrors(spans, calls, tools, byId);
  return {
    index,
    traceId,
    startedAt: isoTime(start),
    durationMs: Math.round((end - start) / 1e6),
    status: interruption ? "interrupted" : errors.length > 0 ? "error" : "ok",
    interruption,
    errors,
    userInput: userInputOf(agent, calls),
    calls,
    tools,
    otherSpans: otherSpansOf(spans, [...chatSpans, ...toolSpans], byId),
  };
}

function captureGaps(turns: Turn[]): CaptureGap[] {
  const gaps: CaptureGap[] = [];
  const calls = turns.flatMap((turn) => turn.calls);
  if (calls.length === 0) {
    gaps.push({ what: "No model-call spans (gen_ai.operation.name = chat) found for this conversation." });
    return gaps;
  }
  if (calls.some((call) => !call.context)) {
    gaps.push({
      what: "Some model calls have no message content.",
      howToEnable: "Enable GenAI content capture in your instrumentation (span events or gen_ai.input.messages).",
    });
  }
  if (calls.some((call) => call.context && !Array.isArray(call.context.tools))) {
    gaps.push({
      what: "Tool definitions (gen_ai.tool.definitions) were not recorded; only tool names are known.",
      howToEnable: "Record gen_ai.tool.definitions on the agent or model-call span. Some SDKs need an opt-in, some do not emit it yet.",
    });
  }
  if (calls.some((call) => !call.usage && call.status !== "error")) gaps.push({ what: "Some model calls have no token usage (gen_ai.usage.*)." });
  return gaps;
}

export function buildConversation(id: string, source: string, spans: Span[]): Conversation {
  const byTrace = new Map<string, Span[]>();
  for (const span of spans) {
    const list = byTrace.get(span.traceId) ?? [];
    list.push(span);
    byTrace.set(span.traceId, list);
  }
  const ordered = [...byTrace.entries()].sort(
    ([, a], [, b]) => Math.min(...a.map((span) => span.startNano)) - Math.min(...b.map((span) => span.startNano)),
  );
  const turns = ordered.map(([traceId, traceSpans], index) => buildTurn(traceId, traceSpans, index));
  return { id, source, turns, gaps: captureGaps(turns) };
}
