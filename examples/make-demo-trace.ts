import { writeFileSync } from "node:fs";
import { textOf, parseParts } from "../src/content.ts";
import { countText } from "../src/tokens.ts";

type Json = Record<string, unknown>;

const SESSION = "demo-trip-42";
const START = Date.parse("2026-10-16T09:00:00.000Z") * 1e6;
let clockNano = START;
let idCounter = 0;
const spans: Json[] = [];

function id(): string {
  idCounter += 1;
  return idCounter.toString(16).padStart(16, "0");
}

function advance(ms: number): number {
  clockNano += ms * 1e6;
  return clockNano;
}

function blocks(...items: unknown[]): string {
  return JSON.stringify(items);
}

const SYSTEM = [
  "<role>",
  "You are Wayfarer, a travel assistant. You find and book flights for the user.",
  "</role>",
  "<tool_policy>",
  "Always search before you answer a question about prices or availability.",
  "If a tool fails, tell the user instead of guessing.",
  "</tool_policy>",
  "<booking_rules>",
  "Never book without the user's explicit confirmation.",
  "Quote prices in the currency the user used.",
  "</booking_rules>",
  "<style>",
  "Answer in two or three short sentences.",
  "</style>",
].join("\n");

const TOOLS = ["search_flights", "book_flight", "get_weather", "convert_currency"];

const airlines = ["TAP", "SAS", "Lufthansa", "KLM", "Iberia", "Ryanair", "easyJet", "Norwegian"];
const flights = Array.from({ length: 160 }, (_, index) => ({
  flight_id: `F${1000 + index}`,
  airline: airlines[index % airlines.length],
  depart: `2026-10-23T${String(6 + (index % 14)).padStart(2, "0")}:${index % 2 === 0 ? "05" : "40"}`,
  stops: index % 3 === 0 ? 0 : 1,
  price_eur: index === 87 ? 149 : 212 + ((index * 37) % 300),
  fare_rules: "Hand luggage only. Changes allowed for a fee. Seat selection at extra cost.",
}));

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

function agent(traceId: string, user: string): Json {
  const start = advance(5);
  const span: Json = {
    traceId,
    spanId: id(),
    name: "invoke_agent travel-agent",
    startTimeUnixNano: start,
    endTimeUnixNano: start,
    status: { code: "OK" },
    scope: { name: "example.agent.telemetry" },
    attributes: {
      "session.id": SESSION,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "travel-agent",
      "gen_ai.request.model": "example-large-model",
      "gen_ai.agent.tools": JSON.stringify(TOOLS),
    },
    events: [{ name: "gen_ai.user.message", timeUnixNano: start, attributes: { content: blocks({ text: user }) } }],
  };
  spans.push(span);
  return span;
}

function finish(span: Json): void {
  span.endTimeUnixNano = advance(5);
}

const TOOL_DEFINITION_TOKENS = 1200;
let previousInput = 0;

function inputTokens(history: Message[]): number {
  const content = [SYSTEM, ...history.map((message) => textOf(parseParts(message.content)))].join("\n");
  return countText(content) + TOOL_DEFINITION_TOKENS;
}

function chat(traceId: string, parent: Json, history: Message[], output: unknown[], finish: string, outputTokens: number, ms: number, cacheMiss = false): void {
  const input = inputTokens(history);
  const usage = { input, cacheRead: cacheMiss ? 0 : previousInput, output: outputTokens };
  previousInput = input;
  const start = advance(10);
  const end = advance(ms);
  spans.push({
    traceId,
    spanId: id(),
    parentSpanId: parent.spanId,
    name: "chat",
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    status: { code: "OK" },
    scope: { name: "example.agent.telemetry" },
    attributes: {
      "session.id": SESSION,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "example-large-model",
      "gen_ai.usage.input_tokens": usage.input,
      "gen_ai.usage.output_tokens": usage.output,
      "gen_ai.usage.cache_read_input_tokens": usage.cacheRead,
      "gen_ai.usage.cache_write_input_tokens": usage.input - usage.cacheRead,
    },
    events: [
      { name: "gen_ai.system.message", timeUnixNano: start, attributes: { content: blocks({ text: SYSTEM }, { cachePoint: { cacheType: "default" } }) } },
      ...history.map((message) => ({ name: `gen_ai.${message.role}.message`, timeUnixNano: start, attributes: { content: message.content } })),
      { name: "gen_ai.choice", timeUnixNano: end, attributes: { message: JSON.stringify(output), finish_reason: finish } },
    ],
  });
}

