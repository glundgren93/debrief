import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { StepIndex, timelineGaps } from "../src/steps.ts";
import { commandsFor, find, promptData, renderStep, renderSummary, renderTurn, stepData, summaryData, turnData } from "../src/views.ts";
import { DEFAULT_REDACTIONS, resolveInput } from "../src/config.ts";
import { parseOtelMessages, parseParts } from "../src/content.ts";
import { buildConversation, splitSections } from "../src/normalize.ts";
import { cachePath, load, redact, redactSpans } from "../src/sources/index.ts";
import { parseSpanRecords, parseSpanText } from "../src/spans.ts";
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

  test("records failed model calls and excludes their missing usage from capture gaps", () => {
    const agent = agentSpan("t", "q");
    const failed = span({
      traceId: "t",
      parent: agent,
      name: "chat",
      status: "error",
      statusMessage: "Model access is denied",
      attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "model-x" },
      events: [{ name: "gen_ai.user.message", attributes: { content: blocks({ text: "q" }) } }],
    });
    const conversation = buildConversation("c", "test", [agent, failed]);
    expect(conversation.turns[0]?.calls[0]).toMatchObject({ status: "error", error: "Model access is denied" });
    expect(conversation.turns[0]?.status).toBe("error");
    expect(conversation.gaps.some((gap) => gap.what.includes("token usage"))).toBe(false);
  });

  test("uses exception messages and lists each failed span once", () => {
    const agent = agentSpan("t", "q");
    const failed = span({
      traceId: "t",
      parent: agent,
      name: "tool.dispatch",
      status: "error",
      events: [{ name: "exception", attributes: { "exception.message": "connector_not_enabled" } }],
    });
    const conversation = buildConversation("c", "test", [agent, failed]);
    const hits = find(conversation, new StepIndex(conversation), { errors: true }, commandsFor("c"));
    expect(hits).toEqual([expect.objectContaining({ where: "span tool.dispatch failed", snippet: "connector_not_enabled", open: "debrief c turn 1" })]);
  });

  test("uses the first result line for a tool error without a status message", () => {
    const agent = agentSpan("t", "q");
    const failed = toolSpan("t", agent, "fetch", { id: 1 }, "Client error: status 404\nnot found", "error");
    const conversation = buildConversation("c", "test", [agent, failed]);
    expect(conversation.turns[0]?.tools[0]?.error).toBe("Client error: status 404");
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

  test("redacts short-segment JWTs", () => {
    expect(redact("token eyJx.eA.", DEFAULT_REDACTIONS)).toBe("token [redacted]");
  });

  test("redacts decoded span and event attribute values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "debrief-redaction-"));
    const path = join(dir, "escaped.json");
    writeFileSync(
      path,
      '{"traceId":"t","spanId":"s","name":"chat","startTimeUnixNano":1,"endTimeUnixNano":2,"attributes":{"token":"\\u0041KIAABCDEFGHIJKLMNOP"},"events":[{"name":"event","attributes":{"token":"\\u0041SIAABCDEFGHIJKLMNOP"}}]}',
    );
    const loaded = await load(
      { kind: "file", path, id: "escaped.json" },
      { files: [], redact: DEFAULT_REDACTIONS, sources: [] },
      { refresh: false, cacheTtlMs: 0 },
    );
    expect(loaded.spans[0]?.attributes.token).toBe("[redacted]");
    expect(loaded.spans[0]?.events[0]?.attributes.token).toBe("[redacted]");
  });

  test("redacts strings nested in attribute arrays", () => {
    const spans = redactSpans(
      [
        {
          traceId: "t",
          spanId: "s",
          name: "chat",
          startNano: 1,
          endNano: 2,
          status: "ok",
          attributes: { tokens: ["AKIAABCDEFGHIJKLMNOP"] },
          events: [],
        },
      ],
      DEFAULT_REDACTIONS,
    );
    expect(spans[0]?.attributes.tokens).toEqual(["[redacted]"]);
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
    const prompt = promptData(index, step, commandsFor("c"));
    const result = prompt?.messages.items.find((item) => item.label === "result of search");
    expect(result?.from).toBe("debrief c turn 1 --step 2");
    expect(prompt?.unrecordedTokens).toBeGreaterThan(19000);
  });

  test("finds text in tool input and model replies and says which step to open", () => {
    const conversation = sampleConversation();
    const index = new StepIndex(conversation);
    const hits = find(conversation, index, { text: "CTR is", errors: false }, commandsFor("c"));
    expect(hits).toEqual([expect.objectContaining({ turn: 2, step: 1, where: "model said", open: "debrief c turn 2 --step 1" })]);
  });

  test("lists failed steps for find --errors", () => {
    const conversation = sampleConversation();
    const index = new StepIndex(conversation);
    const hits = find(conversation, index, { errors: true }, commandsFor("c"));
    expect(hits.map((hit) => hit.open)).toEqual(["debrief c turn 1 --step 4"]);
  });

  test("searches model and tool error text", () => {
    const agent = agentSpan("t", "q");
    const failedModel = span({
      traceId: "t",
      parent: agent,
      name: "chat",
      status: "error",
      statusMessage: "stream ended unexpectedly",
      attributes: { "gen_ai.operation.name": "chat" },
      events: [{ name: "gen_ai.user.message", attributes: { content: blocks({ text: "q" }) } }],
    });
    const conversation = buildConversation("c", "test", [agent, failedModel]);
    const hits = find(conversation, new StepIndex(conversation), { text: "unexpected", errors: false }, commandsFor("c"));
    expect(hits).toEqual([expect.objectContaining({ where: "model error", step: 1 })]);
  });

  test("renders failed model steps with status and error in both views", () => {
    const agent = agentSpan("t", "q");
    const failedModel = span({
      traceId: "t",
      parent: agent,
      name: "chat",
      status: "error",
      statusMessage: "stream ended unexpectedly",
      attributes: { "gen_ai.operation.name": "chat" },
      events: [{ name: "gen_ai.user.message", attributes: { content: blocks({ text: "q" }) } }],
    });
    const conversation = buildConversation("c", "test", [agent, failedModel]);
    const index = new StepIndex(conversation);
    const step = index.step(1, 1);
    if (!step) throw new Error("expected failed model step");
    const data = stepData(conversation, index, step, commandsFor("c"));
    expect(data).toMatchObject({ status: "error", error: "stream ended unexpectedly" });
    expect(renderStep(data, {})).toContain("error");
    expect(renderTurn(turnData(conversation, index, 1, commandsFor("c")))).toContain("model (failed)");
  });

  test("marks errored gap spans in grouped timeline counts", () => {
    const agent = agentSpan("t", "q");
    const call = chatSpan("t", agent, [{ role: "user", content: blocks({ text: "q" }) }], blocks({ text: "a" }), { input: 1 });
    const gets = [0, 1, 2, 3].map((index) => span({ traceId: "t", parent: agent, name: "GET", gapMs: index === 0 ? 1100 : 10, status: index === 0 ? "error" : "ok", statusMessage: index === 0 ? "upstream failed" : undefined }));
    const conversation = buildConversation("c", "test", [agent, call, ...gets]);
    expect(renderTurn(turnData(conversation, new StepIndex(conversation), 1, commandsFor("c")))).toContain("GET ×4 (1 failed)");
  });

  test("labels interrupted turns and pending tools without results", () => {
    const agent = agentSpan("t", "q");
    const interrupt = span({ traceId: "t", parent: agent, name: "execute_agent_loop_cycle", status: "error", statusMessage: "Interrupt raised: approval" });
    const pending = { ...span({ traceId: "t", parent: interrupt, name: "execute_tool fetch" }), status: "unset" as const };
    const conversation = buildConversation("c", "test", [agent, interrupt, pending]);
    expect(conversation.turns[0]).toMatchObject({ status: "interrupted", interruption: "approval" });
    expect(conversation.turns[0]?.tools[0]?.status).toBe("unknown");
    const index = new StepIndex(conversation);
    expect(renderTurn(turnData(conversation, index, 1, commandsFor("c")))).toContain("interrupted: approval");
    expect(renderTurn(turnData(conversation, index, 1, commandsFor("c")))).toContain("no result recorded");
    expect(find(conversation, index, { errors: true }, commandsFor("c"))).toEqual([]);
  });
});

