import { describe, expect, test } from "bun:test";
import { analyze } from "../src/analyze.ts";
import { StepIndex } from "../src/steps.ts";
import { find, flagRef, promptData } from "../src/views.ts";
import { DEFAULT_REDACTIONS, resolveInput } from "../src/config.ts";
import { parseOtelMessages, parseParts } from "../src/content.ts";
import { buildConversation, splitSections } from "../src/normalize.ts";
import { redact } from "../src/sources/index.ts";
import { parseSpanRecords, parseSpanText } from "../src/spans.ts";
import { buildTree, findNode } from "../src/tree.ts";
import { agentSpan, blocks, chatSpan, span, tinyPng, toolSpan } from "./fixtures.ts";

describe("content parsing", () => {
  test("reads Bedrock Converse blocks as recorded by Strands span events", () => {
    const parts = parseParts(
      blocks(
        { text: "hello" },
        { reasoning: { text: "thinking", signature: "sig" } },
        { toolUse: { toolUseId: "t1", name: "search", input: { q: "ctr" } } },
        { toolResult: { toolUseId: "t1", status: "error", content: [{ json: { error: "boom" } }] } },
        { cachePoint: { cacheType: "default" } },
      ),
    );
    expect(parts.map((part) => part.kind)).toEqual(["text", "reasoning", "tool_call", "tool_result"]);
    expect(parts[3]).toMatchObject({ kind: "tool_result", status: "error", content: [{ kind: "data", value: { error: "boom" } }] });
  });

  test("reads choice tool calls whose input is a JSON string", () => {
    const parts = parseParts(blocks({ type: "toolUse", name: "search", toolUseId: "t9", input: '{"q":"cpc"}' }));
    expect(parts).toEqual([{ kind: "tool_call", id: "t9", name: "search", input: { q: "cpc" } }]);
  });

  test("measures image dimensions from a PNG header and digests the bytes", () => {
    const [part] = parseParts(blocks({ image: { format: "png", source: JSON.stringify({ bytes: tinyPng }) } }));
    expect(part).toMatchObject({ kind: "media", mediaType: "image/png", width: 1456, height: 718 });
  });

  test("reads newer OpenTelemetry message parts", () => {
    const messages = parseOtelMessages(
      JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "hi" }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "fetch", arguments: { id: 1 } }] },
        { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: { ok: true } }] },
      ]),
    );
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[1]?.parts[0]).toEqual({ kind: "tool_call", id: "c1", name: "fetch", input: { id: 1 } });
    expect(messages[2]?.parts[0]).toMatchObject({ kind: "tool_result", callId: "c1", content: [{ kind: "data", value: { ok: true } }] });
  });
});

describe("system prompt sections", () => {
  test("splits a prompt on top-level XML-style tags", () => {
    const sections = splitSections("<role>\nYou help.\n</role>\n<rules>\nBe brief.\n</rules>\n");
    expect(sections.map((section) => section.label)).toEqual(["<role>", "<rules>"]);
  });

  test("falls back to markdown headings when there are no tags", () => {
    const sections = splitSections("# Role\nYou help.\n# Rules\nBe brief.");
    expect(sections.map((section) => section.label)).toEqual(["Role", "Rules"]);
  });

  test("keeps an unstructured prompt as one section", () => {
    expect(splitSections("Just be helpful.")).toEqual([{ label: "prompt", text: "Just be helpful." }]);
  });
});

