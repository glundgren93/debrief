import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudWatchSourceConfig, Config, ResolvedInput } from "../config.ts";
import { parseSpanText, type Span } from "../spans.ts";
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

export function redact(text: string, patterns: string[]): string {
  return patterns.reduce((current, pattern) => current.replace(new RegExp(pattern, "g"), "[redacted]"), text);
}

export async function load(resolved: ResolvedInput, config: Config, options: LoadOptions): Promise<Loaded> {
  prepareCache(options.cacheTtlMs);
  if (resolved.kind === "file") {
    const text = redact(readFileSync(resolved.path, "utf8"), config.redact);
    return { spans: parseSpanText(text), sourceName: "file", warnings: [], fromCache: false };
  }
  const path = cachePath(resolved.source, resolved.id);
  if (!options.refresh && existsSync(path) && Date.now() - statSync(path).mtimeMs < options.cacheTtlMs) {
    return { spans: parseSpanText(readFileSync(path, "utf8")), sourceName: resolved.source.name, warnings: [], fromCache: true };
  }
  const result = await fetchCloudWatchSpans(resolved.source, resolved.id);
  const text = redact(result.records.join("\n"), config.redact);
  if (result.records.length > 0) {
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return { spans: text.trim() ? parseSpanText(text) : [], sourceName: resolved.source.name, warnings: result.warnings, fromCache: false };
}
