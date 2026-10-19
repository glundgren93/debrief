import { textOf } from "./content.ts";
import type { Context, Conversation, Message, ModelCall, Part, ToolExecution, Turn } from "./model.ts";
import { countMedia, countText } from "./tokens.ts";

export interface TreeNode {
  path: string;
  name: string;
  kind: string;
  tokens: number;
  note?: string;
  text?: string;
  status?: "ok" | "error";
  children: TreeNode[];
}

function preview(text: string, length = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function leaf(path: string, name: string, kind: string, text: string, extra: Partial<TreeNode> = {}): TreeNode {
  return { path, name, kind, tokens: countText(text), text, children: [], ...extra };
}

function branch(path: string, name: string, kind: string, children: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode {
  return { path, name, kind, tokens: children.reduce((sum, child) => sum + child.tokens, 0), children, ...extra };
}

function formatData(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function partNode(path: string, part: Part, toolNames: Map<string, string>): TreeNode {
  switch (part.kind) {
    case "text":
      return leaf(path, `text: ${preview(part.text, 50)}`, "text", part.text);
    case "reasoning":
      return leaf(path, `reasoning: ${preview(part.text, 45)}`, "reasoning", part.text);
    case "data":
      return leaf(path, "data", "data", formatData(part.value));
    case "tool_call": {
      toolNames.set(part.id, part.name);
      const text = `${part.name} ${formatData(part.input)}`;
      return leaf(path, `tool_call ${part.name}`, "tool_call", text);
    }
    case "tool_result": {
      const name = toolNames.get(part.callId) ?? part.callId;
      const text = part.content.map((item) => (item.kind === "data" ? formatData(item.value) : textOf([item]))).join("\n");
      return leaf(path, `tool_result ${name}${part.status === "error" ? " (error)" : ""}`, "tool_result", text, {
        status: part.status,
      });
    }
    case "media": {
      const size = part.width && part.height ? ` ${part.width}x${part.height}` : "";
      return {
        path,
        name: `${part.mediaType}${size} · ${Math.round(part.bytes / 1024)} KB`,
        kind: "media",
        tokens: countMedia(part),
        note: `digest ${part.digest}`,
        text: `[${part.mediaType}${size}, ${part.bytes} bytes, digest ${part.digest}]`,
        children: [],
      };
    }
  }
}

function messageLabel(index: number, message: Message): string {
  const calls = message.parts.filter((part) => part.kind === "tool_call");
  const results = message.parts.filter((part) => part.kind === "tool_result");
  const text = message.parts.find((part) => part.kind === "text");
  const bits: string[] = [];
  if (text && text.kind === "text") bits.push(`"${preview(text.text, 45)}"`);
  if (calls.length > 0) bits.push(`${calls.length} tool call${calls.length > 1 ? "s" : ""}`);
  if (results.length > 0) bits.push(`${results.length} tool result${results.length > 1 ? "s" : ""}`);
  if (message.parts.some((part) => part.kind === "media")) bits.push("media");
  return `${index} ${message.role}${bits.length > 0 ? `: ${bits.join(", ")}` : ""}`;
}

function messageNode(path: string, index: number, message: Message, toolNames: Map<string, string>): TreeNode {
  const children = message.parts.map((part, partIndex) => partNode(`${path}/${partIndex + 1}`, part, toolNames));
  return branch(path, messageLabel(index, message), "message", children, {
    status: children.some((child) => child.status === "error") ? "error" : undefined,
  });
}

function contextNode(path: string, context: Context, reportedInput: number | undefined): TreeNode {
  const toolNames = new Map<string, string>();
  const system = branch(
    `${path}/system`,
    `system (${context.system.length} section${context.system.length === 1 ? "" : "s"})`,
    "system",
    context.system.map((section, index) => leaf(`${path}/system/${index + 1}`, section.label, "section", section.text)),
  );
  const tools = Array.isArray(context.tools)
    ? branch(
        `${path}/tools`,
        `tools (${context.tools.length})`,
        "tools",
        context.tools.map((tool, index) =>
          leaf(`${path}/tools/${index + 1}`, tool.name, "tool_definition", `${tool.name}\n${tool.description}\n${formatData(tool.inputSchema)}`),
        ),
      )
    : {
        path: `${path}/tools`,
        name: `tools: not captured (${context.tools.names.length} names known)`,
        kind: "tools",
        tokens: 0,
        text: context.tools.names.join("\n"),
        children: [],
      };
  const messages = branch(
    `${path}/messages`,
    `messages (${context.messages.length})`,
    "messages",
    context.messages.map((message, index) => messageNode(`${path}/messages/${index + 1}`, index + 1, message, toolNames)),
  );
  const children = [system, tools, messages];
  const counted = children.reduce((sum, child) => sum + child.tokens, 0);
  if (reportedInput !== undefined && reportedInput > counted) {
    children.push({
      path: `${path}/unattributed`,
      name: "unattributed: in reported input but not in captured content (likely tool schemas)",
      kind: "unattributed",
      tokens: reportedInput - counted,
      note: "reported input minus counted content: uncaptured tool schemas, formatting overhead, tokenizer drift",
      text: "Reported input tokens minus the tokens counted for captured content.",
      children: [],
    });
  }
  return branch(path, "context", "context", children);
}

function callNode(path: string, index: number, call: ModelCall): TreeNode {
  const children: TreeNode[] = [];
  if (call.context) children.push(contextNode(`${path}/context`, call.context, call.usage?.inputTokens));
  if (call.output) {
    const toolNames = new Map<string, string>();
    const output = messageNode(`${path}/output`, 0, call.output, toolNames);
    children.push({ ...output, name: `output${call.finishReason ? ` (${call.finishReason})` : ""}` });
  }
  const usage = call.usage
    ? `${call.usage.inputTokens} in (${call.usage.cacheReadTokens ?? 0} cache read, ${call.usage.cacheWriteTokens ?? 0} cache write) · ${call.usage.outputTokens} out`
    : "no usage";
  const node = branch(path, `${index} ${call.agent} · ${call.model} · ${(call.durationMs / 1000).toFixed(1)}s`, "call", children, { note: usage });
  return { ...node, tokens: call.usage?.inputTokens ?? node.tokens };
}

function toolNode(path: string, index: number, tool: ToolExecution): TreeNode {
  const children = [leaf(`${path}/input`, "input", "tool_input", formatData(tool.input ?? ""))];
  if (tool.output) children.push(leaf(`${path}/output`, "output", "tool_output", tool.output.map((part) => (part.kind === "data" ? formatData(part.value) : textOf([part]))).join("\n")));
  if (tool.error) children.push(leaf(`${path}/error`, "error", "tool_error", tool.error));
  const outputTokens = children.find((child) => child.kind === "tool_output")?.tokens ?? 0;
  const node = branch(path, `${index} ${tool.name} · ${(tool.durationMs / 1000).toFixed(1)}s${tool.status === "error" ? " · error" : ""}`, "tool", children, {
    status: tool.status,
  });
  return { ...node, note: `${outputTokens} tokens returned to the model` };
}

function turnNode(path: string, turn: Turn): TreeNode {
  const input = leaf(`${path}/input`, "input", "user_input", textOf(turn.userInput));
  const calls = branch(
    `${path}/calls`,
    `calls (${turn.calls.length})`,
    "calls",
    turn.calls.map((call, index) => callNode(`${path}/calls/${index + 1}`, index + 1, call)),
  );
  const tools = branch(
    `${path}/tools`,
    `tools (${turn.tools.length})`,
    "tool_executions",
    turn.tools.map((tool, index) => toolNode(`${path}/tools/${index + 1}`, index + 1, tool)),
  );
  return {
    path,
    name: `turn ${turn.index + 1} · ${turn.startedAt.slice(11, 19)} · "${preview(textOf(turn.userInput), 50)}"`,
    kind: "turn",
    tokens: calls.tokens,
    note: `trace ${turn.traceId} · ${(turn.durationMs / 1000).toFixed(1)}s`,
    status: turn.status,
    children: [input, calls, tools],
  };
}

export function buildTree(conversation: Conversation): TreeNode {
  const turns = branch(
    "/turns",
    `turns (${conversation.turns.length})`,
    "turns",
    conversation.turns.map((turn) => turnNode(`/turns/${turn.index + 1}`, turn)),
  );
  return { path: "/", name: `conversation ${conversation.id}`, kind: "conversation", tokens: turns.tokens, children: [turns] };
}

export function findNode(root: TreeNode, path: string): TreeNode | undefined {
  const normalized = `/${path.split("/").filter(Boolean).join("/")}`;
  if (normalized === "/") return root;
  const segments = normalized.split("/").filter(Boolean);
  let current: TreeNode | undefined = root;
  let currentPath = "";
  for (const segment of segments) {
    currentPath += `/${segment}`;
    current = current?.children.find((child) => child.path === currentPath);
    if (!current) return undefined;
  }
  return current;
}

export function walk(node: TreeNode, visit: (node: TreeNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
