import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, ResolvedInput } from "../config.ts";
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

function cachePath(sourceName: string, id: string): string {
  const key = createHash("sha256").update(`${sourceName}:${id}`).digest("hex").slice(0, 24);
  return join(cacheDir(), `${sourceName}-${key}.jsonl`);
}

export function redact(text: string, patterns: string[]): string {
  return patterns.reduce((current, pattern) => current.replace(new RegExp(pattern, "g"), "[redacted]"), text);
}

export async function load(resolved: ResolvedInput, config: Config, options: LoadOptions): Promise<Loaded> {
  if (resolved.kind === "file") {
    const text = redact(readFileSync(resolved.path, "utf8"), config.redact);
    return { spans: parseSpanText(text), sourceName: "file", warnings: [], fromCache: false };
  }
  const path = cachePath(resolved.source.name, resolved.id);
  if (!options.refresh && existsSync(path) && Date.now() - statSync(path).mtimeMs < options.cacheTtlMs) {
    return { spans: parseSpanText(readFileSync(path, "utf8")), sourceName: resolved.source.name, warnings: [], fromCache: true };
  }
  const result = await fetchCloudWatchSpans(resolved.source, resolved.id);
  const text = redact(result.records.join("\n"), config.redact);
  if (result.records.length > 0) {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  }
  return { spans: text.trim() ? parseSpanText(text) : [], sourceName: resolved.source.name, warnings: result.warnings, fromCache: false };
}
