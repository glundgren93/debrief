import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import type { Part } from "./model.ts";

let encoder: Tiktoken | undefined;
const memo = new Map<string, number>();

export function countText(text: string): number {
  if (text.length === 0) return 0;
  const cached = memo.get(text);
  if (cached !== undefined) return cached;
  encoder ??= new Tiktoken(o200k);
  const count = encoder.encode(text, [], []).length;
  memo.set(text, count);
  return count;
}

export function countMedia(part: Extract<Part, { kind: "media" }>): number {
  if (!part.mediaType.startsWith("image/")) return Math.ceil(part.bytes / 4);
  if (!part.width || !part.height) return 1600;
  const scale = Math.min(1, 1568 / Math.max(part.width, part.height));
  return Math.ceil((part.width * scale * part.height * scale) / 750);
}

export const TOKENIZER_NOTE = "Token counts use the o200k tokenizer as an approximation; provider-reported totals are exact.";
