import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

function writeConfig(directory: string, name: string, content: string): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

function withDebriefConfig(path: string | undefined, run: () => void): void {
  const previous = process.env.DEBRIEF_CONFIG;
  if (path === undefined) delete process.env.DEBRIEF_CONFIG;
  else process.env.DEBRIEF_CONFIG = path;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.DEBRIEF_CONFIG;
    else process.env.DEBRIEF_CONFIG = previous;
  }
}

describe("configuration trust boundaries", () => {
  test("ignores credentialProcess in a project config and warns to use profile", () => {
    const directory = mkdtempSync(join(tmpdir(), "debrief-config-"));
    const userPath = writeConfig(
      directory,
      "user.yaml",
      `sources:\n  - name: user-source\n    type: cloudwatch-spans\n    region: eu-west-1\n    credentialProcess: [aws-vault, export, --format=json, profile]\n`,
    );
    writeConfig(
      directory,
      ".debrief.yaml",
      `sources:\n  - name: project-source\n    type: cloudwatch-spans\n    region: eu-west-1\n    profile: project\n    credentialProcess: "touch /tmp/unexpected"\n`,
    );

    withDebriefConfig(userPath, () => {
      const config = loadConfig(undefined, directory);
      expect(config.sources).toContainEqual(expect.objectContaining({ name: "user-source", credentialProcess: ["aws-vault", "export", "--format=json", "profile"] }));
      expect(config.sources.find((source) => source.name === "project-source")).toEqual(expect.objectContaining({ name: "project-source", profile: "project" }));
      expect(config.sources.find((source) => source.name === "project-source")).not.toHaveProperty("credentialProcess");
      expect(config.warnings).toEqual([expect.stringContaining("use profile:")]);
    });
  });

  test("keeps user config source when a project source has the same name", () => {
    const directory = mkdtempSync(join(tmpdir(), "debrief-config-"));
    const userPath = writeConfig(
      directory,
      "user.yaml",
      `sources:\n  - name: shared\n    type: cloudwatch-spans\n    region: eu-west-1\n    profile: user\n`,
    );
    writeConfig(
      directory,
      ".debrief.yaml",
      `sources:\n  - name: shared\n    type: cloudwatch-spans\n    region: us-east-1\n    profile: project\n`,
    );

    withDebriefConfig(userPath, () => {
      const config = loadConfig(undefined, directory);
      expect(config.sources.find((source) => source.name === "shared")).toEqual(expect.objectContaining({ name: "shared", region: "eu-west-1", profile: "user" }));
    });
  });

  test("honors credentialProcess in an explicit user config path", () => {
    const directory = mkdtempSync(join(tmpdir(), "debrief-config-"));
    const explicitPath = writeConfig(
      directory,
      "config.yaml",
      `sources:\n  - name: explicit\n    type: cloudwatch-spans\n    region: eu-west-1\n    credentialProcess: "aws-vault export --format=json profile"\n`,
    );
    writeConfig(
      directory,
      ".debrief.yaml",
      `sources:\n  - name: project\n    type: cloudwatch-spans\n    region: eu-west-1\n    credentialProcess: "touch /tmp/unexpected"\n`,
    );

    withDebriefConfig(undefined, () => {
      const config = loadConfig(explicitPath, directory);
      expect(config.sources).toEqual([expect.objectContaining({ name: "explicit", credentialProcess: "aws-vault export --format=json profile" })]);
      expect(config.warnings).toEqual([]);
    });
  });
});
