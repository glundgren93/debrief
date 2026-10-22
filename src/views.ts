import { textOf } from "./content.ts";
import type { Conversation, OtherSpan, Part, Usage } from "./model.ts";
import { promptBreakdown, type Step, type StepIndex, type StepRef, timelineGaps } from "./steps.ts";
import { countText } from "./tokens.ts";

export const BIN = "debrief";

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function offset(ms: number): string {
  return `+${seconds(ms)}`;
}

function oneLine(value: unknown, length: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function indent(text: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export interface TextLimit {
  maxChars?: number;
}

function clip(text: string, limit: TextLimit): { text: string; truncated: boolean } {
  if (limit.maxChars === undefined || text.length <= limit.maxChars) return { text, truncated: false };
  return { text: text.slice(0, limit.maxChars), truncated: true };
}

export const commands = {
  summary: () => BIN,
  turn: (turn: number) => `${BIN} turn ${turn}`,
  all: (turn: number) => `${BIN} turn ${turn} --all`,
  step: (ref: StepRef) => `${BIN} turn ${ref.turn} --step ${ref.step}`,
  prompt: (ref: StepRef) => `${BIN} turn ${ref.turn} --step ${ref.step} --prompt`,
  fullPrompt: (ref: StepRef) => `${BIN} turn ${ref.turn} --step ${ref.step} --prompt --full`,
  section: (ref: StepRef, name: string) => `${BIN} turn ${ref.turn} --step ${ref.step} --prompt --section ${name}`,
  message: (ref: StepRef, number: number | string) => `${BIN} turn ${ref.turn} --step ${ref.step} --prompt --message ${number}`,
};

function usageLine(usage: Usage | undefined): string {
  if (!usage) return "no token usage recorded";
  const cache = [
    usage.cacheReadTokens !== undefined ? `cache read ${formatTokens(usage.cacheReadTokens)}` : "",
    usage.cacheWriteTokens !== undefined ? `cache write ${formatTokens(usage.cacheWriteTokens)}` : "",
  ].filter(Boolean);
  return [`${formatTokens(usage.inputTokens)} in`, ...cache, `${formatTokens(usage.outputTokens)} out`].join(" · ");
}

function alongsideText(alongside: number[]): string {
  if (alongside.length === 0) return "";
  return `at the same time as step${alongside.length === 1 ? "" : "s"} ${alongside.join(", ")}`;
}

function hasSeveralAgents(conversation: Conversation): boolean {
  return new Set(conversation.turns.flatMap((turn) => turn.calls.map((call) => call.agent))).size > 1;
}

function resultValue(parts: Part[] | undefined): unknown {
  const values = (parts ?? []).map((part) => (part.kind === "data" ? part.value : textOf([part])));
  return values.length === 1 ? values[0] : values;
}

function resultText(parts: Part[] | undefined): string {
  return parts ? pretty(resultValue(parts)) : "";
}

function toolCalls(step: Extract<Step, { kind: "model" }>) {
  return (step.call.output?.parts ?? []).filter((part): part is Extract<Part, { kind: "tool_call" }> => part.kind === "tool_call");
}

function said(step: Extract<Step, { kind: "model" }>): string {
  return textOf((step.call.output?.parts ?? []).filter((part) => part.kind === "text")).trim();
}

function askedFor(step: Extract<Step, { kind: "model" }>): string {
  const counts = new Map<string, number>();
  for (const call of toolCalls(step)) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
}

function lastReply(steps: Step[]): string {
  for (const step of [...steps].reverse()) if (step.kind === "model" && said(step)) return said(step);
  return "";
}

function sumUsage(conversation: Conversation): Usage {
  const usages = conversation.turns.flatMap((turn) => turn.calls).flatMap((call) => (call.usage ? [call.usage] : []));
  const total = (pick: (usage: Usage) => number | undefined) =>
    usages.some((usage) => pick(usage) !== undefined) ? usages.reduce((sum, usage) => sum + (pick(usage) ?? 0), 0) : undefined;
  return {
    inputTokens: total((usage) => usage.inputTokens) ?? 0,
    outputTokens: total((usage) => usage.outputTokens) ?? 0,
    cacheReadTokens: total((usage) => usage.cacheReadTokens),
    cacheWriteTokens: total((usage) => usage.cacheWriteTokens),
  };
}

export function summaryData(conversation: Conversation, index: StepIndex) {
  return {
    chat: conversation.id,
    source: conversation.source,
    usage: sumUsage(conversation),
    turns: conversation.turns.map((turn) => {
      const steps = index.steps(turn.index + 1);
      return {
        turn: turn.index + 1,
        startedAt: turn.startedAt,
        durationMs: turn.durationMs,
        status: turn.status,
        steps: steps.length,
        user: textOf(turn.userInput),
        reply: lastReply(steps),
        open: commands.turn(turn.index + 1),
      };
    }),
    notRecorded: conversation.gaps,
  };
}

export function renderSummary(data: ReturnType<typeof summaryData>): string {
  const lines = [`chat ${data.chat} · ${data.source} · ${plural(data.turns.length, "turn")} · ${usageLine(data.usage)}`, ""];
  for (const turn of data.turns) {
    const status = turn.status === "error" ? " · a span ended with an error" : "";
    lines.push(`turn ${turn.turn}  ${turn.startedAt.slice(11, 16)}  ${seconds(turn.durationMs).padStart(7)}  ${plural(turn.steps, "step").padStart(8)}  "${oneLine(turn.user, 70)}"${status}`);
    if (turn.reply) lines.push(`        reply: "${oneLine(turn.reply, 90)}"`);
  }
  if (data.notRecorded.length > 0) {
    lines.push("", "not recorded by the tracer:");
    for (const gap of data.notRecorded) lines.push(`  - ${gap.what}`);
  }
  const next = data.turns.length === 1 ? commands.turn(1) : data.turns.length > 1 ? `${BIN} turn N` : commands.summary();
  lines.push("", `next: ${next}`);
  return lines.join("\n");
}

function stepHeadline(step: Step, showAgent: boolean): { kind: string; text: string; detail?: string } {
  if (step.kind === "tool") {
    const status = step.tool.status === "error" ? "  (failed)" : "";
    return {
      kind: "tool",
      text: `${step.tool.name}  ${oneLine(step.tool.input ?? "", 110)}${status}`,
      detail: step.tool.error ? `error: ${oneLine(step.tool.error, 120)}` : `→ ${oneLine(resultValue(step.tool.output), 120)}`,
    };
  }
  const agent = showAgent ? ` (${step.call.agent})` : "";
  const text = said(step);
  const asked = askedFor(step);
  const bits = [text ? `said: "${oneLine(text, 100)}"` : "", asked ? `asked for ${asked}` : ""].filter(Boolean);
  return { kind: `model${agent}`, text: bits.join("  ·  ") || "(output not recorded)" };
}

function spanCounts(spans: OtherSpan[]): string {
  const counts = new Map<string, number>();
  for (const span of spans) counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, 3).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  return `${shown.join(", ")}${ranked.length > 3 ? ", …" : ""}`;
}

export function turnData(conversation: Conversation, index: StepIndex, turnNumber: number) {
  const turn = conversation.turns[turnNumber - 1];
  if (!turn) throw new Error(`turn ${turnNumber} missing`);
  const showAgent = hasSeveralAgents(conversation);
  const steps = index.steps(turnNumber);
  const turnStart = Date.parse(turn.startedAt);
  return {
    turn: turnNumber,
    of: conversation.turns.length,
    startedAt: turn.startedAt,
    durationMs: turn.durationMs,
    status: turn.status,
    user: textOf(turn.userInput),
    steps: steps.map((step) => {
      const headline = stepHeadline(step, showAgent);
      return {
        step: step.number,
        kind: headline.kind,
        offsetMs: step.offsetMs,
        durationMs: step.durationMs,
        alongside: step.alongside,
        summary: headline.text,
        detail: headline.detail,
        status: step.kind === "tool" ? step.tool.status : "ok",
        open: commands.step({ turn: turnNumber, step: step.number }),
        prompt: step.kind === "model" && step.call.context ? commands.prompt({ turn: turnNumber, step: step.number }) : undefined,
      };
    }),
    withoutSteps: timelineGaps(turn, steps).map((gap) => ({
      offsetMs: gap.offsetMs,
      durationMs: gap.durationMs,
      otherSpans: gap.otherSpans.map((span) => ({ ...span, offsetMs: Date.parse(span.startedAt) - turnStart })),
    })),
  };
}

export function renderTurn(data: ReturnType<typeof turnData>): string {
  const status = data.status === "error" ? " · a span ended with an error" : "";
  const lines = [`turn ${data.turn} of ${data.of} · ${data.startedAt.slice(11, 19)} · ${seconds(data.durationMs)} · ${plural(data.steps.length, "step")}${status}`, "", `user: ${data.user}`, ""];
  const kindWidth = Math.max(9, ...data.steps.map((step) => step.kind.length));
  const detailPad = " ".repeat(3 + 2 + 8 + 2 + 7 + 2 + kindWidth + 2);
  const rows = [
    ...data.steps.map((step) => ({ offsetMs: step.offsetMs, order: 1, lines: stepRows(step) })),
    ...data.withoutSteps.map((gap) => ({
      offsetMs: gap.offsetMs,
      order: 0,
      lines: [
        `${"".padStart(3)}  ${offset(gap.offsetMs).padStart(8)}  ${seconds(gap.durationMs).padStart(7)}  ${"(no step)".padEnd(kindWidth)}  ${
          gap.otherSpans.length > 0 ? `${plural(gap.otherSpans.length, "other span")} start here: ${spanCounts(gap.otherSpans)}` : "no spans start here"
        }`,
      ],
    })),
  ].sort((a, b) => a.offsetMs - b.offsetMs || a.order - b.order);
  function stepRows(step: (typeof data.steps)[number]): string[] {
    const out = [`${String(step.step).padStart(3)}  ${offset(step.offsetMs).padStart(8)}  ${seconds(step.durationMs).padStart(7)}  ${step.kind.padEnd(kindWidth)}  ${step.summary}`];
    if (step.detail) out.push(`${detailPad}${step.detail}`);
    const alongside = alongsideText(step.alongside);
    if (alongside) out.push(`${detailPad}${alongside}`);
    return out;
  }
  lines.push(`${"step".padStart(4)} ${"start".padStart(8)}  ${"took".padStart(7)}`);
  for (const row of rows) lines.push(...row.lines);
  const lastModel = [...data.steps].reverse().find((step) => step.prompt);
  const hints = [`${BIN} turn ${data.turn} --step N`, lastModel?.prompt, commands.all(data.turn)].filter(Boolean);
  lines.push("", `next: ${hints.join("  ·  ")}`);
  return lines.join("\n");
}

export function stepData(conversation: Conversation, index: StepIndex, step: Step) {
  const ref = { turn: step.turn, step: step.number };
  const total = index.steps(step.turn).length;
  const timing = { offsetMs: step.offsetMs, durationMs: step.durationMs, alongside: step.alongside };
  if (step.kind === "tool") {
    const result = resultText(step.tool.output);
    const requester = step.tool.callId ? index.requestingStep(step.tool.callId) : undefined;
    return {
      kind: "tool" as const,
      turn: step.turn,
      step: step.number,
      of: total,
      tool: step.tool.name,
      ...timing,
      status: step.tool.status,
      input: step.tool.input,
      result,
      resultTokens: step.tool.output ? countText(textOf(step.tool.output)) : 0,
      error: step.tool.error,
      askedBy: requester ? commands.step({ turn: requester.turn, step: requester.number }) : undefined,
      open: commands.step(ref),
    };
  }
  return {
    kind: "model" as const,
    turn: step.turn,
    step: step.number,
    of: total,
    agent: step.call.agent,
    model: step.call.model,
    ...timing,
    usage: step.call.usage,
    finishReason: step.call.finishReason,
    said: said(step),
    reasoning: textOf((step.call.output?.parts ?? []).filter((part) => part.kind === "reasoning")).trim(),
    askedFor: toolCalls(step).map((call) => {
      const tool = index.toolStep(call.id);
      return { tool: call.name, input: call.input, open: tool ? commands.step({ turn: tool.turn, step: tool.number }) : undefined };
    }),
    prompt: step.call.context ? commands.prompt(ref) : undefined,
    open: commands.step(ref),
  };
}

function block(title: string, text: string, limit: TextLimit, more: string): string[] {
  const { text: shown, truncated } = clip(text, limit);
  const lines = [title, indent(shown)];
  if (truncated) lines.push(`  … shortened: ${more} --full`);
  return lines;
}

function timingLine(data: { offsetMs: number; durationMs: number; alongside: number[] }): string {
  return [`started ${offset(data.offsetMs)} into the turn`, `took ${seconds(data.durationMs)}`, alongsideText(data.alongside)].filter(Boolean).join(" · ");
}

export function renderStep(data: ReturnType<typeof stepData>, limit: TextLimit): string {
  const lines: string[] = [];
  if (data.kind === "tool") {
    lines.push(`turn ${data.turn} · step ${data.step} of ${data.of} · tool ${data.tool} · ${data.status === "error" ? "failed" : "ok"}`, timingLine(data), "");
    lines.push(...block("input", pretty(data.input ?? ""), limit, data.open), "");
    lines.push(...block(`result (~${formatTokens(data.resultTokens)} tokens)`, data.result || "(not recorded)", limit, data.open));
    if (data.error) lines.push("", "error", indent(data.error));
    if (data.askedBy) lines.push("", `next: ${data.askedBy}  (the model step that asked for this)`);
    return lines.join("\n");
  }
  lines.push(
    `turn ${data.turn} · step ${data.step} of ${data.of} · model ${data.agent} · ${data.model}`,
    timingLine(data),
    `${usageLine(data.usage)}${data.finishReason ? ` · finished: ${data.finishReason}` : ""}`,
  );
  if (data.reasoning) lines.push("", ...block("thought", data.reasoning, limit, data.open));
  if (data.said) lines.push("", ...block("said", data.said, limit, data.open));
  if (data.askedFor.length > 0) {
    lines.push("", "asked for");
    for (const call of data.askedFor) lines.push(`  ${call.tool}  ${oneLine(call.input, 160)}${call.open ? `  → ${call.open}` : ""}`);
  }
  if (!data.said && data.askedFor.length === 0) lines.push("", "(output not recorded)");
  if (data.prompt) lines.push("", `next: ${data.prompt}  (what the model received)`);
  return lines.join("\n");
}

export function promptData(index: StepIndex, step: Extract<Step, { kind: "model" }>) {
  const breakdown = promptBreakdown(step.call, index);
  if (!breakdown) return undefined;
  const ref = { turn: step.turn, step: step.number };
  return {
    turn: step.turn,
    step: step.number,
    usage: step.call.usage,
    unrecordedTokens: breakdown.unrecordedTokens,
    system: {
      tokens: breakdown.sections.reduce((sum, section) => sum + section.tokens, 0),
      text: breakdown.systemPrompt,
      sections: breakdown.sections.map((section) => ({ name: section.name, tokens: section.tokens, text: section.text, open: commands.section(ref, section.name) })),
    },
    tools: breakdown.toolDefinitions,
    messages: {
      tokens: breakdown.history.reduce((sum, item) => sum + item.tokens, 0),
      items: breakdown.history.map((item) => ({
        number: item.number,
        role: item.role,
        label: item.label,
        tokens: item.tokens,
        text: item.text,
        from: item.ref ? commands.step(item.ref) : undefined,
        open: commands.message(ref, item.number),
      })),
    },
    open: commands.prompt(ref),
    full: commands.fullPrompt(ref),
  };
}

type PromptData = NonNullable<ReturnType<typeof promptData>>;

function toolsLine(tools: PromptData["tools"]): string {
  if (tools.captured) return `tool definitions, ${tools.definitions.length}`;
  if (tools.names.length === 0) return "tools: nothing recorded";
  return `tools: ${plural(tools.names.length, "name")} recorded, definitions not recorded`;
}

function promptHeader(data: PromptData, what: string): string[] {
  return [`turn ${data.turn} · step ${data.step} · ${what}`, `reported by the provider: ${usageLine(data.usage)}`];
}

export function renderPrompt(data: PromptData): string {
  const ref = { turn: data.turn, step: data.step };
  const lines = [...promptHeader(data, "what the model received, in the order it was sent"), "sizes below are estimates (o200k tokenizer)", ""];
  const row = (tokens: number | undefined, text: string, depth = 0) => {
    const size = tokens === undefined ? "" : formatTokens(tokens);
    lines.push(`${" ".repeat(depth * 9)}${size.padStart(7)}  ${text}`);
  };
  row(data.system.tokens, `system prompt, ${plural(data.system.sections.length, "section")}`);
  for (const section of data.system.sections) row(section.tokens, section.name, 1);
  row(data.tools.captured ? data.tools.tokens : undefined, toolsLine(data.tools));
  row(data.messages.tokens, plural(data.messages.items.length, "message item"));
  const numberWidth = String(data.messages.items.length).length;
  for (const item of data.messages.items) row(item.tokens, `${String(item.number).padStart(numberWidth)}  ${item.label}${item.from ? `  → ${item.from}` : ""}`, 1);
  if (data.unrecordedTokens > 0) row(data.unrecordedTokens, "reported input tokens not covered by the recorded content");
  lines.push(
    "",
    `next: ${commands.fullPrompt(ref)}  (all of it, verbatim)  ·  ${commands.section(ref, "NAME")}  ·  ${commands.message(ref, "N")}`,
  );
  return lines.join("\n");
}

export function renderFullPrompt(data: PromptData): string {
  const lines = [...promptHeader(data, "everything the model received, verbatim, in the order it was sent"), ""];
  const heading = (text: string) => lines.push(`━━━ ${text}`, "");
  heading(`system prompt · ~${formatTokens(data.system.tokens)} tokens · ${plural(data.system.sections.length, "section")}`);
  lines.push(data.system.text, "");
  heading(toolsLine(data.tools));
  if (data.tools.captured) {
    for (const tool of data.tools.definitions) lines.push(tool.name, indent(tool.description), indent(pretty(tool.inputSchema ?? null)), "");
  } else if (data.tools.names.length > 0) {
    lines.push(...data.tools.names, "");
  }
  for (const item of data.messages.items) {
    heading(`message item ${item.number} · ${item.role} · ${item.label} · ~${formatTokens(item.tokens)} tokens`);
    lines.push(item.text, "");
  }
  if (data.unrecordedTokens > 0) heading(`~${formatTokens(data.unrecordedTokens)} reported input tokens not covered by the recorded content`);
  return lines.join("\n").trimEnd();
}

export interface FindHit {
  turn: number;
  step?: number;
  where: string;
  snippet: string;
  open: string;
}

function snippet(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  const start = Math.max(0, at - 40);
  return oneLine(`${start > 0 ? "…" : ""}${text.slice(start, at + needle.length + 60)}`, 120);
}

function errorHits(conversation: Conversation, index: StepIndex): FindHit[] {
  return conversation.turns.flatMap((turn) => {
    const turnNumber = turn.index + 1;
    const failed: FindHit[] = index
      .steps(turnNumber)
      .flatMap((step) =>
        step.kind === "tool" && step.tool.status === "error"
          ? [{ turn: turnNumber, step: step.number, where: `tool ${step.tool.name} failed`, snippet: oneLine(step.tool.error ?? "", 120), open: commands.step({ turn: turnNumber, step: step.number }) }]
          : [],
      );
    if (failed.length === 0 && turn.status === "error") failed.push({ turn: turnNumber, where: "turn", snippet: "a span in this turn ended with an error status", open: commands.turn(turnNumber) });
    return failed;
  });
}

export function find(conversation: Conversation, index: StepIndex, options: { text?: string; errors: boolean }): FindHit[] {
  if (options.errors) return errorHits(conversation, index);
  const hits: FindHit[] = [];
  const needle = options.text ?? "";
  for (const turn of conversation.turns) {
    const turnNumber = turn.index + 1;
    const user = textOf(turn.userInput);
    if (user.toLowerCase().includes(needle.toLowerCase())) hits.push({ turn: turnNumber, where: "user", snippet: snippet(user, needle), open: commands.turn(turnNumber) });
    for (const step of index.steps(turnNumber)) {
      const ref = { turn: turnNumber, step: step.number };
      const fields =
        step.kind === "tool"
          ? [
              [`tool ${step.tool.name} input`, pretty(step.tool.input ?? "")],
              [`tool ${step.tool.name} result`, resultText(step.tool.output)],
            ]
          : [
              ["model said", said(step)],
              ["model asked for", toolCalls(step).map((call) => `${call.name} ${JSON.stringify(call.input)}`).join("\n")],
            ];
      for (const [where, text] of fields) {
        if (where && text && text.toLowerCase().includes(needle.toLowerCase())) hits.push({ turn: turnNumber, step: step.number, where, snippet: snippet(text, needle), open: commands.step(ref) });
      }
    }
  }
  return hits;
}

export function renderFind(hits: FindHit[]): string {
  if (hits.length === 0) return "no matches";
  return hits
    .map((hit) => `turn ${hit.turn}${hit.step ? ` step ${hit.step}` : ""}  ${hit.where}\n    ${hit.snippet}\n    → ${hit.open}`)
    .join("\n");
}
