import { chmodSync, existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { cachePath, load } from "../src/sources/index.ts";

const originalCacheDir = process.env.DEBRIEF_CACHE_DIR;

afterEach(() => {
  if (originalCacheDir === undefined) delete process.env.DEBRIEF_CACHE_DIR;
  else process.env.DEBRIEF_CACHE_DIR = originalCacheDir;
});

describe("source cache", () => {
  test("keys entries by resolved source configuration without using the source name", () => {
    const directory = mkdtempSync(join(tmpdir(), "debrief-cache-key-"));
    process.env.DEBRIEF_CACHE_DIR = directory;
    const source = {
      name: "unsafe/source/name",
      type: "cloudwatch-spans" as const,
      region: "eu-west-1",
      logGroup: "aws/spans",
      attribute: "session.id",
      lookbackDays: 30,
      profile: "stage",
    };
    const path = cachePath(source, "chat-1");
    const changed = cachePath({ ...source, region: "us-east-1" }, "chat-1");

    const filename = path.slice(directory.length + 1);
    expect(path).toBe(join(directory, filename));
    expect(filename).not.toContain(source.name);
    expect(filename).not.toContain("/");
    expect(changed).not.toBe(path);
  });

  test("sweeps expired files and enforces cache permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "debrief-cache-sweep-"));
    process.env.DEBRIEF_CACHE_DIR = directory;
    chmodSync(directory, 0o755);
    const expired = join(directory, "expired.jsonl");
    const fresh = join(directory, "fresh.jsonl");
    writeFileSync(expired, "expired");
    writeFileSync(fresh, "fresh");
    chmodSync(expired, 0o644);
    chmodSync(fresh, 0o644);
    const old = new Date(Date.now() - 2_000);
    utimesSync(expired, old, old);
    const source = { name: "app", type: "cloudwatch-spans" as const, region: "eu-west-1" };
    writeFileSync(cachePath(source, "chat-1"), JSON.stringify({ fetchedAt: Date.now(), warnings: [], spans: "" }));

    const loaded = await load(
      { kind: "source", source, id: "chat-1" },
      { sources: [source], redact: [], files: [] },
      { refresh: false, cacheTtlMs: 1_000 },
    );

    expect(loaded.fromCache).toBe(true);

    expect(existsSync(expired)).toBe(false);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  test("reading a local file leaves the cache directory untouched", async () => {
    const parent = mkdtempSync(join(tmpdir(), "debrief-cache-file-"));
    const directory = join(parent, "cache");
    process.env.DEBRIEF_CACHE_DIR = directory;
    const input = join(parent, "input.jsonl");
    writeFileSync(input, "");

    await load(
      { kind: "file", path: input, id: "input.jsonl" },
      { sources: [], redact: [], files: [] },
      { refresh: false, cacheTtlMs: 1_000 },
    );

    expect(existsSync(directory)).toBe(false);
  });
});