describe("span records", () => {
  test("accepts CloudWatch Logs Insights rows that wrap the span in @message", () => {
    const raw = { traceId: "t", spanId: "s", name: "chat", startTimeUnixNano: 1, endTimeUnixNano: 2, attributes: { a: "b" } };
    const spans = parseSpanRecords([{ "@message": JSON.stringify(raw) }]);
    expect(spans[0]).toMatchObject({ traceId: "t", spanId: "s", attributes: { a: "b" } });
  });

  test("accepts OTLP JSON exports with key-value attribute lists", () => {
    const text = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: "lib" },
              spans: [
                {
                  traceId: "t",
                  spanId: "s",
                  name: "chat",
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  status: { code: 2, message: "bad" },
                  attributes: [{ key: "gen_ai.usage.input_tokens", value: { intValue: "42" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const [parsed] = parseSpanText(text);
    expect(parsed).toMatchObject({ scope: "lib", status: "error", statusMessage: "bad", attributes: { "gen_ai.usage.input_tokens": 42 } });
  });
});

function sampleConversation() {
  const system = { role: "system" as const, content: blocks({ text: "<role>\nHelp.\n</role>" }) };
  const turnOneAgent = agentSpan("trace-a", "show cpc");
  const firstCall = chatSpan(
    "trace-a",
    turnOneAgent,
    [system, { role: "user", content: blocks({ text: "show cpc" }) }],
    blocks({ type: "toolUse", name: "search", toolUseId: "c1", input: '{"q":"cpc"}' }),
    { input: 20000, cacheRead: 0, cacheWrite: 19000 },
  );
  const sdkDuplicate = span({ traceId: "trace-a", name: "chat model-x", parent: turnOneAgent, attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 1 } });
  const search = toolSpan("trace-a", turnOneAgent, "search", { q: "cpc" }, { results: "x ".repeat(9000) }, "success", "c1");
  const searchAgain = toolSpan("trace-a", turnOneAgent, "search", { q: "cpc" }, { results: [] });
  const failing = toolSpan("trace-a", turnOneAgent, "fetch", { id: 1 }, { error: "upstream 500" }, "error");
  const secondCall = chatSpan(
    "trace-a",
    turnOneAgent,
    [
      system,
      { role: "user", content: blocks({ text: "show cpc" }, { image: { format: "png", source: JSON.stringify({ bytes: tinyPng }) } }) },
      { role: "tool", content: blocks({ toolResult: { toolUseId: "c1", status: "success", content: [{ json: { results: [] } }] } }) },
    ],
    blocks({ text: "CPC is 1.2" }),
    { input: 21000, cacheRead: 19000, cacheWrite: 1000 },
  );
  const turnTwoAgent = agentSpan("trace-b", "and ctr?");
  const thirdCall = chatSpan(
    "trace-b",
    turnTwoAgent,
    [system, { role: "user", content: blocks({ text: "show cpc" }, { image: { format: "png", source: JSON.stringify({ bytes: tinyPng }) } }) }],
    blocks({ text: "CTR is 2%" }),
    { input: 22000, cacheRead: 100, cacheWrite: 21000 },
  );
  const fourthCall = chatSpan(
    "trace-b",
    turnTwoAgent,
    [system, { role: "user", content: blocks({ text: "show cpc" }, { image: { format: "png", source: JSON.stringify({ bytes: tinyPng }) } }) }],
    blocks({ text: "done" }),
    { input: 22100, cacheRead: 22000, cacheWrite: 0 },
  );
  const spans = [thirdCall, turnTwoAgent, firstCall, sdkDuplicate, search, searchAgain, failing, secondCall, turnOneAgent, fourthCall];
  return buildConversation("conv-1", "test", spans);
}

describe("conversation model", () => {
  test("orders turns by start time and groups spans by trace", () => {
    const conversation = sampleConversation();
    expect(conversation.turns.map((turn) => turn.traceId)).toEqual(["trace-a", "trace-b"]);
    expect(conversation.turns[0]?.userInput).toEqual([{ kind: "text", text: "show cpc" }]);
  });

  test("prefers model-call spans that carry content over SDK-level duplicates", () => {
    const conversation = sampleConversation();
    expect(conversation.turns[0]?.calls).toHaveLength(2);
    expect(conversation.turns[0]?.calls[0]?.agent).toBe("main-agent");
  });

  test("records tool status and reports tool definitions as not captured when only names exist", () => {
    const conversation = sampleConversation();
    expect(conversation.turns[0]?.tools.map((tool) => tool.status)).toEqual(["ok", "ok", "error"]);
    expect(conversation.turns[0]?.calls[0]?.context?.tools).toEqual({ notCaptured: true, names: ["search", "fetch"] });
    expect(conversation.gaps.some((gap) => gap.what.includes("gen_ai.tool.definitions"))).toBe(true);
  });

  test("adds cache tokens to input when the provider reports them separately", () => {
    const agent = agentSpan("t", "q");
    const call = chatSpan("t", agent, [{ role: "user", content: blocks({ text: "q" }) }], blocks({ text: "a" }), { input: 10, cacheRead: 900, cacheWrite: 90 });
    const conversation = buildConversation("c", "test", [agent, call]);
    expect(conversation.turns[0]?.calls[0]?.usage?.inputTokens).toBe(1000);
  });
});

describe("tree", () => {
  test("addresses every node with a stable 1-based path", () => {
    const tree = buildTree(sampleConversation());
    expect(findNode(tree, "/turns/1/calls/2/context/messages/1/2")?.kind).toBe("media");
    expect(findNode(tree, "turns/1/calls/1/context/system/1")?.name).toBe("<role>");
    expect(findNode(tree, "/turns/9")).toBeUndefined();
  });

  test("shows reported input that captured content does not explain as unattributed", () => {
    const tree = buildTree(sampleConversation());
    const context = findNode(tree, "/turns/1/calls/1/context");
    const unattributed = context?.children.find((child) => child.kind === "unattributed");
    expect(context?.tokens).toBe(20000);
    expect(unattributed?.tokens).toBeGreaterThan(19000);
  });

  test("names tool results after the tool call they answer", () => {
    const tree = buildTree(sampleConversation());
    expect(findNode(tree, "/turns/1/calls/2/context/messages/2/1")?.name).toBe("tool_result c1");
  });
});

describe("flags", () => {
  test("flags failed tools, oversized results, duplicate calls, resent media and cache misses", () => {
    const conversation = sampleConversation();
    const flags = analyze(conversation, buildTree(conversation));
    const byId = (id: string) => flags.filter((flag) => flag.id === id);
    expect(byId("tool_error")[0]).toMatchObject({ turn: 1, path: "/turns/1/tools/3" });
    expect(byId("oversized_result")[0]).toMatchObject({ path: "/turns/1/tools/1/output" });
    expect(byId("duplicate_tool_call")[0]).toMatchObject({ path: "/turns/1/tools/2" });
    expect(byId("repeated_media")).toHaveLength(1);
    expect(byId("cache_miss")[0]).toMatchObject({ turn: 2, path: "/turns/2/calls/1" });
  });
});

describe("input resolution", () => {
  const config = {
    files: [],
    redact: [],
    sources: [{ name: "app", type: "cloudwatch-spans" as const, region: "eu-west-1", match: "example\\.com/chat/(?<id>[\\w-]+)" }],
  };

  test("extracts the conversation id from a link with the source pattern", () => {
    expect(resolveInput("https://example.com/chat/abc-123?x=1", config)).toMatchObject({ kind: "source", id: "abc-123" });
  });

  test("accepts an explicit source:id", () => {
    expect(resolveInput("app:xyz", config)).toMatchObject({ kind: "source", id: "xyz" });
  });

  test("explains what it tried when nothing matches", () => {
    expect(() => resolveInput("https://other.com/1", config)).toThrow(/Sources: app/);
  });
});

describe("redaction", () => {
  test("removes JWTs and AWS access keys before anything is cached or printed", () => {
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    expect(redact(`token ${jwt} key AKIAABCDEFGHIJKLMNOP`, DEFAULT_REDACTIONS)).toBe("token [redacted] key [redacted]");
  });
});

describe("steps", () => {
  test("numbers model calls and tool runs together, per turn, in time order", () => {
    const index = new StepIndex(sampleConversation());
    expect(index.steps(1).map((step) => (step.kind === "tool" ? step.tool.name : "model"))).toEqual(["model", "search", "search", "fetch", "model"]);
    expect(index.steps(2).map((step) => step.number)).toEqual([1, 2]);
  });

  test("links a tool result in the prompt back to the step that produced it", () => {
    const conversation = sampleConversation();
    const index = new StepIndex(conversation);
    const step = index.step(1, 5);
    if (step?.kind !== "model") throw new Error("expected a model step");
    const prompt = promptData(index, step);
    const result = prompt?.history.items.find((item) => item.label === "result of search");
    expect(result?.from).toEqual({ turn: 1, step: 2 });
    expect(result?.open).toBe("debrief turn 1 --step 2");
    expect(prompt?.unrecordedTokens).toBeGreaterThan(19000);
  });

  test("points flags at the step a person should open", () => {
    const conversation = sampleConversation();
    const index = new StepIndex(conversation);
    const flags = analyze(conversation, buildTree(conversation));
    const failure = flags.find((flag) => flag.id === "tool_error");
    if (!failure) throw new Error("expected a tool_error flag");
    expect(flagRef(failure, index)).toEqual({ ref: { turn: 1, step: 4 }, prompt: false });
  });

  test("finds text in tool input and model replies and says which step to open", () => {
    const conversation = sampleConversation();
    const index = new StepIndex(conversation);
    const hits = find(conversation, index, [], { text: "CTR is", errors: false });
    expect(hits).toEqual([expect.objectContaining({ turn: 2, step: 1, where: "model said", open: "debrief turn 2 --step 1" })]);
  });

  test("lists failed steps for find --errors", () => {
    const conversation = sampleConversation();
    const index = new StepIndex(conversation);
    const hits = find(conversation, index, analyze(conversation, buildTree(conversation)), { errors: true });
    expect(hits.map((hit) => hit.open)).toEqual(["debrief turn 1 --step 4"]);
  });
});