function at<T extends { startNano: number; endNano: number }>(item: T, startMs: number, durationMs: number, origin: number): T {
  return { ...item, startNano: origin + startMs * 1e6, endNano: origin + (startMs + durationMs) * 1e6 };
}

function parallelTurn() {
  const root = span({ traceId: "t", name: "agent_streaming", durationMs: 6000 });
  const origin = root.startNano;
  const setup = at(span({ traceId: "t", name: "DynamoDB.GetItem", parent: root }), 10, 5, origin);
  const fetch = at(span({ traceId: "t", name: "GET", parent: root, attributes: { "url.full": "https://context.example.com/skills" } }), 20, 300, origin);
  const titleAgent = { ...at(agentSpan("t", "hi"), 750, 900, origin), parentSpanId: root.spanId };
  const mainAgent = { ...at(agentSpan("t", "hi"), 760, 4800, origin), parentSpanId: root.spanId };
  const title = at(chatSpan("t", titleAgent, [{ role: "system", content: blocks({ text: "Title it." }) }, { role: "user", content: blocks({ text: "<first_message>\nhi\n</first_message>" }) }], blocks({ text: "General Chat" }), { input: 40 }), 760, 890, origin);
  const main = at(chatSpan("t", mainAgent, [{ role: "system", content: blocks({ text: "<role>\nHelp.\n</role>\n\n<rules>\nBe brief.\n</rules>" }) }, { role: "user", content: blocks({ text: "hi" }) }], blocks({ text: "Hello!" }), { input: 500, cacheWrite: 480 }), 770, 4800, origin);
  const persist = at(span({ traceId: "t", name: "S3.PutObject", parent: root }), 5600, 80, origin);
  return buildConversation("c", "test", [root, setup, fetch, titleAgent, mainAgent, title, main, persist]);
}

