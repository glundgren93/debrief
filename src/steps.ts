import { textOf } from "./content.ts";
import type { Conversation, Message, ModelCall, OtherSpan, Part, Role, ToolDefinition, ToolExecution, Turn } from "./model.ts";
import { countMedia, countText } from "./tokens.ts";

interface StepTiming {
  turn: number;
  number: number;
  startedAt: string;
  durationMs: number;
  offsetMs: number;
  alongside: number[];
}

export type Step =
  | (StepTiming & { kind: "model"; call: ModelCall; callIndex: number })
  | (StepTiming & { kind: "tool"; tool: ToolExecution; toolIndex: number });

export interface StepRef {
  turn: number;
  step: number;
}

export function stepsOf(turn: Turn): Step[] {
  const turnNumber = turn.index + 1;
  const unordered = [
    ...turn.calls.map((call, callIndex) => ({ kind: "model" as const, startedAt: call.startedAt, durationMs: call.durationMs, call, callIndex })),
    ...turn.tools.map((tool, toolIndex) => ({ kind: "tool" as const, startedAt: tool.startedAt, durationMs: tool.durationMs, tool, toolIndex })),
  ];
  unordered.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || (a.kind === b.kind ? 0 : a.kind === "model" ? -1 : 1));
  const turnStart = Date.parse(turn.startedAt);
  const timed = unordered.map((step, index) => ({ ...step, turn: turnNumber, number: index + 1, offsetMs: Date.parse(step.startedAt) - turnStart }));
  return timed.map((step) => ({
    ...step,
    alongside: timed
      .filter((other) => other.number !== step.number && other.offsetMs < step.offsetMs + step.durationMs && step.offsetMs < other.offsetMs + other.durationMs)
      .map((other) => other.number),
  }));
}

export interface TimelineGap {
  offsetMs: number;
  durationMs: number;
  otherSpans: OtherSpan[];
}

const MIN_GAP_MS = 100;