function tool(traceId: string, parent: Json, name: string, callId: string, input: unknown, result: unknown, ms: number, error?: string): void {
  const start = advance(5);
  const end = advance(ms);
  spans.push({
    traceId,
    spanId: id(),
    parentSpanId: parent.spanId,
    name: `execute_tool ${name}`,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    status: error ? { code: "ERROR", message: error } : { code: "OK" },
    scope: { name: "example.agent.telemetry" },
    attributes: {
      "session.id": SESSION,
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "gen_ai.tool.call.id": callId,
      "gen_ai.tool.status": error ? "error" : "success",
    },
    events: [
      { name: "gen_ai.tool.message", timeUnixNano: start, attributes: { content: JSON.stringify(input) } },
      { name: "gen_ai.choice", timeUnixNano: end, attributes: { message: blocks({ json: result }) } },
    ],
  });
}

const ask = (callId: string, name: string, input: unknown) => ({ type: "toolUse", name, toolUseId: callId, input: JSON.stringify(input) });
const use = (callId: string, name: string, input: unknown) => ({ toolUse: { toolUseId: callId, name, input } });
const result = (callId: string, value: unknown, status = "success") => ({ toolResult: { toolUseId: callId, status, content: [{ json: value }] } });

const query = { from: "ARN", to: "LIS", date: "2026-10-23" };
const timeout = { error: "upstream timeout (504) from the flight search provider" };
const reply1 = "The cheapest flight I found is TAP F1000 on Friday at 06:05 for €212, direct. Want me to book it?";
const reply2 = "You're right: Norwegian F1087 departs Friday at 09:40 for €149, direct. I missed it because I only looked at the first results. Shall I book it?";

const q1 = "Find me the cheapest flight from Stockholm to Lisbon next Friday.";
const t1 = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const a1 = agent(t1, q1);
let history: Message[] = [{ role: "user", content: blocks({ text: q1 }) }];
chat(t1, a1, history, [{ text: "I'll search for flights." }, ask("call-1", "search_flights", query)], "toolUse", 60, 2100);
tool(t1, a1, "search_flights", "call-1", query, timeout, 30000, "upstream timeout (504)");
history = [...history, { role: "assistant", content: blocks({ text: "I'll search for flights." }, use("call-1", "search_flights", query)) }, { role: "tool", content: blocks(result("call-1", timeout, "error")) }];
chat(t1, a1, history, [ask("call-2", "search_flights", query)], "toolUse", 40, 1500);
tool(t1, a1, "search_flights", "call-2", query, { results: flights }, 900);
history = [...history, { role: "assistant", content: blocks(use("call-2", "search_flights", query)) }, { role: "tool", content: blocks(result("call-2", { results: flights })) }];
chat(t1, a1, history, [{ text: reply1 }], "endTurn", 70, 4200);
finish(a1);

advance(9 * 60 * 1000);
const q2 = "Is there nothing cheaper? A friend found one for €149.";
const t2 = "b2c3d4e5f60718293a4b5c6d7e8f90a1";
const a2 = agent(t2, q2);
history = [...history, { role: "assistant", content: blocks({ text: reply1 }) }, { role: "user", content: blocks({ text: q2 }) }];
const cheap = { ...query, max_price_eur: 150 };
chat(t2, a2, history, [ask("call-3", "search_flights", cheap)], "toolUse", 50, 2600, true);
tool(t2, a2, "search_flights", "call-3", cheap, { results: flights.filter((flight) => flight.price_eur <= 150) }, 700);
history = [...history, { role: "assistant", content: blocks(use("call-3", "search_flights", cheap)) }, { role: "tool", content: blocks(result("call-3", { results: flights.filter((flight) => flight.price_eur <= 150) })) }];
chat(t2, a2, history, [{ text: reply2 }], "endTurn", 80, 2300);
finish(a2);

advance(40 * 1000);
const q3 = "Yes, book it.";
const t3 = "c3d4e5f60718293a4b5c6d7e8f90a1b2";
const a3 = agent(t3, q3);
history = [...history, { role: "assistant", content: blocks({ text: reply2 }) }, { role: "user", content: blocks({ text: q3 }) }];
const booking = { flight_id: "F1087", passengers: 1 };
chat(t3, a3, history, [ask("call-4", "book_flight", booking)], "toolUse", 40, 1800);
tool(t3, a3, "book_flight", "call-4", booking, { status: "confirmed", reference: "WYF-7Q2K" }, 1200);
history = [...history, { role: "assistant", content: blocks(use("call-4", "book_flight", booking)) }, { role: "tool", content: blocks(result("call-4", { status: "confirmed", reference: "WYF-7Q2K" })) }];
chat(t3, a3, history, [{ text: "Booked: Norwegian F1087 on Friday at 09:40 for €149. Your reference is WYF-7Q2K." }], "endTurn", 40, 1400);
finish(a3);

writeFileSync(new URL("./demo-trace.jsonl", import.meta.url), `${spans.map((span) => JSON.stringify(span)).join("\n")}\n`);
console.log(`wrote ${spans.length} spans`);
