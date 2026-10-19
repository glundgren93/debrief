import { createHash } from "node:crypto";
import type { Message, Part, Role } from "./model.ts";

type Json = unknown;

function parseMaybeJson(value: Json): Json {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asRecord(value: Json): Record<string, Json> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : undefined;
}

function imageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1] ?? 0;
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

export function mediaPart(mediaType: string, base64: string): Part {
  const bytes = Buffer.from(base64, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { kind: "media", mediaType, bytes: bytes.length, digest, ...imageDimensions(bytes) };
}

function converseImage(image: Record<string, Json>): Part {
  const format = typeof image.format === "string" ? image.format : "unknown";
  const source = asRecord(parseMaybeJson(image.source));
  const bytes = typeof source?.bytes === "string" ? source.bytes : "";
  return mediaPart(`image/${format}`, bytes);
}

function converseBlock(block: Record<string, Json>): Part[] {
  if (typeof block.text === "string") return [{ kind: "text", text: block.text }];
  if ("cachePoint" in block) return [];
  const reasoning = asRecord(block.reasoning) ?? asRecord(block.reasoningContent);
  if (reasoning) {
    const text = reasoning.text ?? asRecord(reasoning.reasoningText)?.text;
    return [{ kind: "reasoning", text: typeof text === "string" ? text : "" }];
  }
  const toolUse = asRecord(block.toolUse) ?? (block.type === "toolUse" ? block : undefined);
  if (toolUse) {
    return [
      {
        kind: "tool_call",
        id: String(toolUse.toolUseId ?? ""),
        name: String(toolUse.name ?? ""),
        input: parseMaybeJson(toolUse.input),
      },
    ];
  }
  const toolResult = asRecord(block.toolResult);
  if (toolResult) {
    const content = Array.isArray(toolResult.content) ? toolResult.content : [];
    return [
      {
        kind: "tool_result",
        callId: String(toolResult.toolUseId ?? ""),
        status: toolResult.status === "error" ? "error" : "ok",
        content: content.flatMap((item) => {
          const record = asRecord(item);
          if (!record) return [];
          if ("json" in record) return [{ kind: "data", value: record.json } as Part];
          return converseBlock(record);
        }),
      },
    ];
  }
  const image = asRecord(block.image);
  if (image) return [converseImage(image)];
  if ("json" in block) return [{ kind: "data", value: block.json }];
  return [{ kind: "data", value: block }];
}

function otelPart(part: Record<string, Json>): Part[] {
  const type = String(part.type ?? "");
  if (type === "text") return [{ kind: "text", text: String(part.content ?? "") }];
  if (type === "reasoning") return [{ kind: "reasoning", text: String(part.content ?? "") }];
  if (type === "tool_call") {
    return [{ kind: "tool_call", id: String(part.id ?? ""), name: String(part.name ?? ""), input: parseMaybeJson(part.arguments) }];
  }
  if (type === "tool_call_response") {
    const response = parseMaybeJson(part.response ?? part.result);
    return [
      {
        kind: "tool_result",
        callId: String(part.id ?? ""),
        status: "ok",
        content: typeof response === "string" ? [{ kind: "text", text: response }] : [{ kind: "data", value: response }],
      },
    ];
  }
  if (type === "blob" && typeof part.content === "string") {
    return [mediaPart(String(part.mime_type ?? part.modality ?? "application/octet-stream"), part.content)];
  }
  return [{ kind: "data", value: part }];
}

function isOtelPart(value: Record<string, Json>): boolean {
  return typeof value.type === "string" && value.type !== "toolUse" && ("content" in value || "arguments" in value || "response" in value || "id" in value);
}

export function parseParts(raw: Json): Part[] {
  const value = parseMaybeJson(raw);
  if (typeof value === "string") return value.length > 0 ? [{ kind: "text", text: value }] : [];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return typeof item === "string" ? [{ kind: "text", text: item } as Part] : [];
    if (Array.isArray(record.parts)) return parseParts(record.parts);
    if (Array.isArray(record.content)) return parseParts(record.content);
    if (isOtelPart(record)) return otelPart(record);
    return converseBlock(record);
  });
}

export function parseOtelMessages(raw: Json): Message[] {
  const value = parseMaybeJson(raw);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const role = normalizeRole(record.role);
    const parts = parseParts(record.parts ?? record.content ?? []);
    return [{ role, parts }];
  });
}

function normalizeRole(value: Json): Role {
  if (value === "system" || value === "assistant" || value === "tool") return value;
  return "user";
}

export function textOf(parts: Part[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case "text":
        case "reasoning":
          return part.text;
        case "data":
          return JSON.stringify(part.value);
        case "tool_call":
          return `${part.name}(${JSON.stringify(part.input)})`;
        case "tool_result":
          return textOf(part.content);
        case "media":
          return `[${part.mediaType} ${part.bytes} bytes]`;
      }
    })
    .join("\n");
}