export function timelineGaps(turn: Turn, steps: Step[]): TimelineGap[] {
  const turnStart = Date.parse(turn.startedAt);
  const intervals = steps.map((step) => [step.offsetMs, step.offsetMs + step.durationMs] as const).sort((a, b) => a[0] - b[0]);
  const covered: [number, number][] = [];
  for (const [start, end] of intervals) {
    const last = covered[covered.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else covered.push([start, end]);
  }
  const bounds = [0, ...covered.flat(), turn.durationMs];
  const gaps: TimelineGap[] = [];
  for (let index = 0; index < bounds.length; index += 2) {
    const start = bounds[index] ?? 0;
    const end = bounds[index + 1] ?? start;
    if (end - start < MIN_GAP_MS) continue;
    const otherSpans = turn.otherSpans.filter((span) => {
      const offset = Date.parse(span.startedAt) - turnStart;
      return offset >= start && offset < end;
    });
    gaps.push({ offsetMs: start, durationMs: end - start, otherSpans });
  }
  return gaps;
}

function outputText(call: ModelCall): string {
  return (call.output?.parts ?? [])
    .filter((part) => part.kind === "text")
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

export class StepIndex {
  readonly byTurn: Step[][];
  private readonly byToolCallId = new Map<string, Step>();
  private readonly byRequestedCallId = new Map<string, Step>();
  private readonly byReply = new Map<string, Step>();

  constructor(readonly conversation: Conversation) {
    this.byTurn = conversation.turns.map(stepsOf);
    for (const step of this.byTurn.flat()) {
      if (step.kind === "tool" && step.tool.callId) this.byToolCallId.set(step.tool.callId, step);
      if (step.kind === "model") {
        for (const part of step.call.output?.parts ?? []) if (part.kind === "tool_call") this.byRequestedCallId.set(part.id, step);
        const reply = outputText(step.call);
        if (reply) this.byReply.set(reply, step);
      }
    }
  }

  steps(turn: number): Step[] {
    return this.byTurn[turn - 1] ?? [];
  }

  step(turn: number, step: number): Step | undefined {
    return this.steps(turn)[step - 1];
  }

  toolStep(callId: string): Step | undefined {
    return this.byToolCallId.get(callId);
  }

  requestingStep(callId: string): Step | undefined {
    return this.byRequestedCallId.get(callId);
  }

  replyStep(text: string): Step | undefined {
    return this.byReply.get(text.trim());
  }

  userTurn(text: string): number | undefined {
    const turn = this.conversation.turns.find((candidate) => textOf(candidate.userInput).trim() === text.trim());
    return turn ? turn.index + 1 : undefined;
  }
}

export interface PromptSection {
  name: string;
  tokens: number;
  text: string;
}

export interface PromptItem {
  number: number;
  role: Role;
  label: string;
  tokens: number;
  ref?: StepRef;
  text: string;
}

export interface PromptBreakdown {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  systemPrompt: string;
  sections: PromptSection[];
  history: PromptItem[];
  toolDefinitions: { captured: true; tokens: number; definitions: ToolDefinition[] } | { captured: false; names: string[] };
  unrecordedTokens: number;
}

function sectionName(label: string, used: Map<string, number>): string {
  const base = label.replace(/^\d+:/, "").replace(/^<(.*)>$/, "$1").replace(/^\((.*)\)$/, "$1").trim() || "section";
  const seen = (used.get(base) ?? 0) + 1;
  used.set(base, seen);
  return seen === 1 ? base : `${base}-${seen}`;
}

function partTokens(part: Part): number {
  return part.kind === "media" ? countMedia(part) : countText(textOf([part]));
}

function ref(step: Step | undefined): StepRef | undefined {
  return step ? { turn: step.turn, step: step.number } : undefined;
}

function historyItems(messages: Message[], index: StepIndex): PromptItem[] {
  type PromptItemDraft = Omit<PromptItem, "number" | "label"> & { label: (number: number) => string };
  const items: PromptItemDraft[] = [];
  messages.forEach((message) => {
    if (message.role === "tool" || message.parts.every((part) => part.kind === "tool_result")) {
      for (const part of message.parts) {
        if (part.kind !== "tool_result") continue;
        const step = index.toolStep(part.callId);
        const name = step?.kind === "tool" ? step.tool.name : "a tool";
        items.push({ role: message.role, label: () => `result of ${name}${part.status === "error" ? " (error)" : ""}`, tokens: partTokens(part), ref: ref(step), text: textOf([part]) });
      }
      return;
    }
    if (message.role === "user") {
      const text = textOf(message.parts.filter((part) => part.kind === "text"));
      const turn = index.userTurn(text);
      for (const part of message.parts.filter((item) => item.kind === "media")) {
        const size = part.kind === "media" && part.width ? ` ${part.width}x${part.height}` : "";
        items.push({ role: message.role, label: () => `image${size} from ${turn ? `turn ${turn}` : "the user"}`, tokens: partTokens(part), text: textOf([part]) });
      }
      const textTokens = message.parts.filter((part) => part.kind !== "media").reduce((sum, part) => sum + partTokens(part), 0);
      if (textTokens > 0) items.push({ role: message.role, label: (number) => (turn ? `user message, turn ${turn}` : `user message ${number}`), tokens: textTokens, text });
      return;
    }
    const tokens = message.parts.reduce((sum, part) => sum + partTokens(part), 0);
    const text = textOf(message.parts.filter((part) => part.kind === "text"));
    const call = message.parts.find((part) => part.kind === "tool_call");
    const step = (call && call.kind === "tool_call" ? index.requestingStep(call.id) : undefined) ?? (text ? index.replyStep(text) : undefined);
    const what = call ? "model asked for tools" : "model reply";
    items.push({ role: message.role, label: (number) => (step ? what : `${what} (message ${number}, no matching step)`), tokens, ref: ref(step), text: textOf(message.parts) });
  });
  return items.map((item, position) => {
    const number = position + 1;
    return { ...item, number, label: item.label(number) };
  });
}

export function promptBreakdown(call: ModelCall, index: StepIndex): PromptBreakdown | undefined {
  const context = call.context;
  if (!context) return undefined;
  const used = new Map<string, number>();
  const sections = context.system.map((section) => ({ name: sectionName(section.label, used), tokens: countText(section.text), text: section.text }));
  const history = historyItems(context.messages, index);
  const toolDefinitions = Array.isArray(context.tools)
    ? {
        captured: true as const,
        tokens: context.tools.reduce((sum, tool) => sum + countText(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`), 0),
        definitions: context.tools,
      }
    : { captured: false as const, names: context.tools.names };
  const counted =
    sections.reduce((sum, section) => sum + section.tokens, 0) +
    history.reduce((sum, item) => sum + item.tokens, 0) +
    (toolDefinitions.captured ? toolDefinitions.tokens : 0);
  const input = call.usage?.inputTokens;
  return {
    inputTokens: input,
    cacheReadTokens: call.usage?.cacheReadTokens,
    cacheWriteTokens: call.usage?.cacheWriteTokens,
    systemPrompt: context.systemPrompt,
    sections,
    history,
    toolDefinitions,
    unrecordedTokens: input !== undefined && input > counted ? input - counted : 0,
  };
}