describe("timeline", () => {
  test("says which steps ran at the same time instead of implying they ran one after another", () => {
    const index = new StepIndex(parallelTurn());
    expect(index.steps(1).map((step) => ({ step: step.number, offsetMs: step.offsetMs, alongside: step.alongside }))).toEqual([
      { step: 1, offsetMs: 760, alongside: [2] },
      { step: 2, offsetMs: 770, alongside: [1] },
    ]);
  });

  test("accounts for time with no model or tool step and the other spans that start in it", () => {
    const conversation = parallelTurn();
    const index = new StepIndex(conversation);
    const turn = conversation.turns[0];
    if (!turn) throw new Error("expected a turn");
    const gaps = timelineGaps(turn, index.steps(1));
    expect(gaps.map((gap) => ({ offsetMs: gap.offsetMs, durationMs: gap.durationMs, spans: gap.otherSpans.map((other) => other.name) }))).toEqual([
      { offsetMs: 0, durationMs: 760, spans: ["DynamoDB.GetItem", "GET context.example.com"] },
      { offsetMs: 5570, durationMs: 430, spans: ["S3.PutObject"] },
    ]);
  });

  test("leaves out spans that only wrap steps, such as the turn root", () => {
    const turn = parallelTurn().turns[0];
    expect(turn?.otherSpans.map((other) => other.name)).toEqual(["DynamoDB.GetItem", "GET context.example.com", "S3.PutObject"]);
  });

  test("reports the turn's timeline in turn view data", () => {
    const conversation = parallelTurn();
    const data = turnData(conversation, new StepIndex(conversation), 1, commandsFor("c"));
    expect(data.withoutSteps[0]?.otherSpans[1]).toMatchObject({ name: "GET context.example.com", offsetMs: 20, durationMs: 300 });
  });
});

describe("prompt contents", () => {
  test("numbers every message item and keeps its text verbatim, including wrappers", () => {
    const conversation = parallelTurn();
    const index = new StepIndex(conversation);
    const step = index.step(1, 1);
    if (step?.kind !== "model") throw new Error("expected a model step");
    const prompt = promptData(index, step, commandsFor("c"));
    expect(prompt?.messages.items).toEqual([
      expect.objectContaining({ number: 1, role: "user", text: "<first_message>\nhi\n</first_message>", open: "debrief c turn 1 --step 1 --prompt --message 1" }),
    ]);
  });

  test("keeps the system prompt exactly as sent alongside its sections", () => {
    const conversation = parallelTurn();
    const index = new StepIndex(conversation);
    const step = index.step(1, 2);
    if (step?.kind !== "model") throw new Error("expected a model step");
    const prompt = promptData(index, step, commandsFor("c"));
    expect(prompt?.system.text).toBe("<role>\nHelp.\n</role>\n\n<rules>\nBe brief.\n</rules>");
    expect(prompt?.system.sections.map((section) => section.name)).toEqual(["role", "rules"]);
    expect(prompt?.usage).toMatchObject({ cacheWriteTokens: 480 });
  });

  test("numbers message labels after tool results are split into items", () => {
    const agent = agentSpan("labels", "first");
    const call = chatSpan(
      "labels",
      agent,
      [
        { role: "user", content: blocks({ text: "first" }) },
        { role: "tool", content: blocks({ toolResult: { toolUseId: "missing-1", content: [{ json: { first: true } }] } }, { toolResult: { toolUseId: "missing-2", content: [{ json: { second: true } }] } }) },
        { role: "user", content: blocks({ text: "later" }) },
        { role: "assistant", content: blocks({ text: "unmatched" }) },
      ],
      blocks({ text: "answer" }),
      { input: 10 },
    );
    const conversation = buildConversation("labels", "test", [agent, call]);
    const index = new StepIndex(conversation);
    const step = index.step(1, 1);
    if (step?.kind !== "model") throw new Error("expected a model step");
    const prompt = promptData(index, step, commandsFor("c"));
    expect(prompt?.messages.items.map((item) => item.label)).toEqual([
      "user message, turn 1",
      "result of a tool",
      "result of a tool",
      "user message 4",
      "model reply (message 5, no matching step)",
    ]);
  });
});

