export type AttributeValue = string | number | boolean | null | AttributeValue[];
export type Attributes = Record<string, AttributeValue>;

export interface SpanEvent {
  name: string;
  timeUnixNano: number;
  attributes: Attributes;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  scope?: string;
  startNano: number;
  endNano: number;
  status: "ok" | "error" | "unset";
  statusMessage?: string;
  attributes: Attributes;
  events: SpanEvent[];
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAnyValue[] };
}

function fromOtlpValue(value: OtlpAnyValue): AttributeValue {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(fromOtlpValue);
  return null;
}

function toAttributes(raw: unknown): Attributes {
  if (Array.isArray(raw)) {
    const result: Attributes = {};
    for (const entry of raw as OtlpKeyValue[]) result[entry.key] = fromOtlpValue(entry.value);
    return result;
  }
  if (raw && typeof raw === "object") return raw as Attributes;
  return {};
}

function toStatus(raw: unknown): { status: Span["status"]; message?: string } {
  const record = (raw ?? {}) as { code?: unknown; message?: string };
  const code = String(record.code ?? "").toUpperCase();
  if (code === "2" || code.includes("ERROR")) return { status: "error", message: record.message };
  if (code === "1" || code.includes("OK")) return { status: "ok" };
  return { status: "unset" };
}

interface RawSpanShape {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  status?: unknown;
  attributes?: unknown;
  events?: { name: string; timeUnixNano?: string | number; attributes?: unknown }[];
  scope?: { name?: string };
}

function fromRawSpan(raw: RawSpanShape, scopeName?: string): Span {
  const status = toStatus(raw.status);
  return {
    traceId: raw.traceId,
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId || undefined,
    name: raw.name,
    scope: raw.scope?.name ?? scopeName,
    startNano: Number(raw.startTimeUnixNano),
    endNano: Number(raw.endTimeUnixNano),
    status: status.status,
    statusMessage: status.message,
    attributes: toAttributes(raw.attributes),
    events: (raw.events ?? []).map((event) => ({
      name: event.name,
      timeUnixNano: Number(event.timeUnixNano ?? 0),
      attributes: toAttributes(event.attributes),
    })),
  };
}

interface OtlpExport {
  resourceSpans: { scopeSpans?: { scope?: { name?: string }; spans?: RawSpanShape[] }[] }[];
}

function isOtlpExport(value: unknown): value is OtlpExport {
  return Boolean(value && typeof value === "object" && "resourceSpans" in value);
}

function unwrapLogRecord(record: unknown): unknown {
  if (record && typeof record === "object" && typeof (record as Record<string, unknown>)["@message"] === "string") {
    return JSON.parse((record as Record<string, string>)["@message"] as string);
  }
  return record;
}

export function parseSpanRecords(records: unknown[]): Span[] {
  const spans: Span[] = [];
  for (const raw of records) {
    const record = unwrapLogRecord(raw);
    if (isOtlpExport(record)) {
      for (const resource of record.resourceSpans) {
        for (const scopeSpans of resource.scopeSpans ?? []) {
          for (const span of scopeSpans.spans ?? []) spans.push(fromRawSpan(span, scopeSpans.scope?.name));
        }
      }
    } else if (record && typeof record === "object" && "spanId" in record) {
      spans.push(fromRawSpan(record as RawSpanShape));
    }
  }
  return spans;
}

export function parseSpanText(text: string): Span[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return parseSpanRecords(JSON.parse(trimmed) as unknown[]);
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) return parseSpanRecords([JSON.parse(trimmed)]);
  const records = trimmed
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  return parseSpanRecords(records);
}

export function stringAttr(attributes: Attributes, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export function numberAttr(attributes: Attributes, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  }
  return undefined;
}
