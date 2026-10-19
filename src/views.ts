import type { Flag } from "./analyze.ts";
import { textOf } from "./content.ts";
import type { Conversation, Part } from "./model.ts";
import { promptBreakdown, type Step, type StepIndex, type StepRef } from "./steps.ts";
import { countText } from "./tokens.ts";

export const BIN = "debrief";

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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
  section: (ref: StepRef, name: string) => `${BIN} turn ${ref.turn} --step ${ref.step} --prompt --section ${name}`,
};

function dominantAgent(conversation: Conversation): string | undefined {
  const counts = new Map<string, number>();
  for (const call of conversation.turns.flatMap((turn) => turn.calls)) counts.set(call.agent, (counts.get(call.agent) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
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

function cacheShare(input?: number, cacheRead?: number): string {
  if (!input || cacheRead === undefined) return "";
  return ` (${Math.round((cacheRead / input) * 100)}% from cache)`;
}

export function flagRef(flag: Flag, index: StepIndex): { ref?: StepRef; prompt: boolean } {
  const match = /^\/turns\/(\d+)(?:\/(calls|tools)\/(\d+))?(\/context)?/.exec(flag.path ?? "");
  if (!match) return { prompt: false };
  const turn = Number(match[1]);
  if (!match[2]) return { ref: { turn, step: 1 }, prompt: false };
  const position = Number(match[3]) - 1;
  const step = match[2] === "calls" ? index.stepForCall(turn, position) : index.stepForTool(turn, position);
  return { ref: step ? { turn, step: step.number } : undefined, prompt: Boolean(match[4]) };
}

function flagCommand(flag: Flag, index: StepIndex): string | undefined {
  const { ref, prompt } = flagRef(flag, index);
  if (!ref) return undefined;
  return prompt ? commands.prompt(ref) : commands.step(ref);
}

const MARK: Record<Flag["severity"], string> = { error: "✗", warn: "!", info: "·" };

function lastReply(steps: Step[]): string {
  for (const step of [...steps].reverse()) if (step.kind === "model" && said(step)) return said(step);
  return "";
}

export function summaryData(conversation: Conversation, index: StepIndex, flags: Flag[]) {
  const calls = conversation.turns.flatMap((turn) => turn.calls);
  const input = calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0);
  const cached = calls.reduce((sum, call) => sum + (call.usage?.cacheReadTokens ?? 0), 0);
  return {
    chat: conversation.id,
    source: conversation.source,
    inputTokens: input,
    cacheReadTokens: cached,
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
    flags: flags.map((flag) => ({ ...flag, path: undefined, open: flagCommand(flag, index) })),
    notRecorded: conversation.gaps,
  };
}

export function renderSummary(data: ReturnType<typeof summaryData>): string {
  const lines = [
    `chat ${data.chat} · ${data.source} · ${data.turns.length} turns · ${formatTokens(data.inputTokens)} tokens in${cacheShare(data.inputTokens, data.cacheReadTokens)}`,
    "",
  ];
  for (const turn of data.turns) {
    const flags = data.flags.filter((flag) => flag.turn === turn.turn);
    const mark = turn.status === "error" || flags.some((flag) => flag.severity === "error") ? "✗" : flags.some((flag) => flag.severity === "warn") ? "!" : " ";
    lines.push(`${mark} turn ${turn.turn}  ${turn.startedAt.slice(11, 16)}  ${seconds(turn.durationMs).padStart(6)}  ${String(turn.steps).padStart(2)} steps  "${oneLine(turn.user, 70)}"`);
    if (turn.reply) lines.push(`         reply: "${oneLine(turn.reply, 90)}"`);
    for (const flag of flags) lines.push(`         ${MARK[flag.severity]} ${flag.message}${flag.open ? `  → ${flag.open}` : ""}`);
  }
  const global = data.flags.filter((flag) => flag.turn === undefined);
  if (global.length > 0) {
    lines.push("");
    for (const flag of global) lines.push(`${MARK[flag.severity]} ${flag.message}${flag.open ? `  → ${flag.open}` : ""}`);
  }
  if (data.notRecorded.length > 0) {
    lines.push("", "not recorded by the tracer:");
    for (const gap of data.notRecorded) lines.push(`  - ${gap.what}`);
  }
  const worst = data.turns.find((turn) => data.flags.some((flag) => flag.turn === turn.turn && flag.severity !== "info")) ?? data.turns[data.turns.length - 1];
  lines.push("", `next: ${worst ? worst.open : commands.summary()}`);
  return lines.join("\n");
}

function stepHeadline(step: Step, mainAgent: string | undefined): { kind: string; text: string; detail?: string } {
  if (step.kind === "tool") {
    const status = step.tool.status === "error" ? "  ✗ failed" : "";
    return {
      kind: "tool",
      text: `${step.tool.name}  ${oneLine(step.tool.input ?? "", 110)}${status}`,
      detail: step.tool.error ? `error: ${oneLine(step.tool.error, 120)}` : `→ ${oneLine(resultValue(step.tool.output), 120)}`,
    };
  }
  const agent = mainAgent && step.call.agent !== mainAgent ? ` (${step.call.agent})` : "";
  const text = said(step);
  const asked = askedFor(step);
  const bits = [text ? `said: "${oneLine(text, 100)}"` : "", asked ? `asked for ${asked}` : ""].filter(Boolean);
  return { kind: `model${agent}`, text: bits.join("  ·  ") || "(output not recorded)" };
}

export function turnData(conversation: Conversation, index: StepIndex, flags: Flag[], turnNumber: number) {
  const turn = conversation.turns[turnNumber - 1];
  if (!turn) throw new Error(`turn ${turnNumber} missing`);
  const mainAgent = dominantAgent(conversation);
  const steps = index.steps(turnNumber);
  return {
    turn: turnNumber,
    of: conversation.turns.length,
    startedAt: turn.startedAt,
    durationMs: turn.durationMs,
    user: textOf(turn.userInput),
    steps: steps.map((step) => {
      const headline = stepHeadline(step, mainAgent);
      return {
        step: step.number,
        kind: headline.kind,
        durationMs: step.durationMs,
        summary: headline.text,
        detail: headline.detail,
        status: step.kind === "tool" ? step.tool.status : "ok",
        open: commands.step({ turn: turnNumber, step: step.number }),
        prompt: step.kind === "model" && step.call.context ? commands.prompt({ turn: turnNumber, step: step.number }) : undefined,
      };
    }),
    flags: flags.filter((flag) => flag.turn === turnNumber).map((flag) => ({ ...flag, path: undefined, open: flagCommand(flag, index) })),
  };
}

export function renderTurn(data: ReturnType<typeof turnData>): string {
  const lines = [`turn ${data.turn} of ${data.of} · ${data.startedAt.slice(11, 19)} · ${seconds(data.durationMs)} · ${data.steps.length} steps`, "", `user: ${data.user}`, ""];
  const kindWidth = Math.max(5, ...data.steps.map((step) => step.kind.length));
  for (const step of data.steps) {
    lines.push(`${String(step.step).padStart(3)}  ${step.kind.padEnd(kindWidth)}  ${seconds(step.durationMs).padStart(6)}  ${step.summary}`);
    if (step.detail) lines.push(`${" ".repeat(kindWidth + 15)}${step.detail}`);
  }
  if (data.flags.length > 0) {
    lines.push("");
    for (const flag of data.flags) lines.push(`${MARK[flag.severity]} ${flag.message}${flag.open ? `  → ${flag.open}` : ""}`);
  }
  const lastModel = [...data.steps].reverse().find((step) => step.prompt);
  const hints = [commands.step({ turn: data.turn, step: 1 }).replace(/--step 1$/, "--step N"), lastModel?.prompt, commands.all(data.turn)].filter(Boolean);
  lines.push("", `next: ${hints.join("  ·  ")}`);
  return lines.join("\n");
}

export function stepData(conversation: Conversation, index: StepIndex, step: Step) {
  const ref = { turn: step.turn, step: step.number };
  const total = index.steps(step.turn).length;
  if (step.kind === "tool") {
    const result = resultText(step.tool.output);
    const requester = step.tool.callId ? index.requestingStep(step.tool.callId) : undefined;
    return {
      kind: "tool" as const,
      turn: step.turn,
      step: step.number,
      of: total,
      tool: step.tool.name,
      durationMs: step.durationMs,
      status: step.tool.status,
      input: step.tool.input,
      result,
      resultTokens: step.tool.output ? countText(textOf(step.tool.output)) : 0,
      error: step.tool.error,
      askedBy: requester ? commands.step({ turn: requester.turn, step: requester.number }) : undefined,
      open: commands.step(ref),
    };
  }
  const usage = step.call.usage;
  return {
    kind: "model" as const,
    turn: step.turn,
    step: step.number,
    of: total,
    agent: step.call.agent,
    model: step.call.model,
    durationMs: step.durationMs,
    inputTokens: usage?.inputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    outputTokens: usage?.outputTokens,
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

export function renderStep(data: ReturnType<typeof stepData>, limit: TextLimit): string {
  const lines: string[] = [];
  if (data.kind === "tool") {
    lines.push(`turn ${data.turn} · step ${data.step} of ${data.of} · tool ${data.tool} · ${seconds(data.durationMs)} · ${data.status === "error" ? "failed" : "ok"}`, "");
    lines.push(...block("input", pretty(data.input ?? ""), limit, data.open), "");
    lines.push(...block(`result (${formatTokens(data.resultTokens)} tokens sent back to the model)`, data.result || "(not recorded)", limit, data.open));
    if (data.error) lines.push("", "error", indent(data.error));
    if (data.askedBy) lines.push("", `next: ${data.askedBy}  (the model step that asked for this)`);
    return lines.join("\n");
  }
  const usage =
    data.inputTokens !== undefined
      ? `${formatTokens(data.inputTokens)} tokens in${cacheShare(data.inputTokens, data.cacheReadTokens)} · ${formatTokens(data.outputTokens ?? 0)} out`
      : "no token usage recorded";
  lines.push(`turn ${data.turn} · step ${data.step} of ${data.of} · model ${data.agent} · ${data.model} · ${seconds(data.durationMs)}`, `${usage}${data.finishReason ? ` · finished: ${data.finishReason}` : ""}`);
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

const TOP_ITEMS = 8;

export function promptData(index: StepIndex, step: Extract<Step, { kind: "model" }>) {
  const breakdown = promptBreakdown(step.call, index);
  if (!breakdown) return undefined;
  const ref = { turn: step.turn, step: step.number };
  const systemTokens = breakdown.sections.reduce((sum, section) => sum + section.tokens, 0);
  const historyTokens = breakdown.history.reduce((sum, item) => sum + item.tokens, 0);
  return {
    turn: step.turn,
    step: step.number,
    inputTokens: breakdown.inputTokens,
    cacheReadTokens: breakdown.cacheReadTokens,
    unrecordedTokens: breakdown.unrecordedTokens,
    toolDefinitions: breakdown.toolDefinitions,
    system: {
      tokens: systemTokens,
      sections: breakdown.sections.map((section) => ({ name: section.name, tokens: section.tokens, open: commands.section(ref, section.name) })),
    },
    history: {
      tokens: historyTokens,
      items: breakdown.history.map((item) => ({ label: item.label, tokens: item.tokens, from: item.ref, open: item.ref ? commands.step(item.ref) : undefined })),
    },
    sectionTexts: Object.fromEntries(breakdown.sections.map((section) => [section.name, section.text])),
    open: commands.prompt(ref),
  };
}

export function renderPrompt(data: NonNullable<ReturnType<typeof promptData>>, full: boolean): string {
  const total = data.inputTokens ?? data.system.tokens + data.history.tokens;
  const lines = [`turn ${data.turn} · step ${data.step} · what the model received · ${formatTokens(total)} tokens${cacheShare(data.inputTokens, data.cacheReadTokens)}`, ""];
  const rows: { tokens: number; lines: string[] }[] = [];
  if (data.toolDefinitions.captured) {
    rows.push({ tokens: data.toolDefinitions.tokens, lines: [`tool definitions (${data.toolDefinitions.names.length})`] });
  }
  if (data.unrecordedTokens > 0) {
    const likely = data.toolDefinitions.captured ? "formatting overhead or tokenizer drift" : `likely the ${data.toolDefinitions.names.length} tool definitions`;
    rows.push({ tokens: data.unrecordedTokens, lines: [`not recorded by the tracer (${likely})`] });
  }
  const sections = [...data.system.sections].sort((a, b) => b.tokens - a.tokens);
  const shownSections = full ? sections : sections.slice(0, 3);
  rows.push({
    tokens: data.system.tokens,
    lines: [
      `system prompt, ${sections.length} section${sections.length === 1 ? "" : "s"}${full ? ":" : ". Largest:"}`,
      ...shownSections.map((section) => `  ${formatTokens(section.tokens).padStart(6)}  ${section.name}`),
    ],
  });
  const items = [...data.history.items].sort((a, b) => b.tokens - a.tokens);
  const shownItems = full ? items : items.slice(0, TOP_ITEMS);
  const rest = items.length - shownItems.length;
  const restTokens = items.slice(shownItems.length).reduce((sum, item) => sum + item.tokens, 0);
  rows.push({
    tokens: data.history.tokens,
    lines: [
      `conversation so far, ${items.length} item${items.length === 1 ? "" : "s"}${full ? ":" : ". Largest:"}`,
      ...shownItems.map((item) => `  ${formatTokens(item.tokens).padStart(6)}  ${item.label}${item.open ? `  → ${item.open}` : ""}`),
      ...(rest > 0 ? [`          and ${rest} more (${formatTokens(restTokens)} together)`] : []),
    ],
  });
  for (const row of rows.sort((a, b) => b.tokens - a.tokens)) {
    const [first, ...others] = row.lines;
    lines.push(`${formatTokens(row.tokens).padStart(7)}  ${first}`);
    for (const other of others) lines.push(`         ${other}`);
  }
  const biggest = sections[0];
  const hints = [biggest ? commands.section({ turn: data.turn, step: data.step }, biggest.name).replace(/--section \S+$/, "--section NAME") : undefined, full ? undefined : `${data.open} --full`].filter(Boolean);
  lines.push("", `next: ${hints.join("  ·  ")}`);
  return lines.join("\n");
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

export function find(conversation: Conversation, index: StepIndex, flags: Flag[], options: { text?: string; errors: boolean }): FindHit[] {
  const hits: FindHit[] = [];
  if (options.errors) {
    for (const flag of flags.filter((item) => item.severity === "error")) {
      const { ref } = flagRef(flag, index);
      if (ref) hits.push({ turn: ref.turn, step: ref.step, where: flag.id, snippet: flag.message, open: commands.step(ref) });
    }
    return hits;
  }
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
