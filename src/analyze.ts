import type { Conversation, ModelCall } from "./model.ts";
import { findNode, type TreeNode, walk } from "./tree.ts";

export type Severity = "error" | "warn" | "info";

export interface Flag {
  id: string;
  severity: Severity;
  turn?: number;
  message: string;
  path?: string;
}

export interface AnalyzeOptions {
  oversizedResultTokens: number;
  slowFirstTokenMs: number;
  cacheTtlMs: number;
}

export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  oversizedResultTokens: 8000,
  slowFirstTokenMs: 10000,
  cacheTtlMs: 5 * 60 * 1000,
};

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function toolFlags(conversation: Conversation, tree: TreeNode, options: AnalyzeOptions): Flag[] {
  const flags: Flag[] = [];
  for (const turn of conversation.turns) {
    const turnNumber = turn.index + 1;
    const seen = new Map<string, number>();
    turn.tools.forEach((tool, index) => {
      const path = `/turns/${turnNumber}/tools/${index + 1}`;
      if (tool.status === "error") {
        flags.push({ id: "tool_error", severity: "error", turn: turnNumber, message: `${tool.name} failed${tool.error ? `: ${tool.error}` : ""}`, path });
      }
      const outputTokens = findNode(tree, `${path}/output`)?.tokens ?? 0;
      if (outputTokens > options.oversizedResultTokens) {
        flags.push({
          id: "oversized_result",
          severity: "warn",
          turn: turnNumber,
          message: `${tool.name} returned ${formatTokens(outputTokens)} tokens to the model`,
          path: `${path}/output`,
        });
      }
      const key = `${tool.name} ${JSON.stringify(tool.input ?? null)}`;
      const first = seen.get(key);
      if (first !== undefined) {
        flags.push({
          id: "duplicate_tool_call",
          severity: "warn",
          turn: turnNumber,
          message: `${tool.name} called again with the same input as an earlier step`,
          path,
        });
      } else {
        seen.set(key, index);
      }
    });
    const turnNode = findNode(tree, `/turns/${turnNumber}`);
    const lastCall = turnNode && findNode(turnNode, `/turns/${turnNumber}/calls/${turn.calls.length}`);
    if (lastCall) {
      const failedResultNames = new Set(turn.tools.filter((tool) => tool.status === "error").map((tool) => tool.name));
      walk(lastCall, (node) => {
        if (node.kind === "tool_result" && node.status === "error") {
          const name = node.name.replace(/^tool_result /, "").replace(/ \(error\)$/, "");
          if (!failedResultNames.has(name)) {
            flags.push({ id: "tool_error", severity: "error", turn: turnNumber, message: `model received an error result from ${name}`, path: node.path });
            failedResultNames.add(name);
          }
        }
      });
    }
    if (turn.status === "error" && !flags.some((flag) => flag.turn === turnNumber && flag.severity === "error")) {
      flags.push({ id: "turn_error", severity: "error", turn: turnNumber, message: "a span in this turn ended with an error status", path: `/turns/${turnNumber}` });
    }
  }
  return flags;
}

function mediaFlags(tree: TreeNode): Flag[] {
  const occurrences = new Map<string, { calls: Set<string>; path: string; tokens: number; name: string }>();
  walk(tree, (node) => {
    if (node.kind !== "media" || !node.note) return;
    const callPath = node.path.split("/context/")[0] ?? node.path;
    const entry = occurrences.get(node.note) ?? { calls: new Set<string>(), path: node.path, tokens: node.tokens, name: node.name };
    entry.calls.add(callPath);
    occurrences.set(node.note, entry);
  });
  const flags: Flag[] = [];
  for (const entry of occurrences.values()) {
    if (entry.calls.size >= 3) {
      flags.push({
        id: "repeated_media",
        severity: "warn",
        message: `${entry.name} resent in ${entry.calls.size} model calls (~${formatTokens(entry.tokens)} tokens each)`,
        path: entry.path,
      });
    }
  }
  return flags;
}

function cacheFlags(conversation: Conversation, options: AnalyzeOptions): Flag[] {
  const flags: Flag[] = [];
  const previousByAgent = new Map<string, { call: ModelCall; path: string }>();
  for (const turn of conversation.turns) {
    turn.calls.forEach((call, index) => {
      const path = `/turns/${turn.index + 1}/calls/${index + 1}`;
      const previous = previousByAgent.get(call.agent);
      previousByAgent.set(call.agent, { call, path });
      if (!previous || !call.usage || !previous.call.usage) return;
      const input = call.usage.inputTokens;
      const cacheRead = call.usage.cacheReadTokens;
      if (cacheRead === undefined || input < 10000) return;
      if (cacheRead >= 0.5 * Math.min(input, previous.call.usage.inputTokens)) return;
      const gapMs = Date.parse(call.startedAt) - (Date.parse(previous.call.startedAt) + previous.call.durationMs);
      const reason = gapMs > options.cacheTtlMs ? `idle ${Math.round(gapMs / 60000)} min, past the ${Math.round(options.cacheTtlMs / 60000)} min cache TTL` : "prompt prefix changed";
      flags.push({
        id: "cache_miss",
        severity: gapMs > options.cacheTtlMs ? "info" : "warn",
        turn: turn.index + 1,
        message: `${cacheRead === 0 ? "none" : `only ${formatTokens(cacheRead)}`} of ${formatTokens(input)} input tokens read from cache (${reason})`,
        path,
      });
    });
  }
  return flags;
}

function latencyFlags(conversation: Conversation, options: AnalyzeOptions): Flag[] {
  return conversation.turns.flatMap((turn) =>
    turn.calls.flatMap((call, index) =>
      call.timeToFirstTokenMs !== undefined && call.timeToFirstTokenMs > options.slowFirstTokenMs
        ? [
            {
              id: "slow_first_token",
              severity: "warn" as const,
              turn: turn.index + 1,
              message: `first token after ${(call.timeToFirstTokenMs / 1000).toFixed(1)}s`,
              path: `/turns/${turn.index + 1}/calls/${index + 1}`,
            },
          ]
        : [],
    ),
  );
}

function unattributedFlag(tree: TreeNode): Flag[] {
  let worst: TreeNode | undefined;
  let worstContext: TreeNode | undefined;
  walk(tree, (node) => {
    if (node.kind !== "context") return;
    const unattributed = node.children.find((child) => child.kind === "unattributed");
    if (unattributed && (!worst || unattributed.tokens > worst.tokens)) {
      worst = unattributed;
      worstContext = node;
    }
  });
  if (!worst || !worstContext || worst.tokens < 2000 || worst.tokens < 0.1 * worstContext.tokens) return [];
  return [
    {
      id: "unattributed_tokens",
      severity: "info",
      message: `up to ${formatTokens(worst.tokens)} input tokens per model call were not recorded by the tracer (likely tool definitions)`,
      path: worst.path,
    },
  ];
}

export function analyze(conversation: Conversation, tree: TreeNode, options: AnalyzeOptions = DEFAULT_ANALYZE_OPTIONS): Flag[] {
  const flags = [
    ...toolFlags(conversation, tree, options),
    ...mediaFlags(tree),
    ...cacheFlags(conversation, options),
    ...latencyFlags(conversation, options),
    ...unattributedFlag(tree),
  ];
  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return flags.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0) || rank[a.severity] - rank[b.severity]);
}