describe("cached source metadata", () => {
  test("returns cached warnings and the fetch time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "debrief-cache-test-"));
    const previous = process.env.DEBRIEF_CACHE_DIR;
    process.env.DEBRIEF_CACHE_DIR = dir;
    try {
      const source = { name: "app", type: "cloudwatch-spans" as const, region: "eu-west-1" };
      const id = "chat-1";
      const fetchedAt = Date.now() - 1000;
      const spans = JSON.stringify({ traceId: "trace", spanId: "span", name: "root", startTimeUnixNano: 1, endTimeUnixNano: 2 });
      writeFileSync(cachePath(source, id), JSON.stringify({ fetchedAt, warnings: ["later turns may be missing"], spans }));
      const loaded = await load(
        { kind: "source", source, id },
        { sources: [source], redact: [], files: [] },
        { refresh: false, cacheTtlMs: 24 * 3600 * 1000 },
      );
      expect(loaded.fromCache).toBe(true);
      expect(loaded.warnings).toEqual(["later turns may be missing"]);
      expect(loaded.fetchedAt).toBe(fetchedAt);
      expect(loaded.spans).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.DEBRIEF_CACHE_DIR;
      else process.env.DEBRIEF_CACHE_DIR = previous;
    }
  });

  test("marks cached output in text and JSON view data", () => {
    const conversation = sampleConversation();
    const cache = { fromCache: true, fetchedAt: Date.now() - 125_000 };
    const data = summaryData(conversation, new StepIndex(conversation), commandsFor("c"), cache);
    expect(data.fromCache).toBe(true);
    expect(renderSummary(data, cache).split("\n")[0]).toContain("cached 2m ago · --refresh to fetch again");
  });
});

describe("naming the chat", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const demo = new URL("../examples/demo-trace.jsonl", import.meta.url).pathname;

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "debrief-test-"));
    const other = join(dir, "other-chat.jsonl");
    copyFileSync(demo, other);
    const run = (args: string[], options: { cwd?: string } = {}) => {
      const result = Bun.spawnSync(["bun", cli, ...args], {
        cwd: options.cwd ?? dir,
        env: { ...process.env, DEBRIEF_CACHE_DIR: join(dir, "cache") },
      });
      return { out: result.stdout.toString(), err: result.stderr.toString(), code: result.exitCode };
    };
    return { dir, other, run };
  }

  test("each command reads only the chat it names, so earlier commands do not change it", () => {
    const { other, run } = setup();
    run([demo]);
    expect(run([other, "turn", "1"]).out.split("\n")[0]).toStartWith("chat other-chat.jsonl · turn 1");
    expect(run([demo, "turn", "1"]).out.split("\n")[0]).toStartWith("chat demo-trace.jsonl · turn 1");
  });

  test("next commands repeat the chat as it was given", () => {
    const { run } = setup();
    expect(run(["other-chat.jsonl", "turn", "1"]).out).toContain("next: debrief other-chat.jsonl turn 1 --step N");
  });

  test("a command without a chat says to give the chat first", () => {
    const { run } = setup();
    const result = run(["turn", "1"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Give the chat first: debrief '<chat link>' turn 1");
  });

  test("suggests the closest command for a typo after the chat", () => {
    const { other, run } = setup();
    const result = run([other, "tunr", "1"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Did you mean "turn"?');
  });

  test("quotes chat links with shell characters in next commands", () => {
    expect(commandsFor("https://app.example.com/chat/abc?x=1&y=2").turn(1)).toBe("debrief 'https://app.example.com/chat/abc?x=1&y=2' turn 1");
  });
});
