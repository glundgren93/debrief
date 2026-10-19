import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export interface CloudWatchSourceConfig {
  name: string;
  type: "cloudwatch-spans";
  match?: string;
  region: string;
  logGroup?: string;
  attribute?: string;
  lookbackDays?: number;
  profile?: string;
  credentialProcess?: string;
}

export type SourceConfig = CloudWatchSourceConfig;

export interface Config {
  sources: SourceConfig[];
  redact: string[];
  files: string[];
}

export const DEFAULT_REDACTIONS = [
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  "(?:AKIA|ASIA)[A-Z0-9]{16}",
];

const PROJECT_FILE = ".debrief.yaml";

function projectConfigPath(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, PROJECT_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readConfigFile(path: string): Partial<Config> {
  const parsed = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<Config>;
  return parsed;
}

function validate(source: SourceConfig, file: string): SourceConfig {
  if (!source.name) throw new Error(`${file}: every source needs a name`);
  if (source.type !== "cloudwatch-spans") throw new Error(`${file}: source ${source.name} has unsupported type ${String(source.type)}`);
  if (!source.region) throw new Error(`${file}: source ${source.name} needs a region`);
  return source;
}

export function loadConfig(explicitPath?: string, cwd = process.cwd()): Config {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [process.env.DEBRIEF_CONFIG, projectConfigPath(cwd), join(homedir(), ".config", "debrief", "config.yaml")].filter(
        (path): path is string => Boolean(path && existsSync(path)),
      );
  const config: Config = { sources: [], redact: [...DEFAULT_REDACTIONS], files: [] };
  for (const file of [...new Set(candidates)]) {
    const partial = readConfigFile(file);
    for (const source of partial.sources ?? []) {
      if (!config.sources.some((existing) => existing.name === source.name)) config.sources.push(validate(source, file));
    }
    config.redact.push(...(partial.redact ?? []));
    config.files.push(file);
  }
  return config;
}

export type ResolvedInput =
  | { kind: "file"; path: string; id: string }
  | { kind: "source"; source: SourceConfig; id: string };

export function resolveInput(input: string, config: Config): ResolvedInput {
  if (existsSync(input)) return { kind: "file", path: resolve(input), id: input.split("/").pop() ?? input };
  const explicit = /^([\w.-]+):(?!\/\/)(.+)$/.exec(input);
  if (explicit) {
    const source = config.sources.find((candidate) => candidate.name === explicit[1]);
    if (source && explicit[2]) return { kind: "source", source, id: explicit[2] };
  }
  for (const source of config.sources) {
    if (!source.match) continue;
    const match = new RegExp(source.match).exec(input);
    const id = match?.groups?.id ?? match?.[1];
    if (id) return { kind: "source", source, id };
  }
  const known = config.sources.map((source) => source.name).join(", ") || "none configured";
  throw new Error(
    `Could not resolve "${input}". It is not a file, does not match any source pattern, and is not <source>:<id>. Sources: ${known}. Config files: ${config.files.join(", ") || "none found"}.`,
  );
}
