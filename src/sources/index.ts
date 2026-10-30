import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudWatchSourceConfig, Config, ResolvedInput } from "../config.ts";
import { parseSpanText, type AttributeValue, type Attributes, type Span } from "../spans.ts";
import { fetchCloudWatchSpans } from "./cloudwatch-spans.ts";

export interface LoadOptions {
  refresh: boolean;
  cacheTtlMs: number;
}

export interface Loaded {
  spans: Span[];
  sourceName: string;
  warnings: string[];
  fromCache: boolean;
  fetchedAt?: number;
}

interface CacheEntry {
  fetchedAt: number;
  warnings: string[];
  spans: string;
}

export function cacheDir(): string {
  return process.env.DEBRIEF_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "debrief");
}

export function cachePath(source: CloudWatchSourceConfig, id: string): string {
  const resolved = {
    type: source.type,
    region: source.region,
    logGroup: source.logGroup ?? "aws/spans",
    attribute: source.attribute ?? "session.id",
    lookbackDays: source.lookbackDays ?? 30,
    profile: source.profile ?? null,
    credentialProcess: source.credentialProcess ?? null,
  };
  const key = createHash("sha256").update(JSON.stringify({ resolved, id })).digest("hex").slice(0, 24);
  return join(cacheDir(), `${key}.jsonl`);
}

function prepareCache(cacheTtlMs: number): void {
  const directory = cacheDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const cutoff = Date.now() - cacheTtlMs;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    const stats = statSync(path);
    if (stats.mtimeMs < cutoff) {
      unlinkSync(path);
    } else {
      chmodSync(path, 0o600);
    }
  }
}

function readCache(path: string): CacheEntry | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const entry = value as { fetchedAt?: unknown; warnings?: unknown; spans?: unknown };
    if (typeof entry.fetchedAt !== "number" || !Array.isArray(entry.warnings) || !entry.warnings.every((warning) => typeof warning === "string") || typeof entry.spans !== "string") {
      return undefined;
    }
    return { fetchedAt: entry.fetchedAt, warnings: entry.warnings, spans: entry.spans };
  } catch {
    return undefined;
  }
}

export function redact(text: string, patterns: string[]): string {
  return patterns.reduce((current, pattern) => current.replace(new RegExp(pattern, "g"), "[redacted]"), text);
}

function redactAttributeValue(value: AttributeValue, patterns: string[]): AttributeValue {
  if (typeof value === "string") return redact(value, patterns);
  if (Array.isArray(value)) return value.map((item) => redactAttributeValue(item, patterns));
  return value;
}

function redactAttributes(attributes: Attributes, patterns: string[]): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) result[key] = redactAttributeValue(value, patterns);
  return result;
}

export function redactSpans(spans: Span[], patterns: string[]): Span[] {
  return spans.map((span) => ({
    ...span,
    attributes: redactAttributes(span.attributes, patterns),
    events: span.events.map((event) => ({ ...event, attributes: redactAttributes(event.attributes, patterns) })),
  }));
}

function parseAndRedact(text: string, patterns: string[]): Span[] {
  return redactSpans(parseSpanText(text), patterns);
}

function parseCachedSpans(text: string, patterns: string[]): Span[] {
  const records = text
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  if (records.every((record) => record && typeof record === "object" && "startNano" in record)) {
    return redactSpans(records as Span[], patterns);
  }
  return parseAndRedact(text, patterns);
}

export async function load(resolved: ResolvedInput, config: Config, options: LoadOptions): Promise<Loaded> {
  if (resolved.kind === "file") {
    const text = redact(readFileSync(resolved.path, "utf8"), config.redact);
    return { spans: parseAndRedact(text, config.redact), sourceName: "file", warnings: [], fromCache: false };
  }
  prepareCache(options.cacheTtlMs);
  const path = cachePath(resolved.source, resolved.id);
  if (!options.refresh && existsSync(path)) {
    const cached = readCache(path);
    if (cached && Date.now() - cached.fetchedAt < options.cacheTtlMs) {
      return {
        spans: parseCachedSpans(cached.spans, config.redact),
        sourceName: resolved.source.name,
        warnings: cached.warnings,
        fromCache: true,
        fetchedAt: cached.fetchedAt,
      };
    }
  }
  const result = await fetchCloudWatchSpans(resolved.source, resolved.id);
  const text = redact(result.records.join("\n"), config.redact);
  const spans = text.trim() ? parseAndRedact(text, config.redact) : [];
  const fetchedAt = Date.now();
  if (result.records.length > 0) {
    const cached: CacheEntry = { fetchedAt, warnings: result.warnings, spans: spans.map((span) => JSON.stringify(span)).join("\n") };
    writeFileSync(path, JSON.stringify(cached), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return { spans, sourceName: resolved.source.name, warnings: result.warnings, fromCache: false, fetchedAt };
}
