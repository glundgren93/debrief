export type Part =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "media"; mediaType: string; bytes: number; digest: string; width?: number; height?: number }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; callId: string; status: "ok" | "error"; content: Part[] }
  | { kind: "data"; value: unknown };

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  parts: Part[];
}

export interface Section {
  label: string;
  text: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface Context {
  systemPrompt: string;
  system: Section[];
  tools: ToolDefinition[] | { notCaptured: true; names: string[] };
  messages: Message[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelCall {
  spanId: string;
  agent: string;
  model: string;
  startedAt: string;
  status: "ok" | "error";
  error?: string;
  durationMs: number;
  timeToFirstTokenMs?: number;
  usage?: Usage;
  context?: Context;
  output?: Message;
  finishReason?: string;
}

export interface ToolExecution {
  spanId: string;
  callId?: string;
  name: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error" | "unknown";
  input?: unknown;
  output?: Part[];
  error?: string;
}

export interface OtherSpan {
  spanId: string;
  name: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface SpanError {
  spanId: string;
  name: string;
  message?: string;
  step?: number;
}

export interface Turn {
  index: number;
  traceId: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error" | "interrupted";
  interruption?: string;
  errors: SpanError[];
  userInput: Part[];
  calls: ModelCall[];
  tools: ToolExecution[];
  otherSpans: OtherSpan[];
}

export interface CaptureGap {
  what: string;
  howToEnable?: string;
}

export interface Conversation {
  id: string;
  source: string;
  turns: Turn[];
  gaps: CaptureGap[];
}
