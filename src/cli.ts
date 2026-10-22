#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, resolveInput } from "./config.ts";
import { buildConversation } from "./normalize.ts";
import { cacheDir, load } from "./sources/index.ts";
import { StepIndex } from "./steps.ts";
import {
  BIN,
  find,
  promptData,
  renderFind,
  renderFullPrompt,
  renderPrompt,
  renderStep,
  renderSummary,
  renderTurn,
  stepData,
  summaryData,
  turnData,
} from "./views.ts";

const HELP = `${BIN}: find out what happened in an AI agent chat

  ${BIN} <chat>                       load a chat and summarize it (it stays loaded)
  ${BIN}                              summarize the loaded chat again
  ${BIN} turn N                       the steps in turn N on a timeline (start, duration, what ran in parallel)
  ${BIN} turn N --all                 every step in turn N, in full
  ${BIN} turn N --step S              one step in full
  ${BIN} turn N --step S --prompt     what the model received at that step: every part, in order, with sizes
        --full                     all of it, verbatim
        --section NAME             one system prompt section, verbatim
        --message N                one message item, verbatim
  ${BIN} find TEXT                    steps that mention TEXT
  ${BIN} find --errors                failed tool runs and turns with an error status

  <chat> is a chat link your config knows about, <source>:<id>, or a trace file.
  Every view ends with the next command to run.

  --json      machine-readable output
  --full      do not shorten long text (with --prompt: print everything the model received)
  --refresh   fetch the chat again instead of using the 24 h cache

examples
  ${BIN} 'https://app.example.com/chat/abc123'
  ${BIN} turn 5
  ${BIN} turn 5 --step 3
  ${BIN} turn 5 --step 4 --prompt --section data_grounding
  ${BIN} find CTR

config: .${BIN}.yaml in this or a parent directory, $DEBRIEF_CONFIG, or ~/.config/${BIN}/config.yaml`;

const COMMANDS = ["turn", "find", "help"];

class UsageError extends Error {}
class NotFoundError extends Error {}

function currentFile(): string {
  return `${cacheDir()}/current.json`;
}

function readCurrent(): string | undefined {
  if (!existsSync(currentFile())) return undefined;
  return (JSON.parse(readFileSync(currentFile(), "utf8")) as { chat?: string }).chat;
}

function writeCurrent(chat: string): void {
  mkdirSync(dirname(currentFile()), { recursive: true, mode: 0o700 });
  writeFileSync(currentFile(), JSON.stringify({ chat, openedAt: new Date().toISOString() }), { mode: 0o600 });
}

function looksLikeChat(value: string): boolean {
  return existsSync(value) || value.includes("/") || value.includes(":");
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function closestCommand(word: string): string | undefined {
  return COMMANDS.find((command) => editDistance(word, command) <= 2);
}

function positiveInt(value: string | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`${what} must be a number from 1, got "${value}"`);
  return parsed;
}

async function loadChat(chat: string, refresh: boolean) {
  const config = loadConfig();
  const resolved = resolveInput(chat, config);
  const loaded = await load(resolved, config, { refresh, cacheTtlMs: 24 * 3600 * 1000 });
  for (const warning of loaded.warnings) console.error(`warning: ${warning}`);
  if (loaded.spans.length === 0) throw new NotFoundError(`No traces found for ${resolved.id} in ${loaded.sourceName}.`);
  const conversation = buildConversation(resolved.id, loaded.sourceName, loaded.spans);
  return { conversation, index: new StepIndex(conversation) };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      step: { type: "string", short: "s" },
      prompt: { type: "boolean", default: false },
      section: { type: "string" },
      message: { type: "string" },
      errors: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [first, second] = positionals;
  const print = (text: string, data: unknown) => console.log(values.json ? JSON.stringify(data, null, 2) : text);
  const limit = { maxChars: values.full ? undefined : 4000 };

  if (values.help || first === "help") {
    console.log(HELP);
    return 0;
  }

  if (first && !COMMANDS.includes(first)) {
    if (!looksLikeChat(first)) {
      const guess = closestCommand(first);
      throw new UsageError(`"${first}" is not a command or a chat link.${guess ? ` Did you mean "${guess}"?` : ""} Run: ${BIN} help`);
    }
    const loaded = await loadChat(first, values.refresh);
    writeCurrent(first);
    const data = summaryData(loaded.conversation, loaded.index);
    print(renderSummary(data), data);
    return 0;
  }

  const chat = readCurrent();
  if (!chat) throw new UsageError(`No chat loaded yet. Run: ${BIN} '<chat link>'`);
  const { conversation, index } = await loadChat(chat, values.refresh);

  if (!first) {
    const data = summaryData(conversation, index);
    print(renderSummary(data), data);
    return 0;
  }

  if (first === "find") {
    if (!second && !values.errors) throw new UsageError(`usage: ${BIN} find TEXT   or   ${BIN} find --errors`);
    const hits = find(conversation, index, { text: second, errors: values.errors });
    print(renderFind(hits), hits);
    return 0;
  }

  const turnCount = conversation.turns.length;
  const turn = positiveInt(second, "turn") ?? turnCount;
  if (turn > turnCount) throw new NotFoundError(`There is no turn ${turn}; this chat has ${turnCount} turn${turnCount === 1 ? "" : "s"}.`);
  const stepCount = index.steps(turn).length;
  const stepNumber = positiveInt(values.step, "--step");

  if (stepNumber === undefined) {
    if (values.prompt || values.section || values.message) throw new UsageError(`--prompt needs a step: ${BIN} turn ${turn} --step S --prompt`);
    if (values.all) {
      const steps = index.steps(turn).map((step) => stepData(conversation, index, step));
      print(steps.map((step) => renderStep(step, limit)).join("\n\n────────\n\n"), steps);
      return 0;
    }
    const data = turnData(conversation, index, turn);
    print(renderTurn(data), data);
    return 0;
  }

  const step = index.step(turn, stepNumber);
  if (!step) throw new NotFoundError(`There is no step ${stepNumber} in turn ${turn}; it has ${stepCount} step${stepCount === 1 ? "" : "s"}. See: ${BIN} turn ${turn}`);

  if (values.prompt || values.section || values.message) {
    if (step.kind !== "model") throw new UsageError(`Step ${stepNumber} is a tool run, not a model call; only model calls have a prompt. See: ${BIN} turn ${turn}`);
    const data = promptData(index, step);
    if (!data) throw new NotFoundError(`The prompt for turn ${turn} step ${stepNumber} was not recorded.`);
    if (values.section) {
      const section = data.system.sections.find((item) => item.name === values.section);
      if (!section) {
        const names = data.system.sections.map((item) => item.name);
        const close = names.filter((name) => name.includes(values.section ?? "") || (values.section ?? "").includes(name));
        throw new NotFoundError(`No section "${values.section}".${close.length > 0 ? ` Did you mean: ${close.join(", ")}?` : ""} Sections: ${names.join(", ")}`);
      }
      print(section.text, { turn, step: stepNumber, section: section.name, tokens: section.tokens, text: section.text });
      return 0;
    }
    if (values.message) {
      const number = positiveInt(values.message, "--message");
      const item = data.messages.items.find((candidate) => candidate.number === number);
      if (!item) throw new NotFoundError(`There is no message item ${values.message}; this prompt has ${data.messages.items.length}. See: ${data.open}`);
      print(item.text, { turn, step: stepNumber, ...item });
      return 0;
    }
    print(values.full ? renderFullPrompt(data) : renderPrompt(data), data);
    return 0;
  }

  const data = stepData(conversation, index, step);
  print(renderStep(data, limit), data);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof NotFoundError ? 2 : 1);
  });
